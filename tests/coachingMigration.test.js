import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

/**
 * CoachBook widens two CHECK constraints by rebuilding tables — the registry's
 * tenants.business_type and every tenant's whatsapp_logs.type. These run on
 * databases that already hold real gyms and real delivery history, so this
 * builds both files the way an older release left them and checks nothing is
 * lost on the way through.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-migration-'));
const registryFile = path.join(tmpDir, 'platform.db');
const tenantFile = path.join(tmpDir, 'legacy-gym.db');
process.env.DB_FILE = tenantFile;
process.env.PLATFORM_DB_FILE = registryFile;
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

// A registry as it stood before CoachBook: business_type's CHECK only knows
// gyms and libraries, and two accounts are already on it.
{
  const legacy = new DatabaseSync(registryFile);
  legacy.exec(`
    CREATE TABLE tenants (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slug             TEXT NOT NULL UNIQUE,
      display_name     TEXT NOT NULL,
      gym_name         TEXT,
      currency         TEXT NOT NULL DEFAULT 'INR',
      status           TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
      db_file          TEXT NOT NULL,
      plan_code        TEXT,
      trial_ends_on    TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      suspended_at     TEXT,
      suspended_reason TEXT
    );
    CREATE UNIQUE INDEX idx_tenants_slug ON tenants(slug);
  `);
  legacy.exec("ALTER TABLE tenants ADD COLUMN business_type TEXT NOT NULL DEFAULT 'gym' CHECK (business_type IN ('gym', 'library'))");
  legacy.exec('CREATE INDEX idx_tenants_business_type ON tenants(business_type)');
  legacy.exec(`INSERT INTO tenants (slug, display_name, gym_name, status, db_file, business_type)
               VALUES ('old-gym', 'Old Gym', 'Old Gym', 'active', 'old-gym.db', 'gym'),
                      ('old-hall', 'Old Hall', 'Old Hall', 'trial', 'old-hall.db', 'library')`);
  legacy.close();
}

// A tenant database whose delivery log predates CoachBook's message types.
{
  // Just the one table: the real schema creates everything else on open. FKs
  // off only for this setup write, since members does not exist yet.
  const legacy = new DatabaseSync(tenantFile, { enableForeignKeyConstraints: false });
  legacy.exec(`
    CREATE TABLE whatsapp_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
      type        TEXT NOT NULL CHECK (type IN ('receipt', 'reminder', 'welcome', 'freeze', 'birthday', 'custom')),
      message     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
      error       TEXT,
      sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO whatsapp_logs (phone, type, message) VALUES ('9800000000', 'birthday', 'Happy birthday!');
  `);
  legacy.close();
}

const { all, closeDb, get, getDb, run } = await import('../src/db.js');
const { closeRegistryDb, createTenant, findTenantBySlug, listTenants } = await import('../src/tenants.js');

after(() => {
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('upgrading an existing registry', () => {
  it('keeps every account and its type, and now accepts coaching', () => {
    assert.equal(findTenantBySlug('old-gym').business_type, 'gym');
    assert.equal(findTenantBySlug('old-hall').business_type, 'library');
    assert.equal(findTenantBySlug('old-gym').status, 'active');
    assert.ok(findTenantBySlug('old-gym').gym_code, 'later migrations still ran on the rebuilt table');

    createTenant({ slug: 'new-institute', displayName: 'New Institute', businessType: 'coaching' });
    assert.equal(findTenantBySlug('new-institute').business_type, 'coaching');
    assert.equal(listTenants().length, 3);
  });

  it('still refuses a type that is not a product', () => {
    assert.throws(() => createTenant({ slug: 'spa-place', displayName: 'Spa', businessType: 'spa' }), /CHECK constraint failed/);
  });

  it('keeps the indexes, the slug uniqueness among them', () => {
    assert.throws(() => createTenant({ slug: 'old-gym', displayName: 'Duplicate' }), /UNIQUE/);
    const registry = new DatabaseSync(registryFile);
    try {
      const names = registry.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tenants'").all().map((r) => r.name);
      for (const name of ['idx_tenants_slug', 'idx_tenants_business_type', 'idx_tenants_gym_code']) assert.ok(names.includes(name), name);
    } finally {
      registry.close();
    }
  });
});

describe('upgrading an existing tenant database', () => {
  it('keeps the delivery log and admits the new message types', () => {
    getDb();
    const rows = all('SELECT type, message FROM whatsapp_logs');
    assert.deepEqual(rows, [{ type: 'birthday', message: 'Happy birthday!' }]);
    run("INSERT INTO whatsapp_logs (phone, type, message) VALUES ('9811111111', 'absence', 'Absent today')");
    assert.equal(get("SELECT COUNT(*) AS n FROM whatsapp_logs WHERE type = 'absence'").n, 1);
    assert.throws(() => run("INSERT INTO whatsapp_logs (phone, type, message) VALUES ('1', 'nonsense', 'x')"), /CHECK/);
  });

  it('creates the CoachBook tables with the parent-alert defaults', () => {
    const settings = get('SELECT * FROM coaching_settings WHERE id = 1');
    assert.equal(settings.absence_alerts, 1);
    assert.equal(settings.fee_reminder_days_before, 3);
    assert.match(settings.absence_template, /\{\{student_name\}\} was marked ABSENT today/);
    assert.match(settings.fee_receipt_template, /\{\{student_name\}\}'s fees/);
  });
});
