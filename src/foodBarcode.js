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
import { guessFoodCategory } from './foodCatalog.js';

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
  'categories_tags',
  'nutriscore_grade',
  'states_tags',
  'countries_tags',
  'lang',
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
 * Whether per-100 g (or ml) figures could describe a real food: no more than
 * 900 kcal (pure fat), no macro over 100 g, the macros together not over the
 * 100 g they are a share of, and no more sugar than carbohydrate. Rounding
 * gets a gram's grace. Crowd-sourced labels fail this more often than you'd
 * hope — a kJ figure typed as kcal, a per-pack column typed as per-100 g.
 */
export function plausibleNutrition(food) {
  const { calories, protein_g: p = 0, carbs_g: c = 0, fats_g: f = 0, fiber_g: fibre = 0, sugar_g: sugar = 0 } = food;
  if (!Number.isFinite(calories) || calories < 0 || calories > 900) return false;
  if ([p, c, f, fibre, sugar].some((v) => !Number.isFinite(v) || v < 0 || v > 100)) return false;
  return p + c + f <= 101 && sugar <= c + 1;
}

/** Open Food Facts' own completeness flags: a Nutri-Score could be worked out
 * and the nutrition table is marked complete. The plan's bar for the tick. */
function labelIsComplete(product) {
  const grade = String(product?.nutriscore_grade ?? '').toLowerCase();
  const states = Array.isArray(product?.states_tags) ? product.states_tags : [];
  return /^[a-e]$/.test(grade) && states.includes('en:nutrition-facts-completed');
}

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

  const food = {
    name: `${name}${hasPlain ? '' : ' (as prepared)'}`.slice(0, 120),
    brand: brand?.slice(0, 80) ?? null,
    category: guessFoodCategory((product.categories_tags ?? []).join(' '), rawName),
    serving_unit: liquid ? '100ml' : '100g',
    calories: Math.round(kcal),
    protein_g: round1(macros.protein_g),
    carbs_g: round1(macros.carbs_g),
    fats_g: round1(macros.fats_g),
    fiber_g: round1(macros.fiber_g),
    sugar_g: round1(macros.sugar_g),
    serving_size_g: servingG && servingG <= 2000 ? round1(servingG) : null,
    serving_label: product.serving_size ? String(product.serving_size).trim().slice(0, 60) : null,
    verified: labelIsComplete(product) ? 1 : 0,
  };
  return plausibleNutrition(food) ? food : null;
}

/**
 * Writes a food from outside the gym — a scanned pack, a pick from online
 * search — into this gym's library. Names are unique there, so a second food
 * that happens to share one gets its barcode (or where it came from) appended.
 * `externalId` is the source database's own id, so the same pick is found
 * again rather than copied twice.
 */
export function insertSourcedFood(food, { source, barcode = null, externalId = null }) {
  const taken = get('SELECT id FROM food_library WHERE name = ? COLLATE NOCASE', [food.name]);
  const suffix = barcode ?? { usda: 'USDA', openfoodfacts: 'Open Food Facts' }[source] ?? externalId ?? source;
  const name = taken ? `${food.name.slice(0, 104)} (${suffix})`.slice(0, 120) : food.name;
  const info = run(
    `INSERT INTO food_library
       (name, category, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g, is_custom,
        barcode, brand, serving_size_g, serving_label, source, external_id, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      food.category ?? 'general',
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
      externalId,
      food.verified ? 1 : 0,
    ],
  );
  return get('SELECT * FROM food_library WHERE id = ?', [info.lastInsertRowid]);
}

/** A barcode food — scanned and found upstream, or typed off the label. */
export function insertBarcodeFood(food, { barcode, source }) {
  return insertSourcedFood(food, { source, barcode, externalId: source === 'openfoodfacts' ? barcode : null });
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

/* ── Search by name ───────────────────────────────────────────────────── */

/** Open Food Facts allows far fewer searches than product reads (10 a
 * minute). Results are cached upstream of this (src/foodSearch.js), so the
 * window is only spent on queries nobody on this server has asked lately. */
const SEARCH_PER_MINUTE = 10;
let searchWindowStart = 0;
let searchWindowCount = 0;

function takeSearchSlot() {
  const now = Date.now();
  if (now - searchWindowStart >= 60_000) {
    searchWindowStart = now;
    searchWindowCount = 0;
  }
  if (searchWindowCount >= SEARCH_PER_MINUTE) {
    throw tooManyRequests('The packaged-food database is busy — try that search again in a minute');
  }
  searchWindowCount += 1;
}

/** Products whose label never gave a protein figure: a zero there would read
 * as "no protein", which for a fitness app is the one number that matters. */
function hasProtein(product) {
  const n = product?.nutriments ?? {};
  return finite(n.proteins_100g, n.proteins_prepared_100g) !== undefined;
}

/* ── Made for India ──────────────────────────────────────────────────── */

/** Brands an Indian member actually finds on the shelf, ranked first. */
export const INDIAN_BRANDS = [
  'Amul', 'Tata', 'Britannia', 'Mother Dairy', 'Pintola', 'Alpino', 'MuscleBlaze', 'Yogabar', 'Saffola',
  'Aashirvaad', 'Fortune', 'Haldiram', 'Bikaji', 'MTR', 'Patanjali', 'Dabur', 'Parle', 'Sunfeast', 'ITC',
  'Bournvita', 'Horlicks', 'Kissan', 'Nandini', 'Aavin', 'Verka', 'Gowardhan', 'Milky Mist', 'Epigamia',
  'Heritage', 'Govind', 'Kwality', 'The Whole Truth', 'RiteBite', 'Max Protein', 'True Elements', 'Happilo',
  'Too Yumm', 'Nutrabay', 'AS-IT-IS', 'Avvatar', 'Bigmuscles', 'Sofit', 'Act II', 'Bingo', 'Unibic',
  'Everest', 'MDH', 'Lijjat', 'Sundrop', 'Kellogg\'s India', 'Nestle India',
];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const INDIAN_BRAND = new RegExp(`(^|[^a-z])(${INDIAN_BRANDS.map(escapeRegExp).join('|')})([^a-z]|$)`, 'i');

const indiaTagged = (product) => (Array.isArray(product?.countries_tags) ? product.countries_tags : []).includes('en:india');
const indianBrand = (product) => INDIAN_BRAND.test(`${product?.brands ?? ''} ${product?.product_name_en || product?.product_name || ''}`);

/** Food words no English-language Indian label uses — "Oeufs de France",
 * "Nouilles aux oeufs", "Biscuits moelleux" — in French, Spanish, German,
 * Italian. One is enough to drop a product. */
const FOREIGN_WORDS = new RegExp(
  '\\b(' +
    [
      'oeufs?', 'œufs?', 'nouilles', 'moelleux', 'poulet', 'fromages?', 'lait', 'laitiers?', 'beurre', 'pâtes', 'pates',
      'céréales', 'cereales', 'farine', 'blé', 'ble', 'sucre', 'chocolat', 'jambon', 'galettes?', 'gâteaux?', 'gateaux?',
      'fourrés?', 'fourres?', 'saveur', 'complet', 'huevos?', 'leche', 'pollo', 'queso', 'galletas', 'harina',
      'azúcar', 'azucar', 'integral', 'milch', 'eier', 'käse', 'kase', 'hähnchen', 'hahnchen', 'nudeln', 'kekse',
      'vollkorn', 'uova', 'formaggio', 'biscotti', 'farina', 'zucchero', 'integrale', 'latte intero',
    ].join('|') +
    ')\\b',
  'i',
);
/** Small words that glue a foreign name together. One of the unmistakable
 * ones, or two of the ambiguous ones ("de", "la"), and it is not English. */
const FOREIGN_GLUE = /\b(aux|avec|sans|mit|und|ohne|della|delle|des|du|les|von|für|sin|con|el|los|las)\b/i;
const AMBIGUOUS_GLUE = /\b(de|la|le|di|al|et|y)\b/gi;

/**
 * Whether a product name reads as English (or Hindi). Accented Latin letters
 * mark a European label — unless the product is sold in India, where
 * "Nescafé" is still on the shelf. Other scripts are dropped; Devanagari is
 * kept.
 */
export function looksEnglish(name, { soldInIndia = false } = {}) {
  const text = String(name ?? '').normalize('NFC').replace(/[’‘´`'"“”–—™®©°•·]/g, ' ');
  if (!text.trim()) return false;
  if (FOREIGN_WORDS.test(text) || FOREIGN_GLUE.test(text)) return false;
  if ((text.match(AMBIGUOUS_GLUE) ?? []).length >= 2) return false;
  const rest = soldInIndia ? text.normalize('NFD').replace(/[̀-ͯ]/g, '') : text;
  return !/[^\x00-\x7Fऀ-ॿ]/.test(rest);
}

/** A search result an Indian member could plausibly buy: an English (or
 * Hindi) name, and not a label whose only language is a foreign one. */
function suitsIndia(product, food) {
  const lang = String(product.lang ?? '').toLowerCase();
  const englishLabel = ['en', 'hi'].includes(lang);
  if (lang && !englishLabel && !product.product_name_en && !indianBrand(product)) return false;
  // Country tags are crowd-edited and European packs pick up "India" now and
  // then; an accent is only forgiven on an Indian brand, or an India-tagged
  // pack whose label is in English or Hindi.
  return looksEnglish(food.name, { soldInIndia: indianBrand(product) || (indiaTagged(product) && englishLabel) });
}

async function fetchSearch(query, { limit, page, india }) {
  takeSearchSlot();
  const params = new URLSearchParams({
    search_terms: String(query),
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(Math.min(Math.max(Number(limit) || 20, 1), 50)),
    page: String(Math.max(Number(page) || 1, 1)),
    fields: FIELDS,
  });
  if (india) {
    params.set('tagtype_0', 'countries');
    params.set('tag_contains_0', 'contains');
    params.set('tag_0', 'india');
  }
  let res;
  try {
    res = await fetch(`${config.foodDbUrl}/cgi/search.pl?${params}`, {
      headers: { 'User-Agent': config.foodDbUserAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.foodSearchTimeoutMs),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Open Food Facts');
  }
  if (res.status === 429) throw tooManyRequests('Open Food Facts is rate-limiting this server');
  if (!res.ok) throw new HttpError(502, 'Open Food Facts is having trouble');
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.products) ? body.products : [];
}

/** Products → rows worth showing in India, Indian brands and India-tagged
 * packs first (a stable sort keeps Open Food Facts' own order within). */
function indianFoods(products) {
  const kept = [];
  for (const product of products) {
    const code = String(product?.code ?? '').trim();
    if (!/^\d{4,20}$/.test(code) || !hasProtein(product)) continue;
    const food = productToFood(product);
    if (!food || !suitsIndia(product, food)) continue;
    const brand = indianBrand(product);
    const tagged = indiaTagged(product);
    kept.push({
      food: { ...food, external_id: code, india: brand || tagged ? 1 : 0 },
      score: (brand ? 3 : 0) + (tagged ? 2 : 0) + food.verified,
    });
  }
  return kept.sort((a, b) => b.score - a.score).map((k) => k.food);
}

/**
 * Packaged foods by name, as food_library-shaped rows carrying `external_id`
 * (the product code) and `india` (an Indian brand, or sold in India) —
 * nothing is written here; the gym's library only gets the one a person
 * actually picks.
 *
 * Asks for products sold in India first; only when none of those survive
 * does it look worldwide, and even then foreign-language labels are dropped,
 * as are labels missing energy or protein or with numbers no food has.
 */
export async function searchOpenFoodFacts(query, { limit = 20, page = 1 } = {}) {
  const local = indianFoods(await fetchSearch(query, { limit, page, india: true }));
  if (local.length) return local;
  try {
    return indianFoods(await fetchSearch(query, { limit, page, india: false }));
  } catch (err) {
    // The India answer (nothing) stands rather than failing the search.
    if (err.status === 429) return local;
    throw err;
  }
}

/** One product by its code, as searchOpenFoodFacts() would have shown it —
 * for picking a search result the server no longer has cached. */
export async function openFoodFactsProduct(code) {
  const product = await fetchProduct(code);
  if (!product || !hasProtein(product)) return null;
  const food = productToFood(product);
  return food ? { ...food, external_id: String(code) } : null;
}

/** Test hook: forget remembered misses and the upstream rate windows. */
export function resetBarcodeCaches() {
  misses.clear();
  windowStart = 0;
  windowCount = 0;
  searchWindowStart = 0;
  searchWindowCount = 0;
}

