import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-backup-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.BACKUP_KEEP = '3';
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
// The engine, not scripts/backup.js — that entry point exits the process when
// it is done, which is right for cron and fatal for a test runner.
const { runBackup, verifySnapshot } = await import('../src/backup.js');
const { s3Configured } = await import('../src/s3.js');

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

describe('taking a backup', () => {
  let summary;

  before(async () => {
    summary = await runBackup({ quiet: true });
    // runBackup calls listTenants(), which reopens tenants.js's own registry
    // connection — close it again so the source platform DB isn't left locked
    // for the tmpDir cleanup.
    closeRegistryDb();
  });

  it('reports no problems', () => {
    assert.deepEqual(summary.errors, []);
  });

  it('writes one timestamped folder', () => {
    const dirs = fs.readdirSync(process.env.BACKUP_DIR);
    assert.equal(dirs.length, 1);
    assert.equal(path.basename(summary.dir), dirs[0]);
  });

  it('snapshots the platform registry with the tenant row intact', () => {
    const copy = path.join(summary.dir, 'platform.db');
    assert.ok(fs.existsSync(copy));
    const db = new DatabaseSync(copy);
    assert.ok(db.prepare("SELECT * FROM tenants WHERE slug = 'backuptest'").get());
    db.close();
  });

  it("snapshots the tenant's own database with its admin account", () => {
    const copy = path.join(summary.dir, 'backuptest.db');
    assert.ok(fs.existsSync(copy));
    const db = new DatabaseSync(copy);
    assert.ok(db.prepare("SELECT * FROM users WHERE email = 'owner@backuptest.test'").get());
    db.close();
  });

  it('verifies every snapshot it wrote', () => {
    // A backup nobody has ever opened is not a backup. runBackup reopens each
    // file, runs integrity_check and counts rows — a snapshot that failed
    // either would have landed in summary.errors, asserted empty above.
    assert.ok(summary.databases >= 2, 'platform and tenant should both be captured');
  });

  it('says plainly that the snapshots have not left this machine', () => {
    assert.equal(summary.offsite, false);
    assert.equal(summary.uploaded, 0);
  });
});

describe('verification', () => {
  it('accepts a real snapshot and reports what is in it', () => {
    const platform = path.join(fs.readdirSync(process.env.BACKUP_DIR)
      .map((d) => path.join(process.env.BACKUP_DIR, d))
      .sort()
      .pop(), 'platform.db');

    const checked = verifySnapshot(platform);
    assert.ok(checked.tables > 0);
    assert.ok(checked.rows > 0, 'an empty file passes integrity_check and is still worthless');
    assert.ok(checked.counts.tenants >= 1);
  });

  it('rejects a file that is not a database at all', () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-broken-'));
    const broken = path.join(brokenDir, 'broken.db');
    fs.writeFileSync(broken, 'this is definitely not a SQLite database');
    try {
      assert.throws(() => verifySnapshot(broken));
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('rejects a database whose pages are corrupt', () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-corrupt-'));
    const corrupt = path.join(brokenDir, 'corrupt.db');

    const db = new DatabaseSync(corrupt);
    db.exec('CREATE TABLE t (a TEXT)');
    for (let i = 0; i < 500; i += 1) db.prepare('INSERT INTO t (a) VALUES (?)').run(`row-${i}`);
    db.close();

    // Scribble over the middle of the file, past the header, so it still looks
    // like SQLite but no longer reads back.
    const bytes = fs.readFileSync(corrupt);
    bytes.fill(0xff, 2048, 6144);
    fs.writeFileSync(corrupt, bytes);

    try {
      assert.throws(() => verifySnapshot(corrupt));
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('pruning', () => {
  it('keeps only the newest BACKUP_KEEP folders', async () => {
    // BACKUP_KEEP is 3 for this suite, and one backup already exists.
    const stamps = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- the folder name is a
      // timestamp, so these have to be taken in sequence to be distinguishable.
      const result = await runBackup({ quiet: true });
      closeRegistryDb();
      stamps.push(result.stamp);
    }

    const remaining = fs.readdirSync(process.env.BACKUP_DIR).sort();
    assert.equal(remaining.length, 3, 'a daily backup must not be allowed to fill the volume');
    assert.deepEqual(remaining, stamps.slice(-3), 'the survivors must be the newest three');
  });
});

describe('off-site upload configuration', () => {
  it('stays disabled until every required value is set', () => {
    assert.equal(s3Configured(), false);
  });
});
