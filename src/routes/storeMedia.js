import { Router } from 'express';
import { notFound } from '../errors.js';
import { storeMediaPath } from '../monetization.js';

/**
 * Serves store product photos and banners to an `<img>`.
 *
 * Public for the same reasons as exercise media: one catalogue for every gym,
 * nothing private in it, and an image tag cannot send an Authorization header.
 * File names are content-addressed, so a URL never changes meaning and can be
 * cached for good.
 */
export const storeMediaRoutes = Router();

storeMediaRoutes.get('/:file', (req, res) => {
  const target = storeMediaPath(req.params.file);
  if (!target) throw notFound('No such file');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(target, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No such file' });
  });
});
