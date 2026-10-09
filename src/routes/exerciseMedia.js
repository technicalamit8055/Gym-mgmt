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
  res.sendFile(target, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No such file' });
  });
});
