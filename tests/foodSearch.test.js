import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Unified food search: the gym's library, then USDA FoodData Central and Open
 * Food Facts. Both upstreams are one local stub — tests must not depend on the
 * internet, and the stub counts requests, which is how caching is proven.
 */

/** A valid EAN-13 from its first twelve digits. */
const ean13 = (twelve) => {
  const sum = twelve.split('').reverse().reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const WHEY_CODE = ean13('506046998683');
const BAR_CODE = ean13('890123400001');

const usdaNutrients = (values) =>
  Object.entries(values).map(([id, value]) => ({
    nutrientId: Number(id),
    unitName: Number(id) === 1062 ? 'kJ' : ['1008', '2047', '2048'].includes(id) ? 'KCAL' : 'G',
    value,
  }));

const USDA_SEARCH = {
  chicken: [
    {
      fdcId: 171477,
      description: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
      dataType: 'SR Legacy',
      foodCategory: 'Poultry Products',
      foodNutrients: usdaNutrients({ 1008: 165, 1062: 690, 1003: 31.02, 1004: 3.57, 1005: 0 }),
      foodMeasures: [
        { disseminationText: 'Quantity not specified', gramWeight: 100, rank: 1 },
        { disseminationText: '1 cup, chopped or diced', gramWeight: 140, rank: 2 },
      ],
    },
    {
      fdcId: 2341000,
      description: 'Chicken curry',
      dataType: 'Survey (FNDDS)',
      foodCategory: 'Chicken, whole pieces',
      foodNutrients: usdaNutrients({ 1008: 134, 1003: 12, 1004: 7, 1005: 5, 1079: 1, 2000: 2 }),
      foodMeasures: [{ disseminationText: '1 cup', gramWeight: 235, rank: 1 }],
    },
    {
      // Foundation foods give energy under the Atwater ids and may skip carbs.
      fdcId: 2646170,
      description: 'Chicken, breast, boneless, skinless, raw',
      dataType: 'Foundation',
      foodCategory: 'Poultry Products',
      foodNutrients: usdaNutrients({ 2047: 118, 1003: 22.5, 1004: 1.93 }),
    },
    { fdcId: 999001, description: 'Broken record', dataType: 'SR Legacy', foodNutrients: usdaNutrients({ 1008: 2000 }) },
  ],
};

/** A single-food read, in FDC's other shape. */
const USDA_FOODS = {
  170567: {
    fdcId: 170567,
    description: 'Seeds, chia seeds, dried',
    dataType: 'SR Legacy',
    foodCategory: { description: 'Nut and Seed Products' },
    foodNutrients: [
      { nutrient: { id: 1008, number: '208', unitName: 'kcal' }, amount: 486 },
      { nutrient: { id: 1003, number: '203', unitName: 'g' }, amount: 16.5 },
      { nutrient: { id: 1004, number: '204', unitName: 'g' }, amount: 30.7 },
      { nutrient: { id: 1005, number: '205', unitName: 'g' }, amount: 42.1 },
      { nutrient: { id: 1079, number: '291', unitName: 'g' }, amount: 34.4 },
    ],
    foodPortions: [{ amount: 1, modifier: 'oz', gramWeight: 28, sequenceNumber: 1 }],
  },
};

const OFF_SEARCH = {
  whey: [
    {
      code: WHEY_CODE,
      product_name: 'Impact Whey Protein',
      brands: 'Myprotein',
      categories_tags: ['en:dietary-supplements', 'en:bodybuilding-supplements', 'en:protein-powders'],
      nutriscore_grade: 'b',
      states_tags: ['en:nutrition-facts-completed', 'en:photos-validated'],
      serving_size: '25 g',
      serving_quantity: 25,
      nutriments: { 'energy-kcal_100g': 412, proteins_100g: 82, carbohydrates_100g: 4, fat_100g: 7.5, sugars_100g: 4 },
    },
    {
      code: BAR_CODE,
      product_name: 'Whey Crisp Bar',
      brands: 'Acme',
      categories_tags: ['en:snacks', 'en:protein-bars'],
      nutriments: { 'energy-kcal_100g': 380, proteins_100g: 30, carbohydrates_100g: 40, fat_100g: 12, sugars_100g: 3 },
    },
    // No protein figure on the label: dropped.
    { code: ean13('890123400002'), product_name: 'Whey Mystery', nutriments: { 'energy-kcal_100g': 300 } },
    // More sugar than carbohydrate: a typo, dropped.
    { code: ean13('890123400003'), product_name: 'Whey Typo', nutriments: { 'energy-kcal_100g': 300, proteins_100g: 20, carbohydrates_100g: 10, sugars_100g: 40 } },
    // A shop's own short code: kept, but not stored as a scannable barcode.
    { code: '12345', product_name: 'Whey Lassi', brands: 'Local Dairy', nutriments: { 'energy-kcal_100g': 70, proteins_100g: 4, carbohydrates_100g: 9, fat_100g: 2 } },
  ],
  // What a worldwide search for "eggs" really returns: French groceries,
  // with one Indian pack in among them.
  eggs: [
    { code: ean13('376000000001'), product_name: 'Oeufs de france Stéphanie eleveur', lang: 'fr', countries_tags: ['en:france', 'en:india'], nutriments: { 'energy-kcal_100g': 140, proteins_100g: 12.5, carbohydrates_100g: 0.5, fat_100g: 10 } },
    { code: ean13('376000000002'), product_name: 'Nouilles aux oeufs', brands: 'Lustucru', countries_tags: ['en:india'], nutriments: { 'energy-kcal_100g': 360, proteins_100g: 13, carbohydrates_100g: 70, fat_100g: 3 } },
    { code: ean13('376000000003'), product_name: 'Gerblé biscuits', brands: 'Gerblé', countries_tags: ['en:india'], nutriments: { 'energy-kcal_100g': 450, proteins_100g: 8, carbohydrates_100g: 65, fat_100g: 16 } },
    { code: ean13('890100000004'), product_name: 'Farm Fresh Brown Eggs', brands: 'Eggoz', lang: 'en', countries_tags: ['en:india'], nutriments: { 'energy-kcal_100g': 143, proteins_100g: 12.6, carbohydrates_100g: 0.7, fat_100g: 9.5 } },
  ],
  // Nothing tagged for India, so the worldwide search answers; the Indian
  // brand is lifted above the one Open Food Facts listed first.
  'protein bar': [
    { code: ean13('500000000005'), product_name: 'Barre protéinée chocolat', brands: 'Gerlinéa', nutriments: { 'energy-kcal_100g': 380, proteins_100g: 30, carbohydrates_100g: 35, fat_100g: 12 } },
    { code: ean13('500000000006'), product_name: 'Crunch Protein Bar', brands: 'Acme', lang: 'en', nutriments: { 'energy-kcal_100g': 390, proteins_100g: 28, carbohydrates_100g: 40, fat_100g: 13 } },
    { code: ean13('890100000007'), product_name: 'Protein Bar Almond Fudge', brands: 'Yogabar', lang: 'en', nutriments: { 'energy-kcal_100g': 400, proteins_100g: 25, carbohydrates_100g: 42, fat_100g: 15 } },
  ],
};

let mode = 'ok';
const counts = { usda: 0, off: 0 };
let lastUsda = null;
let lastOffAgent = '';
const offSearches = [];

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/fdc/')) {
    counts.usda += 1;
    if (mode === 'down') return send(500, {});
    if (mode === 'limited') return send(429, {});
    if (url.pathname === '/fdc/v1/foods/search') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        lastUsda = { apiKey: url.searchParams.get('api_key'), body: JSON.parse(raw || '{}') };
        send(200, { foods: USDA_SEARCH[lastUsda.body.query.toLowerCase()] ?? [] });
      });
      return undefined;
    }
    const id = /^\/fdc\/v1\/food\/(\d+)$/.exec(url.pathname)?.[1];
    return USDA_FOODS[id] ? send(200, USDA_FOODS[id]) : send(404, {});
  }
  counts.off += 1;
  lastOffAgent = req.headers['user-agent'];
  if (mode === 'down') return send(500, {});
  if (url.pathname === '/cgi/search.pl') {
    offSearches.push(Object.fromEntries(url.searchParams));
    const products = OFF_SEARCH[url.searchParams.get('search_terms').toLowerCase()] ?? [];
    // Honours the country filter the way Open Food Facts does.
    const india = url.searchParams.get('tagtype_0') === 'countries' && url.searchParams.get('tag_0') === 'india';
    return send(200, { products: india ? products.filter((p) => p.countries_tags?.includes('en:india')) : products });
  }
  const code = /\/api\/v2\/product\/(\d+)\.json/.exec(url.pathname)?.[1];
  const product = Object.values(OFF_SEARCH).flat().find((p) => p.code === code);
  return product ? send(200, { status: 1, code, product }) : send(404, { status: 0, code });
});
stub.listen(0);
await new Promise((resolve) => stub.once('listening', resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-foodsearch-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.FOOD_DB_URL = stubUrl;
process.env.USDA_API_URL = `${stubUrl}/fdc/v1`;
process.env.USDA_API_KEY = 'test-key';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { looksEnglish, plausibleNutrition, resetBarcodeCaches } = await import('../src/foodBarcode.js');
const { guessFoodCategory } = await import('../src/foodCatalog.js');
const { CORE_FOODS } = await import('../src/foodCoreSeed.js');
const { resetFoodSearchCaches } = await import('../src/foodSearch.js');
const { resetUsdaLimits, usdaToFood } = await import('../src/foodUsda.js');

const TENANT = 'searchgym';
let base;
let server;
let adminToken;
let memberToken;

const call = async (method, urlPath, body, { token = memberToken, tenant = TENANT } = {}) => {
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
const memberSearch = (q, extra = '') => call('GET', `/api/portal/diets/food-search?q=${encodeURIComponent(q)}${extra}`);
const staffSearch = (q, extra = '') => call('GET', `/api/diets/food-search?q=${encodeURIComponent(q)}${extra}`, undefined, { token: adminToken });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await call('POST', '/api/platform/signup', {
    slug: TENANT, gym_name: 'Search Gym', admin_name: 'Owner', admin_email: 'owner@searchgym.test', admin_password: 'ownerpass123',
  }, { token: null, tenant: null });
  adminToken = (await call('POST', '/api/auth/login', { email: 'owner@searchgym.test', password: 'ownerpass123' }, { token: null })).body.token;
  const member = (await call('POST', '/api/members', { first_name: 'Ravi', phone: '9876505555' }, { token: adminToken })).body;
  await call('POST', '/api/fitness-addons/subscribe', { member_id: member.id }, { token: adminToken });
  memberToken = await signInMember(call, { staffToken: adminToken, memberId: member.id });
});

beforeEach(() => {
  mode = 'ok';
  resetBarcodeCaches();
  resetUsdaLimits();
});

after(() => {
  server.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('reading USDA FoodData Central', () => {
  it('takes kcal and macros per 100 g, and the first real household measure', () => {
    const food = usdaToFood(USDA_SEARCH.chicken[0]);
    assert.equal(food.external_id, '171477');
    assert.equal(food.calories, 165);
    assert.equal(food.protein_g, 31);
    assert.equal(food.fats_g, 3.6);
    assert.equal(food.serving_unit, '100g');
    assert.equal(food.category, 'protein');
    assert.equal(food.verified, 1, 'SR Legacy is lab data');
    assert.equal(food.serving_size_g, 140);
    assert.equal(food.serving_label, '1 cup, chopped or diced (140g)');
  });

  it('reads Foundation energy ids, survey foods unticked, and a single-food read', () => {
    const foundation = usdaToFood(USDA_SEARCH.chicken[2]);
    assert.equal(foundation.calories, 118);
    assert.equal(foundation.carbs_g, 0);
    assert.equal(foundation.verified, 1);

    const survey = usdaToFood(USDA_SEARCH.chicken[1]);
    assert.equal(survey.verified, 0);
    assert.equal(survey.fiber_g, 1);

    const chia = usdaToFood(USDA_FOODS[170567]);
    assert.equal(chia.calories, 486);
    assert.equal(chia.fiber_g, 34.4);
    assert.equal(chia.category, 'fats');
    assert.equal(chia.serving_label, '1 oz (28g)');
  });

  it('drops impossible numbers', () => {
    assert.equal(usdaToFood(USDA_SEARCH.chicken[3]), null);
    assert.equal(plausibleNutrition({ calories: 950 }), false);
    assert.equal(plausibleNutrition({ calories: 400, protein_g: 60, carbs_g: 50, fats_g: 10 }), false);
    assert.equal(plausibleNutrition({ calories: 400, protein_g: 10, carbs_g: 5, sugar_g: 20 }), false);
    assert.equal(plausibleNutrition({ calories: 884, fats_g: 100 }), true);
  });

  it('files outside categories under the gym ones', () => {
    assert.equal(guessFoodCategory('en:dietary-supplements en:protein-powders'), 'supplements');
    assert.equal(guessFoodCategory('Dairy and Egg Products'), 'dairy');
    assert.equal(guessFoodCategory('Fruits and Fruit Juices'), 'fruits');
    assert.equal(guessFoodCategory('Cereal Grains and Pasta'), 'carbs');
    assert.equal(guessFoodCategory('Spices and Herbs', 'Boiled cloves'), 'general', '"boiled" is not "oil"');
  });
});

describe('the verified core seed', () => {
  it('reaches every gym with the blue tick and a serving', async () => {
    const res = await call('GET', '/api/diets/foods?q=Ragi', undefined, { token: adminToken });
    const ragi = res.body.items.find((f) => f.name === 'Ragi / Finger Millet Flour');
    assert.ok(ragi);
    assert.equal(ragi.verified, 1);
    assert.equal(ragi.serving_unit, '100g');
    assert.equal(ragi.serving_size_g, 40);
    assert.ok(CORE_FOODS.length >= 100);
  });
});

describe('searching', () => {
  it('stays local when the library has enough, verified foods first', async () => {
    resetFoodSearchCaches();
    const before = { ...counts };
    const res = await memberSearch('chicken');
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 5);
    assert.equal(res.body.items[0].verified, 1);
    assert.deepEqual(res.body.remote, []);
    assert.equal(res.body.online.searched, false);
    assert.deepEqual(counts, before, 'no upstream request');
  });

  it('matches every word in any order', async () => {
    const res = await memberSearch('breast chicken', '&external=0');
    assert.ok(res.body.items.some((f) => f.name === 'Chicken Breast (grilled)'));
  });

  it('asks USDA and Open Food Facts when told to, lab foods first', async () => {
    const res = await memberSearch('chicken', '&external=1');
    assert.equal(res.body.online.searched, true);
    assert.equal(res.body.online.usda, 'ok');
    assert.equal(res.body.online.openfoodfacts, 'ok');
    const usda = res.body.remote.filter((f) => f.source === 'usda');
    assert.deepEqual(usda.map((f) => f.external_id), ['2646170', '171477', '2341000']);
    assert.ok(usda.every((f) => f.ref === `usda:${f.external_id}` && f.id === null));
    assert.deepEqual(lastUsda.body.dataType, ['Foundation', 'SR Legacy', 'Survey (FNDDS)']);
    assert.equal(lastUsda.apiKey, 'test-key');
  });

  it('goes online by itself when the library has little, and keeps only sound labels', async () => {
    const res = await memberSearch('whey');
    assert.equal(res.body.online.searched, true);
    const names = res.body.remote.map((f) => f.name);
    assert.ok(names.includes('Myprotein Impact Whey Protein'));
    assert.ok(!names.includes('Whey Mystery'), 'no protein figure');
    assert.ok(!names.includes('Whey Typo'), 'more sugar than carbs');
    const whey = res.body.remote.find((f) => f.external_id === WHEY_CODE);
    assert.equal(whey.source, 'openfoodfacts');
    assert.equal(whey.category, 'supplements');
    assert.equal(whey.verified, 1, 'Nutri-Score and a complete label');
    assert.equal(res.body.remote.find((f) => f.external_id === BAR_CODE).verified, 0);
    assert.match(lastOffAgent, /GymBook/);
  });

  it('answers a repeated search from the cache', async () => {
    const before = { ...counts };
    const res = await memberSearch('WHEY');
    assert.equal(res.body.online.openfoodfacts, 'cached');
    assert.equal(res.body.online.usda, 'cached');
    assert.deepEqual(counts, before);
  });

  it('still answers from the library when the online databases are down', async () => {
    mode = 'down';
    const res = await memberSearch('paneer tikka');
    assert.equal(res.status, 200);
    assert.equal(res.body.online.usda, 'unavailable');
    assert.equal(res.body.online.openfoodfacts, 'unavailable');
    assert.deepEqual(res.body.remote, []);
  });

  it('reports a rate-limited source and leaves the other working', async () => {
    mode = 'limited';
    const res = await staffSearch('oats', '&external=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.online.usda, 'rate_limited');
    assert.equal(res.body.online.openfoodfacts, 'ok');
  });

  it('validates the query', async () => {
    assert.equal((await memberSearch('a')).status, 400);
    const sneaky = await memberSearch("%' OR 1=1 --", '&external=0');
    assert.equal(sneaky.status, 200);
    assert.deepEqual(sneaky.body.items, []);
    const long = await memberSearch('x'.repeat(300), '&external=0');
    assert.equal(long.body.query.length, 80);
    assert.equal((await call('GET', '/api/portal/diets/food-search?q=whey', undefined, { token: null })).status, 401);
  });
});

describe('tailored to India', () => {
  it('reads foreign-language names as foreign', () => {
    for (const name of [
      'Oeufs de france Stéphanie eleveur',
      'Lustucru Nouilles aux oeufs',
      'Gerblé biscuits',
      'Biscuits moelleux',
      'Leche entera',
      'Vollkorn Nudeln',
      'Pollo con verduras',
      'Pan de la casa',
      'Молоко',
    ]) {
      assert.equal(looksEnglish(name), false, name);
    }
    for (const name of ['Amul Taaza Toned Milk', 'MuscleBlaze Biozyme Performance Whey', "Haldiram's Aloo Bhujia", 'Mother Dairy Dahi', 'अमूल दूध', 'Nature Valley Oats & Honey']) {
      assert.equal(looksEnglish(name), true, name);
    }
    assert.equal(looksEnglish('Nescafé Classic'), false);
    assert.equal(looksEnglish('Nescafé Classic', { soldInIndia: true }), true, 'an accent alone is fine on a pack sold in India');
    assert.equal(looksEnglish('Nouilles aux oeufs', { soldInIndia: true }), false, 'foreign words never are');
  });

  it('puts the everyday Indian egg foods at the top of "egg"', async () => {
    const res = await memberSearch('egg');
    const names = res.body.items.map((f) => f.name);
    assert.deepEqual(new Set(names.slice(0, 4)), new Set(['Whole Boiled Egg', 'Egg White (raw or boiled)', 'Scrambled Egg', 'Egg Bhurji']));
    assert.ok(names.indexOf('Egg Noodles (cooked)') > 3);
    assert.ok(names.indexOf('Brinjal / Eggplant') > names.indexOf('Egg Noodles (cooked)'), '"eggplant" is not the word "egg"');
    assert.equal(res.body.online.searched, false, 'enough at home: no foreign groceries asked for');
  });

  it('ranks Indian staples first for chicken, paneer and milk too', async () => {
    const chicken = (await memberSearch('chicken', '&external=0')).body.items.slice(0, 3).map((f) => f.name);
    assert.ok(chicken.every((n) => ['Chicken Breast (grilled)', 'Tandoori Chicken Breast', 'Chicken Curry (home-style)'].includes(n)), chicken.join(', '));
    assert.equal((await memberSearch('paneer', '&external=0')).body.items[0].name, 'Paneer');
    const milk = (await memberSearch('milk', '&external=0')).body.items.slice(0, 4).map((f) => f.name);
    assert.deepEqual(new Set(milk), new Set(['Cow Milk', 'Buffalo Milk', 'Toned Milk (3% fat)', 'Double Toned Milk (1.5% fat)']));
  });

  it('asks Open Food Facts for products sold in India, and drops foreign labels among them', async () => {
    offSearches.length = 0;
    const res = await memberSearch('eggs');
    assert.equal(offSearches.length, 1, 'India had an answer, so no worldwide search');
    assert.equal(offSearches[0].tag_0, 'india');
    const packs = res.body.remote.filter((f) => f.source === 'openfoodfacts');
    assert.deepEqual(packs.map((f) => f.name), ['Eggoz Farm Fresh Brown Eggs']);
    assert.equal(packs[0].india, 1);
  });

  it('falls back to a worldwide search, English labels only, Indian brands first', async () => {
    offSearches.length = 0;
    const res = await memberSearch('protein bar');
    assert.deepEqual(offSearches.map((s) => s.tag_0 ?? 'world'), ['india', 'world']);
    const packs = res.body.remote.filter((f) => f.source === 'openfoodfacts').map((f) => f.name);
    assert.deepEqual(packs, ['Yogabar Protein Bar Almond Fudge', 'Acme Crunch Protein Bar']);
  });

  it('keeps every library food above every online result', async () => {
    const res = await staffSearch('egg', '&external=1');
    assert.ok(res.body.items.length > 0);
    assert.ok(res.body.items.every((f) => f.id), 'items are library rows');
    assert.ok(res.body.remote.every((f) => f.id === null && f.ref), 'remote ones come after, separately');
    assert.equal(res.body.items[0].verified, 1);
  });
});

describe('picking an online food', () => {
  it('copies a pack into the library once, scannable by its barcode', async () => {
    const before = { ...counts };
    const first = await call('POST', '/api/portal/diets/food-search/select', { ref: `openfoodfacts:${WHEY_CODE}` });
    assert.equal(first.status, 201);
    assert.deepEqual(counts, before, 'the numbers came from the search, not a second request');
    assert.equal(first.body.name, 'Myprotein Impact Whey Protein');
    assert.equal(first.body.barcode, WHEY_CODE);
    assert.equal(first.body.source, 'openfoodfacts');
    assert.equal(first.body.external_id, WHEY_CODE);
    assert.equal(first.body.category, 'supplements');
    assert.equal(first.body.verified, 1);
    assert.equal(first.body.serving_size_g, 25);

    const again = await call('POST', '/api/portal/diets/food-search/select', { source: 'openfoodfacts', external_id: WHEY_CODE });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);

    const scanned = await call('GET', `/api/portal/diets/barcode/${WHEY_CODE}`);
    assert.equal(scanned.body.source, 'library');
    assert.equal(scanned.body.food.id, first.body.id);

    const search = await memberSearch('whey');
    assert.ok(search.body.items.some((f) => f.id === first.body.id));
    assert.ok(!search.body.remote.some((f) => f.external_id === WHEY_CODE), 'shown once, as the library food');
  });

  it('keeps a shop code off the barcode column', async () => {
    const res = await call('POST', '/api/portal/diets/food-search/select', { ref: 'openfoodfacts:12345' });
    assert.equal(res.status, 201);
    assert.equal(res.body.barcode, null);
    assert.equal(res.body.external_id, '12345');
  });

  it('lets staff pick a USDA food, which members can then log', async () => {
    const picked = await call('POST', '/api/diets/food-search/select', { ref: 'usda:171477' }, { token: adminToken });
    assert.equal(picked.status, 201);
    assert.equal(picked.body.source, 'usda');
    assert.equal(picked.body.verified, 1);
    assert.equal(picked.body.is_custom, 1, 'staff can remove it like their own foods');

    const entry = await call('POST', '/api/portal/diets/entries', { meal_type: 'lunch', food_id: picked.body.id, quantity: 1.4 });
    assert.equal(entry.status, 201);
    assert.equal(entry.body.calories, 231);

    const local = await memberSearch('broilers', '&external=0');
    assert.ok(local.body.items.some((f) => f.id === picked.body.id));
  });

  it('asks for the full record of a USDA food the search gave no serving for', async () => {
    const before = counts.usda;
    const res = await call('POST', '/api/portal/diets/food-search/select', { ref: 'usda:2646170' });
    assert.equal(res.status, 201, 'the stub has no full record, so the search copy is used');
    assert.equal(res.body.calories, 118);
    assert.equal(res.body.serving_size_g, null);
    assert.equal(counts.usda, before + 1);
  });

  it('fetches a food the server no longer has cached', async () => {
    resetFoodSearchCaches();
    const before = counts.usda;
    const res = await call('POST', '/api/portal/diets/food-search/select', { ref: 'usda:170567' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Seeds, chia seeds, dried');
    assert.equal(counts.usda, before + 1);
  });

  it('refuses unknown sources, malformed ids and foods that are gone', async () => {
    assert.equal((await call('POST', '/api/portal/diets/food-search/select', { ref: 'nasa:1' })).status, 400);
    assert.equal((await call('POST', '/api/portal/diets/food-search/select', { ref: 'usda:abc' })).status, 400);
    assert.equal((await call('POST', '/api/portal/diets/food-search/select', { ref: 'usda:424242' })).status, 404);
  });
});
