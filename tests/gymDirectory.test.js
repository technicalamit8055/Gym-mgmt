import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-directory-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
// Low enough for the last test to reach, high enough for every other one.
process.env.DIRECTORY_MAX_REQUESTS = '80';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const {
  closeRegistryDb,
  findTenantBySlug,
  getRegistryDb,
  GYM_CODE_RE,
  normalizeGymCode,
  setTenantStatus,
} = await import('../src/tenants.js');

let base;
let server;

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

const signup = async (slug, gymName, extra = {}) => {
  const res = await call('POST', '/api/platform/signup', {
    slug,
    gym_name: gymName,
    admin_name: 'Owner Name',
    admin_email: `owner@${slug}.test`,
    admin_password: 'strongpass123',
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const directory = (suffix) => call('GET', `/api/platform/directory${suffix}`);

let iron;
let pulse;
let study;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  iron = await signup('iron-house', 'Iron House Fitness');
  pulse = await signup('pulse-gym', 'Pulse Gym');
  study = await signup('quiet-reads', 'Quiet Reads Library', { business_type: 'library' });

  const patch = (owner, body) => call('PATCH', `/g/${owner.slug}/api/platform/tenant`, body, { token: owner.token });
  assert.equal((await patch(iron, { address_line: '12 MG Road', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' })).status, 200);
  assert.equal((await patch(pulse, { city: 'Pune', listed_in_app: false })).status, 200);
  assert.equal((await patch(study, { city: 'Jaipur' })).status, 200);
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const codeOf = (slug) => findTenantBySlug(slug).gym_code;

describe('gym codes', () => {
  it('gives every new gym a six-character code that reads like its name', () => {
    const code = codeOf('iron-house');
    assert.match(code, GYM_CODE_RE);
    // I and O are left out of the alphabet, so "Iron House" keeps R, N, H.
    assert.equal(code.slice(0, 3), 'RNH');
    assert.notEqual(codeOf('pulse-gym'), code);
  });

  it('shows the code and address on the gym’s public context', async () => {
    const { body } = await call('GET', '/g/iron-house/api/platform/tenant');
    assert.equal(body.tenant.gym_code, codeOf('iron-house'));
    assert.equal(body.tenant.city, 'Jaipur');
    assert.equal(body.tenant.listed_in_app, true);
  });

  it('ignores case, spaces and dashes in what a member types', () => {
    assert.equal(normalizeGymCode(' rnh 2-34 '), 'RNH234');
    assert.equal(normalizeGymCode('RNH23'), null);
    assert.equal(normalizeGymCode('RNH230'), null); // 0 is not in the alphabet
  });

  it('backfills a code for a gym created before codes existed', () => {
    getRegistryDb().prepare('UPDATE tenants SET gym_code = NULL WHERE slug = ?').run('pulse-gym');
    closeRegistryDb(); // migrations run again on the next open
    assert.match(codeOf('pulse-gym'), GYM_CODE_RE);
  });
});

describe('GET /api/platform/directory/code/:code', () => {
  it('finds a gym by its code, however it was typed', async () => {
    const code = codeOf('iron-house');
    const { status, body } = await directory(`/code/${code.toLowerCase().slice(0, 3)}-${code.slice(3)}`);
    assert.equal(status, 200);
    assert.equal(body.gym.slug, 'iron-house');
    assert.equal(body.gym.gym_name, 'Iron House Fitness');
    assert.equal(body.gym.address_text, '12 MG Road, Jaipur, Rajasthan, 302001');
    assert.equal(body.gym.url, `${base}/g/iron-house`);
  });

  it('never exposes billing or status fields', async () => {
    const { body } = await directory(`/code/${codeOf('iron-house')}`);
    for (const key of ['status', 'db_file', 'razorpay_subscription_id', 'trial_ends_on', 'listed_in_app']) {
      assert.equal(key in body.gym, false, key);
    }
  });

  it('still finds a gym that is hidden from search', async () => {
    const { status, body } = await directory(`/code/${codeOf('pulse-gym')}`);
    assert.equal(status, 200);
    assert.equal(body.gym.slug, 'pulse-gym');
  });

  it('rejects something that cannot be a code, and 404s an unknown one', async () => {
    assert.equal((await directory('/code/abc')).status, 400);
    const missing = await directory('/code/ZZZ999');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.details.code, 'gym_not_found');
  });
});

describe('GET /api/platform/directory/search', () => {
  it('matches on name or city, and filters by business type', async () => {
    const byName = await directory('/search?q=iron');
    assert.deepEqual(byName.body.items.map((g) => g.slug), ['iron-house']);

    const byCity = await directory('/search?q=jaipur');
    assert.deepEqual(byCity.body.items.map((g) => g.slug).sort(), ['iron-house', 'quiet-reads']);

    const gymsOnly = await directory('/search?q=jaipur&type=gym');
    assert.deepEqual(gymsOnly.body.items.map((g) => g.slug), ['iron-house']);
  });

  it('matches a pincode exactly', async () => {
    assert.deepEqual((await directory('/search?q=302001')).body.items.map((g) => g.slug), ['iron-house']);
    assert.deepEqual((await directory('/search?q=3020')).body.items, []);
  });

  it('leaves out a gym whose owner unlisted it', async () => {
    assert.deepEqual((await directory('/search?q=pulse')).body.items, []);
  });

  it('answers nothing for a one-letter query or LIKE wildcards', async () => {
    assert.deepEqual((await directory('/search?q=i')).body.items, []);
    assert.deepEqual((await directory(`/search?q=${encodeURIComponent('%%')}`)).body.items, []);
    assert.deepEqual((await directory(`/search?q=${encodeURIComponent('__')}`)).body.items, []);
  });

  it('only lists gyms that are open for business', async () => {
    setTenantStatus('iron-house', 'suspended', 'test');
    try {
      assert.deepEqual((await directory('/search?q=iron')).body.items, []);
      // A suspended gym's members can still find it to sign in and see why.
      assert.equal((await directory(`/code/${codeOf('iron-house')}`)).status, 200);
    } finally {
      setTenantStatus('iron-house', 'active');
    }
  });

  it('forgets a cancelled gym everywhere', async () => {
    setTenantStatus('pulse-gym', 'cancelled', 'test');
    try {
      assert.equal((await directory(`/code/${codeOf('pulse-gym')}`)).status, 404);
    } finally {
      setTenantStatus('pulse-gym', 'active');
    }
  });
});

describe('GET /api/platform/directory/resolve', () => {
  const resolve = (text) => directory(`/resolve?text=${encodeURIComponent(text)}`);

  it('reads the desk poster’s link', async () => {
    const { status, body } = await resolve(`${base}/g/iron-house/#/portal`);
    assert.equal(status, 200);
    assert.equal(body.gym.slug, 'iron-house');
  });

  it('reads a subdomain link on a platform host', async () => {
    const { body } = await resolve('http://iron-house.localhost:3000/#/portal');
    assert.equal(body.gym.slug, 'iron-house');
  });

  it('reads a gym code or a bare slug', async () => {
    assert.equal((await resolve(codeOf('iron-house'))).body.gym.slug, 'iron-house');
    assert.equal((await resolve('pulse-gym')).body.gym.slug, 'pulse-gym');
  });

  it('reads a gym’s own custom domain', async () => {
    getRegistryDb()
      .prepare(
        `INSERT INTO custom_domains (tenant_slug, hostname, status, verification_token)
         VALUES ('iron-house', 'app.ironhouse.in', 'active', 'x')`,
      )
      .run();
    assert.equal((await resolve('https://app.ironhouse.in/#/portal')).body.gym.slug, 'iron-house');
  });

  it('does not take another site’s /g/<slug> link for one of ours', async () => {
    assert.equal((await resolve('https://example.com/g/iron-house/')).status, 404);
  });

  it('says so when a member card is scanned instead', async () => {
    const { status, body } = await resolve('GB1:abcdefghijklmnopqrstuv');
    assert.equal(status, 400);
    assert.equal(body.details.code, 'member_card');
  });

  it('404s something that is no gym', async () => {
    assert.equal((await resolve('hello there')).status, 404);
    assert.equal((await resolve('')).status, 400);
  });
});

describe('rate limiting', () => {
  it('locks out an address that pages through the directory', async () => {
    let last;
    for (let i = 0; i < 90; i += 1) {
      last = await directory('/search?q=gym');
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
  });
});
