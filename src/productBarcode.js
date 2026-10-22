import { config } from './config.js';
import { get } from './db.js';
import { HttpError } from './errors.js';
import { barcodeVariants, normaliseBarcode, openFoodFactsRecord } from './foodBarcode.js';
import { getStoreProduct, shelfProductByBarcode, storeRegistry } from './monetization.js';

/**
 * Scanning a pack's barcode to add it to a product list — the operator's
 * central catalogue, a partner shop's shelf, or a gym's own desk shelf.
 *
 * A scan answers one of two ways:
 *  - `existing`: the list already carries this pack (on the product, or on
 *    one of its flavour × size variants), so the panel opens it — to edit, to
 *    restock, to sell — instead of creating a duplicate.
 *  - `suggestion`: a new product's details to start from. First from any
 *    listing on the platform with the same barcode (another shop's, or the
 *    central catalogue's — title, brand, label and the MRP printed on the
 *    pack, never anyone's own price), then from Open Food Facts. Null when
 *    neither knows it: the barcode is still kept on the new product, so the
 *    next scan finds it.
 *
 * The coaching store's shelves sell books, whose barcode is their ISBN: there
 * the second source is Open Library instead — title, author, publisher, pages
 * and the cover — and a code that is not an ISBN (a pen, a calculator) has
 * none, since Open Food Facts only knows groceries.
 */

const { one } = storeRegistry;

/** A store category from a product's name and Open Food Facts categories. */
function guessStoreCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/pre[\s-]?workout/.test(t)) return 'preworkout';
  if (/creatine/.test(t)) return 'creatine';
  if (/\b(bcaa|eaa|amino|glutamine)/.test(t)) return 'bcaa';
  if (/\b(bars?|cookies?|snacks?|peanut[\s-]butter|muesli|granola|chips|oats)\b/.test(t)) return 'snacks';
  if (/vitamin|multivit|omega|fish[\s-]oil|zinc|magnesium|ashwagandha|biotin|electrolyte/.test(t)) return 'vitamins';
  if (/whey|protein|casein|isolate|gainer/.test(t)) return 'protein';
  if (/shaker|glove|belt|strap|wrap/.test(t)) return 'gear';
  return 'other';
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Per-serving facts, the shape the store's nutrition table takes. Open Food
 * Facts gives per-serving values when the label has them, and per 100 g
 * always; the second is scaled by the serving's weight when that is known. */
function servingFacts(product) {
  const n = product.nutriments || {};
  const grams = Number(product.serving_quantity) || null;
  const pick = (key) => {
    const serving = Number(n[`${key}_serving`]);
    if (Number.isFinite(serving) && n[`${key}_serving`] !== undefined && n[`${key}_serving`] !== '') return round1(serving);
    const per100 = Number(n[`${key}_100g`]);
    if (grams && Number.isFinite(per100) && n[`${key}_100g`] !== undefined) return round1((per100 * grams) / 100);
    return undefined;
  };
  const facts = {
    serving_size: product.serving_size ? String(product.serving_size).slice(0, 40) : undefined,
    calories: pick('energy-kcal'),
    protein_g: pick('proteins'),
    carbs_g: pick('carbohydrates'),
    sugar_g: pick('sugars'),
    fat_g: pick('fat'),
  };
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return Object.keys(clean).length > (clean.serving_size ? 1 : 0) ? clean : null;
}

function fromOpenFoodFacts(product) {
  const title = String(product.product_name_en || product.product_name || '').trim();
  const brand = String(product.brands || '').split(',')[0].trim();
  if (!title && !brand) return null;
  const categories = (product.categories_tags || []).join(' ').replace(/en:|-/g, ' ');
  const image = product.image_front_url || product.image_url || null;
  return {
    title: title || brand,
    brand: brand || null,
    category: guessStoreCategory(`${title} ${categories}`),
    description: product.generic_name ? String(product.generic_name).trim().slice(0, 500) : null,
    image_url: image && /^https?:\/\//.test(image) ? image : null,
    nutrition_facts: servingFacts(product),
    size: product.quantity ? String(product.quantity).trim().slice(0, 40) : null,
    mrp: null,
    beverage: /beverage|drink/.test(categories),
  };
}

/** The newest listing anywhere in `vertical`'s store carrying this barcode. */
function fromCatalogue(code, vertical) {
  const codes = barcodeVariants(code);
  const marks = codes.map(() => '?').join(',');
  const hit = one(
    `SELECT p.id, v.id AS variant_id FROM store_products p
     LEFT JOIN store_product_variants v ON v.product_id = p.id AND v.barcode IN (${marks})
     WHERE p.vertical = ? AND (p.barcode IN (${marks}) OR v.id IS NOT NULL)
     ORDER BY p.active DESC, p.updated_at DESC, p.id DESC LIMIT 1`,
    ...codes,
    vertical,
    ...codes,
  );
  if (!hit) return null;
  const p = getStoreProduct(hit.id);
  const variant = hit.variant_id ? p.variants.find((v) => v.id === hit.variant_id) : null;
  return {
    title: p.title,
    brand: p.brand,
    category: p.category,
    description: p.description,
    // The cover photo's address: content-addressed, so it can be shared.
    image_url: p.image_url,
    nutrition_facts: p.nutrition_facts,
    book_details: p.book_details,
    lab_report_url: p.lab_report_url,
    size: variant?.weight ?? null,
    flavor: variant?.flavor ?? null,
    mrp: variant ? variant.effective_mrp : p.mrp,
    beverage: false,
  };
}

/** ISBN-13s are EAN-13s from the 978/979 "Bookland" range. */
const isIsbn = (code) => /^97[89]\d{10}$/.test(code);

/** A coaching store category from a book's title and subjects. */
function guessBookCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/previous[\s-]years?|\bpyqs?\b|solved papers|chapter[\s-]?wise solutions/.test(t)) return 'pyq';
  if (/\b(jee|neet|upsc|gate|cat|ssc|clat|cuet|nda|olympiad|ias|banking)\b|objective|practice|mock tests?|question bank|guide/.test(t)) return 'test_prep';
  return 'books';
}

const BOOK_LOOKUP_TIMEOUT_MS = 6000;

/** A book's details from Open Library, in the store's suggestion shape —
 * its publisher stands where a supplement's brand would. */
async function fromOpenLibrary(isbn) {
  let res;
  try {
    res = await fetch(`${config.bookDbUrl}/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`, {
      headers: { 'User-Agent': config.foodDbUserAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(BOOK_LOOKUP_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the book database');
  }
  if (!res.ok) throw new HttpError(502, 'The book database is having trouble');
  const book = (await res.json().catch(() => null))?.[`ISBN:${isbn}`];
  if (!book?.title) return null;
  const title = [book.title, book.subtitle].filter(Boolean).join(': ').slice(0, 120);
  const authors = (book.authors ?? []).map((a) => a?.name).filter(Boolean);
  const publisher = book.publishers?.[0]?.name ? String(book.publishers[0].name).slice(0, 80) : null;
  const subjects = (book.subjects ?? []).map((s) => s?.name ?? s).join(' ');
  const cover = book.cover?.large || book.cover?.medium || null;
  const details = {
    author: authors.slice(0, 3).join(', ') || undefined,
    publisher: publisher ?? undefined,
    year: Number(/\b(1[89]|20)\d\d\b/.exec(book.publish_date ?? '')?.[0]) || undefined,
    pages: Number.isInteger(book.number_of_pages) ? book.number_of_pages : undefined,
    isbn,
  };
  return {
    title,
    brand: publisher ?? authors[0] ?? null,
    category: guessBookCategory(`${title} ${subjects}`),
    description: null,
    image_url: cover && /^https?:\/\//.test(cover) ? cover : null,
    nutrition_facts: null,
    book_details: Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined)),
    size: null,
    mrp: null,
    beverage: false,
  };
}

async function suggest(code, vertical = 'gym') {
  const listed = fromCatalogue(code, vertical);
  if (listed) return { suggestion: listed, source: 'catalogue' };
  try {
    if (vertical === 'coaching') {
      const book = isIsbn(code) ? await fromOpenLibrary(code) : null;
      return { suggestion: book, source: book ? 'openlibrary' : null };
    }
    const record = await openFoodFactsRecord(code);
    const suggestion = record ? fromOpenFoodFacts(record) : null;
    return { suggestion, source: suggestion ? 'openfoodfacts' : null };
  } catch (err) {
    // Open Food Facts down or busy: the product can still be added by hand,
    // barcode and all — the scan is not wasted.
    if (err.status === 429 || err.status === 502) return { suggestion: null, source: null, lookup_error: err.message };
    throw err;
  }
}

/** A scan on a store shelf: `sellerId` null is the central catalogue of
 * `vertical`'s store, a number a partner shop's shelf. */
export async function lookupStoreBarcode(raw, { sellerId, vertical = 'gym' }) {
  const code = normaliseBarcode(raw);
  const hit = shelfProductByBarcode(code, sellerId, null, vertical);
  if (hit) return { barcode: code, existing: getStoreProduct(hit.id), variant_id: hit.variant_id ?? null };
  return { barcode: code, existing: null, ...(await suggest(code, vertical)) };
}

const GYM_CATEGORY = { protein: 'supplements', creatine: 'supplements', preworkout: 'supplements', bcaa: 'supplements', vitamins: 'supplements', snacks: 'snacks', gear: 'accessories', other: 'other' };

/** A store suggestion in the gym shelf's shape: one name, its own categories,
 * and the pack's MRP as a starting price. */
function toGymProduct(s) {
  const startsWithBrand = s.brand && s.title.toLowerCase().startsWith(s.brand.toLowerCase());
  const name = [startsWithBrand ? null : s.brand, s.title, s.flavor, s.size && !s.title.includes(s.size) ? s.size : null]
    .filter(Boolean)
    .join(' ')
    .slice(0, 120);
  return {
    name,
    category: s.beverage ? 'drinks' : GYM_CATEGORY[s.category] ?? 'other',
    description: s.description ?? null,
    price: s.mrp ?? null,
  };
}

/** A scan at a gym's desk, against the gym's own shelf. Runs inside the
 * gym's database, like every other store-hub call. */
export async function lookupGymBarcode(raw) {
  const code = normaliseBarcode(raw);
  const codes = barcodeVariants(code);
  const existing = get(
    `SELECT * FROM gym_products WHERE barcode IN (${codes.map(() => '?').join(',')}) ORDER BY active DESC, id DESC LIMIT 1`,
    codes,
  );
  if (existing) return { barcode: code, existing };
  const { suggestion, source, lookup_error } = await suggest(code);
  return { barcode: code, existing: null, source, lookup_error, suggestion: suggestion ? toGymProduct(suggestion) : null };
}

/** The gym product already carrying `code`, other than `exceptId`. */
export function gymProductByBarcode(code, exceptId = null) {
  const codes = barcodeVariants(code);
  return get(
    `SELECT id, name FROM gym_products WHERE barcode IN (${codes.map(() => '?').join(',')}) AND id IS NOT ? LIMIT 1`,
    [...codes, exceptId],
  );
}
