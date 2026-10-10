/**
 * Packaged foods by barcode: the gym's own food library first, then Open Food
 * Facts (https://openfoodfacts.org), the free, crowd-sourced database of
 * product labels.
 *
 * A product found upstream is copied into this gym's food_library, so the
 * second member to scan the same protein bar never leaves the building, and
 * the row is then logged through the ordinary food_id path — serving
 * arithmetic stays in one place. Members can add a product Open Food Facts
 * does not know (coverage of local brands is patchy); staff see and can
 * delete those like any custom food.
 *
 * Nutrition is stored per 100 g (or 100 ml), the one basis every label in the
 * database has; a product's own serving size rides along so the app can offer
 * "1 bar (40 g)" without a second lookup.
 */

import { config } from './config.js';
import { get, run } from './db.js';
import { HttpError, badRequest, tooManyRequests } from './errors.js';

/** Products that came back empty are not asked about again for a while —
 * across every gym on this server, since the answer is the same for all. */
const MISS_TTL_MS = 6 * 3600_000;
const misses = new Map();

/** Open Food Facts allows 100 product reads a minute per client; staying well
 * under it keeps one busy server from getting the whole platform blocked. */
const UPSTREAM_PER_MINUTE = 60;
let windowStart = 0;
let windowCount = 0;

const LOOKUP_TIMEOUT_MS = 8000;
const FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'quantity',
  'product_quantity_unit',
  'serving_size',
  'serving_quantity',
  'nutriments',
].join(',');

/** Digits only, and a valid check digit for the lengths that carry a plain
 * GTIN one. UPC-E (8 digits off the camera) checks against its expanded form,
 * so 8-digit codes are taken as read rather than wrongly refused. */
export function normaliseBarcode(raw) {
  const code = String(raw ?? '').replace(/[\s-]/g, '');
  if (!/^\d{8,14}$/.test(code)) {
    throw badRequest('A barcode is 8 to 14 digits', { barcode: 'must be 8 to 14 digits' });
  }
  if (code.length >= 12) {
    const digits = code.split('').map(Number);
    const check = digits.pop();
    const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== check) {
      throw badRequest('That barcode does not add up — check the digits', { barcode: 'has a wrong check digit' });
    }
  }
  return code;
}

/** A 12-digit UPC-A and its 13-digit EAN form (a leading zero) are the same
 * product; scanners and Open Food Facts disagree on which to report. */
function variants(code) {
  if (code.length === 12) return [code, `0${code}`];
  if (code.length === 13 && code.startsWith('0')) return [code, code.slice(1)];
  return [code];
}

export function libraryFoodByBarcode(code) {
  const forms = variants(code);
  return get(`SELECT * FROM food_library WHERE barcode IN (${forms.map(() => '?').join(', ')})`, forms) ?? null;
}

const round1 = (n) => Math.round(n * 10) / 10;
const finite = (...values) => values.map(Number).find((v) => Number.isFinite(v) && v >= 0);

/**
 * An Open Food Facts product as a food_library row, or null when its label is
 * missing the energy figure (or carries numbers no real food has).
 *
 * Some products — instant noodles, drink powders — only list values "as
 * prepared"; those are used, consistently, when the plain ones are absent.
 */
export function productToFood(product) {
  const n = product?.nutriments ?? {};
  const hasPlain = finite(n['energy-kcal_100g'], n['energy-kj_100g'], n.energy_100g) !== undefined;
  const suffix = hasPlain ? '_100g' : '_prepared_100g';
  const per100 = (key) => finite(n[`${key}${suffix}`]);

  const kj = per100('energy-kj') ?? per100('energy');
  const kcal = per100('energy-kcal') ?? (kj !== undefined ? kj / 4.184 : undefined);
  if (kcal === undefined || kcal > 900) return null;

  const macros = {
    protein_g: per100('proteins') ?? 0,
    carbs_g: per100('carbohydrates') ?? 0,
    fats_g: per100('fat') ?? 0,
    fiber_g: per100('fiber') ?? 0,
    sugar_g: per100('sugars') ?? 0,
  };
  if (Object.values(macros).some((v) => v > 100)) return null;

  const rawName = String(product.product_name_en || product.product_name || product.generic_name || '').trim();
  // `brands` often lists the company before the brand people know ("COCA-COLA
  // SERVICES SA/NV, Coca-Cola"): one already in the name is the right one and
  // needs no prefix; otherwise the first is put in front so "Masala Noodles"
  // is findable as "Maggi Masala Noodles".
  const brands = String(product.brands || '').split(',').map((b) => b.trim()).filter(Boolean);
  const named = brands.find((b) => rawName.toLowerCase().includes(b.toLowerCase()));
  const brand = named ?? brands[0] ?? null;
  if (!rawName && !brand) return null;
  const name = named || !brand ? rawName || brand : `${brand} ${rawName}`.trim();

  const liquid = product.product_quantity_unit === 'ml' || /\d\s*(ml|cl|l)\b/i.test(String(product.quantity || ''));
  const servingG = finite(product.serving_quantity);

  return {
    name: `${name}${hasPlain ? '' : ' (as prepared)'}`.slice(0, 120),
    brand: brand?.slice(0, 80) ?? null,
    serving_unit: liquid ? '100ml' : '100g',
    calories: Math.round(kcal),
    protein_g: round1(macros.protein_g),
    carbs_g: round1(macros.carbs_g),
    fats_g: round1(macros.fats_g),
    fiber_g: round1(macros.fiber_g),
    sugar_g: round1(macros.sugar_g),
    serving_size_g: servingG && servingG <= 2000 ? round1(servingG) : null,
    serving_label: product.serving_size ? String(product.serving_size).trim().slice(0, 60) : null,
  };
}

/** Writes a barcode food into this gym's library. Names are unique there, so
 * a second product that happens to share one gets its barcode appended. */
export function insertBarcodeFood(food, { barcode, source }) {
  const taken = get('SELECT id FROM food_library WHERE name = ? COLLATE NOCASE', [food.name]);
  const name = taken ? `${food.name.slice(0, 104)} (${barcode})` : food.name;
  const info = run(
    `INSERT INTO food_library
       (name, category, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g, is_custom,
        barcode, brand, serving_size_g, serving_label, source)
     VALUES (?, 'general', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      name,
      food.serving_unit,
      food.calories,
      food.protein_g,
      food.carbs_g,
      food.fats_g,
      food.fiber_g,
      food.sugar_g,
      barcode,
      food.brand ?? null,
      food.serving_size_g ?? null,
      food.serving_label ?? null,
      source,
    ],
  );
  return get('SELECT * FROM food_library WHERE id = ?', [info.lastInsertRowid]);
}

function takeUpstreamSlot() {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= UPSTREAM_PER_MINUTE) {
    throw tooManyRequests('Lots of scanning going on — try that barcode again in a minute');
  }
  windowCount += 1;
}

async function fetchProduct(code) {
  takeUpstreamSlot();
  let res;
  try {
    res = await fetch(`${config.foodDbUrl}/api/v2/product/${code}.json?fields=${FIELDS}`, {
      headers: { 'User-Agent': config.foodDbUserAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the food database — try again, or add the food by hand');
  }
  // Open Food Facts answers an unknown code with 404 and status 0.
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, 'The food database is having trouble — try again, or add the food by hand');
  const body = await res.json().catch(() => null);
  return body?.status === 1 ? body.product : null;
}

/**
 * The food for `code`:
 *   { found: true, food, source: 'library' | 'openfoodfacts' }
 *   { found: false, barcode, product }   product = what little is known, for
 *                                        prefilling the "add it" form, or null
 */
export async function lookupBarcode(rawCode) {
  const code = normaliseBarcode(rawCode);

  const local = libraryFoodByBarcode(code);
  if (local) return { found: true, food: local, source: 'library' };

  const missedUntil = misses.get(code);
  if (missedUntil && missedUntil > Date.now()) return { found: false, barcode: code, product: null };

  const product = await fetchProduct(code);
  const food = product ? productToFood(product) : null;
  if (!food) {
    misses.set(code, Date.now() + MISS_TTL_MS);
    const name = product ? String(product.product_name_en || product.product_name || '').trim() : '';
    const brand = product ? String(product.brands || '').split(',')[0].trim() : '';
    return { found: false, barcode: code, product: name || brand ? { name, brand } : null };
  }

  // A concurrent scan of the same pack may have written it while this one
  // was waiting on the network.
  const raced = libraryFoodByBarcode(code);
  if (raced) return { found: true, food: raced, source: 'library' };
  return { found: true, food: insertBarcodeFood(food, { barcode: code, source: 'openfoodfacts' }), source: 'openfoodfacts' };
}

/** Test hook: forget remembered misses and the upstream rate window. */
export function resetBarcodeCaches() {
  misses.clear();
  windowStart = 0;
  windowCount = 0;
}

