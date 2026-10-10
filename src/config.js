import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

if (process.env.NODE_ENV !== 'test') {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(path.join(ROOT, '.env'));
    }
  } catch {
    // .env file is optional (loads PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD)
  }
}


function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  // Exercise demos (images, GIFs, short clips) uploaded from the operator
  // console. Defaults to sit beside the platform DB so it rides the same volume
  // and backup story: /data/exercise-media on Fly, ./data/exercise-media locally.
  exerciseMediaDir:
    process.env.EXERCISE_MEDIA_DIR ||
    path.join(path.dirname(path.resolve(process.env.PLATFORM_DB_FILE || path.join(ROOT, 'data', 'platform.db'))), 'exercise-media'),
  trialDays: Number(process.env.TRIAL_DAYS || 7),
  // Open Food Facts, for the member app's barcode scanner (src/foodBarcode.js).
  // Overridable so tests can point it at a local stub instead of the internet.
  foodDbUrl: (process.env.FOOD_DB_URL || 'https://world.openfoodfacts.org').replace(/\/+$/, ''),
  // Open Food Facts asks every client to identify itself this way.
  foodDbUserAgent: process.env.FOOD_DB_USER_AGENT || 'GymBook/1.0 (gym management software; member food logging)',
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
  // Gyms bringing their own domain (app.theirgym.com). Off until `target` is
  // set: connecting a domain is only useful once this deployment can also
  // issue it a certificate (see docs/CUSTOM_DOMAINS.md), and a gym handed DNS
  // instructions for a feature that cannot finish would be stuck.
  customDomains: {
    // The hostname a gym's CNAME points at, e.g. "domains.gymbook.app".
    target: (process.env.CUSTOM_DOMAIN_TARGET || '').trim().toLowerCase().replace(/\.$/, ''),
    // This server's public IPv4 address(es), for root domains, which cannot
    // carry a CNAME. Optional: without them a root domain is told to use an
    // ALIAS/ANAME/flattened CNAME instead, and is checked against whatever
    // `target` resolves to.
    ipv4: splitList(process.env.CUSTOM_DOMAIN_IPV4),
    // Asked directly rather than through the OS resolver, whose cache would
    // keep reporting a record the owner fixed minutes ago. Empty string to
    // fall back to the system resolver (e.g. egress-restricted hosts).
    dnsServers:
      process.env.CUSTOM_DOMAIN_DNS_SERVERS === undefined
        ? ['1.1.1.1', '8.8.8.8']
        : splitList(process.env.CUSTOM_DOMAIN_DNS_SERVERS),
    maxPerTenant: Number(process.env.CUSTOM_DOMAIN_LIMIT || 3),
    // How long a "Check DNS" answer is reused before the next click asks the
    // DNS servers again.
    checkCooldownMs: Number(process.env.CUSTOM_DOMAIN_CHECK_COOLDOWN_MS ?? 10_000),
  },
  // Web Push (src/webPush.js). The VAPID key pair is generated on first boot
  // and kept in keyFile, beside the platform DB so it rides the same volume —
  // losing it silently unsubscribes every member. Set both keys explicitly to
  // pin them instead (e.g. when several machines serve one origin).
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    // Push services contact this address if our sends misbehave. Apple rejects
    // a VAPID token without a real mailto:/https: subject.
    subject:
      process.env.VAPID_SUBJECT ||
      (process.env.PLATFORM_ADMIN_EMAIL ? `mailto:${process.env.PLATFORM_ADMIN_EMAIL}` : 'mailto:notifications@gymbook.app'),
    keyFile:
      process.env.VAPID_KEY_FILE ||
      path.join(path.dirname(path.resolve(process.env.PLATFORM_DB_FILE || path.join(ROOT, 'data', 'platform.db'))), 'vapid-keys.json'),
    // How often server.js runs the reminder sweep. Short, because a hydration
    // reminder at 11:00 should not arrive at 11:55.
    sweepIntervalMs: Number(process.env.PUSH_SWEEP_INTERVAL_MS || 5 * 60_000),
  },
  // Operator console credentials. Both must be set for the console to exist
  // at all — an unset password must never mean "no password required".
  platformAdminEmail: (process.env.PLATFORM_ADMIN_EMAIL || '').toLowerCase(),
  platformAdminPassword: process.env.PLATFORM_ADMIN_PASSWORD || '',
  backup: {
    dir: process.env.BACKUP_DIR || path.join(ROOT, 'backups'),
    // On by default in production, where losing a gym's data is unrecoverable,
    // and off in development, where an automatic timer would just litter the
    // working copy. 0 disables it in favour of an external scheduler.
    intervalHours: Number(
      process.env.BACKUP_INTERVAL_HOURS ?? (process.env.NODE_ENV === 'production' ? 24 : 0),
    ),
    // How many local backup folders to keep. Old ones are pruned so a daily
    // backup cannot fill the volume and stop the live database writing.
    keep: Number(process.env.BACKUP_KEEP || 14),
    // Any S3-compatible store (Cloudflare R2, Backblaze B2, MinIO, S3). Uploads
    // stay disabled until all four required values are present — see s3.js.
    s3: {
      bucket: process.env.BACKUP_S3_BUCKET || '',
      endpoint: process.env.BACKUP_S3_ENDPOINT || '',
      region: process.env.BACKUP_S3_REGION || 'auto',
      accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
      prefix: process.env.BACKUP_S3_PREFIX || '',
    },
  },
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
