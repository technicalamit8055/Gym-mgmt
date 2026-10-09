import fs from 'node:fs';
import { createApp } from './app.js';
import { startBackupSchedule } from './backup.js';
import { ensureAdminAccount } from './bootstrap.js';
import { assertProductionReady, config, DEFAULT_TENANT_SLUG } from './config.js';
import { closeDb, tenantStorage } from './db.js';
import { closeRegistryDb, listTenants, tenantDbPath } from './tenants.js';
import { sendAutomatedBirthdayWishes, sendAutomatedRenewalReminders } from './maintenance.js';
import { sweepPushNotifications } from './notifications.js';
import { vapidKeys } from './webPush.js';
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
// Loaded (or generated and saved) up front, so a read-only or full volume is
// a loud startup error rather than the first member's "Enable" tap failing.
vapidKeys();
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
 * Reminders and birthday wishes are per-gym: the settings, the members and the
 * delivery log all live in that gym's own database, so each sweep has to run
 * inside that gym's tenant context. Hourly rather than daily because the host
 * suspends idle machines — a once-a-day timer would simply never fire.
 * Re-running is safe; each sweep skips anyone already messaged today.
 */
function sweepAutomatedMessages() {
  for (const tenant of everyTenant()) {
    try {
      tenantStorage.run(
        {
          slug: tenant.slug,
          dbFile: tenant.dbFile,
          timezone: tenant.timezone,
          businessType: tenant.businessType,
        },
        () => {
          sendAutomatedRenewalReminders({ gymName: tenant.gymName });
          sendAutomatedBirthdayWishes({ gymName: tenant.gymName });
        },
      );
    } catch (err) {
      console.error(`[whatsapp:${tenant.slug}] message sweep failed:`, err.message);
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

/**
 * Push reminders (hydration, meals, workout keep-alive, renewals) for every
 * gym, each inside its own tenant context like the WhatsApp sweep above. More
 * frequent than that sweep because these are tied to a time of day; each
 * reminder is deduplicated per member, so overlapping passes are harmless.
 */
let pushSweepRunning = false;
async function sweepPushReminders() {
  // A slow push service must not let passes pile up on top of each other.
  if (pushSweepRunning) return;
  pushSweepRunning = true;
  try {
    for (const tenant of everyTenant()) {
      try {
        await tenantStorage.run(
          {
            slug: tenant.slug,
            dbFile: tenant.dbFile,
            timezone: tenant.timezone,
            businessType: tenant.businessType,
          },
          () => sweepPushNotifications(),
        );
      } catch (err) {
        console.error(`[push:${tenant.slug}] reminder sweep failed:`, err.message);
      }
    }
  } finally {
    pushSweepRunning = false;
  }
}

const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

const host = process.env.HOST || '0.0.0.0';
const server = app.listen(config.port, host, () => {
  console.log(`${config.gymName} is running at http://localhost:${config.port}`);
  restoreWhatsAppSessions();
});

// Delayed so the first sweep does not compete with startup, and so a crash-loop
// cannot fire reminders/wishes on every restart.
const firstSweep = setTimeout(sweepAutomatedMessages, 60_000);
const sweepTimer = setInterval(sweepAutomatedMessages, REMINDER_INTERVAL_MS);
const firstPushSweep = setTimeout(sweepPushReminders, 30_000);
const pushSweepTimer = setInterval(sweepPushReminders, config.push.sweepIntervalMs);

const stopBackups = startBackupSchedule();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopBackups?.();
    clearTimeout(firstSweep);
    clearInterval(sweepTimer);
    clearTimeout(firstPushSweep);
    clearInterval(pushSweepTimer);
    closeAllWhatsAppSessions();
    server.close(() => {
      closeDb();
      closeRegistryDb();
      process.exit(0);
    });
  });
}
