import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { DEFAULT_TENANT_SLUG } from '../../config.js';
import { tenantStorage } from '../../db.js';
import { conflict } from '../../errors.js';
import { findTenantBySlug, tenantDbPath } from '../../tenants.js';
import { requireModule } from '../../verticals.js';
import {
  completeSignIn, disconnect, parseState, signInUrl, takeSignIn, youtubeConfigured, youtubeStatus,
} from '../../coaching/youtube.js';

/* ── The channel, for managers (/api/coaching/youtube) ───────────────── */

/**
 * Connecting the institute's YouTube channel — managers only, like adding a
 * board: whoever connects it lets every board stream to that channel.
 */
export const youtubeRoutes = Router();
youtubeRoutes.use('/youtube', requireModule('live'), requireRole(...MANAGES_BILLING));

youtubeRoutes.get('/youtube', (_req, res) => {
  res.json(youtubeStatus());
});

/**
 * Where to send the manager's browser to sign in. They come back to the
 * address they started from — built here from the request, never taken from
 * the client, so the callback cannot be turned into an open redirect.
 */
youtubeRoutes.post('/youtube/connect', (req, res) => {
  if (!youtubeConfigured()) throw conflict('YouTube sign-in is not set up on this server', { code: 'youtube_not_configured' });
  const returnUrl = `${req.protocol}://${req.get('host')}${req.tenantPathPrefix || ''}/`;
  res.json({ url: signInUrl({ userId: req.user.id, returnUrl }) });
});

youtubeRoutes.delete('/youtube', async (_req, res) => {
  await disconnect();
  res.json(youtubeStatus());
});

/* ── Google's callback (/api/youtube/callback) ───────────────────────── */

/** Why a sign-in did not finish, as the Smartboards page explains it. */
const OUTCOME = { scope_denied: 'scope', no_channel: 'no_channel', access_denied: 'denied' };

function plainPage(res, status, message) {
  res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>YouTube</title><p style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">${message}</p>`);
}

/**
 * One fixed address for every institute (Google allows no wildcards), so it
 * is mounted before resolveTenant and finds its institute from the state.
 * The state's nonce, matched once against the hash stored when a manager
 * started the sign-in, is the proof; anything else gets a dead end.
 */
export async function handleYoutubeCallback(req, res) {
  const parsed = parseState(req.query.state);
  const tenant = parsed && parsed.slug !== DEFAULT_TENANT_SLUG ? findTenantBySlug(parsed.slug) : null;
  if (!parsed || (!tenant && parsed.slug !== DEFAULT_TENANT_SLUG) || tenant?.status === 'cancelled') {
    return plainPage(res, 400, 'This YouTube sign-in link is not valid. Start again from Smartboards in CoachBook.');
  }
  const store = tenant
    ? { slug: tenant.slug, dbFile: tenantDbPath(tenant.slug), timezone: tenant.timezone || undefined, businessType: tenant.business_type || 'gym' }
    : { slug: DEFAULT_TENANT_SLUG, dbFile: undefined, businessType: 'coaching' };

  return tenantStorage.run(store, async () => {
    const signIn = takeSignIn(parsed.nonce);
    if (!signIn) return plainPage(res, 400, 'This YouTube sign-in has expired. Start again from Smartboards in CoachBook.');
    const back = (outcome) => res.redirect(303, `${signIn.return_url}?youtube=${outcome}#/smartboards`);
    if (req.query.error) return back(OUTCOME[req.query.error] ?? 'failed');
    try {
      await completeSignIn({ code: String(req.query.code ?? ''), userId: signIn.user_id });
      return back('connected');
    } catch (err) {
      console.error('[youtube] sign-in failed:', err.message);
      return back(OUTCOME[err.reason] ?? 'failed');
    }
  });
}
