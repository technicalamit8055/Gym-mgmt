/**
 * One food search for the member app and the staff diet builder, in two tiers:
 *
 *   1. The gym's own food_library — which already holds the platform
 *      catalogue (syncFoodCatalog() copies it in), the gym's own foods and
 *      every pack scanned there. Instant, and verified foods come first.
 *   2. Online, only when the library has little to offer (or the person asks):
 *      USDA FoodData Central for whole foods and Open Food Facts for packs,
 *      side by side, each behind a 24-hour cache and its own rate limit, so a
 *      slow or missing upstream costs a search its online half, never the
 *      local one.
 *
 * Online results are shown, not stored. The one a person picks is copied into
 * the gym's library (importFood()), so it is logged by food_id like any other
 * and found locally next time — the same "first lookup leaves the building,
 * the second doesn't" rule as barcode scanning.
 */

import { config } from './config.js';
import { all, get } from './db.js';
import { badRequest, notFound } from './errors.js';
import {
  insertSourcedFood,
  libraryFoodByBarcode,
  normaliseBarcode,
  openFoodFactsProduct,
  plausibleNutrition,
  searchOpenFoodFacts,
} from './foodBarcode.js';
import { syncFoodCatalog } from './foodCatalog.js';
import { INDIAN_STAPLE_NAMES } from './foodCoreSeed.js';
import { getUsdaFood, searchUsdaFoods } from './foodUsda.js';

export const FOOD_SOURCES = ['usda', 'openfoodfacts'];

/** Fewer local matches than this and the search goes online by itself. */
const LOCAL_ENOUGH = 5;
/** "eg" is not worth spending an upstream request on. */
const MIN_REMOTE_QUERY = 3;
const MAX_REMOTE_RESULTS = 30;

const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 500;
const PICKS_MAX = 5000;

/** `${source}:${query}` → { at, foods }. Shared by every gym on the server:
 * USDA's answer for "oats" is the same for all of them. Oldest out first. */
const cache = new Map();
/** Searches already on their way upstream, so ten members typing "whey" at
 * once cost one request, not ten. */
const inflight = new Map();
/** `${source}:${external_id}` → { at, food }: every result recently shown, so
 * picking one needs no second request — and so the numbers stored are the
 * ones the server fetched, never ones a client sent back. */
const picks = new Map();

/* ── Input ────────────────────────────────────────────────────────────── */

/** What gets searched for: control characters out, whitespace collapsed,
 * capped. Every use downstream is a bound parameter or URL-encoded. */
export function cleanQuery(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** ?external=1 always goes online, =0 never does; anything else lets the
 * number of local matches decide. */
export function externalMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return 'always';
  if (['0', 'false', 'no', 'off'].includes(v)) return 'never';
  return 'auto';
}

/** { ref: 'usda:171477' } or { source, external_id } → a checked pair. */
export function parseFoodRef(body = {}) {
  let { source, external_id: externalId } = body;
  if (body.ref !== undefined) [source, externalId] = String(body.ref).split(':', 2);
  source = String(source ?? '').trim().toLowerCase();
  externalId = String(externalId ?? '').trim();
  if (!FOOD_SOURCES.includes(source)) {
    throw badRequest('That is not one of the online food databases', { source: `use ${FOOD_SOURCES.join(' or ')}` });
  }
  if (!/^\d{1,20}$/.test(externalId)) {
    throw badRequest('That is not a food id from that database', { external_id: 'must be digits' });
  }
  return { source, externalId };
}

const normalisedName = (name) =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/* ── Tier 1: the gym's library ────────────────────────────────────────── */

/** A search term as literal text inside a LIKE pattern. */
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How well a library food answers the query. The order an Indian gym expects:
 * the everyday staples first (INDIAN_STAPLE_NAMES — "egg" is boiled egg and
 * bhurji), then other ticked foods, then the rest; within those, foods that
 * have the words as words ("egg", not "eggplant"), then names that start with
 * the query. Packs rank below whole foods, so a scanned egg-noodle pack never
 * sits above eggs.
 */
function libraryScore(food, query, terms) {
  const name = String(food.name).toLowerCase();
  let score = 0;
  if (name === query.toLowerCase()) score += 100;
  if (INDIAN_STAPLE_NAMES.has(name)) score += 40;
  if (food.verified) score += 25;
  const words = terms.map((t) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(t)}([^a-z0-9]|$)`).test(name));
  if (words.every(Boolean)) score += 15;
  else if (terms.every((t) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(t)}`).test(name))) score += 5;
  if (name.startsWith(query.toLowerCase())) score += 10;
  if (food.barcode || food.source === 'openfoodfacts' || food.source === 'member') score -= 20;
  return score;
}

/** Every word must appear in the name or brand, in any order — "breast
 * chicken" finds "Chicken Breast (grilled)" — then ranked by libraryScore(),
 * shortest name first on a tie. */
function searchLibrary(query, limit) {
  const terms = query.toLowerCase().split(' ').filter(Boolean).slice(0, 6);
  const where = terms.map(() => "(name LIKE ? ESCAPE '\\' OR COALESCE(brand, '') LIKE ? ESCAPE '\\')").join(' AND ');
  const candidates = all(
    `SELECT * FROM food_library WHERE ${where} ORDER BY verified DESC, length(name) LIMIT 500`,
    terms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]),
  );
  return candidates
    .map((food) => ({ food, score: libraryScore(food, query, terms) }))
    .sort((a, b) => b.score - a.score || a.food.name.length - b.food.name.length || a.food.name.localeCompare(b.food.name))
    .slice(0, limit)
    .map((r) => r.food);
}

/* ── Tier 2: online ───────────────────────────────────────────────────── */

function remember(source, foods) {
  const at = Date.now();
  for (const food of foods) {
    const key = `${source}:${food.external_id}`;
    picks.delete(key);
    picks.set(key, { at, food });
  }
  while (picks.size > PICKS_MAX) picks.delete(picks.keys().next().value);
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Re-inserted so a popular query is the last to be evicted.
  cache.delete(key);
  cache.set(key, hit);
  return hit.foods;
}

/** One source's results for `query`, and how they were got: 'ok', 'cached',
 * 'rate_limited' or 'unavailable'. Never throws — a dead upstream is a status. */
async function remoteSearch(source, query) {
  const key = `${source}:${query.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return { foods: hit, status: 'cached' };

  if (!inflight.has(key)) {
    const request = (source === 'usda' ? searchUsdaFoods(query) : searchOpenFoodFacts(query))
      .then((foods) => {
        // Empty answers are cached too: asking again within the day would
        // spend the rate limit to hear "nothing" a second time.
        cache.set(key, { at: Date.now(), foods });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        remember(source, foods);
        return foods;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
  }
  try {
    return { foods: await inflight.get(key), status: 'ok' };
  } catch (err) {
    if (err?.status !== 429 && err?.status !== 502) console.error(`[food search] ${source} failed:`, err?.message);
    return { foods: [], status: err?.status === 429 ? 'rate_limited' : 'unavailable' };
  }
}

/** USDA and Open Food Facts alternated, so neither buries the other, then
 * Indian packs lifted to the top and ticked foods next (a stable sort keeps
 * the alternation within each). */
function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((list) => i < list.length); i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out.sort((a, b) => (b.india ?? 0) - (a.india ?? 0) || b.verified - a.verified);
}

/**
 * The search: { query, items, remote, online }.
 *   items  — food_library rows, ready to log by id
 *   remote — online results not yet in the library, each with a `ref`
 *            ('usda:171477') to hand to importFood() when picked
 *   online — { searched, usda, openfoodfacts }: whether the online tier ran
 *            and each source's status ('ok', 'cached', 'rate_limited',
 *            'unavailable', 'skipped')
 */
export async function searchFoods({ q, external = 'auto', limit = 30 } = {}) {
  const query = cleanQuery(q);
  if (query.length < 2) throw badRequest('Type at least 2 letters to search', { q: 'at least 2 characters' });
  const max = Math.min(Math.max(Number(limit) || 30, 1), 100);

  syncFoodCatalog();
  const items = searchLibrary(query, max);

  const searched =
    config.foodSearchOnline &&
    query.length >= MIN_REMOTE_QUERY &&
    (external === 'always' || (external === 'auto' && items.length < LOCAL_ENOUGH));
  const online = { searched, usda: 'skipped', openfoodfacts: 'skipped' };
  if (!searched) return { query, items, remote: [], online };

  const results = await Promise.all(FOOD_SOURCES.map((source) => remoteSearch(source, query)));
  FOOD_SOURCES.forEach((source, i) => { online[source] = results[i].status; });

  // An online food this gym already picked once is a library food now: show
  // that row (it may have been renamed on a clash) instead of a second copy.
  const lists = results.map((r, i) => r.foods.map((food) => ({ ...food, source: FOOD_SOURCES[i] })));
  const refs = lists.flat().map((f) => [f.source, f.external_id]);
  const imported = refs.length
    ? all(
        `SELECT * FROM food_library WHERE external_id IS NOT NULL AND (${refs.map(() => '(source = ? AND external_id = ?)').join(' OR ')})`,
        refs.flat(),
      )
    : [];
  const shownIds = new Set(items.map((f) => f.id));
  for (const row of imported) {
    if (!shownIds.has(row.id)) {
      items.push(row);
      shownIds.add(row.id);
    }
  }

  // The same food twice — across sources, or already in the library under
  // the same name — is shown once, the library's copy winning.
  const importedRefs = new Set(imported.map((row) => `${row.source}:${row.external_id}`));
  const seenNames = new Set(items.map((f) => normalisedName(f.name)));
  const remote = [];
  for (const food of interleave(lists)) {
    const ref = `${food.source}:${food.external_id}`;
    const name = normalisedName(food.name);
    if (importedRefs.has(ref) || seenNames.has(name)) continue;
    seenNames.add(name);
    remote.push({ ...food, id: null, ref });
    if (remote.length >= MAX_REMOTE_RESULTS) break;
  }

  return { query, items, remote, online };
}

/* ── Picking an online food ───────────────────────────────────────────── */

function validBarcode(code) {
  try {
    return normaliseBarcode(code);
  } catch {
    return null;
  }
}

const libraryRowFor = (source, externalId) =>
  get('SELECT * FROM food_library WHERE source = ? AND external_id = ?', [source, externalId]);

/**
 * Copies an online food into this gym's library and returns the row:
 * { food, created }. Picking it again — or a pack someone already scanned —
 * returns the existing row. The numbers come from the server's own fetch
 * (cached from the search, or asked for again), never from the client.
 */
export async function importFood({ source, externalId }) {
  const existing = libraryRowFor(source, externalId);
  if (existing) return { food: existing, created: false };

  const barcode = source === 'openfoodfacts' ? validBarcode(externalId) : null;
  const scanned = barcode ? libraryFoodByBarcode(barcode) : null;
  if (scanned) return { food: scanned, created: false };

  const seen = picks.get(`${source}:${externalId}`);
  let food = seen && Date.now() - seen.at <= CACHE_TTL_MS ? seen.food : null;
  if (food && source === 'usda' && !food.serving_size_g) {
    // FDC's search leaves household measures off SR Legacy foods; the full
    // record has them ("3 oz (85g)"). Worth one request, once per gym — and
    // if it fails, the food still goes in, logged by weight.
    food = (await getUsdaFood(externalId).catch(() => null)) ?? food;
  }
  if (!food) food = source === 'usda' ? await getUsdaFood(externalId) : await openFoodFactsProduct(externalId);
  if (!food) throw notFound('That food is no longer in the online database');
  if (!plausibleNutrition(food)) throw badRequest('That food’s nutrition figures do not add up, so it was not added');

  // Someone else picked it while the request above was out.
  const raced = libraryRowFor(source, externalId) ?? (barcode ? libraryFoodByBarcode(barcode) : null);
  if (raced) return { food: raced, created: false };
  try {
    return { food: insertSourcedFood(food, { source, barcode, externalId }), created: true };
  } catch (err) {
    const row = libraryRowFor(source, externalId);
    if (row) return { food: row, created: false };
    throw err;
  }
}

/** Test hook: forget cached searches and remembered results. */
export function resetFoodSearchCaches() {
  cache.clear();
  inflight.clear();
  picks.clear();
}
