import { Router } from 'express';
import { notFound } from '../errors.js';
import { mediaFilePath } from '../exerciseCatalog.js';

/**
 * Serves exercise demo images, GIFs and clips to an `<img>` / `<video>`.
 *
 * Public on purpose, like the gym logos: the catalogue is the same for every
 * gym and carries nothing private, and a media tag cannot send an
 * Authorization header anyway. Files are content-addressed, so a URL never
 * changes meaning and can be cached for good.
 */
export const exerciseMediaRoutes = Router();

exerciseMediaRoutes.get('/:file', (req, res) => {
  const target = mediaFilePath(req.params.file);
  if (!target) throw notFound('No such file');

  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  // A muscle picture may be an SVG. Uploads are already refused if they carry
  // script (sniffSvg), but opened by its own URL an SVG is a document on this
  // origin, so it also gets a sandbox that runs nothing and loads nothing.
  if (target.endsWith('.svg')) {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  }
  res.sendFile(target, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No such file' });
  });
});
