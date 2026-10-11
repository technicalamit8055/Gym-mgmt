/**
 * The verified core of the platform food catalogue: whole foods and staples
 * every gym gets on day one, with no network call (see seedCoreFoods() in
 * foodCatalog.js). Seeded once with the blue tick, beside the older starter
 * set in fitnessSeed.js, which stays unticked until the operator checks it.
 *
 * Figures are per 100 g (100 ml for drinks), from USDA FoodData Central's
 * SR Legacy / Foundation tables and, for Indian millets, the Indian Food
 * Composition Tables (IFCT 2017). Raw where the food is weighed raw, cooked
 * where it is weighed cooked — the name always says which. The portion is a
 * typical serving, offered in the app as "1 serving".
 *
 * Rows: [name, category, basis, kcal, protein, carbs, fat, fibre, sugar,
 *        serving_size_g, serving_label]
 */
export const CORE_FOODS = [
  /* ── Meat, fish & eggs ── */
  ['Chicken Breast (raw, skinless)', 'protein', '100g', 120, 22.5, 0, 2.6, 0, 0, 150, '1 fillet (150g)'],
  ['Chicken Drumstick (roasted, skinless)', 'protein', '100g', 172, 28.3, 0, 5.7, 0, 0, 45, '1 drumstick, meat only (45g)'],
  ['Chicken Wing (roasted, with skin)', 'protein', '100g', 290, 26.9, 0, 19.5, 0, 0, 34, '1 wing (34g)'],
  ['Chicken Mince (cooked)', 'protein', '100g', 189, 23.3, 0, 10.9, 0, 0, 85, '3 oz (85g)'],
  ['Turkey Breast (roasted)', 'protein', '100g', 147, 30.1, 0, 2.1, 0, 0, 85, '3 oz (85g)'],
  ['Lean Beef Mince 90% (cooked)', 'protein', '100g', 217, 26.1, 0, 11.7, 0, 0, 85, '3 oz (85g)'],
  ['Pork Tenderloin (roasted)', 'protein', '100g', 143, 26.2, 0, 3.5, 0, 0, 85, '3 oz (85g)'],
  ['Bacon (pan-fried)', 'protein', '100g', 541, 37, 1.4, 41.8, 0, 0, 8, '1 slice (8g)'],
  ['Goat Meat (roasted)', 'protein', '100g', 143, 27.1, 0, 3, 0, 0, 85, '3 oz (85g)'],
  ['Lamb Leg (lean, roasted)', 'protein', '100g', 191, 28.3, 0, 7.7, 0, 0, 85, '3 oz (85g)'],
  ['Salmon (baked)', 'protein', '100g', 206, 22.1, 0, 12.4, 0, 0, 150, '1 fillet (150g)'],
  ['Tilapia (baked)', 'protein', '100g', 128, 26.2, 0, 2.7, 0, 0, 87, '1 fillet (87g)'],
  ['Cod (baked)', 'protein', '100g', 105, 22.8, 0, 0.9, 0, 0, 90, '1 fillet (90g)'],
  ['Mackerel (cooked)', 'protein', '100g', 262, 23.9, 0, 17.8, 0, 0, 88, '1 fillet (88g)'],
  ['Sardines (canned in oil, drained)', 'protein', '100g', 208, 24.6, 0, 11.5, 0, 0, 92, '1 can, drained (92g)'],
  ['Tuna Steak (cooked)', 'protein', '100g', 130, 29.2, 0, 0.6, 0, 0, 85, '3 oz (85g)'],
  ['King Mackerel / Surmai (raw)', 'protein', '100g', 105, 20.3, 0, 2, 0, 0, 100, '1 slice (100g)'],
  ['Crab (cooked)', 'protein', '100g', 83, 17.9, 0, 0.7, 0, 0, 85, '3 oz (85g)'],

  /* ── Pulses, soy & legumes ── */
  ['Tofu (firm)', 'protein', '100g', 144, 17.3, 2.8, 8.7, 2.3, 0.6, 85, '1 slice (85g)'],
  ['Edamame (cooked)', 'protein', '100g', 121, 11.9, 8.9, 5.2, 5.2, 2.2, 155, '1 cup, shelled (155g)'],
  ['Black Beans (boiled)', 'protein', '100g', 132, 8.9, 23.7, 0.5, 8.7, 0.3, 172, '1 cup (172g)'],
  ['Lobia / Black-eyed Peas (boiled)', 'protein', '100g', 116, 7.7, 20.8, 0.5, 6.5, 3.3, 172, '1 cup (172g)'],
  ['Green Moong (whole, boiled)', 'protein', '100g', 105, 7, 19.2, 0.4, 7.6, 2, 202, '1 cup (202g)'],
  ['Moong Sprouts (raw)', 'protein', '100g', 30, 3, 5.9, 0.2, 1.8, 4.1, 104, '1 cup (104g)'],
  ['Urad Dal (cooked)', 'protein', '100g', 105, 7.5, 18.3, 0.6, 6.4, 1.8, 150, '1 bowl (150g)'],
  ['Toor Dal (raw)', 'protein', '100g', 343, 21.7, 62.8, 1.5, 15, 0, 30, '1 portion, dry (30g)'],
  ['Moong Dal (raw)', 'protein', '100g', 347, 23.9, 62.6, 1.2, 16.3, 6.6, 30, '1 portion, dry (30g)'],
  ['Masoor Dal (raw)', 'protein', '100g', 352, 24.6, 63.4, 1.1, 10.7, 2, 30, '1 portion, dry (30g)'],
  ['Urad Dal (raw)', 'protein', '100g', 341, 25.2, 59, 1.6, 18.3, 0, 30, '1 portion, dry (30g)'],
  ['Chickpeas / Kabuli Chana (raw)', 'protein', '100g', 364, 19.3, 60.7, 6, 17.4, 10.7, 30, '1 portion, dry (30g)'],
  ['Rajma / Kidney Beans (raw)', 'protein', '100g', 333, 23.6, 60, 0.8, 24.9, 2.2, 30, '1 portion, dry (30g)'],
  ['Hummus', 'protein', '100g', 166, 7.9, 14.3, 9.6, 6, 0.3, 30, '2 tbsp (30g)'],

  /* ── Dairy ── */
  ['Greek Yogurt (2% fat)', 'dairy', '100g', 73, 10, 3.9, 1.9, 0, 3.6, 170, '1 pot (170g)'],
  ['Low-fat Yogurt (plain)', 'dairy', '100g', 63, 5.3, 7, 1.6, 0, 7, 150, '1 bowl (150g)'],
  ['Mozzarella (part-skim)', 'dairy', '100g', 254, 24.3, 2.8, 15.9, 0, 1.1, 28, '1 oz (28g)'],
  ['Cheddar Cheese', 'dairy', '100g', 403, 24.9, 1.3, 33.1, 0, 0.5, 28, '1 oz (28g)'],
  ['Feta Cheese', 'dairy', '100g', 264, 14.2, 4.1, 21.3, 0, 4.1, 28, '1 oz (28g)'],
  ['Fresh Cream (heavy)', 'dairy', '100g', 340, 2.8, 2.8, 36.1, 0, 2.9, 15, '1 tbsp (15g)'],
  ['Skimmed Milk Powder', 'dairy', '100g', 362, 36.2, 52, 0.8, 0, 52, 25, '1 serving (25g)'],

  /* ── Grains, flours & starches ── */
  ['Oatmeal (cooked with water)', 'carbs', '100g', 71, 2.5, 12, 1.5, 1.7, 0.3, 234, '1 cup (234g)'],
  ['Quinoa (raw)', 'carbs', '100g', 368, 14.1, 64.2, 6.1, 7, 0, 45, '1 portion, dry (45g)'],
  ['Wheat Flour / Atta (whole wheat)', 'carbs', '100g', 340, 13.2, 72, 2.5, 10.7, 0.4, 30, '1 roti\'s worth (30g)'],
  ['Maida / All-purpose Flour', 'carbs', '100g', 364, 10.3, 76.3, 1, 2.7, 0.3, 30, '1/4 cup (30g)'],
  ['Besan / Gram Flour', 'carbs', '100g', 387, 22.4, 57.8, 6.7, 10.8, 10.9, 30, '1/4 cup (30g)'],
  ['Sooji / Semolina (raw)', 'carbs', '100g', 360, 12.7, 72.8, 1.1, 3.9, 0, 40, '1 portion, dry (40g)'],
  ['Ragi / Finger Millet Flour', 'carbs', '100g', 321, 7.2, 66.8, 1.9, 11.2, 0, 40, '1 portion, dry (40g)'],
  ['Bajra / Pearl Millet Flour', 'carbs', '100g', 348, 11, 61.8, 5.4, 11.5, 0, 40, '1 portion, dry (40g)'],
  ['Jowar / Sorghum Flour', 'carbs', '100g', 359, 8.4, 76.6, 3.3, 6.7, 1.9, 40, '1 portion, dry (40g)'],
  ['Sabudana / Tapioca Pearls (raw)', 'carbs', '100g', 358, 0.2, 88.7, 0, 0.9, 3.4, 40, '1 portion, dry (40g)'],
  ['Barley (pearled, cooked)', 'carbs', '100g', 123, 2.3, 28.2, 0.4, 3.8, 0.3, 157, '1 cup (157g)'],
  ['Couscous (cooked)', 'carbs', '100g', 112, 3.8, 23.2, 0.2, 1.4, 0.1, 157, '1 cup (157g)'],
  ['Egg Noodles (cooked)', 'carbs', '100g', 138, 4.5, 25.2, 2.1, 1.2, 0.4, 160, '1 cup (160g)'],
  ['Whole Wheat Spaghetti (cooked)', 'carbs', '100g', 124, 5.3, 26.5, 0.5, 4.5, 0.8, 140, '1 cup (140g)'],
  ['White Bread', 'carbs', '100g', 266, 7.6, 50.6, 3.3, 2.4, 5.3, 25, '1 slice (25g)'],
  ['Paratha (plain, whole wheat)', 'carbs', '100g', 326, 6.4, 45.4, 13.2, 4, 1.6, 80, '1 paratha (80g)'],
  ['Baked Potato (with skin)', 'carbs', '100g', 93, 2.5, 21.2, 0.1, 2.2, 1.2, 173, '1 medium (173g)'],
  ['Sweet Potato (baked)', 'carbs', '100g', 90, 2, 20.7, 0.2, 3.3, 6.5, 114, '1 medium (114g)'],
  ['Sweet Corn (boiled)', 'carbs', '100g', 96, 3.4, 21, 1.5, 2.4, 4.5, 145, '1 cup (145g)'],
  ['Popcorn (air-popped)', 'carbs', '100g', 387, 12.9, 77.8, 4.5, 14.5, 0.9, 24, '3 cups (24g)'],
  ['Rice Cakes (puffed brown rice)', 'carbs', '100g', 387, 8.2, 81.5, 2.8, 4.2, 0.9, 9, '1 cake (9g)'],
  ['French Fries', 'carbs', '100g', 312, 3.4, 41.4, 14.7, 3.8, 0.3, 117, '1 medium serving (117g)'],

  /* ── Nuts, seeds & oils ── */
  ['Pistachios', 'fats', '100g', 560, 20.2, 27.2, 45.3, 10.6, 7.7, 28, '1 handful (28g)'],
  ['Hazelnuts', 'fats', '100g', 628, 15, 16.7, 60.8, 9.7, 4.3, 28, '1 handful (28g)'],
  ['Brazil Nuts', 'fats', '100g', 659, 14.3, 11.7, 67.1, 7.5, 2.3, 28, '6 nuts (28g)'],
  ['Peanuts (dry-roasted)', 'fats', '100g', 585, 24.4, 21.3, 49.7, 8.4, 4.2, 28, '1 handful (28g)'],
  ['Pumpkin Seeds', 'fats', '100g', 559, 30.2, 10.7, 49, 6, 1.4, 28, '1 oz (28g)'],
  ['Sunflower Seeds', 'fats', '100g', 584, 20.8, 20, 51.5, 8.6, 2.6, 28, '1 oz (28g)'],
  ['Sesame Seeds', 'fats', '100g', 573, 17.7, 23.4, 49.7, 11.8, 0.3, 9, '1 tbsp (9g)'],
  ['Almond Butter', 'fats', '100g', 614, 21, 18.8, 55.5, 10.3, 4.4, 16, '1 tbsp (16g)'],
  ['Fresh Coconut', 'fats', '100g', 354, 3.3, 15.2, 33.5, 9, 6.2, 45, '1 piece (45g)'],
  ['Desiccated Coconut', 'fats', '100g', 660, 6.9, 23.7, 64.5, 16.3, 7.4, 10, '2 tbsp (10g)'],
  ['Coconut Oil', 'fats', '100g', 892, 0, 0, 99.1, 0, 0, 14, '1 tbsp (14g)'],
  ['Mustard Oil', 'fats', '100g', 884, 0, 0, 100, 0, 0, 14, '1 tbsp (14g)'],
  ['Sunflower Oil', 'fats', '100g', 884, 0, 0, 100, 0, 0, 14, '1 tbsp (14g)'],
  ['Groundnut Oil', 'fats', '100g', 884, 0, 0, 100, 0, 0, 14, '1 tbsp (14g)'],
  ['Mayonnaise', 'fats', '100g', 680, 1, 0.6, 74.9, 0, 0.6, 14, '1 tbsp (14g)'],

  /* ── Fruit ── */
  ['Mango', 'fruits', '100g', 60, 0.8, 15, 0.4, 1.6, 13.7, 165, '1 cup, sliced (165g)'],
  ['Grapes', 'fruits', '100g', 69, 0.7, 18.1, 0.2, 0.9, 15.5, 151, '1 cup (151g)'],
  ['Pineapple', 'fruits', '100g', 50, 0.5, 13.1, 0.1, 1.4, 9.9, 165, '1 cup, chunks (165g)'],
  ['Strawberries', 'fruits', '100g', 32, 0.7, 7.7, 0.3, 2, 4.9, 152, '1 cup (152g)'],
  ['Blueberries', 'fruits', '100g', 57, 0.7, 14.5, 0.3, 2.4, 10, 148, '1 cup (148g)'],
  ['Pomegranate (arils)', 'fruits', '100g', 83, 1.7, 18.7, 1.2, 4, 13.7, 87, '1/2 cup (87g)'],
  ['Guava', 'fruits', '100g', 68, 2.6, 14.3, 1, 5.4, 8.9, 55, '1 fruit (55g)'],
  ['Pear', 'fruits', '100g', 57, 0.4, 15.2, 0.1, 3.1, 9.8, 178, '1 medium (178g)'],
  ['Kiwi', 'fruits', '100g', 61, 1.1, 14.7, 0.5, 3, 9, 69, '1 fruit (69g)'],
  ['Muskmelon / Cantaloupe', 'fruits', '100g', 34, 0.8, 8.2, 0.2, 0.9, 7.9, 160, '1 cup, cubed (160g)'],
  ['Peach', 'fruits', '100g', 39, 0.9, 9.5, 0.3, 1.5, 8.4, 150, '1 medium (150g)'],
  ['Plum', 'fruits', '100g', 46, 0.7, 11.4, 0.3, 1.4, 9.9, 66, '1 fruit (66g)'],
  ['Cherries', 'fruits', '100g', 63, 1.1, 16, 0.2, 2.1, 12.8, 138, '1 cup (138g)'],
  ['Lychee', 'fruits', '100g', 66, 0.8, 16.5, 0.4, 1.3, 15.2, 10, '1 fruit (10g)'],
  ['Jackfruit', 'fruits', '100g', 95, 1.7, 23.2, 0.6, 1.5, 19.1, 165, '1 cup (165g)'],
  ['Dates (Medjool)', 'fruits', '100g', 277, 1.8, 75, 0.2, 6.7, 66.5, 24, '1 date (24g)'],
  ['Raisins', 'fruits', '100g', 299, 3.1, 79.2, 0.5, 3.7, 59.2, 15, '1 tbsp (15g)'],
  ['Dried Figs / Anjeer', 'fruits', '100g', 249, 3.3, 63.9, 0.9, 9.8, 47.9, 8, '1 fig (8g)'],

  /* ── Vegetables ── */
  ['Carrot', 'fruits', '100g', 41, 0.9, 9.6, 0.2, 2.8, 4.7, 61, '1 medium (61g)'],
  ['Tomato', 'fruits', '100g', 18, 0.9, 3.9, 0.2, 1.2, 2.6, 123, '1 medium (123g)'],
  ['Onion', 'fruits', '100g', 40, 1.1, 9.3, 0.1, 1.7, 4.2, 110, '1 medium (110g)'],
  ['Cauliflower', 'fruits', '100g', 25, 1.9, 5, 0.3, 2, 1.9, 107, '1 cup (107g)'],
  ['Cabbage', 'fruits', '100g', 25, 1.3, 5.8, 0.1, 2.5, 3.2, 89, '1 cup, chopped (89g)'],
  ['Red Bell Pepper', 'fruits', '100g', 31, 1, 6, 0.3, 2.1, 4.2, 119, '1 medium (119g)'],
  ['Capsicum / Green Bell Pepper', 'fruits', '100g', 20, 0.9, 4.6, 0.2, 1.7, 2.4, 119, '1 medium (119g)'],
  ['Bhindi / Okra', 'fruits', '100g', 33, 1.9, 7.5, 0.2, 3.2, 1.5, 100, '1 cup (100g)'],
  ['Brinjal / Eggplant', 'fruits', '100g', 25, 1, 5.9, 0.2, 3, 3.5, 82, '1 cup, cubed (82g)'],
  ['Mushrooms (white)', 'fruits', '100g', 22, 3.1, 3.3, 0.3, 1, 2, 70, '1 cup, sliced (70g)'],
  ['Green Beans', 'fruits', '100g', 31, 1.8, 7, 0.2, 2.7, 3.3, 100, '1 cup (100g)'],
  ['Lauki / Bottle Gourd', 'fruits', '100g', 14, 0.6, 3.4, 0, 0.5, 0, 116, '1 cup (116g)'],
  ['Karela / Bitter Gourd', 'fruits', '100g', 17, 1, 3.7, 0.2, 2.8, 0, 94, '1 cup (94g)'],
  ['Pumpkin', 'fruits', '100g', 26, 1, 6.5, 0.1, 0.5, 2.8, 116, '1 cup, cubed (116g)'],
  ['Beetroot', 'fruits', '100g', 43, 1.6, 9.6, 0.2, 2.8, 6.8, 82, '1 beet (82g)'],
  ['Zucchini', 'fruits', '100g', 17, 1.2, 3.1, 0.3, 1, 2.5, 124, '1 cup (124g)'],
  ['Lettuce (romaine)', 'fruits', '100g', 17, 1.2, 3.3, 0.3, 2.1, 1.2, 47, '1 cup, shredded (47g)'],
  ['Kale', 'fruits', '100g', 35, 2.9, 4.4, 1.5, 4.1, 1, 21, '1 cup, chopped (21g)'],
  ['Asparagus', 'fruits', '100g', 20, 2.2, 3.9, 0.1, 2.1, 1.9, 134, '1 cup (134g)'],
  ['Radish / Mooli', 'fruits', '100g', 16, 0.7, 3.4, 0.1, 1.6, 1.9, 116, '1 cup, sliced (116g)'],
  ['Green Peas (boiled)', 'fruits', '100g', 84, 5.4, 15.6, 0.2, 5.5, 5.9, 160, '1 cup (160g)'],
  ['Spinach / Palak (boiled)', 'fruits', '100g', 23, 3, 3.8, 0.3, 2.4, 0.4, 180, '1 cup (180g)'],
  ['Broccoli (boiled)', 'fruits', '100g', 35, 2.4, 7.2, 0.4, 3.3, 1.4, 156, '1 cup (156g)'],

  /* ── Drinks, sweeteners & treats ── */
  ['Apple Juice (unsweetened)', 'general', '100ml', 46, 0.1, 11.3, 0.1, 0.2, 9.6, 250, '1 glass (250ml)'],
  ['Beer (regular)', 'general', '100ml', 43, 0.5, 3.6, 0, 0, 0, 330, '1 bottle (330ml)'],
  ['Red Wine', 'general', '100ml', 85, 0.1, 2.6, 0, 0, 0.6, 150, '1 glass (150ml)'],
  ['Honey', 'general', '100g', 304, 0.3, 82.4, 0, 0.2, 82.1, 21, '1 tbsp (21g)'],
  ['Sugar (white)', 'general', '100g', 387, 0, 100, 0, 0, 99.8, 4, '1 tsp (4g)'],
  ['Dark Chocolate (70–85%)', 'general', '100g', 598, 7.8, 45.9, 42.6, 10.9, 24, 28, '1 oz (28g)'],
];

/**
 * Everyday Indian gym food — the staples a trainer writes into a plan and a
 * member logs most days — seeded as a second batch on its own marker (see
 * seedCoreFoods() in foodCatalog.js), and ranked first in food search
 * (INDIAN_STAPLE_NAMES), so "egg" means boiled egg and bhurji, not egg noodles.
 *
 * Ingredients follow IFCT 2017 / USDA. Cooked dishes (bhurji, curries,
 * khichdi, lassi…) are standard home recipes as in ICMR-NIN's recipe tables:
 * home cooking varies with the oil, so treat those as ±15%.
 *
 * A few names match the older unticked starter set (Paneer, Tofu, the cooked
 * dals and rice): where the operator never touched that row and it is on the
 * same per-100 g basis, it is upgraded in place — numbers, serving, tick —
 * rather than duplicated. Starter foods measured per piece (Whole Egg, Roti)
 * keep their rows; the per-100 g versions here have their own names.
 *
 * Same row shape as CORE_FOODS.
 */
export const INDIAN_CORE_FOODS = [
  /* ── Eggs ── */
  ['Whole Boiled Egg', 'protein', '100g', 155, 12.6, 1.1, 10.6, 0, 1.1, 50, '1 egg (50g)'],
  ['Egg White (raw or boiled)', 'protein', '100g', 52, 10.9, 0.7, 0.2, 0, 0.7, 33, '1 egg white (33g)'],
  ['Scrambled Egg', 'protein', '100g', 149, 10, 1.6, 11, 0, 1.4, 61, '1 egg, scrambled (61g)'],
  ['Egg Bhurji', 'protein', '100g', 171, 10.5, 3.5, 12.8, 0.6, 1.8, 120, '1 plate, 2 eggs (120g)'],
  ['Plain Omelette', 'protein', '100g', 154, 10.6, 0.6, 11.7, 0, 0.3, 61, '1-egg omelette (61g)'],

  /* ── Chicken & fish ── */
  ['Chicken Breast (grilled)', 'protein', '100g', 165, 31, 0, 3.6, 0, 0, 120, '1 breast piece (120g)'],
  ['Tandoori Chicken Breast', 'protein', '100g', 160, 27, 3, 4.5, 0.5, 1.5, 150, '1 piece (150g)'],
  ['Chicken Curry (home-style)', 'protein', '100g', 153, 14, 4, 9, 0.8, 1.5, 200, '1 bowl (200g)'],
  ['Fish Curry (home-style)', 'protein', '100g', 120, 13, 3.5, 6, 0.6, 1.2, 200, '1 bowl (200g)'],

  /* ── Paneer, soya & tofu ── */
  ['Paneer', 'protein', '100g', 265, 18, 1.2, 20.8, 0, 1.2, 50, '1 portion (50g)'],
  ['Paneer Bhurji', 'protein', '100g', 229, 13, 5, 17.5, 0.8, 2, 150, '1 plate (150g)'],
  ['Paneer Tikka', 'protein', '100g', 222, 14.5, 6, 15.5, 1, 2.5, 150, '6 pieces (150g)'],
  ['Soya Chunks (boiled)', 'protein', '100g', 115, 17.3, 11, 0.2, 4.3, 2, 100, '1 bowl (100g)'],
  ['Soya Chaap (steamed)', 'protein', '100g', 148, 15, 13, 4, 3, 1, 100, '2 sticks (100g)'],
  ['Tofu', 'protein', '100g', 76, 8, 1.9, 4.8, 0.3, 0.6, 100, '1 portion (100g)'],

  /* ── Cooked dals & legumes ── */
  ['Toor Dal (cooked)', 'protein', '100g', 121, 6.8, 23.3, 0.4, 6.7, 0, 150, '1 katori (150g)'],
  ['Moong Dal (cooked)', 'protein', '100g', 105, 7, 19.2, 0.4, 7.6, 2, 150, '1 katori (150g)'],
  ['Masoor Dal (cooked)', 'protein', '100g', 116, 9, 20.1, 0.4, 7.9, 1.8, 150, '1 katori (150g)'],
  ['Chana Dal (cooked)', 'protein', '100g', 142, 8.5, 23, 1.6, 6, 1, 150, '1 katori (150g)'],
  ['Rajma (boiled)', 'protein', '100g', 127, 8.7, 22.8, 0.5, 6.4, 0.3, 150, '1 katori (150g)'],
  ['Rajma Curry', 'protein', '100g', 139, 6.5, 18, 4.5, 5, 2, 200, '1 bowl (200g)'],
  ['Chickpeas (boiled)', 'protein', '100g', 164, 8.9, 27, 2.6, 7.6, 4.8, 150, '1 katori (150g)'],
  ['Chole (chickpea curry)', 'protein', '100g', 154, 7, 19, 5.5, 6, 2.5, 200, '1 bowl (200g)'],
  ['Sprouted Moong (steamed)', 'protein', '100g', 106, 7.5, 18, 0.5, 5, 2, 100, '1 bowl (100g)'],

  /* ── Rotis, rice & breakfast ── */
  ['Roti / Chapati (plain)', 'carbs', '100g', 264, 7.8, 50.5, 3.5, 6.2, 1, 40, '1 roti (40g)'],
  ['Roti / Chapati (with ghee)', 'carbs', '100g', 335, 6.9, 44.9, 14.2, 5.5, 0.9, 45, '1 roti + 1 tsp ghee (45g)'],
  ['White Rice (cooked)', 'carbs', '100g', 130, 2.7, 28, 0.3, 0.4, 0.1, 150, '1 katori (150g)'],
  ['Brown Rice (cooked)', 'carbs', '100g', 123, 2.7, 26, 1, 1.6, 0.4, 150, '1 katori (150g)'],
  ['Kanda Poha', 'carbs', '100g', 180, 3.5, 27, 6.5, 1.8, 2, 150, '1 plate (150g)'],
  ['Rava Upma', 'carbs', '100g', 155, 3.8, 22, 5.8, 1.5, 1.2, 180, '1 plate (180g)'],
  ['Idli (steamed)', 'carbs', '100g', 97, 3.3, 20, 0.4, 1.5, 0.5, 60, '1 idli (60g)'],
  ['Dosa (plain)', 'carbs', '100g', 165, 3.9, 29, 3.7, 1.3, 0.6, 80, '1 dosa (80g)'],
  ['Moong Dal Khichdi', 'carbs', '100g', 120, 4.5, 20, 2.5, 2, 0.5, 200, '1 bowl (200g)'],
  ['Oats (dry)', 'carbs', '100g', 389, 16.9, 66, 6.9, 10.6, 1, 40, '1 portion (40g)'],

  /* ── Dairy & fats ── */
  ['Curd / Dahi', 'dairy', '100g', 61, 3.5, 4.7, 3.3, 0, 4.7, 100, '1 katori (100g)'],
  ['Chaas / Buttermilk (salted)', 'dairy', '100ml', 20, 1.1, 1.6, 1, 0, 1.6, 200, '1 glass (200ml)'],
  ['Sweet Lassi', 'dairy', '100ml', 91, 2.9, 13.5, 2.8, 0, 12.5, 250, '1 glass (250ml)'],
  ['Salted Lassi', 'dairy', '100ml', 50, 2.8, 3.8, 2.6, 0, 3.8, 250, '1 glass (250ml)'],
  ['Toned Milk (3% fat)', 'dairy', '100ml', 58, 3.1, 4.7, 3, 0, 4.7, 200, '1 glass (200ml)'],
  ['Double Toned Milk (1.5% fat)', 'dairy', '100ml', 45, 3.1, 4.7, 1.5, 0, 4.7, 200, '1 glass (200ml)'],
  ['Cow Milk', 'dairy', '100ml', 67, 3.2, 4.4, 4.1, 0, 4.4, 200, '1 glass (200ml)'],
  ['Buffalo Milk', 'dairy', '100ml', 97, 3.8, 5.2, 6.9, 0, 5.2, 200, '1 glass (200ml)'],
  ['Peanut Butter (unsweetened)', 'fats', '100g', 610, 26, 18, 51, 7, 4, 16, '1 tbsp (16g)'],
];

/** Lower-cased names of the Indian staples, for food search's ranking. */
export const INDIAN_STAPLE_NAMES = new Set(INDIAN_CORE_FOODS.map(([name]) => name.toLowerCase()));
