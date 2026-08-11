import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-pwa-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { ROOT } = await import('../src/config.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb, setTenantStatus } = await import('../src/tenants.js');

let base;
let server;

const get = async (urlPath, { tenant } = {}) => {
  // X-Tenant-Slug is resolveTenant's non-production stand-in for a subdomain;
  // fetch() refuses to set a Host header, so it is the only way to exercise
  // the subdomain-addressed path from a test.
  const res = await fetch(`${base}${urlPath}`, { headers: tenant ? { 'X-Tenant-Slug': tenant } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

const manifest = async (urlPath, options) => {
  const res = await get(urlPath, options);
  return { ...res, body: JSON.parse(res.text) };
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = async (slug, gymName) => {
    const res = await fetch(`${base}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        gym_name: gymName,
        admin_name: 'Owner',
        admin_email: `owner@${slug}.test`,
        admin_password: 'ownerpass123',
      }),
    });
    assert.equal(res.status, 201);
  };

  await signup('iron-yard', 'Iron Yard');
  await signup('powerhouse', 'Powerhouse Fitness Studio');
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('web app manifest', () => {
  it('serves an installable manifest on the root domain', async () => {
    const { status, headers, body } = await manifest('/manifest.webmanifest');

    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /application\/manifest\+json/);
    assert.equal(headers.get('cache-control'), 'no-cache');
    assert.equal(body.start_url, '/');
    assert.equal(body.scope, '/');
    assert.equal(body.display, 'standalone');
    assert.ok(body.name.includes('GymBook'));
  });

  it('names the gym and scopes itself to a path-addressed tenant', async () => {
    const { body } = await manifest('/g/iron-yard/manifest.webmanifest');

    assert.equal(body.id, '/g/iron-yard/');
    assert.equal(body.scope, '/g/iron-yard/');
    assert.equal(body.start_url, '/g/iron-yard/#/dashboard');
    assert.ok(body.name.startsWith('Iron Yard'));
    assert.equal(body.short_name, 'Iron Yard');
    assert.equal(body.background_color, '#0d1117');
    // Home-screen shortcuts have to stay inside the gym they were installed
    // from, or a long-press lands the owner on a different gym's dashboard.
    assert.ok(body.shortcuts.length > 0);
    for (const shortcut of body.shortcuts) {
      assert.ok(shortcut.url.startsWith('/g/iron-yard/#/'), shortcut.url);
    }
  });

  it('cuts a long gym name on a word for the home-screen label', async () => {
    const { body } = await manifest('/g/powerhouse/manifest.webmanifest');
    assert.equal(body.short_name, 'Powerhouse');
    assert.ok(body.name.startsWith('Powerhouse Fitness Studio'));
  });

  it('keeps two gyms on one origin from installing as the same app', async () => {
    const acme = await manifest('/g/iron-yard/manifest.webmanifest');
    const root = await manifest('/manifest.webmanifest');
    assert.notEqual(acme.body.id, root.body.id);
  });

  it('names the gym when it is addressed by subdomain instead', async () => {
    const { body } = await manifest('/manifest.webmanifest', { tenant: 'iron-yard' });

    // No path prefix to carry: the gym owns the whole origin here.
    assert.equal(body.scope, '/');
    assert.equal(body.start_url, '/#/dashboard');
    assert.ok(body.name.startsWith('Iron Yard'));
  });

  it('still serves a suspended gym, which must reach its own billing page', async () => {
    setTenantStatus('iron-yard', 'suspended', 'test');
    const { status, body } = await manifest('/g/iron-yard/manifest.webmanifest');
    assert.equal(status, 200);
    assert.equal(body.scope, '/g/iron-yard/');
    setTenantStatus('iron-yard', 'trial', 'test');
  });

  it('points only at icons that exist', async () => {
    const { body } = await manifest('/manifest.webmanifest');
    const sources = [
      ...body.icons.map((i) => i.src),
      ...body.shortcuts.flatMap((s) => s.icons.map((i) => i.src)),
    ];

    for (const src of new Set(sources)) {
      const res = await get(src);
      assert.equal(res.status, 200, `${src} is referenced by the manifest but not served`);
    }
    // Android will not offer an install without a 192px and a 512px icon.
    assert.ok(body.icons.some((i) => i.sizes === '192x192'));
    assert.ok(body.icons.some((i) => i.sizes === '512x512'));
    assert.ok(body.icons.some((i) => i.purpose === 'maskable'));
  });
});

describe('service worker', () => {
  it('is served uncached, so a deploy is never pinned to the old worker', async () => {
    const { status, headers, text } = await get('/sw.js');

    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /javascript/);
    assert.equal(headers.get('cache-control'), 'no-cache');
    // Root scope is what lets one worker serve every /g/<slug> gym.
    assert.equal(headers.get('service-worker-allowed'), '/');
    assert.ok(text.includes("addEventListener('fetch'"));
  });

  it('precaches only files that exist', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    const list = /const SHELL_URLS = \[([\s\S]*?)\]/.exec(source);
    assert.ok(list, 'SHELL_URLS not found in sw.js');

    const urls = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(urls.length >= 5);
    for (const url of urls) {
      const res = await get(url);
      assert.equal(res.status, 200, `${url} is precached but not served`);
    }
  });

  it('serves the offline fallback page', async () => {
    const { status, text } = await get('/offline.html');
    assert.equal(status, 200);
    assert.ok(text.includes("You're offline"));
  });
});

describe('icons', () => {
  it('ships real PNGs at the sizes Android and iOS ask for', async () => {
    const expected = {
      'icon-192.png': 192,
      'icon-512.png': 512,
      'maskable-192.png': 192,
      'maskable-512.png': 512,
      'apple-touch-icon.png': 180,
      'favicon-32.png': 32,
    };

    for (const [file, size] of Object.entries(expected)) {
      const buf = fs.readFileSync(path.join(ROOT, 'public', 'icons', file));
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${file} is not a PNG`);
      // Width and height live at a fixed offset in the IHDR chunk.
      assert.equal(buf.readUInt32BE(16), size, `${file} width`);
      assert.equal(buf.readUInt32BE(20), size, `${file} height`);
    }
  });

  it('serves them with an image content type', async () => {
    const { status, headers } = await get('/icons/icon-512.png');
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), 'image/png');
  });
});

describe('app shell', () => {
  it('links the manifest and the iOS home-screen icon', async () => {
    const { text } = await get('/');
    assert.match(text, /<link rel="manifest"/);
    assert.match(text, /apple-touch-icon/);
    assert.match(text, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(text, /name="theme-color"/);
    // Without viewport-fit=cover the safe-area insets in app.css are all zero
    // and an installed iPhone window renders under the notch.
    assert.match(text, /viewport-fit=cover/);
  });
});
