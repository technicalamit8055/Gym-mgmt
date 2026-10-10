import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/*
 * Open Food Facts is replaced by a local stub: tests must not depend on the
 * internet, and the stub counts requests, which is how the caching is proven.
 */
const PRODUCTS = {
  // Plain per-100 g label with a serving size.
  '3017620422003': {
    product_name: 'Nutella',
    brands: 'Nutella, Ferrero',
    quantity: '400 g',
    serving_size: '15 g',
    serving_quantity: 15,
    nutriments: {
      'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, fiber_100g: 0, sugars_100g: 56.3,
    },
  },
  // Only "as prepared" values, energy in kJ, sold by volume.
  '8901058000290': {
    product_name: 'Masala Noodles',
    brands: 'Maggi',
    quantity: '280 ml',
    nutriments: { 'energy-kj_prepared_100g': 1615.1, proteins_prepared_100g: 8, carbohydrates_prepared_100g: 59.6, fat_prepared_100g: 14 },
  },
  // Known to the database, but nobody has typed in its label yet.
  '4006381333931': { product_name: 'Mystery Bar', brands: 'Acme', nutriments: {} },
};
let upstreamRequests = 0;
let lastUserAgent = '';

const stub = http.createServer((req, res) => {
  upstreamRequests += 1;
  lastUserAgent = req.headers['user-agent'];
  const code = /\/api\/v2\/product\/(\d+)\.json/.exec(req.url)?.[1];
  const product = PRODUCTS[code];
  res.writeHead(product ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(product ? { status: 1, code, product: { code, ...product } } : { status: 0, code }));
});
stub.listen(0);
await new Promise((resolve) => stub.once('listening', resolve));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-barcode-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.FOOD_DB_URL = `http://127.0.0.1:${stub.address().port}`;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { normaliseBarcode, productToFood, resetBarcodeCaches } = await import('../src/foodBarcode.js');

const TENANT = 'scangym';
let base;
let server;
let adminToken;
let memberToken;

const call = async (method, urlPath, body, { token = memberToken, tenant = TENANT } = {}) => {
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

  await call('POST', '/api/platform/signup', {
    slug: TENANT, gym_name: 'Scan Gym', admin_name: 'Owner', admin_email: 'owner@scangym.test', admin_password: 'ownerpass123',
  }, { token: null, tenant: null });
  adminToken = (await call('POST', '/api/auth/login', { email: 'owner@scangym.test', password: 'ownerpass123' }, { token: null })).body.token;
  const member = (await call('POST', '/api/members', { first_name: 'Asha', phone: '9876504444' }, { token: adminToken })).body;
  await call('POST', '/api/fitness-addons/subscribe', { member_id: member.id }, { token: adminToken });
  memberToken = (await call('POST', '/api/portal/login', { identifier: member.code, pin: '4444' }, { token: null })).body.token;
});

after(() => {
  server.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('barcode validation', () => {
  it('accepts EAN-13, UPC-A and EAN-8, with spaces stripped', () => {
    assert.equal(normaliseBarcode('3017620422003'), '3017620422003');
    assert.equal(normaliseBarcode('0 36000 29145 2'), '036000291452');
    assert.equal(normaliseBarcode('96385074'), '96385074');
  });

  it('refuses letters, short codes and a wrong check digit', () => {
    assert.throws(() => normaliseBarcode('ABC123456789'), /8 to 14 digits/);
    assert.throws(() => normaliseBarcode('12345'), /8 to 14 digits/);
    assert.throws(() => normaliseBarcode('3017620422004'), /check the digits/);
  });
});

describe('reading an Open Food Facts label', () => {
  it('uses per-100 g values and carries the serving size', () => {
    const food = productToFood(PRODUCTS['3017620422003']);
    assert.equal(food.name, 'Nutella');
    assert.equal(food.brand, 'Nutella');
    assert.equal(food.serving_unit, '100g');
    assert.equal(food.calories, 539);
    assert.equal(food.sugar_g, 56.3);
    assert.equal(food.serving_size_g, 15);
  });

  it('falls back to prepared values, converts kJ and spots liquids', () => {
    const food = productToFood(PRODUCTS['8901058000290']);
    assert.equal(food.name, 'Maggi Masala Noodles (as prepared)');
    assert.equal(food.calories, 386);
    assert.equal(food.serving_unit, '100ml');
  });

  it('gives up on a label with no energy or impossible numbers', () => {
    assert.equal(productToFood(PRODUCTS['4006381333931']), null);
    assert.equal(productToFood({ product_name: 'X', nutriments: { 'energy-kcal_100g': 2000 } }), null);
    assert.equal(productToFood({ product_name: 'X', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 140 } }), null);
  });
});

describe('scanning in the member app', () => {
  it('fetches an unknown barcode once, then answers from the gym library', async () => {
    resetBarcodeCaches();
    const before = upstreamRequests;
    const first = await call('GET', '/api/portal/diets/barcode/3017620422003');
    assert.equal(first.status, 200);
    assert.equal(first.body.found, true);
    assert.equal(first.body.source, 'openfoodfacts');
    assert.equal(first.body.food.barcode, '3017620422003');
    assert.equal(first.body.food.source, 'openfoodfacts');
    assert.match(lastUserAgent, /^GymBook\//);

    const again = await call('GET', '/api/portal/diets/barcode/3017620422003');
    assert.equal(again.body.source, 'library');
    assert.equal(again.body.food.id, first.body.food.id);
    assert.equal(upstreamRequests, before + 1);

    // The copy is an ordinary library food: searchable and loggable by id.
    const search = await call('GET', '/api/portal/diets/foods?q=Nutella');
    assert.ok(search.body.items.some((f) => f.id === first.body.food.id));
    const entry = await call('POST', '/api/portal/diets/entries', {
      meal_type: 'snack', food_id: first.body.food.id, quantity: 0.3,
    });
    assert.equal(entry.status, 201);
    assert.equal(entry.body.calories, 162);
    assert.equal(entry.body.sugar_g, 16.9);
  });

  it('matches a UPC-A scan to its EAN-13 form', async () => {
    const asUpc = await call('POST', '/api/portal/diets/barcode-foods', {
      barcode: '036000291452', name: 'Corn Chips', calories: 520,
    });
    assert.equal(asUpc.status, 201);
    const asEan = await call('GET', '/api/portal/diets/barcode/0036000291452');
    assert.equal(asEan.body.found, true);
    assert.equal(asEan.body.food.id, asUpc.body.id);
  });

  it('reports a miss with what little is known, and remembers it', async () => {
    resetBarcodeCaches();
    const before = upstreamRequests;
    const res = await call('GET', '/api/portal/diets/barcode/4006381333931');
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
    assert.deepEqual(res.body.product, { name: 'Mystery Bar', brand: 'Acme' });

    const unknown = await call('GET', '/api/portal/diets/barcode/5000112637922');
    assert.equal(unknown.body.found, false);
    assert.equal(unknown.body.product, null);

    await call('GET', '/api/portal/diets/barcode/5000112637922');
    assert.equal(upstreamRequests, before + 2, 'a remembered miss is not asked again');
  });

  it('lets a member add a product the database does not know', async () => {
    const res = await call('POST', '/api/portal/diets/barcode-foods', {
      barcode: '4006381333931', name: 'Mystery Bar', brand: 'Acme', calories: 380, protein_g: 20, carbs_g: 40,
      fats_g: 14, fiber_g: 6, sugar_g: 12, serving_size_g: 40,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Acme Mystery Bar');
    assert.equal(res.body.source, 'member');
    assert.equal(res.body.serving_unit, '100g');
    assert.equal(res.body.serving_size_g, 40);
    assert.equal(res.body.is_custom, 1);

    // Found from now on, without asking upstream.
    const before = upstreamRequests;
    const lookup = await call('GET', '/api/portal/diets/barcode/4006381333931');
    assert.equal(lookup.body.found, true);
    assert.equal(lookup.body.food.id, res.body.id);
    assert.equal(upstreamRequests, before);

    // A second member adding the same pack gets the first one's row.
    const dup = await call('POST', '/api/portal/diets/barcode-foods', { barcode: '4006381333931', name: 'Other', calories: 1 });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.id, res.body.id);

    // Staff can still delete it like any custom food.
    assert.equal((await call('DELETE', `/api/diets/foods/${res.body.id}`, undefined, { token: adminToken })).status, 200);
  });

  it('refuses a bad barcode and labels with impossible numbers', async () => {
    assert.equal((await call('GET', '/api/portal/diets/barcode/3017620422004')).status, 400);
    const bad = await call('POST', '/api/portal/diets/barcode-foods', { barcode: '4006381333931', name: 'Bar', calories: 1200 });
    assert.equal(bad.status, 400);
  });

  it('says so when the database cannot be reached', async () => {
    resetBarcodeCaches();
    const { config } = await import('../src/config.js');
    const original = config.foodDbUrl;
    config.foodDbUrl = 'http://127.0.0.1:9';
    try {
      const res = await call('GET', '/api/portal/diets/barcode/5449000000996');
      assert.equal(res.status, 502);
      assert.match(res.body.error, /food database/);
    } finally {
      config.foodDbUrl = original;
    }
  });

  it('is part of the paid tracker', async () => {
    const res = await call('GET', '/api/portal/diets/barcode/3017620422003', undefined, { token: null });
    assert.equal(res.status, 401);
  });
});

describe('the vendored decoder', () => {
  // Renders an EAN-13 the way the camera sees one: a greyscale strip of bars.
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  function renderEan13(code, moduleWidth = 3, height = 50) {
    const d = code.split('').map(Number);
    let bits = `${'0'.repeat(11)}101`;
    for (let i = 1; i < 7; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L : G)[d[i]];
    bits += '01010';
    for (let i = 7; i < 13; i++) bits += R[d[i]];
    bits += `101${'0'.repeat(11)}`;
    const width = bits.length * moduleWidth;
    const pixels = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) pixels[y * width + x] = bits[Math.floor(x / moduleWidth)] === '1' ? 25 : 230;
    }
    return { pixels, width, height };
  }

  const source = fs.readFileSync(new URL('../public/js/vendor/zxing-1d.min.js', import.meta.url), 'utf8');
  const decoder = new Function(`${source}; return GymbookBarcode;`)();

  it('reads a product barcode and nothing from a blank frame', () => {
    for (const code of ['3017620422003', '8901058000290']) {
      const { pixels, width, height } = renderEan13(code);
      assert.equal(decoder.decode(pixels, width, height), code);
    }
    assert.equal(decoder.decode(new Uint8ClampedArray(100 * 40).fill(240), 100, 40), null);
  });
});
