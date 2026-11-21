import crypto from 'node:crypto';
import express, { Router } from 'express';
import { readToken, signClaims } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { get, run, tenantStorage } from '../db.js';
import { MUSCLE_GROUPS } from '../muscles.js';
import { countTenants, findTenantByGymCode, findTenantBySlug, isValidSlug, tenantDbPath } from '../tenants.js';

/**
 * GymVym for ChatGPT (and any other MCP client): a remote MCP server at /mcp,
 * plus the OAuth 2.1 authorization server ChatGPT signs members in through.
 *
 * How the pieces fit:
 *
 * - ChatGPT finds the sign-in from /.well-known/oauth-protected-resource,
 *   registers itself at /oauth/register (dynamic client registration), and
 *   sends the member to /oauth/authorize, where they type their gym code and
 *   the same member ID/phone + password as the app.
 * - That sign-in goes through the real POST /api/portal/login, so it gets the
 *   app's rate limiting and password rules, and leaves a member_sessions row
 *   named "ChatGPT" on the member's Devices screen. Signing that device out
 *   cuts ChatGPT off on its next call.
 * - Every tool forwards to the member API over loopback with a `scope: 'mcp'`
 *   token, which requireMemberAuth (auth.js) accepts for only the handful of
 *   calls the tools make. All the validation, gating (fitness add-on, module
 *   switches, lapsed gyms) and business rules are the app's own, unchanged.
 *
 * Nothing here needs a table: client registrations, codes and tokens are all
 * signed claims (auth.js signClaims). Codes are one-time via an in-memory
 * set, which assumes one server process — true for this deployment.
 */
export const mcpRoutes = Router();

const BRAND = 'GymVym';
const SCOPE = 'workouts';
const ACCESS_TTL = 60 * 60; // an hour; ChatGPT refreshes on its own
const CODE_TTL = 5 * 60;
const CLIENT_TTL = 10 * 365 * 24 * 60 * 60;
const CONNECTOR_USER_AGENT = 'ChatGPT (GymVym connector)';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const now = () => Math.floor(Date.now() / 1000);

/** The public address ChatGPT reaches us at. MCP_PUBLIC_URL pins it when the
 * proxy in front doesn't pass the scheme through (TRUST_PROXY off). */
function publicOrigin(req) {
  if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** Where this same process answers, for the loopback calls into the member API. */
function internalOrigin(req) {
  if (process.env.MCP_INTERNAL_URL) return process.env.MCP_INTERNAL_URL.replace(/\/+$/, '');
  return `http://127.0.0.1:${req.socket.localPort}`;
}

const tenantPrefix = (slug) => (slug === DEFAULT_TENANT_SLUG ? '' : `/g/${slug}`);

function inTenant(slug, fn) {
  return tenantStorage.run(
    { slug, dbFile: slug === DEFAULT_TENANT_SLUG ? undefined : tenantDbPath(slug), businessType: 'gym' },
    fn,
  );
}

const sha256url = (text) => crypto.createHash('sha256').update(text).digest('base64url');

/* ── Discovery ────────────────────────────────────────────────────────── */

mcpRoutes.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
  const origin = publicOrigin(req);
  res.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: BRAND,
  });
});

mcpRoutes.get('/.well-known/oauth-authorization-server', (req, res) => {
  const origin = publicOrigin(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

/* ── Dynamic client registration (RFC 7591) ──────────────────────────── */

/** https anywhere, or http only back to this machine (local MCP inspectors). */
function acceptableRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

mcpRoutes.post('/oauth/register', (req, res) => {
  const body = req.body ?? {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length || redirectUris.length > 10 || !redirectUris.every(acceptableRedirect)) {
    return res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be https URLs (or http to localhost)',
    });
  }
  const clientName = String(body.client_name ?? 'ChatGPT').slice(0, 80);
  const issuedAt = now();
  const clientId = signClaims({ scope: 'mcp_client', name: clientName, redirect_uris: redirectUris, exp: issuedAt + CLIENT_TTL });
  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  });
});

function readClient(clientId) {
  const claims = readToken(clientId);
  return claims?.scope === 'mcp_client' ? claims : null;
}

/* ── Authorization: the sign-in page ─────────────────────────────────── */

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const AUTH_PARAMS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];

function page(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --text:#15171a; --muted:#5d6470; --line:#d9dce1; --accent:#1f6feb; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0f12; --card:#171a1f; --text:#eef0f3; --muted:#9aa3ae; --line:#2b3038; --accent:#4c8dff; --err:#ff8a80; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px 24px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p { margin:0 0 20px; color:var(--muted); font-size:14px; }
  label { display:block; font-size:14px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:12px; font-size:16px; border-radius:10px; border:1px solid var(--line); background:transparent; color:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:22px; padding:13px; font-size:16px; font-weight:600; border:0; border-radius:10px; background:var(--accent); color:#fff; cursor:pointer; }
  .err { color:var(--err); background:color-mix(in srgb, var(--err) 10%, transparent); padding:10px 12px; border-radius:10px; font-size:14px; margin-bottom:8px; }
  ul { margin:0 0 4px; padding-left:20px; color:var(--muted); font-size:14px; }
  .hint { font-size:13px; color:var(--muted); margin-top:6px; }
</style></head><body><main>${inner}</main></body></html>`;
}

function signInPage(res, params, client, { error, values = {} } = {}) {
  const hidden = AUTH_PARAMS.map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`).join('');
  const html = page(`Connect ${BRAND} to ${client.name}`, `
    <h1>Connect ${BRAND}</h1>
    <p><strong>${escapeHtml(client.name)}</strong> wants to use your ${BRAND} account to:</p>
    <ul><li>read your workouts, personal records and nutrition totals</li><li>create and edit your routines</li></ul>
    <p class="hint">It can't see your payments or profile, or change your password. You can disconnect it any time from Devices in the app.</p>
    ${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="gym_code">Gym code</label>
      <input id="gym_code" name="gym_code" autocomplete="off" autocapitalize="characters" value="${escapeHtml(values.gym_code)}" placeholder="e.g. IRN482">
      <div class="hint">The 6-character code you used to find your gym in the app.</div>
      <label for="identifier">Member ID or phone</label>
      <input id="identifier" name="identifier" autocomplete="username" required value="${escapeHtml(values.identifier)}">
      <label for="password">App password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in and connect</button>
    </form>`);
  return res.status(error ? 400 : 200).type('html').send(html);
}

function badAuthRequest(res, message) {
  return res.status(400).type('html').send(page('Cannot connect', `<h1>Cannot connect</h1><p>${escapeHtml(message)}</p>`));
}

/** Checks the request ChatGPT sent the member here with. Problems with the
 * client or redirect are shown on the page — redirecting an unverified URI
 * would make this an open redirector. */
function checkAuthRequest(params) {
  const client = readClient(params.client_id);
  if (!client) return { error: 'This connection request is not valid. Start again from ChatGPT.' };
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return { error: 'This connection request has an unexpected return address. Start again from ChatGPT.' };
  }
  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    return { error: 'This connection request is missing its security check (PKCE S256). Start again from ChatGPT.' };
  }
  return { client };
}

const authParamsOf = (source) => Object.fromEntries(AUTH_PARAMS.map((k) => [k, source[k] === undefined ? '' : String(source[k])]));

mcpRoutes.get('/oauth/authorize', (req, res) => {
  const params = authParamsOf(req.query);
  if (req.query.response_type !== 'code') return badAuthRequest(res, 'Only the authorization code flow is supported.');
  const { client, error } = checkAuthRequest(params);
  if (error) return badAuthRequest(res, error);
  return signInPage(res, params, client);
});

/** The gym a typed code names: a gym code ("IRN 482"), or its address slug as
 * a fallback. A single-gym install with no registry needs neither. */
function gymFromInput(input) {
  const typed = String(input ?? '').trim();
  if (!typed) return countTenants() === 0 ? { slug: DEFAULT_TENANT_SLUG } : null;
  const byCode = findTenantByGymCode(typed);
  if (byCode) return byCode;
  const slug = typed.toLowerCase();
  return isValidSlug(slug) ? findTenantBySlug(slug) ?? null : null;
}

mcpRoutes.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  const params = authParamsOf(req.body ?? {});
  const { client, error } = checkAuthRequest(params);
  if (error) return badAuthRequest(res, error);

  const values = { gym_code: String(req.body.gym_code ?? '').slice(0, 60), identifier: String(req.body.identifier ?? '').slice(0, 60) };
  const gym = gymFromInput(values.gym_code);
  if (!gym) return signInPage(res, params, client, { values, error: 'We could not find a gym with that code. Check the code shown in your app.' });

  // The app's own sign-in, so its rate limits and password rules apply as-is.
  let login;
  try {
    const response = await fetch(`${internalOrigin(req)}${tenantPrefix(gym.slug)}/api/portal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CONNECTOR_USER_AGENT, 'X-Forwarded-For': req.ip },
      body: JSON.stringify({ identifier: values.identifier, password: String(req.body.password ?? '').slice(0, 200) }),
    });
    login = { status: response.status, body: await response.json().catch(() => ({})) };
  } catch {
    return signInPage(res, params, client, { values, error: 'Something went wrong signing you in. Please try again.' });
  }
  if (login.status !== 200 || !login.body.token) {
    const message = login.body?.details?.reason === 'no_password'
      ? "You haven't set an app password yet. Set one in the GymVym app first, then come back."
      : login.body?.error || 'Sign-in failed. Please try again.';
    return signInPage(res, params, client, { values, error: message });
  }

  // The app's full member token is discarded here: ChatGPT only ever gets the
  // narrow `mcp` scope, bound to the session row that sign-in just created.
  const member = readToken(login.body.token);
  const code = signClaims({
    scope: 'mcp_code',
    jti: crypto.randomBytes(12).toString('base64url'),
    sub: member.sub,
    sid: member.sid,
    tenant: member.tenant,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    cc: params.code_challenge,
    exp: now() + CODE_TTL,
  });

  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  target.searchParams.set('iss', publicOrigin(req));
  return res.redirect(302, target.toString());
});

/* ── Token endpoint ──────────────────────────────────────────────────── */

const usedCodes = new Map(); // jti → exp
function claimCode(jti, exp) {
  const t = now();
  for (const [key, until] of usedCodes) if (until < t) usedCodes.delete(key);
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, exp);
  return true;
}

function issueTokens(grant) {
  const t = now();
  const base = { sub: grant.sub, member_id: grant.sub, sid: grant.sid, tenant: grant.tenant };
  // The session row is what keeps both alive: pushing its expiry out with
  // every refresh means a connector in regular use never has to sign in again.
  inTenant(grant.tenant, () =>
    run("UPDATE member_sessions SET expires_at = datetime(?, 'unixepoch'), last_seen_at = datetime('now') WHERE id = ?", [
      t + config.tokenTtlSeconds,
      grant.sid,
    ]),
  );
  return {
    access_token: signClaims({ scope: 'mcp', ...base, exp: t + ACCESS_TTL }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: signClaims({ scope: 'mcp_refresh', ...base, client_id: grant.client_id, exp: t + config.tokenTtlSeconds }),
    scope: SCOPE,
  };
}

const sessionAlive = (grant) =>
  inTenant(grant.tenant, () =>
    Boolean(get("SELECT 1 AS ok FROM member_sessions WHERE id = ? AND member_id = ? AND expires_at > datetime('now')", [grant.sid, grant.sub])),
  );

const tokenError = (res, error, description) => {
  res.set('Cache-Control', 'no-store');
  return res.status(400).json({ error, error_description: description });
};

mcpRoutes.post('/oauth/token', express.urlencoded({ extended: false, limit: '20kb' }), (req, res) => {
  const body = req.body ?? {};
  res.set('Cache-Control', 'no-store');

  if (body.grant_type === 'authorization_code') {
    const code = readToken(body.code);
    if (code?.scope !== 'mcp_code') return tokenError(res, 'invalid_grant', 'The code is invalid or has expired');
    if (body.client_id && body.client_id !== code.client_id) return tokenError(res, 'invalid_grant', 'The code was issued to another client');
    if (body.redirect_uri !== code.redirect_uri) return tokenError(res, 'invalid_grant', 'redirect_uri does not match');
    if (!body.code_verifier || sha256url(String(body.code_verifier)) !== code.cc) {
      return tokenError(res, 'invalid_grant', 'PKCE verification failed');
    }
    if (!claimCode(code.jti, code.exp)) return tokenError(res, 'invalid_grant', 'The code has already been used');
    if (!sessionAlive(code)) return tokenError(res, 'invalid_grant', 'The sign-in was revoked');
    return res.json(issueTokens(code));
  }

  if (body.grant_type === 'refresh_token') {
    const refresh = readToken(body.refresh_token);
    if (refresh?.scope !== 'mcp_refresh') return tokenError(res, 'invalid_grant', 'The refresh token is invalid or has expired');
    if (body.client_id && body.client_id !== refresh.client_id) return tokenError(res, 'invalid_grant', 'The token was issued to another client');
    if (!sessionAlive(refresh)) return tokenError(res, 'invalid_grant', 'This connection was signed out from the app');
    return res.json(issueTokens(refresh));
  }

  return tokenError(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
});

/* ── Tools ───────────────────────────────────────────────────────────── */

/** Demo media and coaching text the app shows beside an exercise: noise to a
 * model, and most of the bytes of a routine or session. */
const NOISE_KEYS = new Set(['media_url', 'media_type', 'instructions', 'secondary_muscles', 'member_id', 'thumbnail_url', 'image_url', 'video_url']);
function lean(value) {
  if (Array.isArray(value)) return value.map(lean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !NOISE_KEYS.has(k)).map(([k, v]) => [k, lean(v)]));
  }
  return value;
}

const EXERCISE_SCHEMA = {
  type: 'object',
  properties: {
    exercise_name: { type: 'string', description: 'Exact name from search_exercises where possible, so the app shows its demo and history.' },
    muscle_group: { type: 'string', enum: MUSCLE_GROUPS },
    target_sets: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
    target_reps: { type: 'string', description: 'A number or range, e.g. "8-12" or "5".', default: '8-12' },
    target_rpe: { type: 'number', minimum: 1, maximum: 10 },
    rest_seconds: { type: 'integer', minimum: 0, maximum: 900, default: 90 },
    notes: { type: 'string', maxLength: 300 },
  },
  required: ['exercise_name'],
};

const ROUTINE_FIELDS = {
  name: { type: 'string', minLength: 2, maxLength: 100 },
  description: { type: 'string', maxLength: 1000 },
  days: {
    type: 'array',
    minItems: 1,
    maxItems: 7,
    description: 'Each training day of the routine, in order.',
    items: {
      type: 'object',
      properties: {
        day_name: { type: 'string', maxLength: 120, description: 'e.g. "Push", "Day 1 – Upper"' },
        notes: { type: 'string', maxLength: 500 },
        exercises: { type: 'array', minItems: 1, maxItems: 30, items: EXERCISE_SCHEMA },
      },
      required: ['day_name', 'exercises'],
    },
  },
};

const READ = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const status = (invoking, invoked) => ({ 'openai/toolInvocation/invoking': invoking, 'openai/toolInvocation/invoked': invoked });
const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};

/** Each tool: its MCP descriptor, and what it does with the member API. */
const TOOLS = [
  {
    name: 'get_workout_history',
    title: 'Workout history',
    description: "The member's logged workout sessions, newest first, with duration, volume, sets, reps and PR count, plus lifetime totals. Use for questions about consistency, frequency or progress over time.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
        since: { type: 'string', description: 'Only sessions on or after this date (YYYY-MM-DD).' },
      },
    },
    annotations: READ,
    _meta: status('Reading your workouts…', 'Read your workouts'),
    async run(call, args) {
      const data = await call('GET', `/workouts/logs${qs({ limit: args.limit })}`);
      const items = data.items
        .filter((l) => !args.since || l.log_date >= args.since)
        .map((l) => ({
          id: l.id,
          workout_name: l.workout_name,
          log_date: l.log_date,
          duration_minutes: Math.round(l.duration_seconds / 60),
          total_volume_kg: l.total_volume_kg,
          total_sets: l.total_sets,
          total_reps: l.total_reps,
          pr_count: l.pr_count,
          notes: l.notes,
        }));
      return { workouts: items, lifetime: data.stats };
    },
  },
  {
    name: 'get_workout',
    title: 'Workout details',
    description: 'One logged session with every set (exercise, weight in kg, reps, set type) and the records it set. Get ids from get_workout_history.',
    inputSchema: { type: 'object', properties: { workout_id: { type: 'integer', minimum: 1 } }, required: ['workout_id'] },
    annotations: READ,
    _meta: status('Opening workout…', 'Opened workout'),
    run: (call, args) => call('GET', `/workouts/logs/${Number(args.workout_id)}`),
  },
  {
    name: 'get_personal_records',
    title: 'Personal records',
    description: "The member's best lift per exercise (heaviest weight, reps, estimated 1RM in kg), strongest first.",
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    _meta: status('Reading your PRs…', 'Read your PRs'),
    async run(call) {
      return { records: (await call('GET', '/workouts/prs')).items };
    },
  },
  {
    name: 'get_exercise_progress',
    title: 'Exercise progress',
    description: 'Every session one exercise appeared in, with its sets and the all-time bests — for questions like "how is my bench progressing?".',
    inputSchema: { type: 'object', properties: { exercise_name: { type: 'string', maxLength: 120 } }, required: ['exercise_name'] },
    annotations: READ,
    _meta: status('Checking progress…', 'Checked progress'),
    run: (call, args) => call('GET', `/workouts/exercise-history${qs({ name: args.exercise_name })}`),
  },
  {
    name: 'search_exercises',
    title: 'Search exercises',
    description: "Searches the gym's exercise library by name and/or muscle group, with the member's last set of each. Use it to pick exact exercise names before creating a routine.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 60 },
        muscle_group: { type: 'string', enum: MUSCLE_GROUPS },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    },
    annotations: READ,
    _meta: status('Searching exercises…', 'Searched exercises'),
    async run(call, args) {
      const data = await call('GET', `/workouts/exercises${qs({ q: args.query, muscle_group: args.muscle_group })}`);
      return {
        exercises: data.items.slice(0, args.limit ?? 25).map((e) => ({
          name: e.name,
          muscle_group: e.muscle_group,
          equipment: e.equipment,
          last_set: e.previous ?? null,
        })),
      };
    },
  },
  {
    name: 'get_current_workout',
    title: "Today's workout",
    description: "The routine the member is following (their own or their trainer's), which day is up next, and their last session.",
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    _meta: status("Checking today's workout…", "Checked today's workout"),
    async run(call) {
      const d = await call('GET', '/workouts/current');
      return { source: d.source, plan: d.plan, today_day: d.today_day, sessions_logged: d.sessions_logged, last_workout: d.last_workout };
    },
  },
  {
    name: 'list_routines',
    title: 'List routines',
    description: "The member's own routines, which one is active, and their trainer's assigned plan if any.",
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    _meta: status('Reading routines…', 'Read routines'),
    run: (call) => call('GET', '/workouts/routines'),
  },
  {
    name: 'get_routine',
    title: 'Routine details',
    description: 'One of the member\'s own routines with every day and exercise target.',
    inputSchema: { type: 'object', properties: { routine_id: { type: 'integer', minimum: 1 } }, required: ['routine_id'] },
    annotations: READ,
    _meta: status('Opening routine…', 'Opened routine'),
    run: (call, args) => call('GET', `/workouts/routines/${Number(args.routine_id)}`),
  },
  {
    name: 'create_routine',
    title: 'Save new routine',
    description: "Saves a new routine to the member's GymVym account, ready to train from in the app. Prefer exact names from search_exercises. Set activate=true to make it the routine the Workout tab follows. Members can keep up to 20 routines.",
    inputSchema: {
      type: 'object',
      properties: { ...ROUTINE_FIELDS, activate: { type: 'boolean', default: false } },
      required: ['name', 'days'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: status('Saving routine to GymVym…', 'Saved routine to GymVym'),
    run: (call, args) =>
      call('POST', '/workouts/routines', { name: args.name, description: args.description, days: args.days, activate: Boolean(args.activate) }),
  },
  {
    name: 'update_routine',
    title: 'Update routine',
    description: "Replaces one of the member's own routines with the given name, description and full list of days (send every day, not just the changed ones — call get_routine first). Trainer-assigned plans cannot be edited.",
    inputSchema: {
      type: 'object',
      properties: { routine_id: { type: 'integer', minimum: 1 }, ...ROUTINE_FIELDS },
      required: ['routine_id', 'name', 'days'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: status('Updating routine…', 'Updated routine'),
    run: (call, args) =>
      call('PUT', `/workouts/routines/${Number(args.routine_id)}`, { name: args.name, description: args.description, days: args.days }),
  },
  {
    name: 'get_nutrition_summary',
    title: 'Nutrition summary',
    description: 'Daily calories, protein, carbs, fats, fibre, sugar and water the member logged, against their targets and calories burned, for up to 31 days.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 31, default: 7 },
        end: { type: 'string', description: 'Last day to include (YYYY-MM-DD); defaults to today.' },
      },
    },
    annotations: READ,
    _meta: status('Reading nutrition…', 'Read nutrition'),
    run: (call, args) => call('GET', `/diets/summary${qs({ days: args.days, end: args.end })}`),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const SECURITY = [{ type: 'oauth2', scopes: [SCOPE] }];
const toolDescriptors = () =>
  TOOLS.map(({ run: _run, ...descriptor }) => ({ ...descriptor, securitySchemes: SECURITY, _meta: { ...descriptor._meta, securitySchemes: SECURITY } }));

class ToolError extends Error {}

/** A member-API caller bound to one ChatGPT token. */
function memberApi(req, token, grant) {
  const root = `${internalOrigin(req)}${tenantPrefix(grant.tenant)}/api/portal`;
  return async (method, path, body) => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': CONNECTOR_USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const details = data?.details && typeof data.details === 'object' ? ` ${JSON.stringify(data.details)}` : '';
      throw new ToolError(`${data?.error || `Request failed (${response.status})`}${details}`);
    }
    return data;
  };
}

/* ── MCP over Streamable HTTP (stateless, JSON responses) ────────────── */

const INSTRUCTIONS = `${BRAND} is the member app of the user's gym. These tools read the signed-in member's own workout log, personal records and nutrition, and save routines straight into their ${BRAND} account. Weights are in kg. Before create_routine, use search_exercises to match exercise names to the gym's library. Only call create_routine or update_routine when the user asked to save or change a routine.`;

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(req, msg, token, grant) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gymvym', title: BRAND, version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: toolDescriptors() });
    case 'resources/list':
      return rpcResult(msg.id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(msg.id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(msg.id, { prompts: [] });
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try {
        const data = lean(await tool.run(memberApi(req, token, grant), args));
        return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (err) {
        const text = err instanceof ToolError ? err.message : 'GymVym could not complete that request. Please try again.';
        return rpcResult(msg.id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function challenge(req, res, description) {
  res.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource", scope="${SCOPE}", error="invalid_token", error_description="${description}"`,
  );
  return res.status(401).json(rpcError(null, -32001, description));
}

mcpRoutes.post('/mcp', async (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const grant = readToken(token);
  if (grant?.scope !== 'mcp') return challenge(req, res, 'Sign in to GymVym to continue');
  if (!sessionAlive(grant)) return challenge(req, res, 'This connection was signed out from the app');

  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((m) => handleMessage(req, m, token, grant)))).filter(Boolean);
      return replies.length ? res.json(replies) : res.status(202).end();
    }
    const reply = await handleMessage(req, body, token, grant);
    return reply ? res.json(reply) : res.status(202).end();
  } catch (err) {
    return next(err);
  }
});

// Stateless server: no server-initiated stream and no session to end.
mcpRoutes.all('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed')));
