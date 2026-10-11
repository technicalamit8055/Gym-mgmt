import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { tenantStorage } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { EQUIPMENT_TYPES, MUSCLE_GROUPS, muscleGroupOf, muscleLabel } from './fitness.js';
import { EXERCISES } from './fitnessSeed.js';
import { getRegistryDb } from './tenants.js';

/**
 * The platform-wide exercise catalogue — one Hevy-style library, with a demo
 * image, GIF or short clip per exercise, managed from the operator console.
 *
 * It lives in the platform DB rather than in each gym's own, because a demo
 * clip of a deadlift is the same clip for every gym: uploading it once beats
 * uploading it per tenant, and fixing a bad one fixes it everywhere. A gym's
 * own additions stay in its `exercise_library` (is_custom = 1) and are merged
 * in at read time — see listExercisesForGym().
 *
 * The bytes live on disk (config.exerciseMediaDir), not in SQLite: a GIF runs
 * to megabytes, and a BLOB column would swell the platform DB and every backup
 * of it. Files are content-addressed (`<id>-<sha8>.<ext>`), so a URL names
 * exactly one set of bytes and can be cached forever — replacing a demo
 * produces a new URL rather than invalidating anything.
 */

/** What an upload may be, sniffed from its own bytes. The declared
 * Content-Type is never trusted: SVG is deliberately absent (it carries
 * script), and a ".gif" that is really HTML must not be served as one. */
export const MEDIA_FORMATS = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'gif' },
  mp4: { mime: 'video/mp4', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
};
export const MEDIA_MIMES = Object.values(MEDIA_FORMATS).map((f) => f.mime);
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** An exercise's demo is `<id>-<sha8>.<ext>`, a muscle group's picture
 * `m-<group>-<sha8>.<ext>` — the only kind that may be an SVG. */
const MEDIA_FILE_RE = /^(?:\d+-[a-f0-9]{8}\.(?:png|jpg|webp|gif|mp4|webm)|m-[a-z_]+-[a-f0-9]{8}\.(?:png|jpg|webp|gif|svg))$/;

/** Anything in an SVG that runs code or reaches outside the file. An <img>
 * would never run it, but the file is also reachable by its own URL, and the
 * serving route's sandbox header is the second line of defence, not the first. */
const SVG_HAZARDS = [
  [/<script\b/i, 'a script'],
  [/\son[a-z]+\s*=/i, 'an event handler'],
  [/javascript\s*:/i, 'a javascript: link'],
  [/<(?:foreignObject|iframe|embed|object|audio|video|animate|set)\b/i, 'embedded content or animation'],
  [/<!(?:ENTITY|DOCTYPE)\b/i, 'a DOCTYPE or entity'],
  [/@import\b/i, 'a stylesheet import'],
  [/url\(\s*['"]?\s*(?!#|data:image\/)/i, 'an external url()'],
  [/(?:xlink:)?href\s*=\s*['"]\s*(?!#|data:image\/(?:png|jpeg|gif|webp);)/i, 'an external link'],
];

/**
 * A safe SVG's format, or null when the bytes are not an SVG. Throws when the
 * file is an SVG carrying something from SVG_HAZARDS, naming what it found,
 * so the operator can strip it in their editor and re-upload.
 */
export function sniffSvg(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  // The root element, past any XML declaration and comments.
  const body = text.replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/, '');
  if (!/^<svg[\s>]/i.test(body)) return null;
  const hazard = SVG_HAZARDS.find(([pattern]) => pattern.test(text));
  if (hazard) throw badRequest(`That SVG contains ${hazard[1]} — export it as a plain image and try again`, { file: 'unsafe SVG' });
  return { ext: 'svg', mime: 'image/svg+xml', kind: 'image' };
}

/** The format a buffer actually is, or null. */
export function sniffMedia(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const startsWith = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { ext: 'png', ...MEDIA_FORMATS.png };
  if (startsWith(0xff, 0xd8, 0xff)) return { ext: 'jpg', ...MEDIA_FORMATS.jpg };
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { ext: 'gif', ...MEDIA_FORMATS.gif };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: 'webp', ...MEDIA_FORMATS.webp };
  if (head.slice(4, 8) === 'ftyp') return { ext: 'mp4', ...MEDIA_FORMATS.mp4 };
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return { ext: 'webm', ...MEDIA_FORMATS.webm };
  return null;
}

/* ── Storage ──────────────────────────────────────────────────────────── */

const initialised = new WeakSet();

/** The registry handle, with the catalogue's tables guaranteed to exist and
 * the starter exercises seeded exactly once. A WeakSet rather than a flag
 * because tests close and reopen the registry handle between suites. */
function db() {
  const handle = getRegistryDb();
  if (initialised.has(handle)) return handle;

  handle.exec(`
    CREATE TABLE IF NOT EXISTS platform_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS catalog_exercises (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
      muscle_group      TEXT NOT NULL,
      secondary_muscles TEXT NOT NULL DEFAULT '[]',
      equipment         TEXT NOT NULL DEFAULT 'barbell',
      tags              TEXT NOT NULL DEFAULT '[]',
      instructions      TEXT,
      media_file        TEXT,
      media_kind        TEXT,
      media_mime        TEXT,
      media_bytes       INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_exercises_group ON catalog_exercises(muscle_group);
    -- One picture per muscle group (the highlighted-body image on the
    -- member's Muscle Group filter). A row exists only once one is uploaded.
    CREATE TABLE IF NOT EXISTS catalog_muscles (
      muscle_group TEXT PRIMARY KEY,
      media_file   TEXT NOT NULL,
      media_mime   TEXT NOT NULL,
      media_bytes  INTEGER NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seeded once, on the strength of a marker rather than "the table is empty":
  // an operator who deliberately clears the catalogue must not get the starter
  // set back on the next restart.
  const seeded = handle.prepare("SELECT value FROM platform_meta WHERE key = 'catalog_seeded'").get();
  if (!seeded) {
    const insert = handle.prepare(
      'INSERT OR IGNORE INTO catalog_exercises (name, muscle_group, equipment) VALUES (?, ?, ?)',
    );
    for (const [name, group, equipment] of EXERCISES) insert.run(name, group, equipment);
    handle.prepare("INSERT INTO platform_meta (key, value) VALUES ('catalog_seeded', '1')").run();
  }
  remapLegacyMuscles(handle);

  initialised.add(handle);
  return handle;
}

/** Re-files a catalogue written against the old eight coarse groups (back,
 * legs, arms, core…) onto the Hevy list — primary and secondary muscles
 * alike. Once, on a marker, like the seed. */
function remapLegacyMuscles(handle) {
  if (handle.prepare("SELECT value FROM platform_meta WHERE key = 'muscles_v2'").get()) return;
  const update = handle.prepare('UPDATE catalog_exercises SET muscle_group = ?, secondary_muscles = ? WHERE id = ?');
  for (const row of handle.prepare('SELECT id, name, muscle_group, secondary_muscles FROM catalog_exercises').all()) {
    const primary = muscleGroupOf(row.muscle_group, row.name) ?? 'other';
    const secondary = [...new Set(asArray(row.secondary_muscles).map((m) => muscleGroupOf(m)).filter(Boolean))].filter((m) => m !== primary);
    update.run(primary, JSON.stringify(secondary), row.id);
  }
  handle.prepare("INSERT INTO platform_meta (key, value) VALUES ('muscles_v2', '1')").run();
}

const asArray = (text) => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

/** A row as the API shows it. `media_url` carries the gym's own path prefix
 * when asked from inside one, exactly as member photo URLs do, so an <img>
 * on /g/acme/ resolves it without knowing about prefixes. */
export function present(row) {
  if (!row) return row;
  const prefix = tenantStorage.getStore()?.pathPrefix ?? '';
  const { media_file: file, media_kind: kind, media_mime: mime, media_bytes: size, ...rest } = row;
  return {
    ...rest,
    secondary_muscles: asArray(row.secondary_muscles),
    tags: asArray(row.tags),
    is_custom: 0,
    source: 'catalog',
    media_url: file ? `${prefix}/api/exercise-media/${file}` : null,
    media_type: kind ?? null,
    media_mime: mime ?? null,
    media_bytes: size ?? null,
  };
}

/* ── Validation ───────────────────────────────────────────────────────── */

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) throw badRequest('Give the exercise a name of 2–120 characters', { name: 'is required' });
  return name;
}

function cleanChoice(value, allowed, field) {
  if (!allowed.includes(value)) throw badRequest(`${field} is not one of the allowed values`, { [field]: `use one of: ${allowed.join(', ')}` });
  return value;
}

function cleanMuscles(value, primary) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const muscles = list.map((m) => String(m).trim()).filter(Boolean);
  for (const muscle of muscles) cleanChoice(muscleGroupOf(muscle), MUSCLE_GROUPS, 'secondary_muscles');
  return [...new Set(muscles.map((m) => muscleGroupOf(m)))].filter((m) => m !== primary);
}

function cleanTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const tags = [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 8) throw badRequest('Use at most 8 tags', { tags: 'at most 8' });
  if (tags.some((t) => t.length > 24)) throw badRequest('Tags must be 24 characters or fewer', { tags: 'too long' });
  return tags;
}

function cleanInstructions(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > 2000) throw badRequest('Instructions are limited to 2000 characters', { instructions: 'too long' });
  return text || null;
}

/** Normalises a create/update/import payload into column values. `partial`
 * leaves absent fields out, so a PATCH of one field is not a reset of the rest. */
function cleanFields(body, { partial = false } = {}) {
  const out = {};
  const has = (key) => Object.hasOwn(body ?? {}, key);

  if (!partial || has('name')) out.name = cleanName(body?.name);
  if (!partial || has('muscle_group')) {
    out.muscle_group = cleanChoice(muscleGroupOf(body?.muscle_group, body?.name), MUSCLE_GROUPS, 'muscle_group');
  }
  if (!partial || has('equipment')) out.equipment = cleanChoice(body?.equipment ?? 'barbell', EQUIPMENT_TYPES, 'equipment');
  if (!partial || has('instructions')) out.instructions = cleanInstructions(body?.instructions);
  if (!partial || has('tags')) out.tags = JSON.stringify(cleanTags(body?.tags));
  if (!partial || has('secondary_muscles')) out.secondary_muscles = body?.secondary_muscles;
  return out;
}

/* ── Reads ────────────────────────────────────────────────────────────── */

export function getCatalogExercise(id) {
  return present(db().prepare('SELECT * FROM catalog_exercises WHERE id = ?').get(Number(id)));
}

export function listCatalog({ q, muscle_group: group, equipment, withMedia } = {}) {
  const where = [];
  const params = [];
  if (group) { where.push('muscle_group = ?'); params.push(String(group)); }
  if (equipment) { where.push('equipment = ?'); params.push(String(equipment)); }
  if (q) { where.push('name LIKE ?'); params.push(`%${String(q)}%`); }
  if (withMedia === 'yes') where.push('media_file IS NOT NULL');
  if (withMedia === 'no') where.push('media_file IS NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(`SELECT * FROM catalog_exercises ${clause} ORDER BY muscle_group, name`)
    .all(...params)
    .map((row) => present({ ...row }));
}

/** Catalogue entries by lower-cased name, for attaching demos to plan
 * exercises that only carry a name. */
export function catalogByNames(names) {
  const wanted = [...new Set(names.map((n) => String(n).trim().toLowerCase()).filter(Boolean))];
  const found = new Map();
  if (!wanted.length) return found;
  const rows = db()
    .prepare(`SELECT * FROM catalog_exercises WHERE name IN (${wanted.map(() => '?').join(',')})`)
    .all(...wanted);
  for (const row of rows) found.set(row.name.toLowerCase(), present({ ...row }));
  return found;
}

/**
 * What a gym sees: the whole catalogue plus its own custom exercises.
 *
 * A custom exercise whose name matches a catalogue one is dropped, so a gym
 * that added "Deadlift" before the catalogue existed does not see it twice.
 * `gymRows` is passed in rather than queried here because this module sits
 * above any one gym's database.
 */
export function mergeWithGymExercises(catalog, gymRows) {
  const taken = new Set(catalog.map((e) => e.name.toLowerCase()));
  const custom = gymRows
    .filter((e) => e.is_custom && !taken.has(String(e.name).toLowerCase()))
    .map((e) => ({
      ...e,
      secondary_muscles: [],
      tags: [],
      source: 'gym',
      media_url: null,
      media_type: null,
      media_mime: null,
      media_bytes: null,
    }));
  return [...catalog, ...custom].sort(
    (a, b) => a.muscle_group.localeCompare(b.muscle_group) || a.name.localeCompare(b.name),
  );
}

/** Adds the demo and instructions to plan exercises, which only carry a name. */
export function attachCatalogToExercises(exercises) {
  const found = catalogByNames(exercises.map((e) => e.exercise_name));
  return exercises.map((exercise) => {
    const entry = found.get(String(exercise.exercise_name).trim().toLowerCase());
    return {
      ...exercise,
      media_url: entry?.media_url ?? null,
      media_type: entry?.media_type ?? null,
      instructions: entry?.instructions ?? null,
      secondary_muscles: entry?.secondary_muscles ?? [],
      equipment: entry?.equipment ?? null,
    };
  });
}

/* ── Writes ───────────────────────────────────────────────────────────── */

function assertNameFree(name, exceptId) {
  const clash = db().prepare('SELECT id FROM catalog_exercises WHERE name = ?').get(name);
  if (clash && clash.id !== exceptId) throw conflict(`There is already an exercise called "${name}"`);
}

export function createCatalogExercise(body) {
  const fields = cleanFields(body);
  assertNameFree(fields.name);
  fields.secondary_muscles = JSON.stringify(cleanMuscles(fields.secondary_muscles, fields.muscle_group));
  const info = db()
    .prepare(
      `INSERT INTO catalog_exercises (name, muscle_group, secondary_muscles, equipment, tags, instructions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fields.name, fields.muscle_group, fields.secondary_muscles, fields.equipment, fields.tags, fields.instructions);
  return getCatalogExercise(info.lastInsertRowid);
}

export function updateCatalogExercise(id, body) {
  const current = db().prepare('SELECT * FROM catalog_exercises WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Exercise not found');

  const fields = cleanFields(body, { partial: true });
  if (fields.name) assertNameFree(fields.name, current.id);
  const primary = fields.muscle_group ?? current.muscle_group;
  if (Object.hasOwn(fields, 'secondary_muscles') || fields.muscle_group) {
    fields.secondary_muscles = JSON.stringify(
      cleanMuscles(Object.hasOwn(fields, 'secondary_muscles') ? fields.secondary_muscles : asArray(current.secondary_muscles), primary),
    );
  }

  const columns = Object.keys(fields);
  if (columns.length) {
    db()
      .prepare(`UPDATE catalog_exercises SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...columns.map((c) => fields[c]), current.id);
  }
  return getCatalogExercise(current.id);
}

export function deleteCatalogExercise(id) {
  const current = db().prepare('SELECT * FROM catalog_exercises WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Exercise not found');
  db().prepare('DELETE FROM catalog_exercises WHERE id = ?').run(current.id);
  removeMediaFile(current.media_file);
}

/**
 * Creates or updates by name, for the CSV import. One bad row never sinks the
 * rest: each is reported with its line, and the good ones land.
 */
export function importCatalog(rows) {
  const result = { created: 0, updated: 0, errors: [] };
  rows.forEach((row, index) => {
    const line = index + 1;
    try {
      const existing = db().prepare('SELECT id FROM catalog_exercises WHERE name = ?').get(String(row?.name ?? '').trim());
      if (existing) {
        // Only the columns the sheet actually provided: a sheet with no
        // instructions column must not blank the instructions already written.
        const patch = {};
        for (const key of ['muscle_group', 'equipment', 'instructions', 'tags', 'secondary_muscles']) {
          if (row[key] !== undefined && row[key] !== '') patch[key] = row[key];
        }
        updateCatalogExercise(existing.id, patch);
        result.updated += 1;
      } else {
        createCatalogExercise({ ...row, equipment: row.equipment || 'barbell' });
        result.created += 1;
      }
    } catch (err) {
      result.errors.push({ line, name: String(row?.name ?? ''), error: err.message });
    }
  });
  return result;
}

/* ── Media files ──────────────────────────────────────────────────────── */

export function mediaFilePath(file) {
  if (!MEDIA_FILE_RE.test(String(file))) return null;
  return path.join(config.exerciseMediaDir, file);
}

function removeMediaFile(file) {
  const target = file && mediaFilePath(file);
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch {
    // Already gone: nothing the caller can do about it, and the row no longer points at it.
  }
}

export function setCatalogMedia(id, bytes) {
  const current = db().prepare('SELECT * FROM catalog_exercises WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Exercise not found');
  if (!bytes?.length) throw badRequest('That file is empty');
  if (bytes.length > MAX_MEDIA_BYTES) {
    throw badRequest('That file is too large', { file: `must be under ${MAX_MEDIA_BYTES / 1024 / 1024} MB` });
  }
  const format = sniffMedia(bytes);
  if (!format) {
    throw badRequest('That file format is not supported', { file: 'use PNG, JPG, WebP, GIF, MP4 or WebM' });
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const file = `${current.id}-${hash}.${format.ext}`;
  fs.mkdirSync(config.exerciseMediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.exerciseMediaDir, file), bytes);

  db()
    .prepare(
      `UPDATE catalog_exercises
          SET media_file = ?, media_kind = ?, media_mime = ?, media_bytes = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(file, format.kind, format.mime, bytes.length, current.id);
  // After the row points at the new file, so a crash in between leaves a
  // stray file rather than an exercise pointing at nothing.
  if (current.media_file && current.media_file !== file) removeMediaFile(current.media_file);
  return getCatalogExercise(current.id);
}

/* ── Demo from a URL ──────────────────────────────────────────────────── */

/**
 * Pulls a demo from a link (e.g. a CDN's .mp4) and stores it exactly as if it
 * had been uploaded: same sniffing, same size cap, same content-addressed
 * file. Copying rather than hot-linking means a CDN that rotates or withdraws
 * its URLs never leaves members staring at a broken clip.
 *
 * The server is the one making the request, so the URL must not be able to
 * point it at itself or the private network behind it: every hop's host is
 * resolved and refused if it lands on a loopback, private or link-local
 * address, and redirects are followed by hand so each one is checked too.
 */

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

const PRIVATE_NETS = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) PRIVATE_NETS.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE_NETS.addSubnet(address, prefix, 'ipv6');
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 6) {
    // An IPv4 address wearing IPv6 clothes (::ffff:10.0.0.1) is still that IPv4 address.
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return PRIVATE_NETS.check(mapped[1], 'ipv4');
  }
  return PRIVATE_NETS.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw badRequest(`Could not find the server "${host}"`, { url: 'host not found' });
  if (addresses.some(isPrivateAddress)) throw badRequest('That URL points at a private network address', { url: 'not a public address' });
}

function parseMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw badRequest('That is not a valid URL', { url: 'must be a full http(s) link' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Use an http or https link', { url: 'must be http(s)' });
  if (url.username || url.password) throw badRequest('Use a link without a username or password in it', { url: 'no credentials' });
  return url;
}

/** The network call, swappable so tests never reach a real CDN. */
let mediaFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export function setMediaFetch(fn) {
  const previous = mediaFetch;
  mediaFetch = fn;
  return previous;
}

/** The body, read up to the cap and no further — a server that lies about
 * (or omits) Content-Length still cannot make us buffer a gigabyte. */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  const tooLarge = () => badRequest('That file is too large', { file: `must be under ${MAX_MEDIA_BYTES / 1024 / 1024} MB` });
  if (declared > MAX_MEDIA_BYTES) throw tooLarge();
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_MEDIA_BYTES) {
      await res.body.cancel?.().catch(() => {});
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export async function downloadMedia(rawUrl) {
  let url = parseMediaUrl(rawUrl);
  for (let hop = 0; ; hop += 1) {
    await assertPublicHost(url);
    let res;
    try {
      res = await mediaFetch(url.href, { redirect: 'manual', headers: { Accept: MEDIA_MIMES.join(', ') } });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'took too long to answer' : 'could not be reached';
      throw badRequest(`That URL ${reason}`, { url: reason });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw badRequest('That URL redirects too many times', { url: 'too many redirects' });
      url = parseMediaUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) throw badRequest(`That URL answered ${res.status} — check the link opens in a browser`, { url: `HTTP ${res.status}` });
    return readCapped(res);
  }
}

export async function setCatalogMediaFromUrl(id, rawUrl) {
  if (!db().prepare('SELECT id FROM catalog_exercises WHERE id = ?').get(Number(id))) throw notFound('Exercise not found');
  return setCatalogMedia(id, await downloadMedia(rawUrl));
}

export function clearCatalogMedia(id) {
  const current = db().prepare('SELECT * FROM catalog_exercises WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Exercise not found');
  db()
    .prepare(
      `UPDATE catalog_exercises
          SET media_file = NULL, media_kind = NULL, media_mime = NULL, media_bytes = NULL, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(current.id);
  removeMediaFile(current.media_file);
  return getCatalogExercise(current.id);
}

/* ── Muscle group pictures ────────────────────────────────────────────── */

/** Pictures only: a muscle group's tile is a still of the highlighted body,
 * never a clip. SVG is allowed here (anatomy charts often come as vectors),
 * checked by sniffSvg() — unlike exercise demos, which stay raster. */
export const MUSCLE_MEDIA_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

/** Every muscle group in Hevy's order, with its picture's URL when the
 * operator has uploaded one. */
export function listMuscleGroups() {
  const prefix = tenantStorage.getStore()?.pathPrefix ?? '';
  const rows = new Map(db().prepare('SELECT * FROM catalog_muscles').all().map((row) => [row.muscle_group, row]));
  return MUSCLE_GROUPS.map((key) => {
    const row = rows.get(key);
    return {
      key,
      label: muscleLabel(key),
      media_url: row ? `${prefix}/api/exercise-media/${row.media_file}` : null,
      media_mime: row?.media_mime ?? null,
      media_bytes: row?.media_bytes ?? null,
    };
  });
}

function muscleOr404(group) {
  const key = String(group ?? '');
  if (!MUSCLE_GROUPS.includes(key)) throw notFound('No such muscle group');
  return key;
}

export function setMuscleMedia(group, bytes) {
  const key = muscleOr404(group);
  if (!bytes?.length) throw badRequest('That file is empty');
  if (bytes.length > MAX_MEDIA_BYTES) {
    throw badRequest('That file is too large', { file: `must be under ${MAX_MEDIA_BYTES / 1024 / 1024} MB` });
  }
  const format = sniffMedia(bytes) ?? sniffSvg(bytes);
  if (!format || format.kind === 'video') {
    throw badRequest('That file format is not supported', { file: 'use PNG, JPG, WebP, GIF or SVG' });
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const file = `m-${key}-${hash}.${format.ext}`;
  fs.mkdirSync(config.exerciseMediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.exerciseMediaDir, file), bytes);

  const current = db().prepare('SELECT media_file FROM catalog_muscles WHERE muscle_group = ?').get(key);
  db()
    .prepare(
      `INSERT INTO catalog_muscles (muscle_group, media_file, media_mime, media_bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT (muscle_group) DO UPDATE SET
         media_file = excluded.media_file, media_mime = excluded.media_mime,
         media_bytes = excluded.media_bytes, updated_at = datetime('now')`,
    )
    .run(key, file, format.mime, bytes.length);
  // Same order as setCatalogMedia: the row points at the new file first.
  if (current?.media_file && current.media_file !== file) removeMediaFile(current.media_file);
  return listMuscleGroups().find((m) => m.key === key);
}

export function clearMuscleMedia(group) {
  const key = muscleOr404(group);
  const current = db().prepare('SELECT media_file FROM catalog_muscles WHERE muscle_group = ?').get(key);
  db().prepare('DELETE FROM catalog_muscles WHERE muscle_group = ?').run(key);
  if (current) removeMediaFile(current.media_file);
  return listMuscleGroups().find((m) => m.key === key);
}
