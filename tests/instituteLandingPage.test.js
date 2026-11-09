import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The institute website (src/coaching/site.js, src/routes/site.js): the
 * editor's API, the public page's data and enquiry form, the institute-branded
 * HTML shell, and "#/ opens the website" on an institute's own domain.
 *
 * Its own file because the custom-domain half needs CUSTOM_DOMAIN_TARGET and
 * ROOT_DOMAIN, which config.js reads once at import.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-site-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.ROOT_DOMAIN = 'gymbook.app';
process.env.CUSTOM_DOMAIN_TARGET = 'domains.gymbook.app';

const { createApp } = await import('../src/app.js');
const { all, closeDb, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDomain } = await import('../src/customDomains.js');
const { normalizeSiteContent } = await import('../src/coaching/site.js');

const SLUG = 'apex-classes';
const GYM = 'iron-gym';
const DOMAIN = 'www.apexclasses.in';

let server;
let port;
let admin;
let staff;
let gymAdmin;

/** node:http rather than fetch: fetch silently replaces a custom Host header. */
function call(method, urlPath, body, { token, tenant = SLUG, host } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          host: host ?? `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(tenant && !host ? { 'x-tenant-slug': tenant } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const type = res.headers['content-type'] || '';
          const text = buffer.toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, body: type.includes('json') ? (text ? JSON.parse(text) : null) : text, buffer });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const signup = (slug, gymName, businessType) =>
  call(
    'POST',
    '/api/platform/signup',
    {
      slug,
      gym_name: gymName,
      admin_name: 'Owner',
      admin_email: `owner@${slug}.test`,
      admin_password: 'ownerpass123',
      business_type: businessType,
    },
    { tenant: null },
  );

const login = async (slug, email, password) => (await call('POST', '/api/auth/login', { email, password }, { tenant: slug })).body.token;

const inquiries = () => tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG), businessType: 'coaching' }, () => all('SELECT * FROM student_inquiries ORDER BY id'));

// A 1×1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;

  assert.equal((await signup(SLUG, 'Apex "Classes" & Co', 'coaching')).status, 201);
  assert.equal((await signup(GYM, 'Iron Gym', 'gym')).status, 201);
  admin = await login(SLUG, `owner@${SLUG}.test`, 'ownerpass123');
  gymAdmin = await login(GYM, `owner@${GYM}.test`, 'ownerpass123');

  const created = await call('POST', '/api/staff', { name: 'Desk Person', email: 'desk@apex.test', password: 'deskpass123', role: 'staff' }, { token: admin });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  staff = await login(SLUG, 'desk@apex.test', 'deskpass123');
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Content rules ─────────────────────────────────────────────────────── */

describe('normalizeSiteContent', () => {
  it('fills every field, trims text and drops empty rows', () => {
    const content = normalizeSiteContent({
      hero: { headline: '  Crack   JEE  \n with us ' },
      results: [{ name: 'Riya', achievement: 'AIR 12' }, { name: '', achievement: 'orphan' }],
      faqs: [{ q: 'Demo?', a: '' }],
    });
    assert.equal(content.hero.headline, 'Crack JEE with us');
    assert.equal(content.hero.cta_label, 'Enquire now');
    assert.deepEqual(content.results, [{ name: 'Riya', achievement: 'AIR 12', year: '' }]);
    assert.deepEqual(content.faqs, []);
    assert.equal(content.sections.courses, true);
    assert.equal(content.show_fees, false);
  });

  it('accepts a bare domain as a link but rejects a script URL and a bad phone', () => {
    assert.equal(normalizeSiteContent({ contact: { maps_url: 'maps.app.goo.gl/abc' } }).contact.maps_url, 'https://maps.app.goo.gl/abc');
    assert.throws(
      () => normalizeSiteContent({ social: { youtube: 'javascript:alert(1)' }, contact: { phone: 'call me' } }),
      (err) => err.status === 400 && 'social.youtube' in err.details && 'contact.phone' in err.details,
    );
  });

  it('caps lists at their limits', () => {
    const content = normalizeSiteContent({ highlights: Array.from({ length: 9 }, (_, i) => ({ value: `${i}`, label: 'x' })) });
    assert.equal(content.highlights.length, 4);
  });
});

/* ── Editor API ────────────────────────────────────────────────────────── */

describe('the website editor', () => {
  it('starts unpublished, prefilled from the institute, with its live courses', async () => {
    const res = await call('GET', '/api/coaching/website', undefined, { token: admin });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.institute.name, 'Apex "Classes" & Co');
    assert.equal(res.body.content.sections.faculty, false, 'faculty stays off until the owner chooses it');
    assert.equal(res.body.courses.length, 1, 'the starter course');
    assert.equal(res.body.courses[0].fee_from, 45000);
    assert.equal(res.body.active_domain, null);
  });

  it('is for admins and managers only', async () => {
    assert.equal((await call('GET', '/api/coaching/website', undefined, { token: staff })).status, 403);
    assert.equal((await call('PUT', '/api/coaching/website', { enabled: true }, { token: staff })).status, 403);
    assert.equal((await call('GET', '/api/coaching/website')).status, 401);
  });

  it('is CoachBook only', async () => {
    const res = await call('GET', '/api/coaching/website', undefined, { token: gymAdmin, tenant: GYM });
    assert.equal(res.status, 404);
    assert.equal(res.body.details.code, 'module_not_enabled');
  });

  it('refuses a broken contact detail and keeps the old content', async () => {
    const res = await call('PUT', '/api/coaching/website', { content: { contact: { email: 'not-an-email' } } }, { token: admin });
    assert.equal(res.status, 400);
    assert.ok(res.body.details['contact.email']);
    const after = await call('GET', '/api/coaching/website', undefined, { token: admin });
    assert.equal(after.body.updated_at !== undefined, true);
    assert.equal(after.body.content.contact.email, '');
  });
});

/* ── Public page ───────────────────────────────────────────────────────── */

describe('the public website', () => {
  let secondCourse;

  it('is not there until it is published — and the shell stays GymBook', async () => {
    const res = await call('GET', '/api/site');
    assert.equal(res.status, 404);
    assert.equal(res.body.details.code, 'site_disabled');
    const ctx = await call('GET', '/api/platform/tenant');
    assert.deepEqual(ctx.body.site, { enabled: false, on_root: false });
    const shell = await call('GET', '/');
    assert.match(shell.body, /<title>GymBook/);
  });

  it('lets an admin preview the draft before publishing', async () => {
    const res = await call('GET', '/api/coaching/website/preview', undefined, { token: admin });
    assert.equal(res.status, 200);
    assert.equal(res.body.institute.name, 'Apex "Classes" & Co');
  });

  it('publishes with content, pictures and only the courses chosen', async () => {
    const created = await call(
      'POST',
      '/api/coaching/courses',
      { name: 'NEET Dropper', academic_year: '2026-27', target_exam: 'NEET', description: 'One-year intensive' },
      { token: admin },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    secondCourse = created.body;
    const editor = await call('GET', '/api/coaching/website', undefined, { token: admin });
    const starter = editor.body.courses.find((c) => c.id !== secondCourse.id);

    const hero = await call('POST', '/api/coaching/website/images', { kind: 'hero', data_url: PNG }, { token: admin });
    assert.equal(hero.status, 201, JSON.stringify(hero.body));
    const replaced = await call('POST', '/api/coaching/website/images', { kind: 'hero', data_url: PNG }, { token: admin });
    assert.equal(replaced.status, 201);
    const gallery = await call('POST', '/api/coaching/website/images', { kind: 'gallery', data_url: PNG, caption: 'Library' }, { token: admin });
    assert.equal(gallery.status, 201);
    const svg = await call('POST', '/api/coaching/website/images', { kind: 'gallery', data_url: 'data:image/svg+xml;base64,PHN2Zy8+' }, { token: admin });
    assert.equal(svg.status, 400, 'no SVG — it can carry script');

    const saved = await call(
      'PUT',
      '/api/coaching/website',
      {
        enabled: true,
        content: {
          hero: { headline: 'Kota’s <best> coaching', subheadline: 'Small batches, big results' },
          results: [{ name: 'Riya Sharma', achievement: 'AIR 312, JEE Advanced', year: '2026' }],
          hidden_course_ids: [starter.id],
          show_fees: false,
          contact: { phone: '+91 98765 43210', whatsapp: '9876543210', maps_url: 'https://maps.app.goo.gl/x' },
          seo: { description: 'JEE & NEET coaching in Kota' },
        },
      },
      { token: admin },
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.enabled, true);
    assert.ok(saved.body.published_at);
    assert.equal(saved.body.images.filter((i) => i.kind === 'hero').length, 1, 'a new banner replaces the old one');

    const site = await call('GET', '/api/site');
    assert.equal(site.status, 200, JSON.stringify(site.body));
    assert.equal(site.body.content.hero.headline, 'Kota’s <best> coaching');
    assert.deepEqual(site.body.courses.map((c) => c.name), ['NEET Dropper']);
    assert.equal(site.body.courses[0].fee_from, null, 'fees hidden unless the owner shows them');
    assert.deepEqual(site.body.faculty, [], 'faculty section is off');
    assert.equal(site.body.gallery.length, 1);
    assert.equal(site.body.gallery[0].caption, 'Library');
    assert.ok(site.body.hero_image_url);

    const image = await call('GET', site.body.hero_image_url.replace(/^\/g\/[^/]+/, ''));
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.match(image.headers['cache-control'], /immutable/);
  });

  it('serves index.html under the institute’s own name, escaped, with share tags', async () => {
    const shell = await call('GET', '/');
    assert.equal(shell.status, 200);
    assert.match(shell.body, /<title>Apex &quot;Classes&quot; &amp; Co — Kota’s &lt;best&gt; coaching<\/title>/);
    assert.match(shell.body, /<meta name="description" content="JEE &amp; NEET coaching in Kota" \/>/);
    assert.match(shell.body, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/api\/site\/images\/\d+" \/>/);
    assert.match(shell.body, /"@type":"EducationalOrganization"/);
    assert.ok(!shell.body.includes('<best>'), 'nothing the owner typed reaches the HTML raw');
    // The app itself is untouched: still the same scripts.
    assert.match(shell.body, /<script/);
    const ctx = await call('GET', '/api/platform/tenant');
    assert.deepEqual(ctx.body.site, { enabled: true, on_root: false });
  });

  it('files an enquiry in Admissions, marked as from the website', async () => {
    const res = await call('POST', '/api/site/enquiry', {
      student_name: 'Kabir Jain',
      phone: '+91 91234 56789',
      guardian_name: 'Meena Jain',
      course_id: secondCourse.id,
      target_class: 'Class 12',
      message: 'Is there a weekend batch?',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows = inquiries();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'website');
    assert.equal(rows[0].status, 'inquiry');
    assert.equal(rows[0].course_id, secondCourse.id);
    assert.match(rows[0].notes, /weekend batch/);
  });

  it('treats a second enquiry from the same number as the same lead', async () => {
    const res = await call('POST', '/api/site/enquiry', { student_name: 'Kabir Jain', phone: '9123456789', message: 'Calling again' });
    assert.equal(res.status, 201);
    const rows = inquiries();
    assert.equal(rows.length, 1);
    assert.match(rows[0].notes, /weekend batch[\s\S]*Calling again/);
  });

  it('rejects hidden courses and bad numbers, and quietly drops bots', async () => {
    const editor = await call('GET', '/api/coaching/website', undefined, { token: admin });
    const hidden = editor.body.content.hidden_course_ids[0];
    const hiddenCourse = await call('POST', '/api/site/enquiry', { student_name: 'Someone', phone: '9000000001', course_id: hidden });
    assert.equal(hiddenCourse.status, 400);
    assert.ok(hiddenCourse.body.details.course_id);

    const shortPhone = await call('POST', '/api/site/enquiry', { student_name: 'Someone', phone: '12345' });
    assert.equal(shortPhone.status, 400);

    const bot = await call('POST', '/api/site/enquiry', { student_name: 'Bot', phone: '9000000002', company: 'Spam Inc' });
    assert.equal(bot.status, 201);
    assert.equal(inquiries().length, 1, 'the honeypot saves nothing');
  });

  it('rate-limits one address', async () => {
    // Five attempts so far from this address (2 good, 3 refused/dropped).
    const res = await call('POST', '/api/site/enquiry', { student_name: 'Late One', phone: '9000000003' });
    assert.equal(res.status, 429);
    assert.ok(res.headers['retry-after']);
  });

  it('gym accounts have no website', async () => {
    const res = await call('GET', '/api/site', undefined, { tenant: GYM });
    assert.equal(res.status, 404);
    const shell = await call('GET', '/', undefined, { tenant: GYM });
    assert.match(shell.body, /<title>GymBook/);
  });
});

/* ── On the institute's own domain ─────────────────────────────────────── */

describe('on a custom domain', () => {
  before(() => {
    addDomain(SLUG, DOMAIN, { activate: true });
  });

  it('tells the app to open the website at "#/"', async () => {
    const ctx = await call('GET', '/api/platform/tenant', undefined, { host: DOMAIN });
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.tenant.slug, SLUG);
    assert.deepEqual(ctx.body.site, { enabled: true, on_root: true });
  });

  it('names the domain as the canonical address', async () => {
    const shell = await call('GET', '/', undefined, { host: DOMAIN });
    assert.match(shell.body, /<link rel="canonical" href="https:\/\/www\.apexclasses\.in\/" \/>/);
    const viaPlatform = await call('GET', '/');
    assert.match(viaPlatform.body, /<link rel="canonical" href="https:\/\/www\.apexclasses\.in\/" \/>/, 'the platform address points search engines at the domain too');
  });

  it('shows where the website lives in the editor', async () => {
    const res = await call('GET', '/api/coaching/website', undefined, { token: admin });
    assert.equal(res.body.active_domain, DOMAIN);
  });

  it('goes back to the sign-in screen when unpublished', async () => {
    const res = await call('PUT', '/api/coaching/website', { enabled: false }, { token: admin });
    assert.equal(res.status, 200);
    const ctx = await call('GET', '/api/platform/tenant', undefined, { host: DOMAIN });
    assert.deepEqual(ctx.body.site, { enabled: false, on_root: false });
    assert.equal((await call('GET', '/api/site', undefined, { host: DOMAIN })).status, 404);
    // Content survives an unpublish.
    const editor = await call('GET', '/api/coaching/website', undefined, { token: admin });
    assert.equal(editor.body.content.results[0].name, 'Riya Sharma');
  });
});
