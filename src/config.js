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
  trialDays: Number(process.env.TRIAL_DAYS || 7),
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    planId: process.env.RAZORPAY_PLAN_ID || '',
    // Razorpay requires a finite total_count on subscription create; there's
    // no "forever" option. This is a large-but-finite stand-in (~10 years of
    // monthly cycles) — revisit against Razorpay's actual max once real
    // dashboard access exists. If exhausted, Razorpay auto-completes the
    // subscription and the gym would need to hit /subscribe again.
    totalCount: Number(process.env.RAZORPAY_TOTAL_COUNT || 120),
  },
  // Opt-in only: trusting X-Forwarded-For without a real proxy in front lets
  // a client spoof its own IP and dodge the rate limiter below.
  trustProxy: process.env.TRUST_PROXY === 'true',
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
  loginWindowMs: Number(process.env.LOGIN_WINDOW_MS || 15 * 60_000),
  loginLockoutMs: Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60_000),
  signupMaxAttempts: Number(process.env.SIGNUP_MAX_ATTEMPTS || 10),
  signupWindowMs: Number(process.env.SIGNUP_WINDOW_MS || 60 * 60_000),
  signupLockoutMs: Number(process.env.SIGNUP_LOCKOUT_MS || 60 * 60_000),
  // The exact production hostname (e.g. "yourapp.fly.dev" or, later, a real
  // domain) once deployed. Unset locally/in tests, where subdomain detection
  // falls back to inferring from label count instead (see tenant.js).
  rootDomain: process.env.ROOT_DOMAIN || '',
  // Which address shape signup hands a new gym: "path" (/g/acme, works on any
  // hostname) or "subdomain" (acme.example.com, needs wildcard DNS + TLS on a
  // domain you own). Both are always *accepted* — this only picks which one
  // gets advertised. Defaults to the one that cannot be misconfigured.
  tenantUrlMode: process.env.TENANT_URL_MODE === 'subdomain' ? 'subdomain' : 'path',
  // Operator console credentials. Both must be set for the console to exist
  // at all — an unset password must never mean "no password required".
  platformAdminEmail: (process.env.PLATFORM_ADMIN_EMAIL || '').toLowerCase(),
  platformAdminPassword: process.env.PLATFORM_ADMIN_PASSWORD || '',
};

/** Pseudo-slug used whenever a request resolves to no real tenant (dev/single-gym mode). */
export const DEFAULT_TENANT_SLUG = 'default';

/** Refuses to start with the dev-only secret in production — the single
 * most damaging misconfiguration, since every tenant's session tokens would
 * be signed with a publicly-known key. Call at process startup. */
export function assertProductionReady(env = process.env) {
  if (env.NODE_ENV === 'production' && !env.AUTH_SECRET) {
    throw new Error('Refusing to start: AUTH_SECRET must be set when NODE_ENV=production (see README).');
  }
}
