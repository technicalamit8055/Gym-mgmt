import { createApp } from './app.js';
import { ensureAdminAccount } from './bootstrap.js';
import { assertProductionReady, config } from './config.js';
import { closeDb } from './db.js';
import { closeRegistryDb } from './tenants.js';

assertProductionReady();

const created = ensureAdminAccount();
const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`${config.gymName} is running at http://localhost:${config.port}`);
  if (created) {
    console.log(`\nFirst run — admin account created:\n  email:    ${created.email}\n  password: ${created.password}`);
    if (created.generated) console.log('  Change this password after signing in.\n');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      closeDb();
      closeRegistryDb();
      process.exit(0);
    });
  });
}
