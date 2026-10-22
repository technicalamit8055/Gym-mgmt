import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The CoachBook store: the gym store's engine with its own catalogue, switch,
 * cut, banners and partner bookshops, shown only to coaching institutes'
 * students — and the gym store kept exactly as it was for gyms.
 *
 * Razorpay's Orders API and Open Library are one local stub.
 */

/** A valid GTIN: the digits given plus their check digit. */
const gtin = (digits) => {
  const sum = digits.split('').map(Number).reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return `${digits}${(10 - (sum % 10)) % 10}`;
};
const HC_VERMA = gtin('978817709187'); // known to the Open Library stub
const UNKNOWN_BOOK = gtin('978000000000');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-store-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';
process.env.MAIL_TRANSPORT = 'memory';

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/orders') {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: `order_${crypto.randomBytes(4).toString('hex')}`, amount: body.amount, currency: body.currency }));
    }
    if (req.url.startsWith('/api/books')) {
      const key = new URL(req.url, 'http://stub').searchParams.get('bibkeys');
      const books = {
        [`ISBN:${HC_VERMA}`]: {
          title: 'Concepts of Physics',
          subtitle: 'Volume 1',
          authors: [{ name: 'H. C. Verma' }],
          publishers: [{ name: 'Bharati Bhawan' }],
          number_of_pages: 468,
          publish_date: '2019',
          subjects: [{ name: 'Physics' }, { name: 'JEE' }],
          cover: { large: 'https://covers.openlibrary.org/b/id/1-L.jpg' },
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(books[key] ? { [key]: books[key] } : {}));
    }
    res.writeHead(404).end('{}');
  });
});
stub.listen(0);
await new Promise((resolve) => stub.once('listening', resolve));
process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.BOOK_DB_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.FOOD_DB_URL = `http://127.0.0.1:${stub.address().port}`;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;
let ops;
const tenants = {
  apex: { name: 'Apex Institute', type: 'coaching' },
  kota: { name: 'Kota Classes', type: 'coaching' },
  ironworks: { name: 'Iron Works', type: 'gym' },
};

const call = async (method, urlPath, body, { token, tenant = 'apex' } = {}) => {
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
const shopCall = (token, method, urlPath, body) => call(method, `/api/seller${urlPath}`, body, { token, tenant: null });
const sign = (orderId, paymentId) => crypto.createHmac('sha256', 'rzp-test-secret').update(`${orderId}|${paymentId}`).digest('hex');
const pay = (who, checkout, paymentId) =>
  call(
    'POST',
    '/api/portal/store/verify',
    { razorpay_order_id: checkout.order_id, razorpay_payment_id: paymentId, razorpay_signature: sign(checkout.order_id, paymentId) },
    { token: who.member, tenant: who.slug },
  );
const student = (slug) => (method, urlPath, body) => call(method, urlPath, body, { token: tenants[slug].member, tenant: slug });

let book;
let pen;
let whey;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' }, { tenant: null })).body.token;

  for (const [slug, t] of Object.entries(tenants)) {
    const email = `owner@${slug}.test`;
    const signup = await call(
      'POST',
      '/api/platform/signup',
      { slug, gym_name: t.name, admin_name: 'Owner', admin_email: email, admin_password: 'ownerpass123', business_type: t.type },
      { tenant: null },
    );
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    t.slug = slug;
    t.staff = (await call('POST', '/api/auth/login', { email, password: 'ownerpass123' }, { tenant: slug })).body.token;
    const member = await call('POST', '/api/members', { first_name: 'Riya', last_name: 'S', phone: '9990001111' }, { token: t.staff, tenant: slug });
    assert.equal(member.status, 201, JSON.stringify(member.body));
    t.member = await signInMember(call, { staffToken: t.staff, memberId: member.body.id, tenant: slug });
  }
});

after(() => {
  server?.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('two stores, one engine', () => {
  it('gives the coaching store its own switch, cut and promises', async () => {
    const res = await opsCall('GET', '/monetization');
    assert.equal(res.status, 200);
    assert.equal(res.body.stores.gym.store_status, 'coming_soon');
    assert.equal(res.body.stores.coaching.store_status, 'coming_soon');
    assert.equal(res.body.stores.coaching.store_commission_pct, 7.5);
    assert.match(res.body.stores.coaching.pickup_eta, /institute/);
    assert.deepEqual(res.body.options.categories_by_store.coaching.slice(0, 3), ['books', 'test_prep', 'pyq']);

    const saved = await opsCall('PUT', '/monetization', { coaching_store_commission_pct: 10, coaching_delivery_eta: 'Delivery in 2–3 days' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.stores.coaching.store_commission_pct, 10);
    assert.equal(saved.body.stores.gym.store_commission_pct, 7.5);
  });

  it('keeps each store’s categories to its own products', async () => {
    const wrong = await opsCall('POST', '/store/products', { vertical: 'coaching', title: 'Whey', brand: 'ON', category: 'protein', mrp: 100, price: 90 });
    assert.equal(wrong.status, 400);
    const alsoWrong = await opsCall('POST', '/store/products', { title: 'A book', brand: 'NCERT', category: 'books', mrp: 100, price: 90 });
    assert.equal(alsoWrong.status, 400);

    const created = await opsCall('POST', '/store/products', {
      vertical: 'coaching',
      title: 'Concepts of Physics — Vol. 1',
      brand: 'Bharati Bhawan',
      category: 'books',
      mrp: 525,
      price: 449,
      lab_report_url: 'https://example.com/sample.pdf',
      book_details: { author: 'H. C. Verma', pages: '468', language: 'English', exam: 'JEE Main & Advanced', isbn: HC_VERMA },
      variants: [
        { flavor: 'English', weight: 'Paperback' },
        { flavor: 'Hindi', weight: 'Paperback', price: 399, mrp: 475 },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    book = created.body;
    assert.equal(book.vertical, 'coaching');
    assert.deepEqual(book.book_details, { author: 'H. C. Verma', language: 'English', pages: 468, isbn: HC_VERMA, exam: 'JEE Main & Advanced' });
    assert.deepEqual(book.flavors, ['English', 'Hindi']);

    // A category move stays inside the product's own store.
    assert.equal((await opsCall('PATCH', `/store/products/${book.id}`, { category: 'creatine' })).status, 400);
    assert.equal((await opsCall('PATCH', `/store/products/${book.id}`, { book_details: { pages: 'many' } })).status, 400);

    pen = (await opsCall('POST', '/store/products', { vertical: 'coaching', title: 'Gel pens (pack of 10)', brand: 'Cello', category: 'stationery', mrp: 120, price: 99 })).body;
    whey = (await opsCall('POST', '/store/products', { title: 'Platform Whey', brand: 'ON', category: 'protein', mrp: 3500, price: 2999 })).body;
    assert.equal(whey.vertical, 'gym');

    const list = await opsCall('GET', '/store/products?vertical=coaching');
    assert.deepEqual(list.body.items.map((p) => p.id).sort(), [book.id, pen.id].sort());
    assert.deepEqual(list.body.categories, ['books', 'test_prep', 'pyq', 'stationery', 'calculators', 'desk', 'bags', 'other']);
  });

  it('opens each store on its own switch', async () => {
    // The gym store goes live; the institute's students still see coming soon.
    assert.equal((await opsCall('PUT', '/monetization', { store_status: 'live' })).status, 200);
    const me = await student('apex')('GET', '/api/portal/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.monetization.store_status, 'coming_soon');
    const front = await student('apex')('GET', '/api/portal/store');
    assert.equal(front.body.status, 'coming_soon');
    assert.equal(front.body.vertical, 'coaching');
    assert.deepEqual(front.body.products, []);

    const gymFront = await student('ironworks')('GET', '/api/portal/store');
    assert.equal(gymFront.body.status, 'live');
    assert.deepEqual(gymFront.body.products.map((p) => p.id), [whey.id]);
  });

  it('will not open an empty coaching store, or empty a live one', async () => {
    await opsCall('PATCH', `/store/products/${book.id}`, { active: false });
    await opsCall('PATCH', `/store/products/${pen.id}`, { active: false });
    // A live gym product does not count for the coaching store.
    const refused = await opsCall('PUT', '/monetization', { coaching_store_status: 'live' });
    assert.equal(refused.status, 400);
    assert.ok(refused.body.details.coaching_store_status);

    await opsCall('PATCH', `/store/products/${book.id}`, { active: true });
    await opsCall('PATCH', `/store/products/${pen.id}`, { active: true });
    assert.equal((await opsCall('PUT', '/monetization', { coaching_store_status: 'live' })).status, 200);
    await opsCall('PATCH', `/store/products/${pen.id}`, { active: false });
    assert.equal((await opsCall('PATCH', `/store/products/${book.id}`, { active: false })).status, 409);
    await opsCall('PATCH', `/store/products/${pen.id}`, { active: true });
  });

  it('shows students only the coaching catalogue and banners', async () => {
    const offBrand = await opsCall('POST', '/store/banners', { vertical: 'coaching', title: 'Whey week', link_type: 'category', link_value: 'protein' });
    assert.equal(offBrand.status, 400);
    const gymProduct = await opsCall('POST', '/store/banners', { vertical: 'coaching', title: 'Whey', link_type: 'product', link_value: String(whey.id) });
    assert.equal(gymProduct.status, 400);
    const banner = await opsCall('POST', '/store/banners', { vertical: 'coaching', title: 'JEE starter kit', link_type: 'category', link_value: 'books' });
    assert.equal(banner.status, 201);
    assert.equal(banner.body.vertical, 'coaching');
    await opsCall('POST', '/store/banners', { title: 'Whey week', link_type: 'category', link_value: 'protein' });

    const front = await student('apex')('GET', '/api/portal/store');
    assert.equal(front.body.status, 'live');
    assert.deepEqual(front.body.products.map((p) => p.id).sort(), [book.id, pen.id].sort());
    assert.deepEqual(front.body.banners.map((b) => b.title), ['JEE starter kit']);
    assert.match(front.body.delivery.pickup_eta, /institute/);
    assert.equal(front.body.delivery.eta, 'Delivery in 2–3 days');

    const gymFront = await student('ironworks')('GET', '/api/portal/store');
    assert.deepEqual(gymFront.body.products.map((p) => p.id), [whey.id]);
    assert.deepEqual(gymFront.body.banners.map((b) => b.title), ['Whey week']);
  });
});

describe('a student’s order', () => {
  let order;

  it('cannot put a gym product in an institute’s cart', async () => {
    const res = await student('apex')('POST', '/api/portal/store/checkout', {
      items: [{ product_id: whey.id, quantity: 1 }],
      method: 'pickup',
      shipping: { name: 'Riya S', phone: '9990001111' },
    });
    assert.equal(res.status, 400);
    const noEdition = await student('apex')('POST', '/api/portal/store/checkout', {
      items: [{ product_id: book.id, quantity: 1 }],
      method: 'pickup',
      shipping: { name: 'Riya S', phone: '9990001111' },
    });
    assert.equal(noEdition.status, 400);
    assert.match(noEdition.body.error, /edition or format/);
  });

  it('is a CB- order at the coaching cut, picked up at the institute', async () => {
    const hindi = book.variants.find((v) => v.flavor === 'Hindi');
    const res = await student('apex')('POST', '/api/portal/store/checkout', {
      items: [
        { product_id: book.id, variant_id: hindi.id, quantity: 2 },
        { product_id: pen.id, quantity: 1 },
      ],
      method: 'pickup',
      shipping: { name: 'Riya S', phone: '9990001111' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    order = res.body.order;
    assert.match(order.order_code, /^CB-\d{6}-[0-9A-F]{6}$/);
    assert.equal(order.vertical, 'coaching');
    assert.equal(order.subtotal, 399 * 2 + 99);
    assert.equal(order.commission_pct, 10);
    assert.equal(order.commission_amount, 89.7);
    assert.equal(res.body.checkout.name, 'Apex Institute');
    assert.equal((await pay(tenants.apex, res.body.checkout, 'pay_cb_1')).status, 200);
  });

  it('lists coaching orders apart in the console', async () => {
    const coachingOrders = await opsCall('GET', '/store/orders?vertical=coaching');
    assert.deepEqual(coachingOrders.body.items.map((o) => o.order_code), [order.order_code]);
    assert.equal((await opsCall('GET', '/store/orders?vertical=gym')).body.items.length, 0);
    const state = await opsCall('GET', '/monetization');
    assert.equal(state.body.summary.stores.coaching.orders, 1);
    assert.equal(state.body.summary.stores.gym.orders, 0);
    const balances = await opsCall('GET', '/commissions');
    assert.equal(balances.body.items.find((r) => r.tenant_slug === 'apex').vertical, 'coaching');
  });

  it('is received and handed over at the institute office, which makes the cut final', async () => {
    const office = (method, urlPath) => call(method, `/api/store-hub${urlPath}`, method === 'POST' ? {} : null, { token: tenants.apex.staff, tenant: 'apex' });
    const pickups = await office('GET', '/pickups');
    assert.deepEqual(pickups.body.items.map((o) => o.order_code), [order.order_code]);

    const summary = await office('GET', '/summary');
    assert.equal(summary.body.platform.store_status, 'live');
    assert.equal(summary.body.platform.store_vertical, 'coaching');
    assert.equal(summary.body.platform.store_commission_pct, 10);
    assert.equal(summary.body.platform.pending, 89.7);

    assert.equal((await office('POST', `/pickups/${order.id}/received`)).status, 200);
    const inbox = await student('apex')('GET', '/api/portal/notifications');
    assert.ok(inbox.body.items.some((n) => /office/.test(n.body)), JSON.stringify(inbox.body.items));
    assert.equal((await office('POST', `/pickups/${order.id}/collected`)).status, 200);
    const after = await office('GET', '/summary');
    assert.equal(after.body.platform.payable, 89.7);
  });
});

describe('partner bookshops', () => {
  let shop;
  let shopToken;

  it('sell in the coaching store, to institutes only', async () => {
    const options = await opsCall('GET', '/sellers');
    assert.equal(options.body.gyms.find((g) => g.slug === 'kota').vertical, 'coaching');
    assert.equal(options.body.gym_commission_pct_by_store.coaching, 10);

    const toGym = await opsCall('POST', '/sellers', {
      name: 'Vidya Book Depot', owner_name: 'Meena Rao', email: 'books@vidya.test', phone: '98200 22222', city: 'Kota', vertical: 'coaching', gyms: ['ironworks'],
    });
    assert.equal(toGym.status, 400);

    const res = await opsCall('POST', '/sellers', {
      name: 'Vidya Book Depot', owner_name: 'Meena Rao', email: 'books@vidya.test', phone: '98200 22222', city: 'Kota', vertical: 'coaching', gyms: ['kota'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    shop = res.body.seller;
    assert.equal(shop.vertical, 'coaching');
    assert.equal(shop.rates.gym_commission_pct, 10);
    // A supplement shop cannot take an institute either.
    const supplements = await opsCall('POST', '/sellers', {
      name: 'Muscle Mart', owner_name: 'Rahul', email: 'rahul@mm.test', phone: '98200 11111', city: 'Kota', gyms: ['kota'],
    });
    assert.equal(supplements.status, 400);

    shopToken = (await shopCall(null, 'POST', '/login', { email: 'books@vidya.test', password: res.body.password })).body.token;
    const me = await shopCall(shopToken, 'GET', '/me');
    assert.equal(me.body.store_status, 'live');
    assert.equal(me.body.options.categories[0], 'books');
    assert.match(me.body.defaults.pickup_eta, /institute/);
  });

  it('stock their own shelf, which their institutes see instead of the central one', async () => {
    assert.equal((await shopCall(shopToken, 'POST', '/products', { title: 'Whey', brand: 'ON', category: 'protein', mrp: 10, price: 9 })).status, 400);
    const created = await shopCall(shopToken, 'POST', '/products', { title: 'NCERT Chemistry Class 12', brand: 'NCERT', category: 'books', mrp: 250, price: 230 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.vertical, 'coaching');

    const kota = await student('kota')('GET', '/api/portal/store');
    assert.deepEqual(kota.body.products.map((p) => p.title), ['NCERT Chemistry Class 12']);
    assert.equal(kota.body.seller.name, 'Vidya Book Depot');
    const apex = await student('apex')('GET', '/api/portal/store');
    assert.equal(apex.body.seller, null);

    // With products on its shelf, it stays a bookshop.
    assert.equal((await opsCall('PATCH', `/sellers/${shop.id}`, { vertical: 'gym', gyms: [] })).status, 409);
  });
});

describe('scanning a book', () => {
  it('fills a new coaching listing in from Open Library by its ISBN', async () => {
    const res = await opsCall('GET', `/store/barcode/${HC_VERMA}?vertical=coaching`);
    assert.equal(res.status, 200);
    // The central coaching catalogue does not carry this ISBN as a barcode yet.
    assert.equal(res.body.existing, null);
    assert.equal(res.body.source, 'openlibrary');
    assert.equal(res.body.suggestion.title, 'Concepts of Physics: Volume 1');
    assert.equal(res.body.suggestion.brand, 'Bharati Bhawan');
    assert.equal(res.body.suggestion.category, 'test_prep');
    assert.deepEqual(res.body.suggestion.book_details, { author: 'H. C. Verma', publisher: 'Bharati Bhawan', year: 2019, pages: 468, isbn: HC_VERMA });

    const unknown = await opsCall('GET', `/store/barcode/${UNKNOWN_BOOK}?vertical=coaching`);
    assert.equal(unknown.body.suggestion, null);
  });

  it('finds a book already on the coaching shelf, and keeps the two stores’ barcodes apart', async () => {
    assert.equal((await opsCall('PATCH', `/store/products/${book.id}`, { barcode: HC_VERMA })).status, 200);
    const hit = await opsCall('GET', `/store/barcode/${HC_VERMA}?vertical=coaching`);
    assert.equal(hit.body.existing.id, book.id);
    // The gym catalogue may list the same code without clashing.
    const gymCopy = await opsCall('POST', '/store/products', { title: 'Odd pack', brand: 'X', category: 'other', mrp: 10, price: 9, barcode: HC_VERMA });
    assert.equal(gymCopy.status, 201, JSON.stringify(gymCopy.body));
  });
});
