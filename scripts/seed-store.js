/**
 * Fills the platform store with a demo catalogue — eight products across every
 * category, with variants, nutrition facts and photos — so the member Store
 * has something real to show before the operator lists actual stock.
 *
 *   npm run seed:store            add the demo products (skips any already there)
 *   npm run seed:store -- --remove  delete them again
 *
 * Writes to the platform registry (PLATFORM_DB_FILE, data/platform.db by
 * default) and the store photo folder beside it. Safe to run while the server
 * is up. Brands are invented on purpose: these are placeholders, and must not
 * read as a real brand's listing. Every demo variant carries a DEMO- SKU,
 * which is how --remove finds them without touching real products — and which
 * members never see.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProductImage, createStoreProduct, deleteStoreProduct, listStoreProducts } from '../src/monetization.js';
import { closeRegistryDb } from '../src/tenants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const photo = (name) => fs.readFileSync(path.join(here, 'store-demo', `${name}.webp`));
const DEMO_SKU = 'DEMO-';

const PRODUCTS = [
  {
    photo: 'whey-isolate',
    title: '100% Whey Protein Isolate',
    brand: 'IronFuel',
    category: 'protein',
    featured: true,
    mrp: 6599,
    price: 4999,
    description: '27 g of fast-absorbing whey isolate per scoop, low in fat and sugar, for recovery after every session.',
    nutrition_facts: { serving_size: '1 scoop (33 g)', servings: 30, calories: 120, protein_g: 27, carbs_g: 2, sugar_g: 1, fat_g: 0.5, bcaa_g: 6.1 },
    variants: [
      { flavor: 'Double Rich Chocolate', weight: '1 kg' },
      { flavor: 'Double Rich Chocolate', weight: '2 kg', mrp: 12499, price: 8999 },
      { flavor: 'Café Mocha', weight: '1 kg' },
      { flavor: 'Vanilla Ice Cream', weight: '1 kg', in_stock: false },
    ],
  },
  {
    photo: 'whey-blend',
    title: 'Performance Whey Blend',
    brand: 'PeakForm',
    category: 'protein',
    featured: true,
    mrp: 3999,
    price: 2999,
    description: 'A whey concentrate and isolate blend with 24 g protein per scoop and digestive enzymes added.',
    nutrition_facts: { serving_size: '1 scoop (32 g)', servings: 31, calories: 128, protein_g: 24, carbs_g: 3.5, sugar_g: 2, fat_g: 1.8, bcaa_g: 5.5 },
    variants: [
      { flavor: 'Chocolate Fudge', weight: '1 kg' },
      { flavor: 'Chocolate Fudge', weight: '2 kg', mrp: 7499, price: 5499 },
      { flavor: 'Kesar Badam', weight: '1 kg' },
    ],
  },
  {
    photo: 'creatine',
    title: 'Creatine Monohydrate',
    brand: 'Musclecore',
    category: 'creatine',
    featured: true,
    mrp: 1599,
    price: 1299,
    description: 'Micronised creatine monohydrate, 3 g per serving, unflavoured so it mixes into anything.',
    nutrition_facts: { serving_size: '1 scoop (3 g)', servings: 100, calories: 0, creatine_g: 3 },
    variants: [
      { flavor: 'Unflavoured', weight: '300 g' },
      { flavor: 'Unflavoured', weight: '100 g', mrp: 699, price: 549 },
    ],
  },
  {
    photo: 'preworkout',
    title: 'Ignite Pre-Workout',
    brand: 'PeakForm',
    category: 'preworkout',
    mrp: 1999,
    price: 1699,
    description: 'Caffeine, beta-alanine and citrulline for energy and pump. Start with half a scoop to check tolerance.',
    nutrition_facts: { serving_size: '1 scoop (10 g)', servings: 30, calories: 5, caffeine_mg: 200 },
    variants: [
      { flavor: 'Fruit Punch', weight: '300 g' },
      { flavor: 'Blue Raspberry', weight: '300 g' },
    ],
  },
  {
    photo: 'bcaa',
    title: 'BCAA 2:1:1',
    brand: 'IronFuel',
    category: 'bcaa',
    mrp: 1499,
    price: 1199,
    description: 'Leucine, isoleucine and valine in a 2:1:1 ratio with electrolytes, for sipping through training.',
    nutrition_facts: { serving_size: '1 scoop (10 g)', servings: 30, calories: 10, bcaa_g: 7 },
    variants: [
      { flavor: 'Watermelon', weight: '300 g' },
      { flavor: 'Green Apple', weight: '300 g' },
    ],
  },
  {
    photo: 'multivitamin',
    title: 'Daily Multivitamin',
    brand: 'VitalStack',
    category: 'vitamins',
    mrp: 899,
    price: 599,
    description: '24 vitamins and minerals for active adults, one tablet a day after breakfast.',
    variants: [
      { weight: '60 tablets' },
      { weight: '120 tablets', mrp: 1599, price: 1049 },
    ],
  },
  {
    photo: 'protein-bar',
    title: 'Protein Bar',
    brand: 'BarFit',
    category: 'snacks',
    mrp: 600,
    price: 499,
    description: '20 g protein per bar with real almonds and no added sugar. A box of six.',
    nutrition_facts: { serving_size: '1 bar (65 g)', servings: 6, calories: 230, protein_g: 20, carbs_g: 21, sugar_g: 2, fat_g: 8 },
    variants: [
      { flavor: 'Choco Almond', weight: 'Box of 6' },
      { flavor: 'Peanut Butter', weight: 'Box of 6' },
    ],
  },
  {
    photo: 'belt-combo',
    title: 'Lifting Belt & Shaker Combo',
    brand: 'IronFuel Gear',
    category: 'gear',
    mrp: 2499,
    price: 1499,
    description: '4-inch leather lifting belt with a double-prong buckle, plus a 700 ml leak-proof shaker.',
    variants: [{ weight: 'M' }, { weight: 'L' }, { weight: 'XL' }],
  },
];

const isDemo = (p) => p.variants.some((v) => String(v.sku ?? '').startsWith(DEMO_SKU));

function remove() {
  const demo = listStoreProducts().filter(isDemo);
  for (const p of demo) {
    const res = deleteStoreProduct(p.id);
    console.log(`${res.retired ? 'hidden (has orders)' : 'deleted'}  ${p.title}`);
  }
  console.log(demo.length ? `Removed ${demo.length} demo product(s).` : 'No demo products to remove.');
}

function add() {
  const existing = new Set(listStoreProducts().map((p) => p.title.toLowerCase()));
  let added = 0;
  for (const [i, { photo: name, ...product }] of PRODUCTS.entries()) {
    if (existing.has(product.title.toLowerCase())) {
      console.log(`skipped   ${product.title} (already listed)`);
      continue;
    }
    const variants = product.variants.map((v, j) => ({ ...v, sku: `${DEMO_SKU}${i + 1}-${j + 1}` }));
    const created = createStoreProduct({ ...product, variants, active: true });
    addProductImage(created.id, photo(name));
    console.log(`added     ${product.brand} · ${product.title}`);
    added += 1;
  }
  console.log(`Done — ${added} demo product(s) added.`);
}

try {
  if (process.argv.includes('--remove')) remove();
  else add();
} finally {
  closeRegistryDb();
}
