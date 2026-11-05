import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Recording a private class this server carries (selfHostedStream.js), to
 * disk, as it streams. Kept apart from the database: recordings.js files
 * the finished recording in the batch's lecture library.
 *
 * The board uploads every quality; the recording keeps 480p and 360p
 * (KEEP_HEIGHTS) — about 0.8 GB an hour, half of all three, and still a
 * choice in the player. Each segment is copied from the live window when a
 * playlist naming it arrives (so its length is known), and listed in a
 * running playlist per quality, `v<height>.part`.
 *
 * A board that restarts its stream (or a server restart, which makes it)
 * starts a new run: its segments are prefixed `r<run>_`, so names never
 * clash, and the playlists mark the join with a discontinuity. When the
 * class ends, finishRecording writes the playlists out as a finished video
 * (VOD HLS) beside a master playlist, and the player plays it like any
 * other private stream.
 *
 *   <recordingsDir>/<slug>/session-<id>/
 *     streams.json       the kept qualities, from the board's master playlist
 *     runs               how many runs so far
 *     v480.part …        while recording
 *     master.m3u8, v480.m3u8, v360.m3u8, r1_stream_1_00000.ts …   once finished
 */

export const KEEP_HEIGHTS = [480, 360];
const REF = /^session-\d+$/;
const FILE = /^[\w.-]{1,80}$/;

const slugDir = (slug) => path.join(config.recordingsDir, slug);
export const recordingRef = (sessionId) => `session-${sessionId}`;
const dirOf = (slug, ref) => path.join(slugDir(slug), ref);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/**
 * Starts (or carries on) recording a class: one run of the board's stream.
 * selfHostedStream.js calls `master` and `playlist` as the board uploads.
 */
export function createRecorder(slug, sessionId) {
  const dir = dirOf(slug, recordingRef(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  const runFile = path.join(dir, 'runs');
  const run = (Number(readJson(runFile, 0)) || 0) + 1;
  fs.writeFileSync(runFile, String(run));
  /** variant index → height, from this run's master playlist */
  let heights = null;
  /** per variant: segments already recorded, and whether this run has written to it yet */
  const seen = new Map();

  return {
    /** The board's master playlist: which variant is which quality. */
    master(text) {
      const found = new Map();
      const kept = readJson(path.join(dir, 'streams.json'), {});
      const lines = String(text).split(/\r?\n/);
      lines.forEach((line, i) => {
        const height = /^#EXT-X-STREAM-INF:.*RESOLUTION=\d+x(\d+)/.exec(line)?.[1];
        const variant = /^stream_(\d+)\.m3u8$/.exec(lines[i + 1] ?? '')?.[1];
        if (!height || variant === undefined) return;
        found.set(Number(variant), Number(height));
        if (KEEP_HEIGHTS.includes(Number(height))) kept[height] = line;
      });
      heights = found;
      fs.writeFileSync(path.join(dir, 'streams.json'), JSON.stringify(kept));
    },

    /**
     * One variant's live playlist: copies the segments it names that are
     * new, from `segment(name)` (the live window), and lists them.
     */
    playlist(name, text, segment) {
      const variant = /^stream_(\d+)\.m3u8$/.exec(name)?.[1];
      // Before the master arrives the heights are unknown; the segments are
      // still in the live window when the next playlist names them.
      if (variant === undefined || !heights) return;
      const height = heights.get(Number(variant));
      if (!KEEP_HEIGHTS.includes(height)) return;
      const state = seen.get(height) ?? { names: new Set(), started: false };
      seen.set(height, state);
      const part = path.join(dir, `v${height}.part`);
      const lines = String(text).split(/\r?\n/);
      lines.forEach((line, i) => {
        const duration = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
        const file = lines[i + 1];
        if (!duration || !file || !FILE.test(file) || state.names.has(file)) return;
        const bytes = segment(file);
        if (!bytes) return;
        const stored = `r${run}_${file}`;
        fs.writeFileSync(path.join(dir, stored), bytes);
        // The join between two runs: timestamps and numbering start again.
        const join = !state.started && fs.existsSync(part) && fs.statSync(part).size > 0 ? '#EXT-X-DISCONTINUITY\n' : '';
        fs.appendFileSync(part, `${join}#EXTINF:${duration},\n${stored}\n`);
        state.started = true;
        state.names.add(file);
      });
    },
  };
}

/**
 * Turns a class's running playlists into a finished video. Null if it
 * recorded nothing (the board never streamed, or recording was off), in
 * which case anything half-made is removed.
 *
 * @returns {{ ref: string, durationSec: number, sizeBytes: number } | null}
 */
export function finishRecording(slug, sessionId) {
  const ref = recordingRef(sessionId);
  const dir = dirOf(slug, ref);
  if (!fs.existsSync(dir)) return null;
  const kept = readJson(path.join(dir, 'streams.json'), {});
  const qualities = KEEP_HEIGHTS.filter((height) => kept[height] && fs.existsSync(path.join(dir, `v${height}.part`)));
  if (!qualities.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  let durationSec = 0;
  for (const height of qualities) {
    const body = fs.readFileSync(path.join(dir, `v${height}.part`), 'utf8');
    const lengths = [...body.matchAll(/^#EXTINF:([\d.]+)/gm)].map((m) => Number(m[1]));
    durationSec = Math.max(durationSec, lengths.reduce((a, b) => a + b, 0));
    fs.writeFileSync(path.join(dir, `v${height}.m3u8`), [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(2, ...lengths))}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `${body.trimEnd()}`,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'));
    fs.rmSync(path.join(dir, `v${height}.part`));
  }
  fs.writeFileSync(path.join(dir, 'master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    ...qualities.flatMap((height) => [kept[height], `v${height}.m3u8`]),
    '',
  ].join('\n'));
  return { ref, durationSec: Math.round(durationSec), sizeBytes: recordingSize(slug, ref) };
}

/** A finished recording's file, as an absolute path — or null for anything else. */
export function recordingFile(slug, ref, name) {
  if (!REF.test(String(ref)) || !FILE.test(String(name)) || name.endsWith('.part') || name === 'runs' || name === 'streams.json') return null;
  const file = path.join(dirOf(slug, ref), name);
  return fs.existsSync(file) ? file : null;
}

/** The bytes a recording takes on disk; 0 for one already gone. */
export function recordingSize(slug, ref) {
  if (!REF.test(String(ref))) return 0;
  const dir = dirOf(slug, ref);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
}

/** Deletes a recording's files; a no-op for one already gone. */
export function removeRecording(slug, ref) {
  if (!REF.test(String(ref))) return;
  fs.rmSync(dirOf(slug, ref), { recursive: true, force: true });
}
