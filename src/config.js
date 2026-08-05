import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

export const config = {
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'gym.db'),
  // A stable secret keeps sessions alive across restarts. Generated per-process
  // when unset, which is fine for local development.
  secret: process.env.AUTH_SECRET || 'dev-only-secret-change-me',
  tokenTtlSeconds: Number(process.env.TOKEN_TTL || 60 * 60 * 12),
  currency: process.env.CURRENCY || 'INR',
  gymName: process.env.GYM_NAME || 'GymBook',
  // Multi-tenant platform registry (which gyms exist) and where their
  // individual SQLite files live. Separate from dbFile, which stays the
  // single-tenant/dev fallback database.
  platformDbFile: process.env.PLATFORM_DB_FILE || path.join(ROOT, 'data', 'platform.db'),
  tenantsDir: process.env.TENANTS_DIR || path.join(ROOT, 'data', 'tenants'),
};

/** Pseudo-slug used whenever a request resolves to no real tenant (dev/single-gym mode). */
export const DEFAULT_TENANT_SLUG = 'default';
