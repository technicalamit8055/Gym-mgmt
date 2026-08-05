/**
 * Snapshots the platform registry plus every tenant's database into backups/,
 * using SQLite's VACUUM INTO — safe to run against a live WAL-mode database,
 * no server downtime, no torn copies. Meant to be triggered by an external
 * scheduler (cron / Windows Task Scheduler); the app never runs this itself.
 *
 * Restore: stop the server, copy the wanted backup file back over the
 * original path (e.g. data/tenants/acme.db), start the server again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ROOT } from '../src/config.js';
import { closeRegistryDb, listTenants, tenantDbPath } from '../src/tenants.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(process.env.BACKUP_DIR || path.join(ROOT, 'backups'), stamp);
fs.mkdirSync(backupDir, { recursive: true });

function snapshot(label, sourceFile) {
  if (!fs.existsSync(sourceFile)) {
    console.log(`skip ${label}: no file at ${sourceFile}`);
    return;
  }
  const dest = path.join(backupDir, `${label}.db`);
  const db = new DatabaseSync(sourceFile);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  db.close();
  console.log(`backed up ${label} -> ${dest}`);
}

snapshot('platform', config.platformDbFile);
snapshot('default', config.dbFile);
for (const tenant of listTenants()) {
  snapshot(tenant.slug, tenantDbPath(tenant.slug));
}
closeRegistryDb();

console.log(`\nDone: ${backupDir}`);
