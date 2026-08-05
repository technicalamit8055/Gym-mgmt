import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  gym_name         TEXT,
  currency         TEXT NOT NULL DEFAULT 'INR',
  status           TEXT NOT NULL DEFAULT 'trial'
                   CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  db_file          TEXT NOT NULL,
  plan_code        TEXT,
  trial_ends_on    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at     TEXT,
  suspended_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
`;

let registryDb;

function getRegistryDb() {
  if (registryDb) return registryDb;
  fs.mkdirSync(path.dirname(path.resolve(config.platformDbFile)), { recursive: true });
  registryDb = new DatabaseSync(config.platformDbFile);
  registryDb.exec('PRAGMA journal_mode = WAL');
  registryDb.exec(SCHEMA);
  return registryDb;
}

function plain(row) {
  return row === undefined ? undefined : { ...row };
}

export const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'static', 'assets', 'mail', 'ns1', 'ns2', 'localhost', 'default',
]);
const SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

export function tenantDbPath(slug) {
  if (!isValidSlug(slug)) throw new Error(`Refusing to build a path for invalid slug "${slug}"`);
  return path.join(config.tenantsDir, `${slug}.db`);
}

export function findTenantBySlug(slug) {
  return plain(getRegistryDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug));
}

export function listTenants() {
  return getRegistryDb().prepare('SELECT * FROM tenants ORDER BY created_at').all().map(plain);
}

export function createTenant({ slug, displayName, gymName, currency = 'INR' }) {
  if (!isValidSlug(slug)) throw new Error(`Invalid tenant slug "${slug}"`);
  const dbFile = `tenants/${slug}.db`;
  getRegistryDb()
    .prepare(
      'INSERT INTO tenants (slug, display_name, gym_name, currency, db_file) VALUES (?, ?, ?, ?, ?)',
    )
    .run(slug, displayName, gymName ?? displayName, currency, dbFile);
  return findTenantBySlug(slug);
}

export function setTenantStatus(slug, status, reason) {
  getRegistryDb()
    .prepare(
      `UPDATE tenants SET status = ?,
         suspended_at = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE suspended_at END,
         suspended_reason = ?
       WHERE slug = ?`,
    )
    .run(status, status, reason ?? null, slug);
}

export function closeRegistryDb() {
  if (registryDb) {
    registryDb.close();
    registryDb = undefined;
  }
}
