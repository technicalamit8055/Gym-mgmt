import { gymDateOf, utcTimestamp } from '../clock.js';
import { all, get, run, tenantStorage } from '../db.js';
import { classRecording, cloudflarePlayable, playbackUrl } from './privateStream.js';
import { recordingToken } from './selfHostedStream.js';
import { finishRecording, recordingSize, removeRecording } from './serverRecording.js';

/**
 * Recorded lectures: each batch's library of classes to rewatch, by subject
 * and chapter — the student app's My Batches (routes/coaching/portal.js),
 * managed from the staff app's Recorded lectures (routes/coaching/recordings.js).
 *
 * A live class files its own recording the moment it ends (recordClass,
 * from endLiveSession), in the batch and subject it was taught to, and in
 * the chapter the subject's last lecture was in:
 *
 *   youtube     the class's unlisted broadcast, or a YouTube link a teacher
 *               typed in. Ready at once: YouTube keeps the broadcast as a
 *               video, at the same address, once it ends. One that never
 *               went on air is deleted from the channel, and its recording
 *               with it (dropYoutubeRecording, from youtube.js).
 *   cloudflare  a private class. 'processing' until Cloudflare has made the
 *               video, which takes a minute or so after the board stops:
 *               asked a few times in the background after the class, and
 *               again whenever someone opens a list it is on. Played with a
 *               link signed for each student, like the class itself.
 *   server      a private class this server carried, where the institute
 *               records them (Smartboards): copied to disk as it streamed
 *               (serverRecording.js), finished and ready at once. Played
 *               with a link signed for each student; deleted, files and
 *               all, after the institute's keep-for days.
 *   (none)      a self-hosted class with recording off keeps only the last
 *               half-minute (selfHostedStream.js), and a Zoom or Meet link is
 *               somebody else's — neither leaves a recording to file.
 *
 * Staff can also add a lecture recorded elsewhere as a link (source 'link'),
 * and rename, re-file, hide or delete any of them.
 */

/** How often a processing recording is asked about, at most. */
const CHECK_EVERY_MS = 60_000;
/** After the class, when Cloudflare is asked first. */
const CHECK_AFTER_MS = [90_000, 5 * 60_000, 20 * 60_000];
/** Nothing at Cloudflare this long after the class: the board never streamed. */
const NONE_AFTER_MS = 30 * 60_000;
/** Still processing after this long: something went wrong there. */
const GIVE_UP_MS = 48 * 60 * 60_000;
/** Watched this far, a lecture counts as done. */
export const COMPLETE_AT = 0.9;

const utcMs = (stamp) => Date.parse(`${String(stamp).replace(' ', 'T')}Z`);

/** What staff and students both see of a recording — never its video_ref. */
export const RECORDING_SELECT = `
  SELECT r.id, r.batch_id, r.subject_id, r.faculty_id, r.live_session_id, r.title, r.chapter, r.source, r.status,
         r.duration_sec, r.recorded_at, ${gymDateOf('r.recorded_at')} AS recorded_on, r.published, r.created_at,
         b.name AS batch_name, s.name AS subject_name, u.name AS faculty_name
  FROM class_recordings r
  JOIN academic_batches b ON b.id = r.batch_id
  LEFT JOIN academic_subjects s ON s.id = r.subject_id
  LEFT JOIN users u ON u.id = r.faculty_id
`;

/** The video id in a YouTube watch, youtu.be, /live/ or /embed/ link; null for anything else. */
export function youtubeVideoId(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  const id = host === 'youtu.be'
    ? u.pathname.slice(1)
    : ['youtube.com', 'youtube-nocookie.com'].includes(host)
      ? u.searchParams.get('v') || (/^\/(?:live|embed|shorts)\/([^/?#]+)/.exec(u.pathname) || [])[1]
      : null;
  return id && id !== 'live_stream' && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/* ── Filing a class ──────────────────────────────────────────────────── */

const pending = new Set();
function track(work) {
  pending.add(work);
  work.finally(() => pending.delete(work));
  return work;
}

/** Settles once every background check has (tests). */
export const recordingsIdle = () => Promise.allSettled([...pending]);

/**
 * Files an ended class's recording, if it left one. Called once the class
 * is marked ended; a class already filed is left as it is.
 *
 * @returns {number|null} the recording's id
 */
export function recordClass(sessionId) {
  const s = get(
    `SELECT ls.id, ls.batch_id, ls.subject_id, ls.faculty_id, ls.title, ls.stream_url, ls.cf_live_input_id,
            ls.started_at, ls.ended_at, ls.created_by, sub.name AS subject_name
     FROM live_sessions ls LEFT JOIN academic_subjects sub ON sub.id = ls.subject_id WHERE ls.id = ?`,
    [sessionId],
  );
  if (!s || get('SELECT 1 FROM class_recordings WHERE live_session_id = ?', [sessionId])) return null;

  // Recorded to this server's disk as it streamed: finished now, and ready at once.
  let server = null;
  try {
    server = finishRecording(tenantStorage.getStore().slug, sessionId);
  } catch (err) {
    console.error(`[recordings] could not finish the recording of class ${sessionId}:`, err.message);
  }
  const youtube = server || s.cf_live_input_id ? null : youtubeVideoId(s.stream_url);
  if (!server && !s.cf_live_input_id && !youtube) return null;

  // Lectures usually carry on where the last one left off.
  const chapter = get(
    'SELECT chapter FROM class_recordings WHERE batch_id = ? AND subject_id IS ? AND chapter IS NOT NULL ORDER BY recorded_at DESC, id DESC LIMIT 1',
    [s.batch_id, s.subject_id],
  )?.chapter ?? null;
  const startedAt = s.started_at ?? s.ended_at;
  // The class's own clock, until the player or Cloudflare says better; under
  // a minute is a class that was started and ended by mistake, not a length.
  const clocked = s.ended_at && s.started_at ? Math.round((utcMs(s.ended_at) - utcMs(s.started_at)) / 1000) : 0;
  // A server recording knows its own length exactly, from its segments.
  const seconds = server ? server.durationSec : clocked >= 60 ? clocked : null;
  const [source, ref, status] = server ? ['server', server.ref, 'ready'] : youtube ? ['youtube', youtube, 'ready'] : ['cloudflare', null, 'processing'];
  const info = run(
    `INSERT INTO class_recordings (batch_id, subject_id, faculty_id, live_session_id, title, chapter, source, video_ref, status, duration_sec, recorded_at, created_by, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.batch_id, s.subject_id, s.faculty_id, s.id, s.title || `${s.subject_name || 'Class'} lecture`, chapter, source, ref, status, seconds, startedAt, s.created_by, server?.sizeBytes ?? null],
  );
  const id = Number(info.lastInsertRowid);
  if (source === 'cloudflare') {
    for (const ms of CHECK_AFTER_MS) setTimeout(() => track(checkRecording(id)), ms).unref?.();
  }
  return id;
}

/** A broadcast that never went on air is deleted from the channel; so is its recording. */
export function dropYoutubeRecording(videoId) {
  run("DELETE FROM class_recordings WHERE source = 'youtube' AND video_ref = ? AND live_session_id IS NOT NULL", [videoId]);
}

/**
 * Asks Cloudflare whether a processing recording is ready. The check is
 * stamped before the call goes out, so two lists opened together ask once.
 */
export async function checkRecording(id) {
  const r = get(
    `SELECT r.status, r.source, r.created_at, ls.cf_live_input_id, ls.started_at, ls.ended_at
     FROM class_recordings r LEFT JOIN live_sessions ls ON ls.id = r.live_session_id WHERE r.id = ?`,
    [id],
  );
  if (!r || r.status !== 'processing' || r.source !== 'cloudflare') return;
  run('UPDATE class_recordings SET checked_at = ? WHERE id = ?', [utcTimestamp(), id]);
  const age = Date.now() - utcMs(r.created_at);
  if (!r.cf_live_input_id || !r.started_at) {
    run("UPDATE class_recordings SET status = 'failed' WHERE id = ?", [id]);
    return;
  }
  try {
    const found = await classRecording(r.cf_live_input_id, { from: r.started_at, to: r.ended_at ?? utcTimestamp() });
    if (found.state === 'ready') {
      run("UPDATE class_recordings SET status = 'ready', video_ref = ?, duration_sec = COALESCE(?, duration_sec) WHERE id = ? AND status = 'processing'", [found.uid, found.duration, id]);
    } else if ((found.state === 'none' && age > NONE_AFTER_MS) || age > GIVE_UP_MS) {
      run("UPDATE class_recordings SET status = 'failed' WHERE id = ? AND status = 'processing'", [id]);
    }
  } catch (err) {
    console.error(`[recordings] could not check recording ${id}:`, err.message);
  }
}

/**
 * Checks, in the background, the processing recordings in these batches
 * (every batch, for null) that have not been asked about for a minute.
 */
export function checkProcessing(batchIds = null) {
  if (batchIds && !batchIds.length) return;
  const scope = batchIds ? `AND batch_id IN (${batchIds.map(() => '?').join(', ')})` : '';
  const due = all(
    `SELECT id FROM class_recordings
     WHERE status = 'processing' AND source = 'cloudflare' AND (checked_at IS NULL OR checked_at < ?) ${scope}`,
    [utcTimestamp(-CHECK_EVERY_MS), ...(batchIds ?? [])],
  );
  for (const { id } of due) track(checkRecording(id));
}

/* ── Watching ────────────────────────────────────────────────────────── */

/**
 * The address the app plays, or null while there is nothing to play.
 * A server recording's link is signed for whoever asks (`viewerId`: a
 * student, or 0 for staff), and reached at `base`, this server's
 * /api/recording-hls as their app sees it.
 */
export function playUrl(id, { viewerId = 0, base = null } = {}) {
  const r = get('SELECT source, video_ref, status FROM class_recordings WHERE id = ?', [id]);
  if (!r || r.status !== 'ready') return null;
  if (r.source === 'youtube') return `https://www.youtube.com/watch?v=${r.video_ref}`;
  if (r.source === 'cloudflare') return cloudflarePlayable() ? playbackUrl(r.video_ref) : null;
  if (r.source === 'server') return base ? `${base}/${recordingToken(tenantStorage.getStore().slug, id, viewerId)}/master.m3u8` : null;
  return r.video_ref;
}

/** Whether the app has to ask for a fresh link now and then: the signed ones run out. */
export const signedSource = (source) => source === 'cloudflare' || source === 'server';

/* ── Keeping server recordings ───────────────────────────────────────── */

/** Whether the institute records the private classes this server carries, and for how long. */
export function recordingSettings() {
  const row = get('SELECT record_classes, recording_keep_days FROM coaching_settings WHERE id = 1');
  return { record_classes: Boolean(row?.record_classes), recording_keep_days: row?.recording_keep_days ?? 30 };
}

/** Deletes a recording, and its files if this server holds them. */
export function deleteRecording(id) {
  const r = get('SELECT source, video_ref FROM class_recordings WHERE id = ?', [id]);
  if (!r) return false;
  run('DELETE FROM class_recordings WHERE id = ?', [id]);
  if (r.source === 'server') removeRecording(tenantStorage.getStore().slug, r.video_ref);
  return true;
}

/**
 * Deletes server recordings past the institute's keep-for days (the hourly
 * sweep, server.js). Only 'server' ones: YouTube and Cloudflare keep their
 * own, and a link is somebody else's.
 *
 * @returns {number} how many went
 */
export function pruneServerRecordings({ now = Date.now() } = {}) {
  const { recording_keep_days: days } = recordingSettings();
  const cutoff = new Date(now - days * 24 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const old = all("SELECT id FROM class_recordings WHERE source = 'server' AND recorded_at < ?", [cutoff]);
  for (const { id } of old) deleteRecording(id);
  // A recording filed before sizes were kept is measured once, for the operator's storage card.
  const slug = tenantStorage.getStore().slug;
  for (const r of all("SELECT id, video_ref FROM class_recordings WHERE source = 'server' AND size_bytes IS NULL")) {
    run('UPDATE class_recordings SET size_bytes = ? WHERE id = ?', [recordingSize(slug, r.video_ref), r.id]);
  }
  return old.length;
}

/**
 * Where a student got to. Done stays done: rewatching the start of a
 * finished lecture does not take its tick away.
 *
 * The length the player reports is the video's own, which beats what is on
 * file for anything but Cloudflare (whose API says exactly): a class's
 * clock also counts the minutes before the board started streaming, and a
 * length typed in by staff is a guess. A minute out is close enough to keep.
 */
export function saveProgress(recordingId, memberId, { position, duration }) {
  const completed = duration > 0 && position >= duration * COMPLETE_AT ? 1 : 0;
  run(
    `INSERT INTO recording_progress (recording_id, member_id, position_sec, completed, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (recording_id, member_id) DO UPDATE SET
       position_sec = excluded.position_sec, completed = MAX(completed, excluded.completed), updated_at = excluded.updated_at`,
    [recordingId, memberId, Math.round(position), completed, utcTimestamp()],
  );
  if (duration > 0) {
    run(
      "UPDATE class_recordings SET duration_sec = ? WHERE id = ? AND source <> 'cloudflare' AND (duration_sec IS NULL OR abs(duration_sec - ?) > 60)",
      [Math.round(duration), recordingId, Math.round(duration)],
    );
  }
  return get('SELECT position_sec, completed, updated_at FROM recording_progress WHERE recording_id = ? AND member_id = ?', [recordingId, memberId]);
}

/** Lecture numbers within one subject's list, oldest first: "Lecture 12". */
export function numbered(recordings) {
  const order = [...recordings].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id - b.id);
  const number = new Map(order.map((r, i) => [r.id, i + 1]));
  return recordings.map((r) => ({ ...r, number: number.get(r.id) }));
}
