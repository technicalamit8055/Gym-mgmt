import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-biometric-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

/* ── Minimal CBOR encoder (just enough to build attestation objects and
   COSE public keys — no need to pull in a CBOR library for a test) ────── */

function cborHead(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  const buf = Buffer.alloc(3);
  buf[0] = (major << 5) | 25;
  buf.writeUInt16BE(len, 1);
  return buf;
}
const cborUint = (n) => cborHead(0, n);
const cborNegint = (n) => cborHead(1, -n - 1);
const cborInt = (n) => (n >= 0 ? cborUint(n) : cborNegint(n));
const cborBytes = (buf) => Buffer.concat([cborHead(2, buf.length), buf]);
const cborText = (str) => {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([cborHead(3, buf.length), buf]);
};
const cborMapHeader = (pairs) => cborHead(5, pairs);

function encodeCoseKeyEC2(x, y) {
  return Buffer.concat([
    cborMapHeader(5),
    cborInt(1), cborInt(2), // kty: EC2
    cborInt(3), cborInt(-7), // alg: ES256
    cborInt(-1), cborInt(1), // crv: P-256
    cborInt(-2), cborBytes(x),
    cborInt(-3), cborBytes(y),
  ]);
}

function encodeAttestationObjectNone(authData) {
  return Buffer.concat([
    cborMapHeader(3),
    cborText('fmt'), cborText('none'),
    cborText('attStmt'), cborMapHeader(0),
    cborText('authData'), cborBytes(authData),
  ]);
}

/* ── Minimal software WebAuthn authenticator ──────────────────────────── */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

function buildAuthData({ rpId, flags, counter, aaguid, credId, cosePublicKey }) {
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(counter, 0);
  let attestedCredData = Buffer.alloc(0);
  if (aaguid) {
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credId.length, 0);
    attestedCredData = Buffer.concat([aaguid, credIdLen, credId, cosePublicKey]);
  }
  return Buffer.concat([rpIdHash, Buffer.from([flags]), counterBuf, attestedCredData]);
}

/** Creates a fake authenticator with its own keypair, standing in for a
 * fingerprint sensor / Face ID / Windows Hello device for testing purposes. */
function createSoftwareAuthenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = fromB64url(jwk.x);
  const y = fromB64url(jwk.y);
  const credId = crypto.randomBytes(16);
  const cosePublicKey = encodeCoseKeyEC2(x, y);
  const aaguid = Buffer.alloc(16);

  function register({ rpId, origin, challenge, counter = 0 }) {
    const UP_UV_AT = 0x01 | 0x04 | 0x40;
    const authData = buildAuthData({ rpId, flags: UP_UV_AT, counter, aaguid, credId, cosePublicKey });
    const attestationObject = encodeAttestationObjectNone(authData);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
    );
    return {
      id: b64url(credId),
      rawId: b64url(credId),
      type: 'public-key',
      response: {
        attestationObject: b64url(attestationObject),
        clientDataJSON: b64url(clientDataJSON),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  function authenticate({ rpId, origin, challenge, counter = 1 }) {
    const UP_UV = 0x01 | 0x04;
    const authenticatorData = buildAuthData({ rpId, flags: UP_UV, counter });
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
    );
    const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
    const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, clientDataHash]), privateKey);
    return {
      id: b64url(credId),
      rawId: b64url(credId),
      type: 'public-key',
      response: {
        authenticatorData: b64url(authenticatorData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }

  return { register, authenticate, credentialId: b64url(credId) };
}

/* ── Test harness ──────────────────────────────────────────────────────── */

let base;
let server;

const call = async (method, urlPath, body, { token, tenant } = {}) => {
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WebAuthn biometric check-in', () => {
  let token;
  let memberId;
  const rpId = 'localhost'; // default rpID when WEBAUTHN_RP_ID is unset
  const authenticator = createSoftwareAuthenticator();

  it('sets up a tenant, a member, and an active plan', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'ironhouse',
      gym_name: 'Iron House',
      admin_name: 'Owner',
      admin_email: 'owner@ironhouse.test',
      admin_password: 'ownerpass123',
    });
    token = (
      await call('POST', '/api/auth/login', { email: 'owner@ironhouse.test', password: 'ownerpass123' }, { tenant: 'ironhouse' })
    ).body.token;

    const member = await call('POST', '/api/members', { first_name: 'Amit' }, { token, tenant: 'ironhouse' });
    assert.equal(member.status, 201);
    memberId = member.body.id;

    const plan = await call('POST', '/api/plans', { name: 'Monthly', price: 1000, duration_days: 30 }, { token, tenant: 'ironhouse' });
    const sub = await call('POST', '/api/subscriptions', { member_id: memberId, plan_id: plan.body.id }, { token, tenant: 'ironhouse' });
    assert.equal(sub.status, 201);
  });

  it('rejects registration options for an unauthenticated caller', async () => {
    const res = await call('POST', '/api/biometric/register/options', { member_id: memberId }, { tenant: 'ironhouse' });
    assert.equal(res.status, 401);
  });

  it('issues registration options for a known member', async () => {
    const res = await call('POST', '/api/biometric/register/options', { member_id: memberId }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.ok(res.body.sessionKey);
    assert.ok(res.body.options.challenge);
  });

  it('completes registration with a valid authenticator response', async () => {
    const optionsRes = await call('POST', '/api/biometric/register/options', { member_id: memberId }, { token, tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;

    const credential = authenticator.register({ rpId, origin: base, challenge: options.challenge, counter: 0 });

    const verifyRes = await call(
      'POST',
      '/api/biometric/register/verify',
      { sessionKey, member_id: memberId, device_name: 'Right index finger', credential },
      { token, tenant: 'ironhouse' },
    );
    assert.equal(verifyRes.status, 201);
    assert.equal(verifyRes.body.verified, true);

    const list = await call('GET', `/api/biometric/${memberId}/credentials`, null, { token, tenant: 'ironhouse' });
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].device_name, 'Right index finger');
  });

  it('rejects a registration verify replayed with an already-consumed challenge', async () => {
    const optionsRes = await call('POST', '/api/biometric/register/options', { member_id: memberId }, { token, tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;

    const second = createSoftwareAuthenticator();
    const credential = second.register({ rpId, origin: base, challenge: options.challenge, counter: 0 });

    const first = await call(
      'POST',
      '/api/biometric/register/verify',
      { sessionKey, member_id: memberId, credential },
      { token, tenant: 'ironhouse' },
    );
    assert.equal(first.status, 201);

    const replay = await call(
      'POST',
      '/api/biometric/register/verify',
      { sessionKey, member_id: memberId, credential },
      { token, tenant: 'ironhouse' },
    );
    assert.equal(replay.status, 400);
    assert.match(replay.body.error, /Challenge expired/i);
  });

  it('rejects enrolling the same biometric twice with a clear conflict, not a crash', async () => {
    const optionsRes = await call('POST', '/api/biometric/register/options', { member_id: memberId }, { token, tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;
    const credential = authenticator.register({ rpId, origin: base, challenge: options.challenge, counter: 0 });

    const res = await call(
      'POST',
      '/api/biometric/register/verify',
      { sessionKey, member_id: memberId, credential },
      { token, tenant: 'ironhouse' },
    );
    assert.equal(res.status, 409);
  });

  it('fetches authentication options without requiring staff auth', async () => {
    const res = await call('POST', '/api/biometric/authenticate/options', null, { tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.ok(res.body.sessionKey);
  });

  it('checks the member in on a valid biometric authentication', async () => {
    const optionsRes = await call('POST', '/api/biometric/authenticate/options', null, { tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;

    const credential = authenticator.authenticate({ rpId, origin: base, challenge: options.challenge, counter: 1 });

    const res = await call('POST', '/api/biometric/authenticate/verify', { sessionKey, credential }, { tenant: 'ironhouse' });
    assert.equal(res.status, 201);
    assert.equal(res.body.already_in, false);
    assert.equal(res.body.visit.source, 'biometric');

    const attendance = await call('GET', `/api/attendance?member_id=${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(attendance.body.items.length, 1);
  });

  it('is idempotent for a second biometric punch the same day', async () => {
    const optionsRes = await call('POST', '/api/biometric/authenticate/options', null, { tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;
    const credential = authenticator.authenticate({ rpId, origin: base, challenge: options.challenge, counter: 2 });

    const res = await call('POST', '/api/biometric/authenticate/verify', { sessionKey, credential }, { tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.equal(res.body.already_in, true);
  });

  it('rejects authentication from a credential that was never registered', async () => {
    const optionsRes = await call('POST', '/api/biometric/authenticate/options', null, { tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;

    const strangerAuthenticator = createSoftwareAuthenticator();
    // Register the stranger's key with itself so `authenticate` has a
    // well-formed credential — but never tell the server about it.
    strangerAuthenticator.register({ rpId, origin: base, challenge: options.challenge, counter: 0 });
    const credential = strangerAuthenticator.authenticate({ rpId, origin: base, challenge: options.challenge, counter: 1 });

    const res = await call('POST', '/api/biometric/authenticate/verify', { sessionKey, credential }, { tenant: 'ironhouse' });
    assert.equal(res.status, 400);
  });

  it('rejects authentication with a stale/unknown session key', async () => {
    const credential = authenticator.authenticate({ rpId, origin: base, challenge: 'does-not-matter', counter: 3 });
    const res = await call(
      'POST',
      '/api/biometric/authenticate/verify',
      { sessionKey: 'not-a-real-session', credential },
      { tenant: 'ironhouse' },
    );
    assert.equal(res.status, 400);
  });

  it('stores the credential id in the exact form the browser sends back', async () => {
    const list = await call('GET', `/api/biometric/${memberId}/credentials`, null, { token, tenant: 'ironhouse' });
    const ids = list.body.items.map((c) => c.credential_id);
    assert.ok(
      ids.includes(authenticator.credentialId),
      `stored ids ${JSON.stringify(ids)} should contain the raw browser id ${authenticator.credentialId}`,
    );
  });

  it('lets staff delete a credential, after which it can no longer authenticate', async () => {
    const list = await call('GET', `/api/biometric/${memberId}/credentials`, null, { token, tenant: 'ironhouse' });
    const row = list.body.items.find((c) => c.credential_id === authenticator.credentialId);

    const del = await call('DELETE', `/api/biometric/${memberId}/credentials/${row.id}`, null, { token, tenant: 'ironhouse' });
    assert.equal(del.status, 200);

    const afterList = await call('GET', `/api/biometric/${memberId}/credentials`, null, { token, tenant: 'ironhouse' });
    assert.ok(!afterList.body.items.some((c) => c.credential_id === authenticator.credentialId));

    const optionsRes = await call('POST', '/api/biometric/authenticate/options', null, { tenant: 'ironhouse' });
    const { sessionKey, options } = optionsRes.body;
    const credential = authenticator.authenticate({ rpId, origin: base, challenge: options.challenge, counter: 4 });
    const res = await call('POST', '/api/biometric/authenticate/verify', { sessionKey, credential }, { tenant: 'ironhouse' });
    assert.equal(res.status, 400);
  });

  it('404s deleting a credential that no longer exists', async () => {
    const res = await call('DELETE', `/api/biometric/${memberId}/credentials/999999`, null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 404);
  });
});
