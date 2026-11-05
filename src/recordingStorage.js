import fs from 'node:fs';
import path from 'node:path';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { get, tenantStorage } from './db.js';
import { emailEnabled, sendEmail } from './mailer.js';
import { listTenants, tenantDbPath } from './tenants.js';

/**
 * The disk class recordings live on (config.recordingsDir;
 * src/coaching/serverRecording.js), watched so it never fills up:
 *
 *   ok    plenty of room
 *   low   under recordingDisk.warnPct free: the operator console's Server
 *         storage card turns amber, and the operator gets an email a day
 *   full  under recordingDisk.stopPct free (or under 2 GB): recording
 *         pauses — no new recordings, and one in progress stops where it
 *         is and is still filed. Live classes are never touched.
 *
 * Platform-wide, not per institute: every institute's recordings share the
 * one disk. Each recording's size is kept in its institute's database
 * (class_recordings.size_bytes), so the summary adds up rows, not files.
 */

const CACHE_MS = 30_000;
const WARN_EVERY_MS = 24 * 60 * 60_000;

/** The measurement, swappable so tests can fake a full disk. */
let probe = (dir) => fs.statfsSync(dir);
let cached = null;

export function setDiskProbe(fn) {
  const previous = probe;
  probe = fn;
  cached = null;
  return previous;
}

/** The recordings folder, or the nearest folder above it that exists yet. */
function measuredDir() {
  let dir = path.resolve(config.recordingsDir);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/**
 * The disk's size, free space and state. Cached for 30 seconds: it is asked
 * on every playlist a recording board uploads.
 */
export function diskSpace({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const s = probe(measuredDir());
  const total = Number(s.blocks) * Number(s.bsize);
  const free = Number(s.bavail) * Number(s.bsize);
  const freePct = total > 0 ? (free / total) * 100 : 100;
  const { warnPct, stopPct, stopBytes } = config.recordingDisk;
  const value = {
    total_bytes: total,
    free_bytes: free,
    free_pct: Math.round(freePct * 10) / 10,
    state: freePct < stopPct || free < stopBytes ? 'full' : freePct < warnPct ? 'low' : 'ok',
  };
  cached = { at: Date.now(), value };
  return value;
}

/** Whether there is room to record. A disk that cannot be measured is not risked. */
export function recordingRoom() {
  try {
    return diskSpace().state !== 'full';
  } catch (err) {
    console.error('[recordings] could not measure the disk:', err.message);
    return false;
  }
}

/** Every CoachBook institute's database, as tenant contexts. */
function institutes() {
  if (!fs.existsSync(config.platformDbFile)) {
    return [{ slug: DEFAULT_TENANT_SLUG, name: config.gymName, store: { slug: DEFAULT_TENANT_SLUG, dbFile: config.dbFile, businessType: 'coaching' } }];
  }
  return listTenants()
    .filter((t) => t.status !== 'cancelled' && t.business_type === 'coaching')
    .map((t) => ({
      slug: t.slug,
      name: t.gym_name || t.display_name || t.slug,
      store: { slug: t.slug, dbFile: tenantDbPath(t.slug), timezone: t.timezone || undefined, businessType: 'coaching' },
    }));
}

/**
 * The operator console's Server storage card: the disk, the thresholds, and
 * each institute's recordings, biggest first.
 */
export function storageSummary() {
  const disk = diskSpace({ fresh: true });
  const rows = [];
  for (const inst of institutes()) {
    try {
      const row = tenantStorage.run(inst.store, () => ({
        ...get("SELECT COUNT(*) AS recordings, COALESCE(SUM(size_bytes), 0) AS bytes FROM class_recordings WHERE source = 'server'"),
        recording_on: Boolean(get('SELECT record_classes FROM coaching_settings WHERE id = 1')?.record_classes),
        keep_days: get('SELECT recording_keep_days FROM coaching_settings WHERE id = 1')?.recording_keep_days ?? 30,
      }));
      if (row.recordings || row.recording_on) rows.push({ slug: inst.slug, name: inst.name, ...row });
    } catch (err) {
      console.error(`[recordings:${inst.slug}] could not read its recordings:`, err.message);
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return {
    disk,
    warn_pct: config.recordingDisk.warnPct,
    stop_pct: config.recordingDisk.stopPct,
    recordings_dir: path.resolve(config.recordingsDir),
    recordings_bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
    institutes: rows,
  };
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
let lastWarned = 0;

/**
 * Emails the operator while the disk is low or full — once a day at most
 * (the hourly sweep, server.js). Nothing without email set up: the console
 * card says it there.
 *
 * @returns {Promise<boolean>} whether an email went out
 */
export async function warnOperatorIfLow({ now = Date.now() } = {}) {
  if (!emailEnabled() || !config.platformAdminEmail || now - lastWarned < WARN_EVERY_MS) return false;
  const disk = diskSpace({ fresh: true });
  if (disk.state === 'ok') return false;
  lastWarned = now;
  const full = disk.state === 'full';
  await sendEmail({
    to: config.platformAdminEmail,
    subject: full ? 'CoachBook: recording paused — server disk nearly full' : 'CoachBook: server disk is getting full',
    text: [
      `The disk that holds class recordings has ${gb(disk.free_bytes)} free of ${gb(disk.total_bytes)} (${disk.free_pct}%).`,
      full
        ? `Below ${config.recordingDisk.stopPct}% free, new recordings are paused. Live classes carry on.`
        : `Below ${config.recordingDisk.stopPct}% free, recording pauses by itself.`,
      '',
      'To make room: delete old recordings, ask the biggest institutes to keep them for fewer days, or enlarge the disk.',
      'The operator console’s Server storage card shows which institutes use the most.',
    ].join('\n'),
  });
  return true;
}

/** Forgets the last warning (tests). */
export const resetOperatorWarning = () => {
  lastWarned = 0;
};
