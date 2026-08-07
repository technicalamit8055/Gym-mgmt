import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-reset-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'operator@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { issuePasswordReset } = await import('../src/passwordReset.js');

let base;
let server;
let operatorToken;

const call = async (method, urlPath, body, { token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const OWNER = { email: 'owner@ironhouse.test', password: 'original12345' };

const signIn = (slug, email, password) =>
  call('POST', `/g/${slug}/api/auth/login`, { email, password });

/** The token out of a reset link the console just handed back. */
const tokenOf = (url) => new URL(url, base).hash.split('token=')[1];

const inGym = (slug, fn) =>
  tenantStorage.run({ slug, dbFile: tenantDbPath(slug) }, fn);

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = await call('POST', '/api/platform/signup', {
    slug: 'iron-house',
    gym_name: 'Iron House',
    admin_name: 'Ravi Owner',
    admin_email: OWNER.email,
    admin_password: OWNER.password,
  });
  assert.equal(signup.status, 201);

  const login = await call('POST', '/api/platform/admin/login', {
    email: 'operator@gymbook.test',
    password: 'operator-secret',
  });
  assert.equal(login.status, 200);
  operatorToken = login.body.token;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the operator issues a reset link', () => {
  it('needs an operator token — a gym admin cannot issue one', async () => {
    const owner = await signIn('iron-house', OWNER.email, OWNER.password);
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: owner.body.token },
    );
    assert.equal(res.status, 403);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await call('POST', '/api/platform/admin/tenants/iron-house/password-reset', {});
    assert.equal(res.status, 401);
  });

  it('404s for a gym that does not exist', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/no-such-gym/password-reset',
      {},
      { token: operatorToken },
    );
    assert.equal(res.status, 404);
  });

  it('targets the gym owner when no email is given', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.email, OWNER.email);
    assert.match(res.body.url, /#\/reset\?token=/);
    assert.match(res.body.reset_path, /^\/g\/iron-house\/#\/reset\?token=/);
    assert.equal(res.body.expires_in_minutes, 60);
  });

  it('stores the token as a digest, never in the clear', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );
    const token = tokenOf(res.body.url);
    const row = inGym('iron-house', () => get('SELECT token_hash FROM password_resets'));
    assert.ok(row);
    assert.notEqual(row.token_hash, token);
    assert.doesNotMatch(row.token_hash, new RegExp(token.slice(0, 12)));
  });

  it('keeps only the newest link alive when reissued', async () => {
    const first = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );
    const second = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );

    const outstanding = inGym('iron-house', () => get('SELECT COUNT(*) AS n FROM password_resets'));
    assert.equal(outstanding.n, 1);

    const stale = await call('POST', '/g/iron-house/api/auth/password-reset/check', {
      token: tokenOf(first.body.url),
    });
    assert.equal(stale.body.valid, false);

    const live = await call('POST', '/g/iron-house/api/auth/password-reset/check', {
      token: tokenOf(second.body.url),
    });
    assert.equal(live.body.valid, true);
  });
});

describe('the owner redeems the link', () => {
  let token;

  before(async () => {
    const issued = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );
    token = tokenOf(issued.body.url);
  });

  it('rejects a password below the minimum', async () => {
    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token,
      new_password: 'short',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.new_password);
  });

  it('rejects a token that was never issued', async () => {
    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token: 'made-up-token-that-was-never-issued',
      new_password: 'brand-new-pass',
    });
    assert.equal(res.status, 400);
  });

  it('will not redeem one gym’s token against another gym', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'other-house',
      gym_name: 'Other House',
      admin_name: 'Someone Else',
      admin_email: 'someone@other.test',
      admin_password: 'other12345',
    });

    const res = await call('POST', '/g/other-house/api/auth/password-reset', {
      token,
      new_password: 'brand-new-pass',
    });
    assert.equal(res.status, 400);
  });

  it('sets the new password', async () => {
    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token,
      new_password: 'recovered12345',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, OWNER.email);
  });

  it('lets the owner sign in with it', async () => {
    const res = await signIn('iron-house', OWNER.email, 'recovered12345');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'admin');
  });

  it('stops the old password working', async () => {
    const res = await signIn('iron-house', OWNER.email, OWNER.password);
    assert.equal(res.status, 401);
  });

  it('cannot be replayed', async () => {
    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token,
      new_password: 'third-password-attempt',
    });
    assert.equal(res.status, 400);

    // And the password it already set is still the working one.
    assert.equal((await signIn('iron-house', OWNER.email, 'recovered12345')).status, 200);
  });

  it('leaves no spent row behind', () => {
    const row = inGym('iron-house', () => get('SELECT COUNT(*) AS n FROM password_resets'));
    assert.equal(row.n, 0);
  });
});

describe('an expired link', () => {
  it('is refused, and reports itself invalid before asking for a password', async () => {
    const issued = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );
    const token = tokenOf(issued.body.url);

    // Age it past its hour rather than waiting one out.
    inGym('iron-house', () =>
      run("UPDATE password_resets SET expires_at = datetime('now', '-1 minute')"),
    );

    const check = await call('POST', '/g/iron-house/api/auth/password-reset/check', { token });
    assert.equal(check.body.valid, false);

    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token,
      new_password: 'too-late-for-this',
    });
    assert.equal(res.status, 400);
    assert.equal((await signIn('iron-house', OWNER.email, 'too-late-for-this')).status, 401);
  });
});

describe('targeting a specific staff account', () => {
  before(async () => {
    const owner = await signIn('iron-house', OWNER.email, 'recovered12345');
    const res = await call(
      'POST',
      '/g/iron-house/api/staff',
      { name: 'Desk Person', email: 'desk@ironhouse.test', password: 'desk12345', role: 'staff' },
      { token: owner.body.token },
    );
    assert.equal(res.status, 201);
  });

  it('resets that account rather than the owner', async () => {
    const issued = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      { email: 'desk@ironhouse.test' },
      { token: operatorToken },
    );
    assert.equal(issued.body.email, 'desk@ironhouse.test');

    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token: tokenOf(issued.body.url),
      new_password: 'deskchanged12345',
    });
    assert.equal(res.status, 200);

    assert.equal((await signIn('iron-house', 'desk@ironhouse.test', 'deskchanged12345')).status, 200);
    // The owner's own password is untouched.
    assert.equal((await signIn('iron-house', OWNER.email, 'recovered12345')).status, 200);
  });

  it('404s for an address with no account', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      { email: 'nobody@ironhouse.test' },
      { token: operatorToken },
    );
    assert.equal(res.status, 404);
  });
});

describe('a suspended gym can still be recovered', () => {
  // The case that matters most: the owner cannot sign in to pay because they
  // have lost their password, and the gym is suspended for not having paid.
  it('issues and redeems a reset while suspended', async () => {
    const suspend = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/status',
      { status: 'suspended', reason: 'test' },
      { token: operatorToken },
    );
    assert.equal(suspend.status, 200);

    const issued = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      {},
      { token: operatorToken },
    );
    assert.equal(issued.status, 200);

    const res = await call('POST', '/g/iron-house/api/auth/password-reset', {
      token: tokenOf(issued.body.url),
      new_password: 'unsuspended12345',
    });
    assert.equal(res.status, 200);
    assert.equal((await signIn('iron-house', OWNER.email, 'unsuspended12345')).status, 200);
  });
});

describe('issuePasswordReset directly', () => {
  it('refuses when there is no active account to reset', () => {
    tenantStorage.run({ slug: 'empty', dbFile: path.join(tmpDir, 'empty.db') }, () => {
      assert.throws(() => issuePasswordReset(), /No active staff account/);
    });
  });

  it('will not target a deactivated account', async () => {
    // The suspended-gym test above left this gym suspended, and every other
    // /api route is gated on an active subscription — so lift it before trying
    // to use the staff API, or the deactivation would silently 402 and this
    // test would pass for the wrong reason.
    const reactivate = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/status',
      { status: 'active', reason: 'test' },
      { token: operatorToken },
    );
    assert.equal(reactivate.status, 200);

    const owner = await signIn('iron-house', OWNER.email, 'unsuspended12345');
    const staff = inGym('iron-house', () =>
      get("SELECT id FROM users WHERE email = 'desk@ironhouse.test'"),
    );
    const deactivated = await call(
      'PATCH',
      `/g/iron-house/api/staff/${staff.id}`,
      { active: false },
      { token: owner.body.token },
    );
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.active, 0);

    const res = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/password-reset',
      { email: 'desk@ironhouse.test' },
      { token: operatorToken },
    );
    assert.equal(res.status, 404);
  });
});
