import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  listTenantPickups,
  markPickupCollected,
  markPickupReceived,
  tenantCommissionLedger,
  tenantCommissionSummary,
} from '../monetization.js';
import { normaliseBarcode } from '../foodBarcode.js';
import { gymProductByBarcode, lookupGymBarcode } from '../productBarcode.js';
import { parse, startOfMonth, today, toInt } from '../validate.js';

/**
 * The gym owner's "Store & Commissions" hub, two kinds of money side by side:
 *
 *  - Platform products: the gym's affiliate cut of what its members bought
 *    from the platform store and of in-app add-on purchases. Read-only here —
 *    it is the platform's ledger of what it owes the gym (src/monetization.js).
 *  - Our gym products: the gym's own shelf — tees, shakers, bars, drinks —
 *    stocked and sold at the desk, all revenue the gym's. Lives in the gym's
 *    own database, like every other sale it records.
 *
 * Billing roles only, the same line the rest of the money pages draw.
 */
export const storeHubRoutes = Router();
storeHubRoutes.use(requireAuth, requireRole(...MANAGES_BILLING));

export const GYM_PRODUCT_CATEGORIES = ['apparel', 'accessories', 'drinks', 'snacks', 'supplements', 'other'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

storeHubRoutes.get('/summary', (req, res) => {
  const from = startOfMonth(today());
  const platform = tenantCommissionSummary(req.tenant.slug, from);
  const local = get(
    `SELECT COALESCE(SUM(total), 0) AS revenue_month, COALESCE(SUM(quantity), 0) AS units_month, COUNT(*) AS sales_month
     FROM gym_product_sales WHERE sold_on >= ?`,
    [from],
  );
  const stock = get(
    `SELECT COUNT(*) AS products,
            COUNT(CASE WHEN stock_quantity <= low_stock_at THEN 1 END) AS low_stock,
            COALESCE(SUM(stock_quantity * price), 0) AS stock_value
     FROM gym_products WHERE active = 1`,
  );
  res.json({
    month_start: from,
    platform,
    local: { ...local, ...stock, revenue_month: round2(local.revenue_month), stock_value: round2(stock.stock_value) },
    total_month: round2(platform.month_total + local.revenue_month),
  });
});

/**
 * The commission statement. Store rows carry their own snapshot of the
 * member's name; add-on rows only a member id, which is resolved here against
 * this gym's own members table.
 */
storeHubRoutes.get('/commissions', (req, res) => {
  const rows = tenantCommissionLedger(req.tenant.slug, { limit: toInt(req.query.limit, 200) });
  const ids = [...new Set(rows.filter((r) => !r.member_name && r.member_id).map((r) => r.member_id))];
  const names = new Map(
    ids.length
      ? all(
          `SELECT id, first_name || COALESCE(' ' || last_name, '') AS name FROM members WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids,
        ).map((m) => [m.id, m.name])
      : [],
  );
  res.json({ items: rows.map((r) => ({ ...r, member_name: r.member_name ?? names.get(r.member_id) ?? null })) });
});

/* ── Store orders picked up at this gym's desk ────────────────────────── */

storeHubRoutes.get('/pickups', (req, res) => {
  res.json({ items: listTenantPickups(req.tenant.slug) });
});

/** The parcel arrived at the gym; the member is told it is ready. */
storeHubRoutes.post('/pickups/:id/received', (req, res) => {
  res.json({ order: markPickupReceived(req.tenant.slug, Number(req.params.id)) });
});

storeHubRoutes.post('/pickups/:id/collected', (req, res) => {
  res.json({ order: markPickupCollected(req.tenant.slug, Number(req.params.id)) });
});

/* ── The gym's own products ───────────────────────────────────────────── */

const PRODUCT_FIELDS = {
  name: { type: 'string', min: 2, max: 120 },
  category: { type: 'enum', values: GYM_PRODUCT_CATEGORIES },
  description: { type: 'string', max: 500 },
  sku: { type: 'string', max: 60 },
  barcode: { type: 'string', max: 20 },
  price: { type: 'number', min: 0, max: 1000000 },
  cost_price: { type: 'number', min: 0, max: 1000000 },
  stock_quantity: { type: 'int', min: 0, max: 1000000 },
  low_stock_at: { type: 'int', min: 0, max: 100000 },
  active: { type: 'boolean' },
};

/** A barcode is checked and kept in one form, and one pack is one product. */
function cleanProductBarcode(body, exceptId = null) {
  if (body.barcode === undefined) return;
  if (body.barcode === null || body.barcode === '') {
    body.barcode = null;
    return;
  }
  body.barcode = normaliseBarcode(body.barcode);
  const taken = gymProductByBarcode(body.barcode, exceptId);
  if (taken) throw conflict(`Barcode ${body.barcode} is already on “${taken.name}”`);
}

/** A scanned pack: the gym's own product (to restock or sell), or details to
 * start a new one from (src/productBarcode.js). */
storeHubRoutes.get('/barcode/:code', async (req, res) => {
  res.json(await lookupGymBarcode(req.params.code));
});

storeHubRoutes.get('/products', (req, res) => {
  const includeRetired = req.query.all === '1' || req.query.all === 'true';
  res.json({
    items: all(
      `SELECT p.*,
              COALESCE((SELECT SUM(s.quantity) FROM gym_product_sales s WHERE s.product_id = p.id), 0) AS units_sold,
              COALESCE((SELECT SUM(s.total) FROM gym_product_sales s WHERE s.product_id = p.id), 0) AS revenue
       FROM gym_products p ${includeRetired ? '' : 'WHERE p.active = 1'}
       ORDER BY p.active DESC, p.name COLLATE NOCASE`,
    ),
    categories: GYM_PRODUCT_CATEGORIES,
  });
});

storeHubRoutes.post('/products', (req, res) => {
  const body = parse(req.body, {
    ...PRODUCT_FIELDS,
    name: { ...PRODUCT_FIELDS.name, required: true },
    price: { ...PRODUCT_FIELDS.price, required: true },
    category: { ...PRODUCT_FIELDS.category, default: 'other' },
    stock_quantity: { ...PRODUCT_FIELDS.stock_quantity, default: 0 },
    low_stock_at: { ...PRODUCT_FIELDS.low_stock_at, default: 5 },
  });
  cleanProductBarcode(body);
  const info = run(
    `INSERT INTO gym_products (name, category, description, sku, barcode, price, cost_price, stock_quantity, low_stock_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.name,
      body.category,
      body.description ?? null,
      body.sku ?? null,
      body.barcode ?? null,
      body.price,
      body.cost_price ?? null,
      body.stock_quantity,
      body.low_stock_at,
    ],
  );
  res.status(201).json(get('SELECT * FROM gym_products WHERE id = ?', [info.lastInsertRowid]));
});

storeHubRoutes.patch('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM gym_products WHERE id = ?', [id])) throw notFound('Product not found');
  const body = parse(req.body, PRODUCT_FIELDS);
  cleanProductBarcode(body, id);
  // Required columns cannot be blanked; optional text ones can be cleared.
  const columns = Object.keys(body).filter(
    (c) => body[c] !== null || ['description', 'sku', 'barcode', 'cost_price'].includes(c),
  );
  if (!columns.length) throw badRequest('Nothing to update');
  run(
    `UPDATE gym_products SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    [...columns.map((c) => body[c]), id],
  );
  res.json(get('SELECT * FROM gym_products WHERE id = ?', [id]));
});

/** Adds delivered stock, so the desk doesn't do the arithmetic on a count. */
storeHubRoutes.post('/products/:id/restock', (req, res) => {
  const id = Number(req.params.id);
  const body = parse(req.body, { quantity: { type: 'int', required: true, min: 1, max: 100000 } });
  const changed = run(
    "UPDATE gym_products SET stock_quantity = stock_quantity + ?, updated_at = datetime('now') WHERE id = ?",
    [body.quantity, id],
  ).changes;
  if (!changed) throw notFound('Product not found');
  res.json(get('SELECT * FROM gym_products WHERE id = ?', [id]));
});

/** A product with sales behind it is retired, not deleted, so the sales list
 * and the month's revenue keep their history. */
storeHubRoutes.delete('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM gym_products WHERE id = ?', [id])) throw notFound('Product not found');
  if (get('SELECT 1 AS ok FROM gym_product_sales WHERE product_id = ? LIMIT 1', [id])) {
    run("UPDATE gym_products SET active = 0, updated_at = datetime('now') WHERE id = ?", [id]);
    return res.json({ retired: true });
  }
  run('DELETE FROM gym_products WHERE id = ?', [id]);
  res.json({ deleted: true });
});

/* ── Desk sales of the gym's own products ─────────────────────────────── */

storeHubRoutes.get('/sales', (req, res) => {
  res.json({
    items: all(
      `SELECT s.*, m.code AS member_code, m.first_name, m.last_name, u.name AS sold_by_name
       FROM gym_product_sales s
       LEFT JOIN members m ON m.id = s.member_id
       LEFT JOIN users u ON u.id = s.sold_by
       ORDER BY s.sold_on DESC, s.id DESC LIMIT ?`,
      [Math.min(toInt(req.query.limit, 100), 500)],
    ),
  });
});

/**
 * Rings up a sale and takes it off the shelf in one step. The stock check and
 * the decrement are one conditional UPDATE, so two desks selling the last
 * shaker at once cannot both succeed.
 */
storeHubRoutes.post('/sales', (req, res) => {
  const body = parse(req.body, {
    product_id: { type: 'int', required: true, min: 1 },
    quantity: { type: 'int', min: 1, max: 1000, default: 1 },
    // Defaults to the shelf price; overridable for a one-off discount.
    unit_price: { type: 'number', min: 0, max: 1000000 },
    member_id: { type: 'int', min: 1 },
    method: { type: 'enum', values: ['cash', 'card', 'upi', 'bank', 'online'], default: 'cash' },
    sold_on: { type: 'date', default: today() },
    note: { type: 'string', max: 300 },
  });
  const product = get('SELECT * FROM gym_products WHERE id = ?', [body.product_id]);
  if (!product || !product.active) throw notFound('Product not found');
  if (body.member_id && !get('SELECT id FROM members WHERE id = ?', [body.member_id])) throw notFound('Member not found');
  const unitPrice = body.unit_price ?? product.price;

  const saleId = tx(() => {
    const taken = run(
      "UPDATE gym_products SET stock_quantity = stock_quantity - ?, updated_at = datetime('now') WHERE id = ? AND stock_quantity >= ?",
      [body.quantity, product.id, body.quantity],
    ).changes;
    if (!taken) {
      throw conflict(`Only ${product.stock_quantity} ${product.name} left in stock`, { quantity: 'exceeds stock' });
    }
    return run(
      `INSERT INTO gym_product_sales
         (product_id, product_name, member_id, quantity, unit_price, total, method, sold_on, sold_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product.id,
        product.name,
        body.member_id ?? null,
        body.quantity,
        unitPrice,
        round2(unitPrice * body.quantity),
        body.method,
        body.sold_on,
        req.user.id,
        body.note ?? null,
      ],
    ).lastInsertRowid;
  });

  res.status(201).json({
    sale: get('SELECT * FROM gym_product_sales WHERE id = ?', [saleId]),
    product: get('SELECT * FROM gym_products WHERE id = ?', [product.id]),
  });
});
