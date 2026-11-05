import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { run } from '../../db.js';
import { conflict } from '../../errors.js';
import { parse } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { privateBackend, privateStreamConfigured, setStreamProvider, streamProvider } from '../../coaching/privateStream.js';
import { recordingSettings } from '../../coaching/recordings.js';
import { recordingRoom } from '../../recordingStorage.js';

/**
 * Where the institute's boards stream — YouTube, or privately through
 * CoachBook (src/coaching/privateStream.js) — and whether the private
 * classes this server carries are recorded, and kept for how long
 * (src/coaching/serverRecording.js). Managers only, like the YouTube
 * channel: it decides who can watch every class.
 */
export const streamingRoutes = Router();
streamingRoutes.use('/streaming', requireModule('live'), requireRole(...MANAGES_BILLING));

const status = () => ({
  provider: streamProvider(),
  private_configured: privateStreamConfigured(),
  // Recording to this server applies to its own private classes; Cloudflare records by itself.
  private_backend: privateBackend(),
  ...recordingSettings(),
  // The server's disk is nearly full: recordings are paused for every institute (recordingStorage.js).
  recording_paused: !recordingRoom(),
});

streamingRoutes.get('/streaming', (_req, res) => {
  res.json(status());
});

streamingRoutes.put('/streaming', (req, res) => {
  const body = parse(req.body, {
    provider: { type: 'enum', values: ['youtube', 'private'] },
    record_classes: { type: 'boolean' },
    recording_keep_days: { type: 'int', min: 1, max: 365 },
  });
  if (body.provider === 'private' && !privateStreamConfigured()) {
    throw conflict('Private streaming is not set up on this CoachBook server', { code: 'private_stream_not_configured' });
  }
  if (body.provider) setStreamProvider(body.provider);
  if (body.record_classes !== undefined) run('UPDATE coaching_settings SET record_classes = ? WHERE id = 1', [body.record_classes ? 1 : 0]);
  if (body.recording_keep_days !== undefined) run('UPDATE coaching_settings SET recording_keep_days = ? WHERE id = 1', [body.recording_keep_days]);
  res.json(status());
});
