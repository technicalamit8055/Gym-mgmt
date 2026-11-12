import { Router } from 'express';
import {
  marketingBrandFor,
  marketingShellHtml,
  onPlatformRoot,
  publicOrigin,
  robotsTxt,
  sitemapXml,
} from '../marketing.js';

/**
 * The platform's marketing pages and the files crawlers ask for first (see
 * src/marketing.js). Mounted after the API and ahead of express.static, so
 * "/" here wins over public/index.html — but only on the platform's root.
 * Under any gym's address each handler steps aside, and "/" stays that gym's
 * app shell.
 */
export const marketingRoutes = Router();

marketingRoutes.get(['/', '/library'], (req, res, next) => {
  if (!onPlatformRoot(req)) return next();
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(marketingShellHtml(marketingBrandFor(req), { origin: publicOrigin(req) }));
});

marketingRoutes.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(robotsTxt({ origin: publicOrigin(req), root: onPlatformRoot(req) }));
});

marketingRoutes.get('/sitemap.xml', (req, res) => {
  if (!onPlatformRoot(req)) return res.status(404).type('text/plain').send('No sitemap here');
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(sitemapXml({ origin: publicOrigin(req) }));
});
