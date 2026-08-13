import crypto from 'node:crypto';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { get, run, tenantStorage, tx } from './db.js';
import { badRequest } from './errors.js';

/**
 * Member photos, stored as bytes and served over their own URL.
 *
 * They used to live as base64 data URLs in `members.photo_url`, which meant a
 * 25-row roster page carried ~600 KB of image inside its JSON — re-downloaded
 * on every filter change, over gym wifi, and impossible for the browser to
 * cache because it was part of the API response. `photo_url` on the way *out*
 * is now a URL to the bytes; the JSON stays small and each photo is fetched
 * once and cached.
 */

/** Only real raster formats a browser will render, so a photo can never smuggle
 * in SVG (which carries script) or an off-origin URL. */
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** public/js/photo.js crops and compresses to a 300×300 JPEG before upload,
 * which lands around 20 KB. This is a wide backstop against a hand-crafted
 * request, not a limit real uploads should ever approach. */
export const MAX_PHOTO_BYTES = 512 * 1024;

/** ID-proof uploads: the same raster formats plus a scanned PDF. */
export const DOCUMENT_MIMES = new Set([...ALLOWED_MIMES, 'application/pdf']);
/** express.json({ limit: '5mb' }) in app.js means 2 MB of bytes is ~2.7 MB
 * base64 with headroom; raising this without raising that limit would just
 * turn a real upload into an opaque body-too-large failure. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Turns a `data:<mime>;base64,…` data URL into bytes, rejecting anything that
 * isn't one of `allowed`'s mime types or exceeds `maxBytes`. Returns null for
 * an explicitly empty value, which is how a photo or document gets cleared.
 */
export function parseUploadDataUrl(value, { allowed, maxBytes, field = 'file' }) {
  if (value === null || value === undefined || value === '') return null;

  const match = DATA_URL_RE.exec(String(value).trim());
  if (!match) {
    throw badRequest('That file could not be read', { [field]: 'expected a base64 data URL' });
  }

  const mime = match[1].toLowerCase();
  if (!allowed.has(mime)) {
    throw badRequest('That file format is not supported', { [field]: `use one of: ${[...allowed].join(', ')}` });
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw badRequest('That file is empty', { [field]: 'no file data' });
  if (bytes.length > maxBytes) {
    throw badRequest('That file is too large', { [field]: `must be under ${Math.round(maxBytes / 1024)} KB once encoded` });
  }

  return { mime, bytes };
}

/** One-line alias so the three existing photo call sites are untouched. */
export function parsePhotoDataUrl(value) {
  return parseUploadDataUrl(value, { allowed: ALLOWED_MIMES, maxBytes: MAX_PHOTO_BYTES, field: 'photo' });
}

/**
 * Writes (or clears) a member's photo and bumps their version counter.
 *
 * The counter is what makes the served URL cacheable forever *and* correct: a
 * new photo is a new URL, so no cache anywhere has to be invalidated.
 */
export function setMemberPhoto(memberId, dataUrl) {
  const parsed = parsePhotoDataUrl(dataUrl);

  return tx(() => {
    if (parsed) {
      run(
        `INSERT INTO member_photos (member_id, mime, bytes, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (member_id) DO UPDATE
           SET mime = excluded.mime, bytes = excluded.bytes, updated_at = excluded.updated_at`,
        [memberId, parsed.mime, parsed.bytes],
      );
    } else {
      run('DELETE FROM member_photos WHERE member_id = ?', [memberId]);
    }
    run('UPDATE members SET photo_version = photo_version + 1 WHERE id = ?', [memberId]);
    return get('SELECT photo_version FROM members WHERE id = ?', [memberId])?.photo_version ?? 0;
  });
}

export function getMemberPhoto(memberId) {
  return get('SELECT mime, bytes, updated_at FROM member_photos WHERE member_id = ?', [memberId]);
}

/* ── Signed URLs ──────────────────────────────────────────────────────── */

/**
 * A photo is served to an `<img src>`, and an img tag cannot carry the Bearer
 * token the rest of the API is authenticated with. So the URL authenticates
 * itself: it is signed with the same server secret, scoped to one member of one
 * gym, and expires. Same idea as an S3 presigned URL.
 *
 * Scoping the signature to the tenant slug is what stops a URL minted inside
 * one gym from resolving a member id in another.
 */
const PHOTO_URL_TTL_SECONDS = 60 * 60 * 12;

function signature(slug, memberId, version, expiry) {
  return crypto
    .createHmac('sha256', config.secret)
    .update(`photo:${slug}:${memberId}:${version}:${expiry}`)
    .digest('base64url');
}

/**
 * The URL that serves this member's photo, or null when they have none.
 *
 * Carries the tenant's `/g/<slug>` prefix when the request arrived that way,
 * because the browser resolves a root-relative `/api/...` against the origin —
 * without the prefix a path-addressed gym's photos would be looked up in the
 * default database.
 */
export function memberPhotoUrl(memberId, photoVersion) {
  const store = tenantStorage.getStore();
  const slug = store?.slug ?? DEFAULT_TENANT_SLUG;
  const prefix = store?.pathPrefix ?? '';
  const expiry = Math.floor(Date.now() / 1000) + PHOTO_URL_TTL_SECONDS;
  const sig = signature(slug, memberId, photoVersion, expiry);

  return `${prefix}/api/member-photos/${memberId}?v=${photoVersion}&e=${expiry}&s=${sig}`;
}

/** True when this request carries a signature this server minted, for this
 * member, in this gym, that has not expired yet. */
export function verifyPhotoUrl(memberId, { v, e, s }) {
  const version = Number(v);
  const expiry = Number(e);
  if (!Number.isInteger(version) || !Number.isInteger(expiry) || typeof s !== 'string') return false;
  if (expiry < Math.floor(Date.now() / 1000)) return false;

  const slug = tenantStorage.getStore()?.slug ?? DEFAULT_TENANT_SLUG;
  const expected = signature(slug, memberId, version, expiry);
  if (expected.length !== s.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s));
}

/**
 * Joins the photo table in and reports whether a member has one.
 *
 * Presence has to come from the table rather than from `photo_version`, because
 * that counter is deliberately monotonic: removing a photo still increments it,
 * so that re-adding one later cannot mint a URL some cache is already holding
 * different bytes for. A non-zero version therefore means "has changed at least
 * once", not "has a photo".
 */
export const PHOTO_JOIN = 'LEFT JOIN member_photos photo ON photo.member_id = m.id';
export const PHOTO_PRESENT_COL = 'photo.member_id IS NOT NULL AS has_photo';

/**
 * Replaces a row's photo bookkeeping with the URL the front end renders.
 *
 * Every member-shaped response goes through this, so `photo_url` means exactly
 * one thing to a client: somewhere to GET an image, or null.
 */
export function withPhotoUrl(row, idField = 'id') {
  if (!row) return row;
  const { photo_version, has_photo, ...rest } = row;
  return { ...rest, photo_url: has_photo ? memberPhotoUrl(row[idField], photo_version) : null };
}
