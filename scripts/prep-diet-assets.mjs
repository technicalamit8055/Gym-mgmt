// Prepares the Diet tab's meal illustrations from gym_nutrition_asset_pack.
//
// The pack is a set of ~180px crops of one generated sheet, so each still has a
// sliver of the neighbouring tile (or its own card border) on the edge. This
// trims that off and upscales 2.5x so the art stays crisp on a retina phone.
// Output lands in public/images/diet/ and is committed — the pack itself is not
// served. Re-run with: node scripts/prep-diet-assets.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'gym_nutrition_asset_pack', 'meal-illustrations');
const out = path.join(root, 'public', 'images', 'diet');
mkdirSync(out, { recursive: true });

// left, top, width, height — measured per image against its own tile edge.
const CROPS = {
  breakfast: [10, 8, 160, 126],
  lunch: [10, 8, 158, 126],
  dinner: [10, 8, 158, 126],
  snacks: [10, 8, 136, 126],
  'breakfast-dark': [14, 8, 150, 126],
  'lunch-dark': [14, 8, 140, 126],
  'dinner-dark': [14, 8, 140, 126],
  'snacks-dark': [14, 8, 150, 126],
};

for (const [name, [left, top, width, height]] of Object.entries(CROPS)) {
  await sharp(path.join(src, `${name}.png`))
    .extract({ left, top, width, height })
    .resize({ width: Math.round(width * 2.5), kernel: 'lanczos3' })
    .sharpen({ sigma: 0.7 })
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, `meal-${name}.png`));
}
console.log('wrote', Object.keys(CROPS).length, 'illustrations to', out);
