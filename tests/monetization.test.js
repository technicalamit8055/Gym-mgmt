import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * In-app store, the add-on paywall's online payments and the commission
 * ledger: operator switches → member checkout → signature verification →
 * entitlement + gym commission → the gym owner's hub and the payout.
 *
 * Razorpay's Orders API is a local stub (RAZORPAY_API_BASE), and signatures
 * are computed here exactly as Checkout would hand them back.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-monetization-test-'));
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
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp-webhook-secret';

// The stub has to be listening before config.js reads RAZORPAY_API_BASE.
const razorpayOrders = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/orders') {
      const body = JSON.parse(raw);
      const order = { id: `order_${razorpayOrders.length + 1}`, amount: body.amount, currency: body.currency, notes: body.notes };
      razorpayOrders.push(order);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(order));
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

let base;
let server;
let ops;
let staff;
let asha;
let ravi;
const TENANT = 'ironworks';

const call = async (method, urlPath, body, { token, tenant = TENANT, raw, headers = {} } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body || raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sign = (orderId, paymentId) =>
  crypto.createHmac('sha256', 'rzp-test-secret').update(`${orderId}|${paymentId}`).digest('hex');

const paid = (orderId, paymentId) => ({
  razorpay_order_id: orderId,
  razorpay_payment_id: paymentId,
  razorpay_signature: sign(orderId, paymentId),
});

const opsCall = (method, urlPath, body) => call(method, `/api/platform/admin${urlPath}`, body, { token: ops, tenant: null });

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
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' }, { tenant: null }))
    .body.token;

  for (const [first, phone] of [['Asha', '9990001111'], ['Ravi', '9990002222']]) {
    assert.equal((await call('POST', '/api/members', { first_name: first, last_name: 'K', phone }, { token: staff })).status, 201);
  }
  asha = (await call('POST', '/api/portal/login', { identifier: '9990001111', pin: '1111' })).body.token;
  ravi = (await call('POST', '/api/portal/login', { identifier: '9990002222', pin: '2222' })).body.token;
  assert.ok(asha && ravi);
});

after(() => {
  server?.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('operator settings', () => {
  it('defaults to a coming-soon store, desk collection, 25% / 7.5%', async () => {
    const res = await opsCall('GET', '/monetization');
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.store_status, 'coming_soon');
    assert.equal(res.body.settings.fitness_addon_collection_mode, 'desk');
    assert.equal(res.body.settings.addon_commission_pct, 25);
    assert.equal(res.body.settings.store_commission_pct, 7.5);
    assert.deepEqual(res.body.addon_tiers.map((t) => [t.key, t.price]), [['1m', 79], ['3m', 199], ['6m', 349]]);
    assert.equal(res.body.razorpay_configured, true);
  });

  it('is closed to a gym admin token', async () => {
    assert.equal((await call('GET', '/api/platform/admin/monetization', null, { token: staff, tenant: null })).status, 403);
  });

  it('refuses to open an empty store', async () => {
    const res = await opsCall('PUT', '/monetization', { store_status: 'live' });
    assert.equal(res.status, 400);
  });

  it('keeps the member on "coming soon" until the operator goes live', async () => {
    const me = await call('GET', '/api/portal/me', null, { token: asha });
    assert.equal(me.body.monetization.store_status, 'coming_soon');
    const store = await call('GET', '/api/portal/store', null, { token: asha });
    assert.deepEqual(store.body.products, []);
  });
});

describe('central catalogue', () => {
  let productId;

  it('creates a product with variants and nutrition facts', async () => {
    const res = await opsCall('POST', '/store/products', {
      title: 'Gold Standard Whey',
      brand: 'Optimum Nutrition',
      category: 'protein',
      mrp: 3500,
      price: 2999,
      lab_report_url: 'https://labs.example.com/on-whey.pdf',
      nutrition_facts: { serving_size: '1 scoop (30g)', protein_g: 24, calories: 120 },
      variants: [
        { flavor: 'Double Rich Chocolate', weight: '1 kg' },
        { flavor: 'Double Rich Chocolate', weight: '2 kg', mrp: 6500, price: 5499 },
        { flavor: 'Vanilla', weight: '1 kg', in_stock: false },
      ],
    });
    assert.equal(res.status, 201);
    productId = res.body.id;
    assert.equal(res.body.variants.length, 3);
    assert.equal(res.body.variants[1].effective_price, 5499);
    assert.equal(res.body.variants[0].effective_price, 2999);
    assert.deepEqual(res.body.weights, ['1 kg', '2 kg']);
    assert.equal(res.body.nutrition_facts.protein_g, 24);
  });

  it('rejects a price above MRP and a javascript: link', async () => {
    assert.equal((await opsCall('POST', '/store/products', { title: 'X1', brand: 'B', mrp: 100, price: 120 })).status, 400);
    assert.equal(
      (await opsCall('POST', '/store/products', { title: 'X2', brand: 'B', mrp: 100, price: 90, image_url: 'javascript:alert(1)' })).status,
      400,
    );
  });

  it('edits variants in place, keeping their ids', async () => {
    const before = (await opsCall('GET', '/store/products')).body.items.find((p) => p.id === productId);
    const variants = before.variants.map((v) => ({ id: v.id, flavor: v.flavor, weight: v.weight, mrp: v.mrp, price: v.price, in_stock: v.in_stock }));
    variants[2].in_stock = 1;
    const res = await opsCall('PATCH', `/store/products/${productId}`, { variants });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.variants.map((v) => v.id), before.variants.map((v) => v.id));
    assert.equal(res.body.variants[2].in_stock, 1);
  });

  it('goes live once there is something to sell', async () => {
    const res = await opsCall('PUT', '/monetization', { store_status: 'live', fitness_addon_collection_mode: 'both' });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.store_status, 'live');
    const me = await call('GET', '/api/portal/me', null, { token: asha });
    assert.equal(me.body.monetization.store_status, 'live');
    assert.equal(me.body.monetization.addon_collection_mode, 'both');
    const store = await call('GET', '/api/portal/store', null, { token: asha });
    assert.equal(store.body.products.length, 1);
    assert.equal(store.body.shipping.phone, '9990001111');
  });
});

describe('store checkout', () => {
  let order;
  let checkout;
  const shipping = { name: 'Asha K', phone: '9990001111', address: '12 MG Road, Indiranagar', city: 'Bengaluru', pincode: '560038' };

  it('prices the cart on the server and opens a Razorpay order', async () => {
    const product = (await call('GET', '/api/portal/store', null, { token: asha })).body.products[0];
    const res = await call(
      'POST',
      '/api/portal/store/checkout',
      {
        items: [
          { product_id: product.id, variant_id: product.variants[1].id, quantity: 1, price: 1 },
          { product_id: product.id, variant_id: product.variants[0].id, quantity: 2 },
        ],
        shipping,
      },
      { token: asha },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ({ order, checkout } = res.body);
    assert.equal(order.subtotal, 5499 + 2 * 2999);
    assert.equal(order.commission_pct, 7.5);
    assert.equal(order.commission_amount, Math.round(11497 * 7.5) / 100);
    assert.equal(checkout.amount, 11497 * 100);
    assert.equal(checkout.key_id, 'rzp_test_key');
    assert.equal(checkout.name, 'Iron Works');
  });

  it('requires a variant when the product has them, and a real PIN code', async () => {
    const product = (await call('GET', '/api/portal/store', null, { token: asha })).body.products[0];
    assert.equal(
      (await call('POST', '/api/portal/store/checkout', { items: [{ product_id: product.id, quantity: 1 }], shipping }, { token: asha })).status,
      400,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/portal/store/checkout',
          { items: [{ product_id: product.id, variant_id: product.variants[0].id, quantity: 1 }], shipping: { ...shipping, pincode: '12' } },
          { token: asha },
        )
      ).status,
      400,
    );
  });

  it('rejects a forged signature', async () => {
    const res = await call(
      'POST',
      '/api/portal/store/verify',
      { ...paid(checkout.order_id, 'pay_1'), razorpay_signature: 'f'.repeat(64) },
      { token: asha },
    );
    assert.equal(res.status, 400);
  });

  it("will not let another member settle someone else's order", async () => {
    const res = await call('POST', '/api/portal/store/verify', paid(checkout.order_id, 'pay_1'), { token: ravi });
    assert.equal(res.status, 404);
  });

  it('marks the order paid and credits the gym exactly once', async () => {
    const first = await call('POST', '/api/portal/store/verify', paid(checkout.order_id, 'pay_1'), { token: asha });
    assert.equal(first.status, 200);
    assert.equal(first.body.order.payment_status, 'paid');
    const again = await call('POST', '/api/portal/store/verify', paid(checkout.order_id, 'pay_1'), { token: asha });
    assert.equal(again.status, 200);

    const ledger = await call('GET', '/api/store-hub/commissions', null, { token: staff });
    const rows = ledger.body.items.filter((r) => r.source_type === 'store_order');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].member_name, 'Asha K');

    const orders = await call('GET', '/api/portal/store/orders', null, { token: asha });
    assert.equal(orders.body.items.length, 1);
    assert.equal(orders.body.items[0].items.length, 2);
    assert.equal((await call('GET', '/api/portal/store/orders', null, { token: ravi })).body.items.length, 0);
  });

  it('approves the commission on delivery and pays it out', async () => {
    const list = await opsCall('GET', '/store/orders');
    assert.equal(list.body.items.length, 1);
    const res = await opsCall('PATCH', `/store/orders/${order.id}`, {
      fulfillment_status: 'delivered',
      courier_name: 'Delhivery',
      tracking_id: 'DL123',
    });
    assert.equal(res.status, 200);
    const balances = (await opsCall('GET', '/commissions')).body.items.find((b) => b.tenant_slug === TENANT);
    assert.equal(balances.payable, order.commission_amount);
  });
});

describe('fitness add-on paywall', () => {
  let checkout;

  it('starts locked behind the paywall with the online tiers on offer', async () => {
    const status = await call('GET', '/api/portal/fitness/status', null, { token: ravi });
    assert.equal(status.body.has_access, false);
    assert.equal(status.body.monetization.addon_collection_mode, 'both');
  });

  it('opens checkout at the operator price, whatever the client sends', async () => {
    const res = await call('POST', '/api/portal/fitness/checkout', { tier: '3m', amount: 1 }, { token: ravi });
    assert.equal(res.status, 201);
    checkout = res.body.checkout;
    assert.equal(checkout.amount, 19900);
    assert.equal(res.body.tier.save_pct, 16);
  });

  it('unlocks on a verified payment and logs a 25% commission', async () => {
    const res = await call('POST', '/api/portal/fitness/verify', paid(checkout.order_id, 'pay_addon_1'), { token: ravi });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.has_access, true);
    assert.equal(res.body.source, 'addon');
    assert.equal(res.body.addon.channel, 'online');

    const ledger = await call('GET', '/api/store-hub/commissions', null, { token: staff });
    const row = ledger.body.items.find((r) => r.source_type === 'fitness_addon');
    assert.equal(row.amount, 49.75);
    assert.equal(row.status, 'approved');
    assert.equal(row.member_name, 'Ravi K');
  });

  it('settles from the webhook when the member never came back', async () => {
    const res = await call('POST', '/api/portal/fitness/checkout', { tier: '1m' }, { token: asha });
    const payload = JSON.stringify({
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_hook_1', order_id: res.body.checkout.order_id } } },
    });
    const signature = crypto.createHmac('sha256', 'rzp-webhook-secret').update(payload).digest('hex');
    const hook = await call('POST', '/api/platform/webhooks/razorpay', null, {
      raw: payload,
      tenant: null,
      headers: { 'x-razorpay-signature': signature },
    });
    assert.equal(hook.status, 200);
    const status = await call('GET', '/api/portal/fitness/status', null, { token: asha });
    assert.equal(status.body.has_access, true);
  });

  it('refuses online checkout once the operator switches to the desk', async () => {
    await opsCall('PUT', '/monetization', { fitness_addon_collection_mode: 'desk' });
    assert.equal((await call('POST', '/api/portal/fitness/checkout', { tier: '1m' }, { token: ravi })).status, 400);
    const me = await call('GET', '/api/portal/me', null, { token: ravi });
    assert.equal(me.body.monetization.addon_collection_mode, 'desk');
  });
});

describe("the gym's own shelf and the earnings hub", () => {
  let shaker;

  it('lists a product and sells it at the desk', async () => {
    const res = await call('POST', '/api/store-hub/products', { name: 'Iron Works Shaker', category: 'accessories', price: 350, stock_quantity: 2 }, { token: staff });
    assert.equal(res.status, 201);
    shaker = res.body;
    const sale = await call('POST', '/api/store-hub/sales', { product_id: shaker.id, quantity: 2, method: 'upi', member_id: 1 }, { token: staff });
    assert.equal(sale.status, 201);
    assert.equal(sale.body.sale.total, 700);
    assert.equal(sale.body.product.stock_quantity, 0);
  });

  it('will not sell stock it does not have', async () => {
    assert.equal((await call('POST', '/api/store-hub/sales', { product_id: shaker.id, quantity: 1 }, { token: staff })).status, 409);
    const restock = await call('POST', `/api/store-hub/products/${shaker.id}/restock`, { quantity: 5 }, { token: staff });
    assert.equal(restock.body.stock_quantity, 5);
  });

  it('adds both revenue lines into one monthly total', async () => {
    const res = await call('GET', '/api/store-hub/summary', null, { token: staff });
    assert.equal(res.status, 200);
    const storeCut = Math.round(11497 * 7.5) / 100;
    const addonCut = 49.75 + Math.round(79 * 25) / 100;
    assert.equal(res.body.platform.month_store, storeCut);
    assert.equal(res.body.platform.month_addon, addonCut);
    assert.equal(res.body.local.revenue_month, 700);
    assert.equal(res.body.total_month, Math.round((storeCut + addonCut + 700) * 100) / 100);
  });

  it('retires rather than deletes a product with sales', async () => {
    const res = await call('DELETE', `/api/store-hub/products/${shaker.id}`, null, { token: staff });
    assert.deepEqual(res.body, { retired: true });
  });

  it('records a payout against everything payable', async () => {
    const res = await opsCall('POST', `/commissions/${TENANT}/payout`, { payout_ref: 'UTR123456' });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 3);
    const summary = await call('GET', '/api/store-hub/summary', null, { token: staff });
    assert.equal(summary.body.platform.payable, 0);
    assert.ok(summary.body.platform.paid > 0);
  });
});

describe('pickup at the gym, photos and banners', () => {
  // The smallest bytes sniffMedia recognises as a PNG.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const upload = (method, urlPath, bytes) =>
    fetch(`${base}/api/platform/admin${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${ops}`, 'Content-Type': 'image/png' },
      body: bytes,
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
  let product;
  let pickup;

  it('stores uploaded product photos and serves them publicly', async () => {
    product = (await opsCall('GET', '/store/products')).body.items[0];
    const res = await upload('POST', `/store/products/${product.id}/images`, png);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.images.length, 1);
    assert.equal(res.body.image_url, res.body.images[0].url);
    const served = await fetch(`${base}${res.body.image_url}`);
    assert.equal(served.status, 200);
    assert.equal((await upload('POST', `/store/products/${product.id}/images`, Buffer.from('<html>not an image</html>'))).status, 400);
    assert.equal((await fetch(`${base}/api/store-media/..%2Fplatform.db`)).status, 404);
  });

  it('shows active banners on the storefront with the delivery promise', async () => {
    const banner = await opsCall('POST', '/store/banners', { title: 'Whey week', subtitle: 'Up to 25% off', link_type: 'category', link_value: 'protein' });
    assert.equal(banner.status, 201);
    assert.equal((await upload('PUT', `/store/banners/${banner.body.id}/image`, png)).status, 200);
    await opsCall('POST', '/store/banners', { title: 'Hidden', active: false });
    assert.equal((await opsCall('POST', '/store/banners', { title: 'Bad link', link_type: 'category', link_value: 'pizza' })).status, 400);

    await opsCall('PUT', '/monetization', { delivery_eta: 'Delivery in 3 days' });
    const store = await call('GET', '/api/portal/store', null, { token: asha });
    assert.equal(store.body.banners.length, 1);
    assert.ok(store.body.banners[0].image_url);
    assert.equal(store.body.delivery.eta, 'Delivery in 3 days');
    assert.equal(store.body.delivery.pickup_enabled, true);
    assert.equal(store.body.delivery.gym_name, 'Iron Works');
  });

  it('takes a pickup order with just a name and phone', async () => {
    const res = await call(
      'POST',
      '/api/portal/store/checkout',
      {
        method: 'pickup',
        items: [{ product_id: product.id, variant_id: product.variants[0].id, quantity: 1 }],
        shipping: { name: 'Asha K', phone: '9990001111' },
      },
      { token: asha },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.fulfillment_method, 'pickup');
    assert.equal(res.body.order.shipping_address, null);
    await call('POST', '/api/portal/store/verify', paid(res.body.checkout.order_id, 'pay_pickup_1'), { token: asha });
    pickup = res.body.order;
  });

  it('runs the desk flow: received, then collected, which approves the cut', async () => {
    const list = await call('GET', '/api/store-hub/pickups', null, { token: staff });
    assert.ok(list.body.items.some((o) => o.id === pickup.id));
    assert.equal((await call('POST', `/api/store-hub/pickups/${pickup.id}/collected`, {}, { token: staff })).status, 409);
    const received = await call('POST', `/api/store-hub/pickups/${pickup.id}/received`, {}, { token: staff });
    assert.equal(received.body.order.fulfillment_status, 'ready');
    const collected = await call('POST', `/api/store-hub/pickups/${pickup.id}/collected`, {}, { token: staff });
    assert.equal(collected.body.order.fulfillment_status, 'delivered');
    const row = (await call('GET', '/api/store-hub/commissions', null, { token: staff })).body.items.find(
      (r) => r.source_type === 'store_order' && r.source_id === pickup.id,
    );
    assert.equal(row.status, 'approved');
  });

  it('keeps "ready" for pickups and turns pickup off on request', async () => {
    const delivery = (await opsCall('GET', '/store/orders')).body.items.find((o) => o.fulfillment_method === 'delivery');
    assert.equal((await opsCall('PATCH', `/store/orders/${delivery.id}`, { fulfillment_status: 'ready' })).status, 400);
    await opsCall('PUT', '/monetization', { pickup_enabled: false });
    const res = await call(
      'POST',
      '/api/portal/store/checkout',
      { method: 'pickup', items: [{ product_id: product.id, variant_id: product.variants[0].id, quantity: 1 }], shipping: { name: 'Asha K', phone: '9990001111' } },
      { token: asha },
    );
    assert.equal(res.status, 400);
  });
});

describe('quality badges', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
  const upload = (urlPath, bytes) =>
    fetch(`${base}/api/platform/admin${urlPath}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ops}`, 'Content-Type': 'image/png' },
      body: bytes,
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
  let trustified;
  let hidden;
  let product;

  it('keeps a library of badges with uploaded icons', async () => {
    const res = await opsCall('POST', '/store/badges', { name: 'Trustified' });
    assert.equal(res.status, 201);
    trustified = res.body;
    const icon = await upload(`/store/badges/${trustified.id}/image`, png);
    assert.equal(icon.status, 200, JSON.stringify(icon.body));
    assert.match(icon.body.image_url, /\/api\/store-media\/q\d+-[a-f0-9]{10}\.png$/);
    assert.equal((await fetch(`${base}${icon.body.image_url}`)).status, 200);
    hidden = (await opsCall('POST', '/store/badges', { name: 'Draft seal', active: false })).body;
    assert.equal((await opsCall('POST', '/store/badges', { name: 'X' })).status, 400);
  });

  it('pins badges to a product and shows members only the active ones', async () => {
    product = (await opsCall('GET', '/store/products')).body.items[0];
    const res = await opsCall('PATCH', `/store/products/${product.id}`, { badge_ids: [trustified.id, hidden.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.badges.map((b) => b.name), ['Trustified', 'Draft seal']);
    assert.equal((await opsCall('PATCH', `/store/products/${product.id}`, { badge_ids: [9999] })).status, 400);

    const store = await call('GET', '/api/portal/store', null, { token: asha });
    const seen = store.body.products.find((p) => p.id === product.id);
    assert.deepEqual(seen.badges.map((b) => b.name), ['Trustified']);
    assert.ok(seen.badges[0].image_url);

    const library = (await opsCall('GET', '/store/badges')).body.items;
    assert.equal(library.find((b) => b.id === trustified.id).product_count, 1);
  });

  it('leaves badges alone on an unrelated edit and drops a deleted badge everywhere', async () => {
    const edit = await opsCall('PATCH', `/store/products/${product.id}`, { description: 'Updated' });
    assert.equal(edit.body.badges.length, 2);
    assert.equal((await opsCall('DELETE', `/store/badges/${hidden.id}`)).status, 200);
    const after = (await opsCall('GET', '/store/products')).body.items.find((p) => p.id === product.id);
    assert.deepEqual(after.badges.map((b) => b.name), ['Trustified']);
    assert.equal((await opsCall('DELETE', `/store/badges/${hidden.id}`)).status, 404);
  });
});
