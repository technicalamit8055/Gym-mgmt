import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Scanning a pack's barcode to add it to a product list, in all three
 * places that keep one: the operator's central catalogue, a partner shop's
 * shelf and a gym's own desk shelf. Open Food Facts is a local stub.
 */

/** A valid GTIN: the digits given plus their check digit. */
const gtin = (digits) => {
  const sum = digits.split('').map(Number).reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return `${digits}${(10 - (sum % 10)) % 10}`;
};
const WHEY = gtin('890123456789'); // 13 digits, known to Open Food Facts
const UNKNOWN = gtin('890000000001'); // nobody knows it
const UPC = gtin('01234567890'); // 12-digit UPC-A; its EAN-13 form has a leading 0
const BARS = gtin('890555000111');

const OFF = {
  [WHEY]: {
    product_name: 'Biozyme Performance Whey',
    brands: 'MuscleBlaze, Bright Lifecare',
    quantity: '1 kg',
    serving_size: '33 g',
    serving_quantity: 33,
    categories_tags: ['en:dietary-supplements', 'en:protein-powders'],
    image_front_url: 'https://images.openfoodfacts.org/images/products/whey/front.jpg',
    nutriments: { proteins_100g: 75.8, 'energy-kcal_100g': 393.9, carbohydrates_100g: 9.1, fat_100g: 6 },
  },
};
let upstream = 0;
const stub = http.createServer((req, res) => {
  upstream += 1;
  const code = /\/api\/v2\/product\/(\d+)\.json/.exec(req.url)?.[1];
  const product = OFF[code];
  res.writeHead(product ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(product ? { status: 1, code, product: { code, ...product } } : { status: 0, code }));
});
stub.listen(0);
await new Promise((resolve) => stub.once('listening', resolve));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-product-barcode-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';
process.env.FOOD_DB_URL = `http://127.0.0.1:${stub.address().port}`;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;
let ops;
let staff;
let shop;
const TENANT = 'ironworks';

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
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const opsCall = (method, urlPath, body) => call(method, `/api/platform/admin${urlPath}`, body, { token: ops, tenant: null });
const shopCall = (method, urlPath, body) => call(method, `/api/seller${urlPath}`, body, { token: shop, tenant: null });
const gymCall = (method, urlPath, body) => call(method, `/api/store-hub${urlPath}`, body, { token: staff });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const signup = await call(
    'POST',
    '/api/platform/signup',
    { slug: TENANT, gym_name: 'Iron Works', admin_name: 'Owner', admin_email: 'owner@iron.test', admin_password: 'ownerpass123' },
    { tenant: null },
  );
  assert.equal(signup.status, 201);
  staff = (await call('POST', '/api/auth/login', { email: 'owner@iron.test', password: 'ownerpass123' })).body.token;
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' }, { tenant: null })).body.token;
  const seller = await opsCall('POST', '/sellers', {
    name: 'Muscle Mart',
    owner_name: 'Rahul',
    email: 'rahul@mm.test',
    phone: '9820011111',
    city: 'Mumbai',
    gyms: [TENANT],
  });
  shop = (await shopCall('POST', '/login', { email: 'rahul@mm.test', password: seller.body.password })).body.token;
});

after(() => {
  server?.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('operator: central catalogue', () => {
  let product;

  it('starts a new listing from Open Food Facts when nothing on the platform has the code', async () => {
    const res = await opsCall('GET', `/store/barcode/${WHEY}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.existing, null);
    assert.equal(res.body.source, 'openfoodfacts');
    const s = res.body.suggestion;
    assert.equal(s.title, 'Biozyme Performance Whey');
    assert.equal(s.brand, 'MuscleBlaze');
    assert.equal(s.category, 'protein');
    assert.equal(s.size, '1 kg');
    assert.equal(s.image_url, OFF[WHEY].image_front_url);
    // Per serving, scaled from per 100 g by the 33 g scoop.
    assert.deepEqual(s.nutrition_facts, { serving_size: '33 g', calories: 130, protein_g: 25, carbs_g: 3, fat_g: 2 });
  });

  it('refuses a code that is not a barcode', async () => {
    assert.equal((await opsCall('GET', '/store/barcode/12345')).status, 400);
    assert.equal((await opsCall('GET', `/store/barcode/${WHEY.slice(0, -1)}${(Number(WHEY.at(-1)) + 1) % 10}`)).status, 400);
  });

  it('keeps the barcode on the product, so the next scan finds it', async () => {
    const created = await opsCall('POST', '/store/products', {
      title: 'Biozyme Performance Whey',
      brand: 'MuscleBlaze',
      category: 'protein',
      mrp: 3299,
      price: 2799,
      barcode: WHEY,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    product = created.body;
    assert.equal(product.barcode, WHEY);
    const again = await opsCall('GET', `/store/barcode/${WHEY}`);
    assert.equal(again.body.existing.id, product.id);
  });

  it('lists one pack once per shelf', async () => {
    const dupe = await opsCall('POST', '/store/products', { title: 'Whey again', brand: 'MB', mrp: 10, price: 9, barcode: WHEY });
    assert.equal(dupe.status, 409);
    const twice = await opsCall('POST', '/store/products', {
      title: 'Two of the same',
      brand: 'MB',
      mrp: 10,
      price: 9,
      variants: [{ flavor: 'A', barcode: BARS }, { flavor: 'B', barcode: BARS }],
    });
    assert.equal(twice.status, 400);
  });

  it('treats a UPC-A and its EAN-13 form as the same pack', async () => {
    const created = await opsCall('POST', '/store/products', { title: 'Imported Creatine', brand: 'ON', category: 'creatine', mrp: 1999, price: 1799, barcode: UPC });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const scanned = await opsCall('GET', `/store/barcode/0${UPC}`);
    assert.equal(scanned.body.existing.id, created.body.id);
  });
});

describe('partner shop: its own shelf', () => {
  it('fills a new listing from the catalogue’s, with the pack’s MRP but never the price', async () => {
    const res = await shopCall('GET', `/barcode/${WHEY}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.existing, null, 'the central product is not on this shop’s shelf');
    assert.equal(res.body.source, 'catalogue');
    assert.equal(res.body.suggestion.title, 'Biozyme Performance Whey');
    assert.equal(res.body.suggestion.mrp, 3299);
    assert.equal(res.body.suggestion.price, undefined);
  });

  it('finds the flavour × size a code belongs to', async () => {
    const created = await shopCall('POST', '/products', {
      title: 'Biozyme Performance Whey',
      brand: 'MuscleBlaze',
      category: 'protein',
      mrp: 3299,
      price: 2599,
      variants: [
        { flavor: 'Chocolate', weight: '1 kg', barcode: WHEY },
        { flavor: 'Chocolate', weight: '2 kg', barcode: BARS },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const res = await shopCall('GET', `/barcode/${BARS}`);
    assert.equal(res.body.existing.id, created.body.id);
    assert.equal(res.body.variant_id, created.body.variants[1].id);
  });

  it('is shop-only', async () => {
    assert.equal((await call('GET', `/api/seller/barcode/${WHEY}`, null, { token: staff })).status, 401);
    assert.equal((await call('GET', `/api/store-hub/barcode/${WHEY}`, null, { token: shop })).status, 401);
  });
});

describe('gym desk: its own shelf', () => {
  let tub;

  it('suggests a gym product from what the platform knows, priced at the pack’s MRP', async () => {
    const res = await gymCall('GET', `/barcode/${WHEY}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.existing, null);
    // The newest listing of the code is the shop's tub, flavour and size included.
    assert.equal(res.body.suggestion.name, 'MuscleBlaze Biozyme Performance Whey Chocolate 1 kg');
    assert.equal(res.body.suggestion.category, 'supplements');
    assert.equal(res.body.suggestion.price, 3299);
  });

  it('remembers a code Open Food Facts does not know, and still lets the gym add it', async () => {
    const before = upstream;
    const first = await gymCall('GET', `/barcode/${UNKNOWN}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.suggestion, null);
    await gymCall('GET', `/barcode/${UNKNOWN}`);
    assert.equal(upstream - before, 1, 'a miss is not asked about twice');

    const created = await gymCall('POST', '/products', { name: 'Iron Works Shaker', category: 'accessories', price: 299, stock_quantity: 12, barcode: UNKNOWN });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    tub = created.body;
    const scanned = await gymCall('GET', `/barcode/${UNKNOWN}`);
    assert.equal(scanned.body.existing.id, tub.id);
    assert.equal(scanned.body.existing.stock_quantity, 12);
  });

  it('keeps one product per code, and can clear a code', async () => {
    assert.equal((await gymCall('POST', '/products', { name: 'Another', price: 1, barcode: UNKNOWN })).status, 409);
    const cleared = await gymCall('PATCH', `/products/${tub.id}`, { barcode: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.barcode, null);
    assert.equal((await gymCall('GET', `/barcode/${UNKNOWN}`)).body.existing, null);
  });
});
