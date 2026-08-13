import fs from 'node:fs';
import { createApp } from './app.js';
import { startBackupSchedule } from './backup.js';
import { ensureAdminAccount } from './bootstrap.js';
import { assertProductionReady, config, DEFAULT_TENANT_SLUG } from './config.js';
import { closeDb, tenantStorage } from './db.js';
import { closeRegistryDb, listTenants, tenantDbPath } from './tenants.js';
import { sendAutomatedRenewalReminders } from './maintenance.js';
import { closeAllWhatsAppSessions, connectWhatsApp, hasStoredCredentials } from './whatsapp.js';

assertProductionReady();

/**
 * The fallback database behind the root domain must not come up with a
 * well-known admin account on it.
 *
 * On a single-gym install this bootstrap is the whole point — it is how a
 * fresh checkout becomes loggable-into. On the platform it is a liability:
 * the root domain would answer with a live `admin@gymbook.local /
 * admin12345` account that nobody ever asked for and no gym owner owns.
 * Explicitly-set credentials still provision, so deliberately running a
 * single gym in production keeps working; the defaults do not.
 */
const wantsDefaultAdmin = process.env.NODE_ENV !== 'production'
  || Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD);

const created = wantsDefaultAdmin ? ensureAdminAccount() : null;
const app = createApp();

/**
 * Every gym this process serves, as {slug, dbFile, timezone, gymName}.
 *
 * On a single-gym install there is no registry file, and touching it would
 * force-create data/platform.db on a deployment that never uses it — so the
 * fallback database stands in as the one and only tenant.
 */
function everyTenant() {
  if (!fs.existsSync(config.platformDbFile)) {
    return [
      { slug: DEFAULT_TENANT_SLUG, dbFile: config.dbFile, businessType: 'gym', gymName: config.gymName },
    ];
  }
  return listTenants()
    .filter((tenant) => tenant.status !== 'cancelled')
    .map((tenant) => ({
      slug: tenant.slug,
      dbFile: tenantDbPath(tenant.slug),
      timezone: tenant.timezone || undefined,
      businessType: tenant.business_type || 'gym',
      gymName: tenant.gym_name || tenant.display_name || config.gymName,
    }));
}

/**
 * Reminders are per-gym: the settings, the memberships and the delivery log all
 * live in that gym's own database, so each sweep has to run inside that gym's
 * tenant context. Hourly rather than daily because the host suspends idle
 * machines — a once-a-day timer would simply never fire. Re-running is safe;
 * the sweep skips anyone already reminded today.
 */
function sweepRenewalReminders() {
  for (const tenant of everyTenant()) {
    try {
      tenantStorage.run(
        {
          slug: tenant.slug,
          dbFile: tenant.dbFile,
          timezone: tenant.timezone,
          businessType: tenant.businessType,
        },
        () => sendAutomatedRenewalReminders({ gymName: tenant.gymName }),
      );
    } catch (err) {
      console.error(`[whatsapp:${tenant.slug}] reminder sweep failed:`, err.message);
    }
  }
}

/** Re-links gyms that had already paired, so a restart does not make every
 * owner re-scan. Gyms that never paired are left alone — connecting them would
 * open a socket to WhatsApp for a feature they have not switched on. */
function restoreWhatsAppSessions() {
  for (const tenant of everyTenant()) {
    if (!hasStoredCredentials(tenant.slug)) continue;
    connectWhatsApp({ slug: tenant.slug, force: true }).catch((err) =>
      console.error(`[whatsapp:${tenant.slug}] could not restore the session:`, err.message),
    );
  }
}

const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

const host = process.env.HOST || '0.0.0.0';
const server = app.listen(config.port, host, () => {
  console.log(`${config.gymName} is running at http://localhost:${config.port}`);
  restoreWhatsAppSessions();
});

// Delayed so the first sweep does not compete with startup, and so a crash-loop
// cannot fire reminders on every restart.
const firstSweep = setTimeout(sweepRenewalReminders, 60_000);
const sweepTimer = setInterval(sweepRenewalReminders, REMINDER_INTERVAL_MS);

const stopBackups = startBackupSchedule();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopBackups?.();
    clearTimeout(firstSweep);
    clearInterval(sweepTimer);
    closeAllWhatsAppSessions();
    server.close(() => {
      closeDb();
      closeRegistryDb();
      process.exit(0);
    });
  });
}
