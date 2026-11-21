import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { giveMemberPassword } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-mcp-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb, findTenantBySlug } = await import('../src/tenants.js');

const TENANT = 'mcpgym';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
let base;
let server;
let staffToken;
let memberCode;
let gymCode;

const call = async (method, urlPath, body, { token, tenant = TENANT } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
};

const form = (urlPath, fields) =>
  fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

let rpcId = 0;
const rpc = async (token, method, params) => {
  rpcId += 1;
  return call('POST', '/mcp', { jsonrpc: '2.0', id: rpcId, method, params }, { token, tenant: null });
};

/** The whole ChatGPT connect flow: register, sign in on our page, swap the code. */
async function connect({ password = 'member-pass-123', code = gymCode } = {}) {
  const reg = await call('POST', '/oauth/register', { client_name: 'ChatGPT', redirect_uris: [REDIRECT] }, { tenant: null });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const auth = {
    client_id: reg.body.client_id,
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'workouts',
    resource: `${base}/mcp`,
  };
  const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...auth, response_type: 'code' })}`);
  assert.equal(page.status, 200);
  const signIn = await form('/oauth/authorize', { ...auth, gym_code: code, identifier: memberCode, password });
  if (signIn.status !== 302) return { failed: await signIn.text() };
  const back = new URL(signIn.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const exchange = { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier };
  const tokens = await form('/oauth/token', exchange);
  return { tokens: await tokens.json(), status: tokens.status, exchange, clientId: reg.body.client_id };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'MCP Gym',
    admin_name: 'Owner',
    admin_email: 'owner@mcpgym.test',
    admin_password: 'ownerpass123',
  }, { tenant: null });
  gymCode = findTenantBySlug(TENANT).gym_code;
  staffToken = (await call('POST', '/api/auth/login', { email: 'owner@mcpgym.test', password: 'ownerpass123' })).body.token;
  const member = await call('POST', '/api/members', { first_name: 'Rahul', phone: '9876543210' }, { token: staffToken });
  memberCode = member.body.code;
  const plans = (await call('GET', '/api/plans', undefined, { token: staffToken })).body.items;
  await call('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plans[0].id }, { token: staffToken });
  await call('POST', '/api/fitness-addons/subscribe', { member_id: member.body.id, months: 1, method: 'cash' }, { token: staffToken });
  await giveMemberPassword(call, { staffToken, memberId: member.body.id });
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GymVym for ChatGPT (MCP)', () => {
  let tokens;
  let exchange;
  let clientId;

  it('points an unauthenticated client at the OAuth metadata', async () => {
    const res = await rpc(null, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
    const resource = await call('GET', '/.well-known/oauth-protected-resource', undefined, { tenant: null });
    assert.equal(resource.body.resource, `${base}/mcp`);
    const as = await call('GET', '/.well-known/oauth-authorization-server', undefined, { tenant: null });
    assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
    assert.equal(as.body.registration_endpoint, `${base}/oauth/register`);
  });

  it('refuses unregistered redirect addresses without redirecting', async () => {
    const reg = await call('POST', '/oauth/register', { redirect_uris: ['http://evil.example/cb'] }, { tenant: null });
    assert.equal(reg.status, 400);
    const ok = await call('POST', '/oauth/register', { redirect_uris: [REDIRECT] }, { tenant: null });
    const res = await fetch(`${base}/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: ok.body.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    assert.equal(res.status, 400);
  });

  it('shows a wrong password on the sign-in page', async () => {
    const result = await connect({ password: 'nope-nope-nope' });
    assert.match(result.failed, /Incorrect password/);
  });

  it('connects with gym code + app login and swaps the code once', async () => {
    ({ tokens, exchange, clientId } = await connect());
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token && tokens.refresh_token);
    const again = await form('/oauth/token', exchange);
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error, 'invalid_grant');
  });

  it('lists tools after initialize', async () => {
    const init = await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    const list = await rpc(tokens.access_token, 'tools/list');
    const names = list.body.result.tools.map((t) => t.name);
    assert.ok(names.includes('create_routine') && names.includes('get_workout_history'));
  });

  it('saves a routine into the member account and reads it back', async () => {
    const created = await rpc(tokens.access_token, 'tools/call', {
      name: 'create_routine',
      arguments: {
        name: 'ChatGPT PPL',
        activate: true,
        days: [
          { day_name: 'Push', exercises: [{ exercise_name: 'Bench Press', muscle_group: 'chest', target_sets: 4, target_reps: '6-8' }] },
          { day_name: 'Pull', exercises: [{ exercise_name: 'Barbell Row', muscle_group: 'lats' }] },
        ],
      },
    });
    assert.equal(created.body.result.isError, undefined, JSON.stringify(created.body));
    assert.equal(created.body.result.structuredContent.days.length, 2);

    const routines = await rpc(tokens.access_token, 'tools/call', { name: 'list_routines', arguments: {} });
    const item = routines.body.result.structuredContent.items.find((r) => r.name === 'ChatGPT PPL');
    assert.ok(item);
    assert.equal(routines.body.result.structuredContent.active.plan_id, item.id);
  });

  it('turns app validation errors into tool errors the model can fix', async () => {
    const res = await rpc(tokens.access_token, 'tools/call', {
      name: 'create_routine',
      arguments: { name: 'Bad', days: [{ day_name: 'Legs', exercises: [{ exercise_name: 'Squat', target_sets: 99 }] }] },
    });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /target_sets/);
  });

  it('keeps the ChatGPT token out of the rest of the member API', async () => {
    assert.equal((await call('GET', '/api/portal/workouts/prs', undefined, { token: tokens.access_token })).status, 200);
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: tokens.access_token })).status, 401);
    assert.equal((await call('GET', '/api/portal/sessions', undefined, { token: tokens.access_token })).status, 401);
  });

  it('refreshes, and is cut off when the member signs ChatGPT out from Devices', async () => {
    const refreshed = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    assert.equal(refreshed.status, 200);
    const fresh = await refreshed.json();
    assert.equal((await rpc(fresh.access_token, 'ping')).status, 200);

    const phone = (await call('POST', '/api/portal/login', { identifier: memberCode, password: 'member-pass-123' })).body.token;
    const sessions = (await call('GET', '/api/portal/sessions', undefined, { token: phone })).body.sessions;
    const chatgpt = sessions.find((s) => s.device === 'ChatGPT');
    assert.ok(chatgpt, JSON.stringify(sessions));
    assert.equal((await call('DELETE', `/api/portal/sessions/${chatgpt.id}`, undefined, { token: phone })).status, 200);

    assert.equal((await rpc(fresh.access_token, 'ping')).status, 401);
    const denied = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: fresh.refresh_token });
    assert.equal(denied.status, 400);
  });
});
