import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-marketing-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { config } = await import('../src/config.js');
const { marketingBrandFor } = await import('../src/marketing.js');
const { marketingContent, roiEstimate, MARKETING_BRANDS } = await import('../public/js/marketing.js');

let base;
let server;

const get = async (urlPath) => {
  const res = await fetch(`${base}${urlPath}`);
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
};

/** The JSON-LD @graph a page carries, by @type. */
const structuredData = (html) => {
  const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  assert.ok(match, 'the page carries JSON-LD');
  return Object.fromEntries(JSON.parse(match[1])['@graph'].map((node) => [node['@type'], node]));
};

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // A real gym, so "/" can be checked under a tenant's address too.
  const signup = await fetch(`${base}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'iron-house',
      gym_name: 'Iron House Fitness',
      admin_name: 'Amit Singh',
      admin_email: 'amit@ironhouse.test',
      admin_password: 'strongpass123',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    }),
  });
  assert.equal(signup.status, 201);
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketing copy', () => {
  for (const brand of MARKETING_BRANDS) {
    it(`keeps ${brand}'s title and description short enough to show whole in a search result`, () => {
      const content = marketingContent(brand);
      assert.ok(content.title.length <= 60, `${content.title.length} chars: ${content.title}`);
      assert.ok(content.description.length <= 160, `${content.description.length} chars: ${content.description}`);
    });

    it(`ships ${brand}'s share image`, () => {
      assert.ok(fs.existsSync(path.join('public', marketingContent(brand).ogImage)));
    });
  }

  it('states the configured trial length in the FAQ, not a hard-coded one', () => {
    const answer = marketingContent('gym', { trialDays: 21 }).faqs.at(-1).a;
    assert.match(answer, /21 days free/);
  });

  it('estimates what reminders recover from exactly the inputs shown', () => {
    const result = roiEstimate({ count: 100, fee: 1000, lateRate: 0.2, recovery: 0.5 });
    assert.equal(result.atRisk, 20000);
    assert.equal(result.recovered, 10000);
    assert.equal(result.yearly, 120000);
    assert.equal(result.messages, 200);
    assert.equal(result.hours, 7); // 200 messages × 2 min
  });
});

describe('the root domain\'s marketing pages', () => {
  it('serves GymBook at "/" with its own title, description and canonical URL', async () => {
    const { status, type, text } = await get('/');
    const content = marketingContent('gym', { trialDays: config.trialDays });
    assert.equal(status, 200);
    assert.match(type, /text\/html/);
    assert.equal(decode(text.match(/<title>([^<]*)<\/title>/)[1]), content.title);
    assert.equal(decode(text.match(/<meta name="description" content="([^"]*)"/)[1]), content.description);
    assert.match(text, new RegExp(`<link rel="canonical" href="${base}/" />`));
    assert.match(text, /<meta property="og:image" content="[^"]+\/images\/og\/gymbook\.png" \/>/);
    assert.match(text, /<meta name="twitter:card" content="summary_large_image" \/>/);
    // The rest of the shell is untouched: the app still boots from it.
    assert.match(text, /<script type="module" src="\/js\/app\.js"><\/script>/);
    assert.match(text, /<link rel="manifest"/);
  });

  it('serves SeatBook at "/library", with its own icons', async () => {
    const { status, text } = await get('/library');
    assert.equal(status, 200);
    assert.equal(decode(text.match(/<title>([^<]*)<\/title>/)[1]), marketingContent('library').title);
    assert.match(text, new RegExp(`<link rel="canonical" href="${base}/library" />`));
    assert.match(text, /href="\/icons\/library\/apple-touch-icon\.png"/);
    assert.match(text, /data-brand="library"/);
  });

  it('treats "/library" and a seatbook.* hostname as SeatBook, like landingBrand in api.js', () => {
    // Called directly: fetch() will not send a Host header of the caller's choosing.
    const req = (reqPath, host) => ({ path: reqPath, get: () => host });
    assert.equal(marketingBrandFor(req('/', 'gymbook.app')), 'gym');
    assert.equal(marketingBrandFor(req('/library', 'gymbook.app')), 'library');
    assert.equal(marketingBrandFor(req('/library/', 'gymbook.app')), 'library');
    assert.equal(marketingBrandFor(req('/', 'www.seatbook.in')), 'library');
    assert.equal(marketingBrandFor(req('/', 'seatbook.in:443')), 'library');
  });

  it('describes the product and its FAQ in JSON-LD that matches the visible FAQ word for word', async () => {
    const { text } = await get('/');
    const graph = structuredData(text);
    const content = marketingContent('gym', { trialDays: config.trialDays });

    assert.equal(graph.SoftwareApplication.name, 'GymBook');
    assert.equal(graph.SoftwareApplication.applicationCategory, 'BusinessApplication');
    assert.deepEqual(graph.SoftwareApplication.featureList, content.features.map((f) => f.title));
    // No made-up price: the subscription price is not on the page.
    assert.equal(graph.SoftwareApplication.offers, undefined);

    const questions = graph.FAQPage.mainEntity;
    assert.equal(questions.length, content.faqs.length);
    for (const [i, { q, a }] of content.faqs.entries()) {
      assert.equal(questions[i].name, q);
      assert.equal(questions[i].acceptedAnswer.text, a);
      // ...and the same words are on the page itself, not only in the markup.
      assert.ok(decode(text).includes(`<summary>${q}</summary><p>${a}</p>`), `visible: ${q}`);
    }
  });

  it('puts a readable copy of the page in #app for crawlers that run no JavaScript', async () => {
    const { text } = await get('/');
    const app = text.slice(text.indexOf('<div id="app">'), text.indexOf('<div id="toasts"'));
    assert.match(app, /<h1>Run your gym\. <span class="grad">All of it\.<\/span><\/h1>/);
    assert.match(app, /<h2 id="ssr-features">/);
    assert.match(app, /<table>/);
    assert.match(app, /href="\/#\/signup"/);
    assert.match(app, /href="\/library"/);
    // With JavaScript off the splash would sit over it forever.
    assert.match(text, /<noscript><style>\.splash \{ display: none; \}<\/style><\/noscript>/);
  });

  it('leaves a gym\'s own address alone: "/" there is the plain app shell', async () => {
    const { status, text } = await get('/g/iron-house/');
    assert.equal(status, 200);
    assert.doesNotMatch(text, /application\/ld\+json/);
    assert.doesNotMatch(text, /rel="canonical"/);
    assert.match(text, /<div id="app"><\/div>/);
  });
});

describe('robots.txt and sitemap.xml', () => {
  it('lets crawlers in, keeps them off the API, and points at the sitemap', async () => {
    const { status, type, text } = await get('/robots.txt');
    assert.equal(status, 200);
    assert.match(type, /text\/plain/);
    assert.match(text, /^User-agent: \*$/m);
    assert.match(text, /^Disallow: \/api\/$/m);
    assert.match(text, new RegExp(`^Sitemap: ${base}/sitemap\\.xml$`, 'm'));
  });

  it('lists both marketing pages', async () => {
    const { status, type, text } = await get('/sitemap.xml');
    assert.equal(status, 200);
    assert.match(type, /application\/xml/);
    assert.match(text, new RegExp(`<loc>${base}/</loc>`));
    assert.match(text, new RegExp(`<loc>${base}/library</loc>`));
  });

  it('has no sitemap under a gym\'s address, and no sitemap line in its robots.txt', async () => {
    assert.equal((await get('/g/iron-house/sitemap.xml')).status, 404);
    assert.doesNotMatch((await get('/g/iron-house/robots.txt')).text, /Sitemap:/);
  });
});
