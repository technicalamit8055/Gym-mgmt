import { createApp } from './app.js';
import { startBackupSchedule } from './backup.js';
import { ensureAdminAccount } from './bootstrap.js';
import { assertProductionReady, config } from './config.js';
import { closeDb } from './db.js';
import { closeRegistryDb } from './tenants.js';

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

const host = process.env.HOST || '0.0.0.0';
const server = app.listen(config.port, host, () => {
  console.log(`${config.gymName} is running at http://localhost:${config.port}`);
});

const stopBackups = startBackupSchedule();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopBackups?.();
    server.close(() => {
      closeDb();
      closeRegistryDb();
      process.exit(0);
    });
  });
}
