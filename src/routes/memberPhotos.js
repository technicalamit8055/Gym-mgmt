import { Router } from 'express';
import { notFound, unauthorized } from '../errors.js';
import { getMemberPhoto, verifyPhotoUrl } from '../photo.js';

/**
 * Serves member photo bytes to an `<img src>`.
 *
 * Deliberately not behind requireAuth: an image tag cannot send an
 * Authorization header, so the URL authenticates itself instead — see
 * memberPhotoUrl() in src/photo.js. Only this app can mint one, it names a
 * single member of a single gym, and it stops working after twelve hours.
 */
export const memberPhotoRoutes = Router();

memberPhotoRoutes.get('/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId)) throw notFound('No such photo');
  if (!verifyPhotoUrl(memberId, req.query)) {
    throw unauthorized('That photo link is no longer valid — reload the page');
  }

  const photo = getMemberPhoto(memberId);
  if (!photo) throw notFound('No such photo');

  res.set('Content-Type', photo.mime);
  // The URL carries a version, so these bytes can never change underneath it:
  // a new photo is a new URL. `private` keeps it out of any shared cache,
  // since a member's photo is theirs.
  res.set('Cache-Control', 'private, max-age=604800, immutable');
  res.set('Content-Disposition', 'inline');
  res.send(Buffer.from(photo.bytes));
});
