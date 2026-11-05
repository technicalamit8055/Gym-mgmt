import { Router } from 'express';
import { get, tenantStorage } from '../../db.js';
import { notFound } from '../../errors.js';
import { checkRecordingToken, checkWatchToken, getFile } from '../../coaching/selfHostedStream.js';
import { recordingFile } from '../../coaching/serverRecording.js';

/**
 * A private class's video, as students' players fetch it
 * (/api/live-hls/<watch token>/<file>; src/coaching/selfHostedStream.js).
 *
 * No sign-in here: hls.js, and iOS's own player, fetch every playlist and
 * segment without the app's Authorization header. The watch token — signed
 * for one student and one class, and short-lived — is the credential, and
 * it is in the path, so the playlists' relative links carry it along.
 */
export const liveHlsRoutes = Router();

liveHlsRoutes.get('/:token/:file', (req, res) => {
  const { slug } = tenantStorage.getStore();
  const sessionId = checkWatchToken(slug, req.params.token);
  const file = sessionId ? getFile(slug, sessionId, req.params.file) : null;
  // One answer for a bad token, an ended class and a segment past the window.
  if (!file) throw notFound('Not found');
  // Playlists change every two seconds; a segment never does.
  res.set('Cache-Control', file.type === 'application/vnd.apple.mpegurl' ? 'no-store' : 'private, max-age=60');
  res.type(file.type).send(file.body);
});

/**
 * A recorded lecture this server holds (/api/recording-hls/<token>/<file>;
 * src/coaching/serverRecording.js), on the same terms: a signed link per
 * viewer is the credential. The recording has to still be filed and shown
 * — one staff hid or deleted stops playing at once, whatever links are out.
 */
export const recordingHlsRoutes = Router();

recordingHlsRoutes.get('/:token/:file', (req, res) => {
  const { slug } = tenantStorage.getStore();
  const id = checkRecordingToken(slug, req.params.token);
  const recording = id ? get("SELECT video_ref, published FROM class_recordings WHERE id = ? AND source = 'server' AND status = 'ready'", [id]) : null;
  const file = recording?.published ? recordingFile(slug, recording.video_ref, req.params.file) : null;
  if (!file) throw notFound('Not found');
  const playlist = file.endsWith('.m3u8');
  res.set('Cache-Control', playlist ? 'private, no-cache' : 'private, max-age=86400');
  res.type(playlist ? 'application/vnd.apple.mpegurl' : 'video/mp2t').sendFile(file);
});
