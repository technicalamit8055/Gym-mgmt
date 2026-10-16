import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Partner shops: the operator adds a supplement shop and assigns it the gyms
 * of its area; the shop signs in to its own panel, stocks its own shelf and
 * fulfils its gyms' orders; gyms with no shop keep the central catalogue.
 *
 * Razorpay's Orders API is a local stub, as in monetization.test.js.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-sellers-test-'));
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
    res.writeHead(404).end('{}');
  });
});
stub.listen(0);
await new Promise((resolve) => stub.once('listening', resolve));
process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${stub.address().port}`;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { outbox } = await import('../src/mailer.js');

let base;
let server;
let ops;
const gyms = {
  ironworks: { name: 'Iron Works' },
  pulse: { name: 'Pulse Fitness' },
};

const call = async (method, urlPath, body, { token, tenant = 'ironworks' } = {}) => {
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

const sign = (orderId, paymentId) =>
  crypto.createHmac('sha256', 'rzp-test-secret').update(`${orderId}|${paymentId}`).digest('hex');
const pay = (gym, checkout, paymentId) =>
  call(
    'POST',
    '/api/portal/store/verify',
    { razorpay_order_id: checkout.order_id, razorpay_payment_id: paymentId, razorpay_signature: sign(checkout.order_id, paymentId) },
    { token: gym.member, tenant: gym.slug },
  );
const shipping = { name: 'Asha K', phone: '9990001111', address: '12 Linking Road, Bandra', city: 'Mumbai', pincode: '400050' };

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' }, { tenant: null })).body
    .token;

  for (const [slug, gym] of Object.entries(gyms)) {
    const email = `owner@${slug}.test`;
    const signup = await call(
      'POST',
      '/api/platform/signup',
      { slug, gym_name: gym.name, admin_name: 'Owner', admin_email: email, admin_password: 'ownerpass123' },
      { tenant: null },
    );
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    gym.slug = slug;
    gym.staff = (await call('POST', '/api/auth/login', { email, password: 'ownerpass123' }, { tenant: slug })).body.token;
    const member = await call('POST', '/api/members', { first_name: 'Asha', last_name: 'K', phone: '9990001111' }, { token: gym.staff, tenant: slug });
    gym.member = await signInMember(call, { staffToken: gym.staff, memberId: member.body.id, tenant: slug });
  }

  const central = await opsCall('POST', '/store/products', { title: 'Platform Whey', brand: 'ON', category: 'protein', mrp: 3500, price: 2999 });
  assert.equal(central.status, 201);
  gyms.centralProductId = central.body.id;
  assert.equal((await opsCall('PUT', '/monetization', { store_status: 'live' })).status, 200);
});

after(() => {
  server?.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('partner shops', () => {
  let shop;
  let shopToken;
  let password;
  let shopProduct;
  let order;

  it('lets the operator add a shop for an area, with a one-time password', async () => {
    const options = await opsCall('GET', '/sellers');
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.gyms.map((g) => g.slug).sort(), ['ironworks', 'pulse']);

    const res = await opsCall('POST', '/sellers', {
      name: 'Muscle Mart Bandra',
      owner_name: 'Rahul Shah',
      email: 'Rahul@MuscleMart.test',
      phone: '98200 11111',
      city: 'Mumbai',
      area: 'Bandra West',
      platform_fee_pct: 10,
      gyms: ['ironworks'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    shop = res.body.seller;
    password = res.body.password;
    assert.match(password, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.equal(shop.email, 'rahul@musclemart.test');
    assert.equal(shop.password_hash, undefined);
    assert.deepEqual(shop.gyms.map((g) => g.slug), ['ironworks']);
    assert.equal(shop.must_change_password, true);

    assert.equal((await opsCall('POST', '/sellers', { ...res.body.seller, email: 'rahul@musclemart.test', gyms: [] })).status, 409);
    assert.equal((await opsCall('POST', '/sellers', { name: 'X', owner_name: 'Y', email: 'x@y.test', phone: '1', city: 'Pune' })).status, 400);
  });

  it('signs the shop in to its own panel, and nowhere else', async () => {
    assert.equal((await shopCall(null, 'POST', '/login', { email: 'rahul@musclemart.test', password: 'wrong-password' })).status, 401);
    const login = await shopCall(null, 'POST', '/login', { email: 'RAHUL@musclemart.test', password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    shopToken = login.body.token;

    const me = await shopCall(shopToken, 'GET', '/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.seller.name, 'Muscle Mart Bandra');

    // A shop token opens neither the console nor a gym; their tokens do not open the panel.
    assert.equal((await call('GET', '/api/platform/admin/sellers', null, { token: shopToken, tenant: null })).status, 403);
    assert.equal((await call('GET', '/api/members', null, { token: shopToken })).status, 401);
    assert.equal((await call('GET', '/api/portal/me', null, { token: shopToken })).status, 401);
    assert.equal((await shopCall(ops, 'GET', '/me')).status, 401);
    assert.equal((await shopCall(gyms.ironworks.staff, 'GET', '/me')).status, 401);
    assert.equal((await shopCall(gyms.ironworks.member, 'GET', '/me')).status, 401);
  });

  it('keeps the central catalogue showing until the shop has stock', async () => {
    const store = await call('GET', '/api/portal/store', null, { token: gyms.ironworks.member });
    assert.deepEqual(store.body.products.map((p) => p.title), ['Platform Whey']);
    assert.equal(store.body.seller, null);
  });

  it('stocks its own shelf, without the operator’s quality badges', async () => {
    const badge = await opsCall('POST', '/store/badges', { name: 'Lab tested' });
    const res = await shopCall(shopToken, 'POST', '/products', {
      title: 'MuscleBlaze Biozyme',
      brand: 'MuscleBlaze',
      category: 'protein',
      mrp: 3000,
      price: 2000,
      badge_ids: [badge.body.id],
      variants: [{ flavor: 'Chocolate', weight: '1 kg' }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    shopProduct = res.body;
    assert.equal(shopProduct.seller_id, shop.id);
    assert.deepEqual(shopProduct.badges, []);

    const shelf = await shopCall(shopToken, 'GET', '/products');
    assert.deepEqual(shelf.body.items.map((p) => p.title), ['MuscleBlaze Biozyme']);
    // The console's central catalogue does not fill up with shop listings.
    assert.deepEqual((await opsCall('GET', '/store/products')).body.items.map((p) => p.title), ['Platform Whey']);
  });

  it('cannot touch a product that is not its own', async () => {
    assert.equal((await shopCall(shopToken, 'PATCH', `/products/${gyms.centralProductId}`, { price: 1 })).status, 404);
    assert.equal((await shopCall(shopToken, 'DELETE', `/products/${gyms.centralProductId}`)).status, 404);
  });

  it('shows the shop’s shelf and promise to its gyms only', async () => {
    assert.equal((await shopCall(shopToken, 'PATCH', '/me', { delivery_eta: 'Delivery today in Bandra' })).status, 200);

    const iron = await call('GET', '/api/portal/store', null, { token: gyms.ironworks.member, tenant: 'ironworks' });
    assert.deepEqual(iron.body.products.map((p) => p.title), ['MuscleBlaze Biozyme']);
    assert.equal(iron.body.seller.name, 'Muscle Mart Bandra');
    assert.equal(iron.body.delivery.eta, 'Delivery today in Bandra');

    const pulse = await call('GET', '/api/portal/store', null, { token: gyms.pulse.member, tenant: 'pulse' });
    assert.deepEqual(pulse.body.products.map((p) => p.title), ['Platform Whey']);
    assert.equal(pulse.body.seller, null);
  });

  it('only sells a gym what its own shelf carries', async () => {
    const wrongShelf = await call(
      'POST',
      '/api/portal/store/checkout',
      { items: [{ product_id: gyms.centralProductId, quantity: 1 }], shipping },
      { token: gyms.ironworks.member, tenant: 'ironworks' },
    );
    assert.equal(wrongShelf.status, 400);
    const otherGym = await call(
      'POST',
      '/api/portal/store/checkout',
      { items: [{ product_id: shopProduct.id, variant_id: shopProduct.variants[0].id, quantity: 1 }], shipping },
      { token: gyms.pulse.member, tenant: 'pulse' },
    );
    assert.equal(otherGym.status, 400);
  });

  it('routes the order to the shop with the money split fixed on it', async () => {
    const res = await call(
      'POST',
      '/api/portal/store/checkout',
      { items: [{ product_id: shopProduct.id, variant_id: shopProduct.variants[0].id, quantity: 2 }], shipping },
      { token: gyms.ironworks.member, tenant: 'ironworks' },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    order = res.body.order;
    assert.equal(order.subtotal, 4000);
    assert.equal(order.seller_id, shop.id);
    assert.equal(order.commission_amount, 300); // 7.5% to the gym
    assert.equal(order.seller_fee_amount, 400); // 10% to the platform
    assert.equal(order.seller_amount, 3300);

    // Not in the panel until it is paid.
    assert.equal((await shopCall(shopToken, 'GET', '/orders')).body.items.length, 0);
    outbox.length = 0;
    assert.equal((await pay(gyms.ironworks, res.body.checkout, 'pay_shop_1')).status, 200);

    const orders = await shopCall(shopToken, 'GET', '/orders');
    assert.deepEqual(orders.body.items.map((o) => o.order_code), [order.order_code]);
    assert.equal(orders.body.items[0].gym_name, 'Iron Works');
    const mail = outbox.find((m) => m.to === 'rahul@musclemart.test');
    assert.ok(mail, 'the shop is emailed about a paid order');
    assert.match(mail.subject, new RegExp(order.order_code));

    const consoleOrders = await opsCall('GET', '/store/orders');
    assert.equal(consoleOrders.body.items.find((o) => o.id === order.id).seller_name, 'Muscle Mart Bandra');
  });

  it('leaves the gym desk’s steps to the gym', async () => {
    assert.equal((await shopCall(shopToken, 'PATCH', `/orders/${order.id}`, { fulfillment_status: 'ready' })).status, 400);
  });

  it('ships and delivers, which makes its share payable, then gets paid out', async () => {
    const shipped = await shopCall(shopToken, 'PATCH', `/orders/${order.id}`, {
      fulfillment_status: 'shipped',
      courier_name: 'Shop rider',
    });
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
    let me = await shopCall(shopToken, 'GET', '/me');
    assert.equal(me.body.seller.stats.pending, 3300);
    assert.equal(me.body.seller.stats.payable, 0);

    assert.equal((await shopCall(shopToken, 'PATCH', `/orders/${order.id}`, { fulfillment_status: 'delivered' })).status, 200);
    me = await shopCall(shopToken, 'GET', '/me');
    assert.equal(me.body.seller.stats.payable, 3300);

    const payout = await opsCall('POST', `/sellers/${shop.id}/payout`, { payout_ref: 'UTR123456' });
    assert.equal(payout.status, 200);
    assert.equal(payout.body.total, 3300);
    me = await shopCall(shopToken, 'GET', '/me');
    assert.equal(me.body.seller.stats.payable, 0);
    assert.equal(me.body.seller.stats.paid, 3300);
    assert.equal(me.body.payouts[0].payout_ref, 'UTR123456');
    assert.equal((await opsCall('POST', `/sellers/${shop.id}/payout`, { payout_ref: 'UTR999' })).status, 400);

    // The gym's commission went through the same delivery as before.
    const hub = await call('GET', '/api/store-hub/summary', null, { token: gyms.ironworks.staff, tenant: 'ironworks' });
    assert.equal(hub.body.platform.payable, 300);
  });

  it('does not let another shop see or touch those orders', async () => {
    const other = await opsCall('POST', '/sellers', {
      name: 'Delhi Supplements',
      owner_name: 'Priya',
      email: 'priya@delhi.test',
      phone: '9811122222',
      city: 'Delhi',
    });
    const login = await shopCall(null, 'POST', '/login', { email: 'priya@delhi.test', password: other.body.password });
    assert.equal((await shopCall(login.body.token, 'GET', '/orders')).body.items.length, 0);
    assert.equal((await shopCall(login.body.token, 'PATCH', `/orders/${order.id}`, { tracking_id: 'X' })).status, 404);
    assert.equal((await shopCall(login.body.token, 'PATCH', `/products/${shopProduct.id}`, { price: 1 })).status, 404);

    // Taking over a gym moves it, and says from whom.
    const moved = await opsCall('PATCH', `/sellers/${other.body.seller.id}`, { gyms: ['ironworks'] });
    assert.equal(moved.body.moved[0].slug, 'ironworks');
    assert.deepEqual((await opsCall('GET', '/sellers')).body.items.find((s) => s.id === shop.id).gyms, []);
    assert.equal((await opsCall('PATCH', `/sellers/${shop.id}`, { gyms: ['ironworks'] })).status, 200);

    assert.equal((await opsCall('DELETE', `/sellers/${other.body.seller.id}`)).status, 200);
    assert.equal((await opsCall('DELETE', `/sellers/${shop.id}`)).status, 409);
  });

  it('signs out every device on a password change', async () => {
    const short = await shopCall(shopToken, 'POST', '/me/password', { current_password: password, new_password: 'short' });
    assert.equal(short.status, 400);
    const changed = await shopCall(shopToken, 'POST', '/me/password', { current_password: password, new_password: 'my-own-pass-123' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.seller.must_change_password, false);
    assert.equal((await shopCall(shopToken, 'GET', '/me')).status, 401);
    shopToken = changed.body.token;
    assert.equal((await shopCall(shopToken, 'GET', '/me')).status, 200);
  });

  it('pausing a shop locks it out and hands its gyms back to the central catalogue', async () => {
    assert.equal((await opsCall('PATCH', `/sellers/${shop.id}`, { active: false })).status, 200);
    assert.equal((await shopCall(shopToken, 'GET', '/me')).status, 401);
    assert.equal((await shopCall(null, 'POST', '/login', { email: 'rahul@musclemart.test', password: 'my-own-pass-123' })).status, 403);
    const store = await call('GET', '/api/portal/store', null, { token: gyms.ironworks.member, tenant: 'ironworks' });
    assert.deepEqual(store.body.products.map((p) => p.title), ['Platform Whey']);

    assert.equal((await opsCall('PATCH', `/sellers/${shop.id}`, { active: true })).status, 200);
    const reset = await opsCall('POST', `/sellers/${shop.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.equal((await shopCall(null, 'POST', '/login', { email: 'rahul@musclemart.test', password: 'my-own-pass-123' })).status, 401);
    assert.equal((await shopCall(null, 'POST', '/login', { email: 'rahul@musclemart.test', password: reset.body.password })).status, 200);
  });
});

describe('your own store and per-shop gym commission', () => {
  let own;
  let ownToken;
  let product;
  const checkout = async (gym, body) => {
    const res = await call('POST', '/api/portal/store/checkout', body, { token: gym.member, tenant: gym.slug });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const buy = (gym, quantity = 1) => checkout(gym, { items: [{ product_id: product.id, quantity }], shipping });

  it('opens your own dark store with no platform fee and no gym cut by default', async () => {
    const res = await opsCall('POST', '/sellers', {
      name: 'GymVym Dark Store',
      owner_name: 'Me',
      email: 'store@gymvym.test',
      phone: '9000000001',
      city: 'Mumbai',
      owned: true,
      gyms: ['pulse'],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    own = res.body.seller;
    assert.equal(own.owned, true);
    assert.deepEqual(own.rates, { gym_commission_pct: 0, gym_commission_custom: true, platform_fee_pct: 0 });
    ownToken = (await shopCall(null, 'POST', '/login', { email: 'store@gymvym.test', password: res.body.password })).body.token;
    product = (await shopCall(ownToken, 'POST', '/products', { title: 'House Creatine', brand: 'GymVym', category: 'creatine', mrp: 1200, price: 999 })).body;
  });

  it('keeps the whole sale, and leaves no ₹0 line in the gym’s statement', async () => {
    const { order, checkout: c } = await buy(gyms.pulse, 2);
    assert.equal(order.commission_amount, 0);
    assert.equal(order.seller_fee_amount, 0);
    assert.equal(order.seller_amount, 1998);
    assert.equal((await pay(gyms.pulse, c, 'pay_own_1')).status, 200);

    const hub = await call('GET', '/api/store-hub/summary', null, { token: gyms.pulse.staff, tenant: 'pulse' });
    assert.equal(hub.body.platform.pending, 0);
    assert.equal(hub.body.platform.store_commission_pct, 0);
    const ledger = await call('GET', '/api/store-hub/commissions', null, { token: gyms.pulse.staff, tenant: 'pulse' });
    assert.equal(ledger.body.items.length, 0);

    const me = await shopCall(ownToken, 'GET', '/me');
    assert.equal(me.body.platform_fee_pct, 0);
    assert.equal(me.body.gym_commission_pct, 0);
  });

  it('has nothing to pay out to itself', async () => {
    const orders = (await shopCall(ownToken, 'GET', '/orders')).body.items;
    assert.equal((await shopCall(ownToken, 'PATCH', `/orders/${orders[0].id}`, { fulfillment_status: 'delivered' })).status, 200);
    assert.equal((await opsCall('POST', `/sellers/${own.id}/payout`, { payout_ref: 'UTR1' })).status, 400);
  });

  it('can give its gyms a custom cut, or go back to the platform default', async () => {
    const custom = await opsCall('PATCH', `/sellers/${own.id}`, { gym_commission_pct: 5 });
    assert.equal(custom.body.seller.rates.gym_commission_pct, 5);
    assert.equal((await buy(gyms.pulse)).order.commission_amount, 49.95);

    const back = await opsCall('PATCH', `/sellers/${own.id}`, { gym_commission_pct: null });
    assert.deepEqual(back.body.seller.rates, { gym_commission_pct: 7.5, gym_commission_custom: false, platform_fee_pct: 0 });
    assert.equal((await buy(gyms.pulse)).order.commission_pct, 7.5);
  });

  it('can switch gym commission off for a partner shop, keeping its platform fee', async () => {
    const res = await opsCall('PATCH', `/sellers/${own.id}`, { owned: false, gym_commission_pct: 0, platform_fee_pct: 12 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.seller.rates, { gym_commission_pct: 0, gym_commission_custom: true, platform_fee_pct: 12 });
    const { order } = await buy(gyms.pulse);
    assert.equal(order.commission_amount, 0);
    assert.equal(order.seller_fee_amount, 119.88);
    assert.equal(order.seller_amount, 879.12);
  });

  it('will not turn a partner still owed money into your own store', async () => {
    const shop = (await opsCall('GET', '/sellers')).body.items.find((s) => s.name === 'Muscle Mart Bandra');
    const variant = (await call('GET', '/api/portal/store', null, { token: gyms.ironworks.member })).body.products[0].variants[0];
    const { checkout: c } = await checkout(gyms.ironworks, {
      items: [{ product_id: variant.product_id, variant_id: variant.id, quantity: 1 }],
      shipping,
    });
    assert.equal((await pay(gyms.ironworks, c, 'pay_mm_2')).status, 200);
    assert.equal((await opsCall('PATCH', `/sellers/${shop.id}`, { owned: true })).status, 409);
  });
});
