import fs from 'node:fs';
import { notFound } from './errors.js';
import { storeMediaPath, storeMediaUrl, writeStoreImage } from './monetization.js';
import { getRegistryDb } from './tenants.js';
import { parse, today } from './validate.js';

/**
 * Badges the operator pins on the member app's bottom tabs — "Offer" on the
 * Store while a sale runs, "New" on Diet after a feature ships.
 *
 * One set for every gym, so it lives in the registry (tenants.db) beside the
 * other operator switches. A tab has at most one badge: the row is keyed by
 * the tab, and saving a badge on a tab replaces whatever was there.
 *
 * A badge is either a text pill (label + tone) or an uploaded sticker image
 * (a sale seal, a "new" burst). An image badge still keeps its label — it is
 * the image's alt text and what the console lists it by. Images share the
 * store's media folder and its public serving route (/api/store-media).
 *
 * `expires_on` is the last day the badge shows, read against the gym's own
 * calendar so a badge "until the 20th" ends at midnight where the member is.
 * `hide_when_seen` lets the app drop the badge on a phone once that member
 * has opened the tab; the app remembers that per badge version (updated_at),
 * so editing a badge shows it again to everyone.
 */

/** Every tab key the portal can draw: the gym's bar, then SeatBook's extras. */
export const NAV_BADGE_TABS = ['home', 'workout', 'diet', 'store', 'profile', 'pass', 'schedule'];
export const NAV_BADGE_TONES = ['brand', 'red', 'green', 'amber', 'blue', 'violet'];

const initialised = new WeakSet();

function db() {
  const handle = getRegistryDb();
  if (initialised.has(handle)) return handle;
  handle.exec(`
    CREATE TABLE IF NOT EXISTS platform_nav_badges (
      tab_key        TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      tone           TEXT NOT NULL DEFAULT 'brand',
      hide_when_seen INTEGER NOT NULL DEFAULT 0,
      expires_on     TEXT,
      image_file     TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Registries made before image badges.
  const columns = handle.prepare('PRAGMA table_info(platform_nav_badges)').all().map((c) => c.name);
  if (!columns.includes('image_file')) handle.exec('ALTER TABLE platform_nav_badges ADD COLUMN image_file TEXT');
  initialised.add(handle);
  return handle;
}

const row = (tabKey) => {
  const found = db().prepare('SELECT * FROM platform_nav_badges WHERE tab_key = ?').get(tabKey);
  return found === undefined ? undefined : { ...found };
};

const present = ({ image_file, ...badge }) => ({ ...badge, image_url: storeMediaUrl(image_file) });

const BADGE_FIELDS = {
  label: { type: 'string', required: true, min: 1, max: 10 },
  tone: { type: 'enum', values: NAV_BADGE_TONES, default: 'brand' },
  hide_when_seen: { type: 'boolean', default: 0 },
  expires_on: { type: 'date' },
};

function assertTab(tabKey) {
  if (!NAV_BADGE_TABS.includes(tabKey)) throw notFound('No such tab');
}

/** Each tab's image file has its own prefix, so no other row shares it. */
function removeImage(file) {
  const target = file && storeMediaPath(file);
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch {
    // Already gone.
  }
}

/** Every badge, expired ones included — the console shows those as ended. */
export function listNavBadges() {
  return db()
    .prepare('SELECT * FROM platform_nav_badges ORDER BY tab_key')
    .all()
    .map((found) => present({ ...found }));
}

export function setNavBadge(tabKey, payload) {
  assertTab(tabKey);
  const body = parse(payload, BADGE_FIELDS);
  db()
    .prepare(
      `INSERT INTO platform_nav_badges (tab_key, label, tone, hide_when_seen, expires_on, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (tab_key) DO UPDATE SET
         label = excluded.label, tone = excluded.tone, hide_when_seen = excluded.hide_when_seen,
         expires_on = excluded.expires_on, updated_at = excluded.updated_at`,
    )
    .run(tabKey, body.label, body.tone, body.hide_when_seen, body.expires_on ?? null);
  return present(row(tabKey));
}

/** Turns the tab's badge into a sticker image (PNG, JPG or WebP). */
export function setNavBadgeImage(tabKey, bytes) {
  assertTab(tabKey);
  const badge = row(tabKey);
  if (!badge) throw notFound('Save the badge before adding its image');
  const file = writeStoreImage(`nb${tabKey}`, bytes);
  db().prepare("UPDATE platform_nav_badges SET image_file = ?, updated_at = datetime('now') WHERE tab_key = ?").run(file, tabKey);
  if (badge.image_file && badge.image_file !== file) removeImage(badge.image_file);
  return present(row(tabKey));
}

/** Back to a text pill. */
export function clearNavBadgeImage(tabKey) {
  assertTab(tabKey);
  const badge = row(tabKey);
  if (!badge) throw notFound('No badge on that tab');
  db().prepare("UPDATE platform_nav_badges SET image_file = NULL, updated_at = datetime('now') WHERE tab_key = ?").run(tabKey);
  removeImage(badge.image_file);
  return present(row(tabKey));
}

export function clearNavBadge(tabKey) {
  assertTab(tabKey);
  const badge = row(tabKey);
  db().prepare('DELETE FROM platform_nav_badges WHERE tab_key = ?').run(tabKey);
  removeImage(badge?.image_file);
}

/**
 * What the member app draws, keyed by tab. Called inside a gym's request, so
 * today() is that gym's date and an expiry lands on its midnight.
 */
export function portalNavBadges() {
  const now = today();
  const out = {};
  for (const badge of listNavBadges()) {
    if (badge.expires_on && badge.expires_on < now) continue;
    out[badge.tab_key] = {
      label: badge.label,
      tone: badge.tone,
      image_url: badge.image_url,
      hide_when_seen: Boolean(badge.hide_when_seen),
      version: badge.updated_at,
    };
  }
  return out;
}
