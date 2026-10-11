/**
 * Whole foods from USDA FoodData Central (https://fdc.nal.usda.gov), the US
 * government's public-domain nutrient database, for online food search.
 *
 * Only the three curated data types are asked for: Foundation and SR Legacy
 * (laboratory analyses — these get the blue tick) and Survey (FNDDS), the
 * as-eaten foods behind US dietary surveys. Branded foods are left to Open
 * Food Facts, which also covers packs sold outside the US.
 *
 * Every figure FDC returns for these types is per 100 g, so foods land on a
 * '100g' basis, with the first household measure ("1 cup (140g)") carried
 * along as the serving.
 */

import { config } from './config.js';
import { HttpError, tooManyRequests } from './errors.js';
import { plausibleNutrition } from './foodBarcode.js';
import { guessFoodCategory } from './foodCatalog.js';

export const USDA_DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
const VERIFIED_TYPES = new Set(['Foundation', 'SR Legacy']);

/** FDC allows 1,000 requests an hour on a free key and about 30 on DEMO_KEY,
 * per IP. Staying under both keeps a busy server from locking itself out. */
const hourlyBudget = () => (config.usdaApiKey === 'DEMO_KEY' ? 25 : 900);
let windowStart = 0;
let windowCount = 0;
/** After FDC itself says "too many", stop asking until this time. */
let pausedUntil = 0;

function takeSlot() {
  const now = Date.now();
  if (now < pausedUntil) throw tooManyRequests('USDA FoodData Central is rate-limiting this server');
  if (now - windowStart >= 3600_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= hourlyBudget()) throw tooManyRequests('The USDA food database budget for this hour is used up');
  windowCount += 1;
}

async function usdaFetch(pathname, { method = 'GET', body } = {}) {
  takeSlot();
  const url = `${config.usdaApiUrl}${pathname}${pathname.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(config.usdaApiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.foodSearchTimeoutMs),
    });
  } catch {
    throw new HttpError(502, 'Could not reach USDA FoodData Central');
  }
  if (res.status === 429) {
    pausedUntil = Date.now() + 10 * 60_000;
    throw tooManyRequests('USDA FoodData Central is rate-limiting this server');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, 'USDA FoodData Central is having trouble');
  return res.json().catch(() => null);
}

/* ── Normalising ──────────────────────────────────────────────────────── */

// FDC nutrient ids, with the older nutrient numbers as a fallback — search
// results and single-food reads label them differently.
const NUTRIENTS = {
  kcal: [[1008, '208'], [2048, '958'], [2047, '957']],
  kj: [[1062, '268']],
  protein_g: [[1003, '203']],
  fats_g: [[1004, '204']],
  carbs_g: [[1005, '205'], [1050, '205.2']],
  fiber_g: [[1079, '291']],
  sugar_g: [[2000, '269'], [1063, '269.3']],
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Nutrient id → amount, from either response shape: search results carry
 * { nutrientId, nutrientNumber, unitName, value }, a single-food read
 * { nutrient: { id, number, unitName }, amount }. */
function nutrientTable(list) {
  const table = new Map();
  for (const n of Array.isArray(list) ? list : []) {
    const id = Number(n.nutrientId ?? n.nutrient?.id);
    const number = String(n.nutrientNumber ?? n.nutrient?.number ?? '');
    const unit = String(n.unitName ?? n.nutrient?.unitName ?? '').toLowerCase();
    const value = Number(n.value ?? n.amount);
    if (!Number.isFinite(value) || value < 0) continue;
    // Energy comes in both kcal and kJ under the same name; keep them apart.
    if ((id === 1008 || number === '208') && unit === 'kj') continue;
    if (id) table.set(`id:${id}`, value);
    if (number) table.set(`no:${number}`, value);
  }
  return table;
}

function pick(table, key) {
  for (const [id, number] of NUTRIENTS[key]) {
    const value = table.get(`id:${id}`) ?? table.get(`no:${number}`);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The first household measure with a weight — "1 cup, chopped (91g)". */
function servingOf(food) {
  const measures = [
    ...(Array.isArray(food.foodMeasures) ? food.foodMeasures : []).map((m) => ({
      text: m.disseminationText,
      grams: Number(m.gramWeight),
      rank: Number(m.rank ?? 0),
    })),
    ...(Array.isArray(food.foodPortions) ? food.foodPortions : []).map((p) => ({
      text:
        p.portionDescription && !/quantity not specified/i.test(p.portionDescription)
          ? p.portionDescription
          : [p.amount, p.modifier || p.measureUnit?.name].filter((v) => v !== undefined && v !== null && v !== '' && v !== 'undetermined').join(' '),
      grams: Number(p.gramWeight),
      rank: Number(p.sequenceNumber ?? 0),
    })),
  ]
    .filter((m) => m.text && Number.isFinite(m.grams) && m.grams > 0 && m.grams <= 2000 && !/quantity not specified/i.test(m.text))
    .sort((a, b) => a.rank - b.rank);
  const first = measures[0];
  if (!first) return { serving_size_g: null, serving_label: null };
  const grams = round1(first.grams);
  return { serving_size_g: grams, serving_label: `${String(first.text).trim()} (${grams}g)`.slice(0, 60) };
}

function categoryText(food) {
  if (typeof food.foodCategory === 'string') return food.foodCategory;
  return food.foodCategory?.description ?? food.wweiaFoodCategory?.wweiaFoodCategoryDescription ?? '';
}

/**
 * An FDC food — from a search or a single read — as a food_library-shaped
 * row carrying `external_id` (the FDC id), or null when it has no energy
 * figure or numbers no real food has.
 */
export function usdaToFood(food) {
  if (!food?.fdcId || !food.description) return null;
  const table = nutrientTable(food.foodNutrients);
  const kj = pick(table, 'kj');
  const kcal = pick(table, 'kcal') ?? (kj !== undefined ? kj / 4.184 : undefined);
  if (kcal === undefined) return null;

  const row = {
    external_id: String(food.fdcId),
    name: String(food.description).trim().replace(/\s+/g, ' ').slice(0, 120),
    brand: null,
    category: guessFoodCategory(categoryText(food), food.description),
    serving_unit: '100g',
    calories: Math.round(kcal),
    protein_g: round1(pick(table, 'protein_g') ?? 0),
    carbs_g: round1(pick(table, 'carbs_g') ?? 0),
    fats_g: round1(pick(table, 'fats_g') ?? 0),
    fiber_g: round1(pick(table, 'fiber_g') ?? 0),
    sugar_g: round1(pick(table, 'sugar_g') ?? 0),
    ...servingOf(food),
    verified: VERIFIED_TYPES.has(food.dataType) ? 1 : 0,
    data_type: food.dataType ?? null,
  };
  return plausibleNutrition(row) ? row : null;
}

/* ── Calls ────────────────────────────────────────────────────────────── */

/** Lab-analysed foods first, then survey foods: the same "banana" appears in
 * all three, and the tick-worthy one should be the one people see. */
const TYPE_ORDER = new Map(USDA_DATA_TYPES.map((type, i) => [type, i]));

export async function searchUsdaFoods(query, { pageSize = 20 } = {}) {
  const body = await usdaFetch('/foods/search', {
    method: 'POST',
    body: {
      query: String(query),
      dataType: USDA_DATA_TYPES,
      pageSize: Math.min(Math.max(Number(pageSize) || 20, 1), 50),
      requireAllWords: true,
    },
  });
  const foods = Array.isArray(body?.foods) ? body.foods : [];
  return foods
    .map((food, index) => ({ food: usdaToFood(food), index, order: TYPE_ORDER.get(food.dataType) ?? 9 }))
    .filter((r) => r.food)
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((r) => r.food);
}

/** One food by FDC id, for picking a search result no longer cached. */
export async function getUsdaFood(fdcId) {
  if (!/^\d{1,10}$/.test(String(fdcId))) return null;
  const food = await usdaFetch(`/food/${fdcId}`);
  if (!food || !USDA_DATA_TYPES.includes(food.dataType)) return null;
  return usdaToFood(food);
}

/** Test hook: forget the rate window and any pause. */
export function resetUsdaLimits() {
  windowStart = 0;
  windowCount = 0;
  pausedUntil = 0;
}
