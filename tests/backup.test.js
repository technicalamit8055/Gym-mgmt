import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-backup-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

after(() => {
  // Windows can briefly hold a file lock after a SQLite DatabaseSync handle
  // is closed (WAL/SHM sidecar cleanup) — retry instead of failing on it.
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

before(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'backuptest',
      gym_name: 'Backup Test Gym',
      admin_name: 'Owner',
      admin_email: 'owner@backuptest.test',
      admin_password: 'ownerpass123',
    }),
  });

  await new Promise((resolve) => server.close(resolve));
  closeDb();
  closeRegistryDb();
});

it('snapshots the platform registry and every tenant into a timestamped folder', async () => {
  await import('../scripts/backup.js');
  // backup.js calls listTenants(), which reopens tenants.js's own registry
  // connection (closed in before()) — close it again so the source platform
  // DB file isn't left locked for the tmpDir cleanup below.
  closeRegistryDb();

  const dirs = fs.readdirSync(process.env.BACKUP_DIR);
  assert.equal(dirs.length, 1);
  const backupDir = path.join(process.env.BACKUP_DIR, dirs[0]);

  const platformCopy = path.join(backupDir, 'platform.db');
  assert.ok(fs.existsSync(platformCopy));
  const platformDb = new DatabaseSync(platformCopy);
  const tenantRow = platformDb.prepare("SELECT * FROM tenants WHERE slug = 'backuptest'").get();
  assert.ok(tenantRow);
  platformDb.close();

  const tenantCopy = path.join(backupDir, 'backuptest.db');
  assert.ok(fs.existsSync(tenantCopy));
  const tenantDb = new DatabaseSync(tenantCopy);
  const admin = tenantDb.prepare("SELECT * FROM users WHERE email = 'owner@backuptest.test'").get();
  assert.ok(admin);
  tenantDb.close();
});
