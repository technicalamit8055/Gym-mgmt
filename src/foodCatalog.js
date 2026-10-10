import { getDb } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { FOOD_FIBER_SUGAR, FOODS } from './fitnessSeed.js';
import { getRegistryDb } from './tenants.js';

/**
 * The platform-wide food catalogue — one nutrition database for every gym,
 * managed from the operator console, with a Lifesum-style blue tick on the
 * foods the operator has checked.
 *
 * Unlike the exercise catalogue, which gyms read straight from the platform
 * DB, foods are copied into each gym's own `food_library`: a member's log
 * entries, favourites and scanned packs all point at library rows by id, and
 * those ids have to stay local. So the catalogue is the source and every
 * gym's library a synced copy, keyed by `catalog_id` — see syncFoodCatalog().
 * A gym's own foods (staff-added, scanned packs) live alongside, untouched.
 */

/** The categories gyms already file foods under (the staff food form uses
 * the same list), so a synced food never lands in one a gym can't filter by. */
export const FOOD_CATEGORIES = ['protein', 'carbs', 'fats', 'fruits', 'dairy', 'supplements', 'meal', 'general'];

/** What a spreadsheet or an AI tool tends to write instead. */
const CATEGORY_ALIASES = {
  meat: 'protein', fish: 'protein', seafood: 'protein', egg: 'protein', eggs: 'protein', poultry: 'protein',
  legume: 'protein', legumes: 'protein', pulses: 'protein', dal: 'protein',
  carb: 'carbs', carbohydrate: 'carbs', carbohydrates: 'carbs', grain: 'carbs', grains: 'carbs',
  cereal: 'carbs', cereals: 'carbs', bread: 'carbs', breads: 'carbs', starch: 'carbs',
  fat: 'fats', oils: 'fats', oil: 'fats', nut: 'fats', nuts: 'fats', seeds: 'fats', nuts_seeds: 'fats',
  fruit: 'fruits', vegetable: 'fruits', vegetables: 'fruits', veg: 'fruits', veggies: 'fruits',
  fruit_veg: 'fruits', fruits_vegetables: 'fruits', produce: 'fruits',
  milk: 'dairy', dairy_products: 'dairy',
  supplement: 'supplements', protein_powder: 'supplements',
  meals: 'meal', dish: 'meal', dishes: 'meal', full_meal: 'meal', recipe: 'meal', recipes: 'meal',
  beverage: 'general', beverages: 'general', drink: 'general', drinks: 'general',
  snack: 'general', snacks: 'general', sweets: 'general', dessert: 'general', other: 'general', misc: 'general',
};

const MAX_IMPORT_ROWS = 2000;

/* ── Storage ──────────────────────────────────────────────────────────── */

const initialised = new WeakSet();

/** The registry handle with the catalogue's table in place and the starter
 * foods seeded once — on a marker, not "the table is empty", so an operator
 * who clears the catalogue does not get the starter set back on restart. */
function db() {
  const handle = getRegistryDb();
  if (initialised.has(handle)) return handle;

  handle.exec(`
    CREATE TABLE IF NOT EXISTS platform_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS catalog_foods (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      category       TEXT NOT NULL DEFAULT 'general',
      serving_unit   TEXT NOT NULL DEFAULT '100g',
      calories       INTEGER NOT NULL DEFAULT 0,
      protein_g      REAL NOT NULL DEFAULT 0,
      carbs_g        REAL NOT NULL DEFAULT 0,
      fats_g         REAL NOT NULL DEFAULT 0,
      fiber_g        REAL NOT NULL DEFAULT 0,
      sugar_g        REAL NOT NULL DEFAULT 0,
      serving_size_g REAL,
      serving_label  TEXT,
      brand          TEXT,
      verified       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_foods_category ON catalog_foods(category);
  `);

  const seeded = handle.prepare("SELECT value FROM platform_meta WHERE key = 'food_catalog_seeded'").get();
  if (!seeded) {
    const insert = handle.prepare(
      `INSERT OR IGNORE INTO catalog_foods
         (name, category, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [name, category, unit, kcal, protein, carbs, fats] of FOODS) {
      const [fiber, sugar] = FOOD_FIBER_SUGAR[name] ?? [0, 0];
      insert.run(name, category, unit, kcal, protein, carbs, fats, fiber, sugar);
    }
    handle.prepare("INSERT INTO platform_meta (key, value) VALUES ('food_catalog_seeded', '1')").run();
  }

  initialised.add(handle);
  if (!seeded) bumpVersion();
  return handle;
}

/** Every write moves this on, and a gym re-syncs when its copy is older. */
function bumpVersion() {
  db()
    .prepare(
      `INSERT INTO platform_meta (key, value) VALUES ('food_catalog_version', '1')
       ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
    )
    .run();
}

const catalogVersion = () =>
  db().prepare("SELECT value FROM platform_meta WHERE key = 'food_catalog_version'").get()?.value ?? '0';

const present = (row) => (row ? { ...row, verified: Boolean(row.verified) } : row);

/* ── Validation ───────────────────────────────────────────────────────── */

/** "12.5", "12.5 g", "1,200" → a number; blank → undefined. */
function numberFrom(value, field, { min = 0, max, integer = false, required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`${field} is required`, { [field]: 'is required' });
    return undefined;
  }
  // Units and stray words go ("7.5 g"), but a value with no digits at all
  // ("lots") is not a zero.
  const digits = String(value).replace(/,/g, '').replace(/[^\d.+-]/g, '');
  const n = typeof value === 'number' ? value : /\d/.test(digits) ? Number(digits) : NaN;
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`, { [field]: 'must be a number' });
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`, { [field]: `between ${min} and ${max}` });
  return integer ? Math.round(n) : Math.round(n * 10) / 10;
}

function textFrom(value, field, max) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (text.length > max) throw badRequest(`${field} is limited to ${max} characters`, { [field]: 'too long' });
  return text;
}

function categoryFrom(value, { lenient }) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s/&-]+/g, '_').replace(/_+/g, '_');
  if (!key) return 'general';
  if (FOOD_CATEGORIES.includes(key)) return key;
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  if (lenient) return 'general';
  throw badRequest('That category is not one of the allowed values', { category: `use one of: ${FOOD_CATEGORIES.join(', ')}` });
}

function booleanFrom(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'verified', '✓'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * A create/update/import payload as column values. `partial` leaves out what
 * the payload does not mention, so a PATCH — or an import sheet without a
 * fibre column — never blanks what is already there.
 */
function cleanFields(body = {}, { partial = false, lenient = false } = {}) {
  const has = (key) => Object.hasOwn(body, key) && !(partial && String(body[key] ?? '').trim() === '');
  const out = {};

  if (!partial || has('name')) {
    const name = textFrom(body.name, 'name', 120) ?? '';
    if (name.length < 2) throw badRequest('Give the food a name of 2–120 characters', { name: 'is required' });
    out.name = name;
  }
  if (!partial || has('category')) out.category = categoryFrom(body.category, { lenient });
  if (!partial || has('serving_unit')) out.serving_unit = textFrom(body.serving_unit, 'serving_unit', 60) || '100g';
  if (!partial || has('calories')) out.calories = numberFrom(body.calories, 'calories', { max: 5000, integer: true, required: true });
  for (const [key, max] of [['protein_g', 1000], ['carbs_g', 1000], ['fats_g', 1000], ['fiber_g', 500], ['sugar_g', 1000]]) {
    if (!partial || has(key)) out[key] = numberFrom(body[key], key, { max }) ?? 0;
  }
  if (!partial || has('serving_size_g')) out.serving_size_g = numberFrom(body.serving_size_g, 'serving_size_g', { min: 1, max: 5000 }) ?? null;
  if (!partial || has('serving_label')) out.serving_label = textFrom(body.serving_label, 'serving_label', 60) || null;
  if (!partial || has('brand')) out.brand = textFrom(body.brand, 'brand', 80) || null;
  if (!partial || has('verified')) out.verified = booleanFrom(body.verified) ? 1 : 0;
  return out;
}

/** The serving label a member sees when the sheet gave a size but no words. */
function labelFor(fields) {
  if (!fields.serving_size_g || fields.serving_label) return fields.serving_label ?? null;
  const measure = /ml/i.test(fields.serving_unit ?? '') ? 'ml' : 'g';
  return `${fields.serving_size_g} ${measure}`;
}

/**
 * Macros that cannot add up to the calories — the usual slip in a sheet an AI
 * tool filled in. A warning, not an error: alcohol, polyols and rounding all
 * move the sum, so a person decides.
 */
function energyWarning(f) {
  if (!f.calories) return null;
  const fromMacros = Math.round(f.protein_g * 4 + f.carbs_g * 4 + f.fats_g * 9);
  const gap = Math.abs(fromMacros - f.calories);
  if (gap <= Math.max(30, f.calories * 0.25)) return null;
  return `Macros add up to about ${fromMacros} kcal, but calories says ${f.calories}`;
}

/* ── Reads ────────────────────────────────────────────────────────────── */

export function getCatalogFood(id) {
  return present(db().prepare('SELECT * FROM catalog_foods WHERE id = ?').get(Number(id)));
}

export function listFoodCatalog({ q, category, verified } = {}) {
  const where = [];
  const params = [];
  if (q) { where.push('(name LIKE ? OR brand LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category) { where.push('category = ?'); params.push(String(category)); }
  if (verified === 'yes') where.push('verified = 1');
  if (verified === 'no') where.push('verified = 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = db().prepare(`SELECT * FROM catalog_foods ${clause} ORDER BY category, name`).all(...params).map(present);
  const totals = db().prepare('SELECT COUNT(*) AS total, COALESCE(SUM(verified), 0) AS verified FROM catalog_foods').get();
  return { items, total: totals.total, verified_total: totals.verified };
}

/* ── Writes ───────────────────────────────────────────────────────────── */

function assertNameFree(name, exceptId) {
  const clash = db().prepare('SELECT id FROM catalog_foods WHERE name = ?').get(name);
  if (clash && clash.id !== exceptId) throw conflict(`There is already a food called "${name}"`);
}

function insertFood(fields) {
  const info = db()
    .prepare(
      `INSERT INTO catalog_foods
         (name, category, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g,
          serving_size_g, serving_label, brand, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.name, fields.category, fields.serving_unit, fields.calories, fields.protein_g, fields.carbs_g,
      fields.fats_g, fields.fiber_g, fields.sugar_g, fields.serving_size_g, labelFor(fields), fields.brand, fields.verified,
    );
  return Number(info.lastInsertRowid);
}

function patchFood(id, fields) {
  const columns = Object.keys(fields);
  if (!columns.length) return;
  if (Object.hasOwn(fields, 'serving_size_g') && !Object.hasOwn(fields, 'serving_label')) {
    const current = db().prepare('SELECT serving_unit, serving_label FROM catalog_foods WHERE id = ?').get(id);
    if (!current.serving_label) {
      fields.serving_label = labelFor({ ...fields, serving_unit: fields.serving_unit ?? current.serving_unit });
      columns.push('serving_label');
    }
  }
  db()
    .prepare(`UPDATE catalog_foods SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...columns.map((c) => fields[c]), id);
}

export function createCatalogFood(body) {
  const fields = cleanFields(body);
  assertNameFree(fields.name);
  const id = insertFood(fields);
  bumpVersion();
  return getCatalogFood(id);
}

export function updateCatalogFood(id, body) {
  const current = db().prepare('SELECT id FROM catalog_foods WHERE id = ?').get(Number(id));
  if (!current) throw notFound('Food not found');
  const fields = cleanFields(body, { partial: true });
  if (fields.name) assertNameFree(fields.name, current.id);
  patchFood(current.id, fields);
  bumpVersion();
  return getCatalogFood(current.id);
}

export function deleteCatalogFood(id) {
  const info = db().prepare('DELETE FROM catalog_foods WHERE id = ?').run(Number(id));
  if (!info.changes) throw notFound('Food not found');
  bumpVersion();
}

/** Ticks, unticks or deletes many foods at once — the console's selection bar. */
export function bulkUpdateCatalog({ ids, action }) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) throw badRequest('Pick at least one food', { ids: 'is required' });
  if (list.length > 5000) throw badRequest('At most 5000 foods at a time', { ids: 'at most 5000' });
  const marks = list.map(() => '?').join(', ');
  let info;
  if (action === 'verify' || action === 'unverify') {
    info = db()
      .prepare(`UPDATE catalog_foods SET verified = ?, updated_at = datetime('now') WHERE id IN (${marks})`)
      .run(action === 'verify' ? 1 : 0, ...list);
  } else if (action === 'delete') {
    info = db().prepare(`DELETE FROM catalog_foods WHERE id IN (${marks})`).run(...list);
  } else {
    throw badRequest('Unknown action', { action: 'use verify, unverify or delete' });
  }
  if (info.changes) bumpVersion();
  return { changed: Number(info.changes) };
}

/**
 * Creates or updates by name, for the CSV / JSON import. One bad row never
 * sinks the rest: each is reported with its line, the good ones land, and
 * rows whose macros don't add up land with a warning to look at.
 *
 * `verified` ticks every row the sheet does not say otherwise about — off by
 * default, because numbers an AI tool wrote deserve a look before a member
 * sees them with a tick.
 */
export function importFoodCatalog(rows, { verified = false } = {}) {
  if (!Array.isArray(rows)) throw badRequest('Send the rows as an array', { rows: 'is required' });
  if (rows.length > MAX_IMPORT_ROWS) {
    throw badRequest(`Import at most ${MAX_IMPORT_ROWS} foods at a time`, { rows: `at most ${MAX_IMPORT_ROWS}` });
  }
  const result = { created: 0, updated: 0, errors: [], warnings: [] };
  const handle = db();
  handle.exec('BEGIN');
  try {
    rows.forEach((raw, index) => {
      const line = index + 1;
      const row = raw && typeof raw === 'object' ? { ...raw } : {};
      if (verified && (row.verified === undefined || row.verified === '')) row.verified = true;
      const name = String(row.name ?? '').trim().replace(/\s+/g, ' ');
      try {
        const existing = handle.prepare('SELECT * FROM catalog_foods WHERE name = ?').get(name);
        if (existing) {
          const fields = cleanFields(row, { partial: true, lenient: true });
          delete fields.name; // matched on it; keep the catalogue's own spelling
          patchFood(existing.id, fields);
          result.updated += 1;
          const warning = energyWarning({ ...existing, ...fields });
          if (warning) result.warnings.push({ line, name, warning });
        } else {
          const fields = cleanFields(row, { lenient: true });
          insertFood(fields);
          result.created += 1;
          const warning = energyWarning(fields);
          if (warning) result.warnings.push({ line, name, warning });
        }
      } catch (err) {
        result.errors.push({ line, name, error: err.message });
      }
    });
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
  if (result.created || result.updated) bumpVersion();
  return result;
}

/* ── Sync into a gym's library ────────────────────────────────────────── */

/** Which catalogue version each open gym database last copied. In memory:
 * after a restart every gym re-syncs once, which is cheap and idempotent. */
const syncedVersion = new WeakMap();

/**
 * Brings the current gym's `food_library` up to the catalogue: new foods in,
 * changed ones updated, deleted ones out. Called by the routes that list
 * foods, so a gym catches up the first time anyone there opens a food list
 * after the operator changes something — and costs one lookup otherwise.
 *
 * A gym row with the same name as a catalogue food is adopted rather than
 * duplicated (the starter set every gym was seeded with, or a trainer's own
 * "Paneer"): the catalogue's numbers win, and it stops being a custom food.
 * A scanned pack is never adopted — its numbers are the label's.
 */
export function syncFoodCatalog() {
  let version;
  let foods;
  try {
    version = catalogVersion();
    const tenant = getDb();
    if (syncedVersion.get(tenant) === version) return;
    foods = db().prepare('SELECT * FROM catalog_foods').all();
    tenant.exec('BEGIN');
    try {
      applyCatalog(tenant, foods);
      tenant.exec('COMMIT');
    } catch (err) {
      tenant.exec('ROLLBACK');
      throw err;
    }
    syncedVersion.set(tenant, version);
  } catch (err) {
    // The gym's own library still works without the catalogue's latest.
    console.error('[food catalogue] sync failed:', err.message);
  }
}

function applyCatalog(tenant, foods) {
  const linked = new Map(
    tenant.prepare('SELECT id, catalog_id FROM food_library WHERE catalog_id IS NOT NULL').all().map((r) => [r.catalog_id, r.id]),
  );
  const byName = tenant.prepare('SELECT id, barcode, catalog_id FROM food_library WHERE name = ? COLLATE NOCASE');
  const columns = `catalog_id = ?, name = ?, category = ?, serving_unit = ?, calories = ?, protein_g = ?, carbs_g = ?,
                   fats_g = ?, fiber_g = ?, sugar_g = ?, serving_size_g = ?, serving_label = ?, brand = ?, verified = ?, is_custom = 0`;
  const update = tenant.prepare(`UPDATE food_library SET ${columns} WHERE id = ?`);
  const insert = tenant.prepare(
    `INSERT INTO food_library
       (catalog_id, name, category, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g,
        serving_size_g, serving_label, brand, verified, is_custom)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );

  for (const food of foods) {
    const values = [
      food.id, food.name, food.category, food.serving_unit, food.calories, food.protein_g, food.carbs_g,
      food.fats_g, food.fiber_g, food.sugar_g, food.serving_size_g, food.serving_label, food.brand, food.verified,
    ];
    let id = linked.get(food.id);
    if (!id) {
      const match = byName.get(food.name);
      if (match && (match.barcode || match.catalog_id)) continue;
      id = match?.id;
    }
    try {
      if (id) update.run(...values, id);
      else insert.run(...values);
    } catch {
      // Renamed onto a name one of the gym's own foods already holds: this
      // gym keeps the old copy until the clash is gone.
    }
  }

  // Gone from the catalogue: gone from the gym. Entries logged with it keep
  // their own copy of the numbers; favourites of it go with it.
  const live = new Set(foods.map((f) => f.id));
  const remove = tenant.prepare('DELETE FROM food_library WHERE id = ?');
  for (const [catalogId, id] of linked) if (!live.has(catalogId)) remove.run(id);

  // Starter foods the operator removed before this gym first synced — a gym
  // created later is still seeded with them, and nothing else would retire them.
  const catalogNames = new Set(foods.map((f) => f.name.toLowerCase()));
  const retire = tenant.prepare(
    'DELETE FROM food_library WHERE name = ? AND catalog_id IS NULL AND is_custom = 0 AND barcode IS NULL',
  );
  for (const [name] of FOODS) if (!catalogNames.has(name.toLowerCase())) retire.run(name);
}
