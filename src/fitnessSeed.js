/**
 * The catalogue behind the Diet & Workout feature: an exercise library, a food
 * library with real macros, and starter workout/diet templates a trainer can
 * assign on day one.
 *
 * Seeded from a migration in db.js rather than from bootstrap.js's signup path,
 * because a gym that already exists needs these rows just as much as one
 * signing up today — a trainer opening an empty exercise picker reads as a
 * broken feature, not as an empty state. Every writer here is guarded on the
 * table being untouched, so re-running (migrations run on every handle open)
 * is a no-op, and a gym that curates its own catalogue never gets stomped.
 *
 * seedFitnessLibraries takes a raw DatabaseSync handle, not db.js's get/run
 * helpers: it runs inside openHandle(), before the handle is registered for
 * getDb() to find.
 */

/** [name, muscle_group, equipment] */
const EXERCISES = [
  // chest
  ['Barbell Bench Press', 'chest', 'barbell'],
  ['Incline Barbell Bench Press', 'chest', 'barbell'],
  ['Dumbbell Bench Press', 'chest', 'dumbbell'],
  ['Incline Dumbbell Press', 'chest', 'dumbbell'],
  ['Chest Dip', 'chest', 'bodyweight'],
  ['Cable Fly', 'chest', 'cable'],
  ['Pec Deck Machine', 'chest', 'machine'],
  ['Push-Up', 'chest', 'bodyweight'],
  // back
  ['Deadlift', 'back', 'barbell'],
  ['Barbell Row', 'back', 'barbell'],
  ['Pull-Up', 'back', 'bodyweight'],
  ['Chin-Up', 'back', 'bodyweight'],
  ['Lat Pulldown', 'back', 'cable'],
  ['Seated Cable Row', 'back', 'cable'],
  ['T-Bar Row', 'back', 'barbell'],
  ['One-Arm Dumbbell Row', 'back', 'dumbbell'],
  ['Straight-Arm Pulldown', 'back', 'cable'],
  ['Rack Pull', 'back', 'barbell'],
  // legs
  ['Back Squat', 'legs', 'barbell'],
  ['Front Squat', 'legs', 'barbell'],
  ['Leg Press', 'legs', 'machine'],
  ['Romanian Deadlift', 'legs', 'barbell'],
  ['Bulgarian Split Squat', 'legs', 'dumbbell'],
  ['Walking Lunge', 'legs', 'dumbbell'],
  ['Leg Extension', 'legs', 'machine'],
  ['Lying Leg Curl', 'legs', 'machine'],
  ['Standing Calf Raise', 'legs', 'machine'],
  ['Seated Calf Raise', 'legs', 'machine'],
  ['Hip Thrust', 'legs', 'barbell'],
  ['Goblet Squat', 'legs', 'dumbbell'],
  // shoulders
  ['Overhead Press', 'shoulders', 'barbell'],
  ['Seated Dumbbell Shoulder Press', 'shoulders', 'dumbbell'],
  ['Arnold Press', 'shoulders', 'dumbbell'],
  ['Lateral Raise', 'shoulders', 'dumbbell'],
  ['Front Raise', 'shoulders', 'dumbbell'],
  ['Rear Delt Fly', 'shoulders', 'dumbbell'],
  ['Upright Row', 'shoulders', 'barbell'],
  ['Face Pull', 'shoulders', 'cable'],
  // arms
  ['Barbell Curl', 'arms', 'barbell'],
  ['Dumbbell Curl', 'arms', 'dumbbell'],
  ['Hammer Curl', 'arms', 'dumbbell'],
  ['Preacher Curl', 'arms', 'barbell'],
  ['Cable Curl', 'arms', 'cable'],
  ['Close-Grip Bench Press', 'arms', 'barbell'],
  ['Triceps Pushdown', 'arms', 'cable'],
  ['Overhead Triceps Extension', 'arms', 'dumbbell'],
  ['Skull Crusher', 'arms', 'barbell'],
  ['Triceps Dip', 'arms', 'bodyweight'],
  // core
  ['Plank', 'core', 'bodyweight'],
  ['Hanging Leg Raise', 'core', 'bodyweight'],
  ['Cable Crunch', 'core', 'cable'],
  ['Russian Twist', 'core', 'dumbbell'],
  ['Ab Wheel Rollout', 'core', 'bodyweight'],
  ['Bicycle Crunch', 'core', 'bodyweight'],
  ['Side Plank', 'core', 'bodyweight'],
  // cardio
  ['Treadmill Run', 'cardio', 'cardio'],
  ['Stationary Bike', 'cardio', 'cardio'],
  ['Rowing Machine', 'cardio', 'cardio'],
  ['Elliptical Trainer', 'cardio', 'cardio'],
  ['Jump Rope', 'cardio', 'bodyweight'],
  ['Stair Climber', 'cardio', 'cardio'],
  ['Assault Bike', 'cardio', 'cardio'],
  // full body
  ['Barbell Clean', 'full_body', 'barbell'],
  ['Kettlebell Swing', 'full_body', 'dumbbell'],
  ['Burpee', 'full_body', 'bodyweight'],
  ['Thruster', 'full_body', 'barbell'],
  ["Farmer's Walk", 'full_body', 'dumbbell'],
];

/** [name, category, serving_unit, calories, protein_g, carbs_g, fats_g] */
const FOODS = [
  // protein
  ['Chicken Breast (grilled)', 'protein', '100g', 165, 31, 0, 3.6],
  ['Chicken Thigh', 'protein', '100g', 209, 26, 0, 10.9],
  ['Whole Egg', 'protein', '1 egg (50g)', 78, 6.3, 0.6, 5.3],
  ['Egg White', 'protein', '1 white (33g)', 17, 3.6, 0.2, 0.1],
  ['Paneer', 'protein', '100g', 265, 18, 1.2, 20.8],
  ['Tofu', 'protein', '100g', 76, 8, 1.9, 4.8],
  ['Salmon', 'protein', '100g', 208, 20, 0, 13],
  ['Tuna (canned in water)', 'protein', '100g', 116, 25.5, 0, 0.8],
  ['Rohu Fish', 'protein', '100g', 97, 16.6, 0, 1.4],
  ['Prawns', 'protein', '100g', 99, 24, 0.2, 0.3],
  ['Mutton (lean)', 'protein', '100g', 258, 25, 0, 17],
  ['Soya Chunks (dry)', 'protein', '100g', 345, 52, 33, 0.5],
  ['Greek Yogurt (plain)', 'protein', '100g', 59, 10, 3.6, 0.4],
  ['Cottage Cheese (low fat)', 'protein', '100g', 98, 11, 3.4, 4.3],
  ['Chickpeas (boiled)', 'protein', '100g', 164, 8.9, 27, 2.6],
  ['Rajma (boiled)', 'protein', '100g', 127, 8.7, 23, 0.5],
  ['Toor Dal (cooked)', 'protein', '100g', 116, 7, 20, 0.4],
  ['Moong Dal (cooked)', 'protein', '100g', 105, 7, 19, 0.4],
  ['Lentils (cooked)', 'protein', '100g', 116, 9, 20, 0.4],
  // carbs
  ['White Rice (cooked)', 'carbs', '100g', 130, 2.7, 28, 0.3],
  ['Brown Rice (cooked)', 'carbs', '100g', 123, 2.7, 26, 1],
  ['Roti / Chapati', 'carbs', '1 roti (40g)', 104, 3, 20, 1.7],
  ['Oats (dry)', 'carbs', '100g', 389, 16.9, 66, 6.9],
  ['Whole Wheat Bread', 'carbs', '1 slice (30g)', 82, 4, 14, 1.1],
  ['Sweet Potato (boiled)', 'carbs', '100g', 90, 2, 21, 0.2],
  ['Potato (boiled)', 'carbs', '100g', 87, 2, 20, 0.1],
  ['Quinoa (cooked)', 'carbs', '100g', 120, 4.4, 21, 1.9],
  ['Pasta (cooked)', 'carbs', '100g', 131, 5, 25, 1.1],
  ['Poha (cooked)', 'carbs', '100g', 130, 2.4, 28, 0.5],
  ['Idli', 'carbs', '1 idli (60g)', 58, 2, 12, 0.4],
  ['Plain Dosa', 'carbs', '1 dosa (80g)', 133, 2.7, 24, 3.7],
  ['Corn Flakes', 'carbs', '100g', 357, 7, 84, 0.4],
  // fats
  ['Almonds', 'fats', '100g', 579, 21, 22, 50],
  ['Walnuts', 'fats', '100g', 654, 15, 14, 65],
  ['Cashews', 'fats', '100g', 553, 18, 30, 44],
  ['Peanuts', 'fats', '100g', 567, 26, 16, 49],
  ['Peanut Butter', 'fats', '1 tbsp (16g)', 94, 4, 3, 8],
  ['Olive Oil', 'fats', '1 tbsp (14g)', 119, 0, 0, 13.5],
  ['Ghee', 'fats', '1 tsp (5g)', 45, 0, 0, 5],
  ['Butter', 'fats', '1 tsp (5g)', 36, 0, 0, 4],
  ['Avocado', 'fats', '100g', 160, 2, 9, 15],
  ['Chia Seeds', 'fats', '100g', 486, 17, 42, 31],
  ['Flax Seeds', 'fats', '100g', 534, 18, 29, 42],
  // dairy
  ['Full Fat Milk', 'dairy', '250 ml', 160, 8, 12, 8.5],
  ['Skimmed Milk', 'dairy', '250 ml', 85, 8.5, 12.5, 0.2],
  ['Curd / Dahi', 'dairy', '100g', 61, 3.5, 4.7, 3.3],
  ['Cheese Slice', 'dairy', '1 slice (20g)', 70, 4, 1, 5.5],
  // fruits and vegetables
  ['Banana', 'fruits', '1 medium (118g)', 105, 1.3, 27, 0.4],
  ['Apple', 'fruits', '1 medium (182g)', 95, 0.5, 25, 0.3],
  ['Orange', 'fruits', '1 medium (140g)', 62, 1.2, 15, 0.2],
  ['Papaya', 'fruits', '100g', 43, 0.5, 11, 0.3],
  ['Watermelon', 'fruits', '100g', 30, 0.6, 7.6, 0.2],
  ['Broccoli', 'fruits', '100g', 34, 2.8, 7, 0.4],
  ['Spinach', 'fruits', '100g', 23, 2.9, 3.6, 0.4],
  ['Cucumber', 'fruits', '100g', 15, 0.7, 3.6, 0.1],
  ['Mixed Vegetable Salad', 'fruits', '100g', 35, 1.5, 6, 0.3],
  // supplements
  ['Whey Protein', 'supplements', '1 scoop (30g)', 120, 24, 3, 1.5],
  ['Mass Gainer', 'supplements', '1 scoop (100g)', 380, 20, 70, 3],
  ['Creatine Monohydrate', 'supplements', '5g', 0, 0, 0, 0],
  ['BCAA', 'supplements', '10g', 40, 10, 0, 0],
  // drinks
  ['Black Coffee (no sugar)', 'general', '1 cup (240ml)', 2, 0.3, 0, 0],
  ['Green Tea', 'general', '1 cup (240ml)', 2, 0, 0.5, 0],
  ['Coconut Water', 'general', '250 ml', 45, 1.7, 9, 0.5],
  ['Orange Juice', 'general', '250 ml', 112, 1.7, 26, 0.5],
];

/** Exercise rows are [name, muscle_group, target_sets, target_reps, rest_seconds]. */
const WORKOUT_TEMPLATES = [
  {
    name: 'Push / Pull / Legs — 6 Day',
    description: 'The classic hypertrophy split: two rotations a week, every muscle hit twice.',
    goal: 'muscle_gain',
    level: 'intermediate',
    days_per_week: 6,
    days: [
      {
        day_name: 'Day 1: Push (Chest, Shoulders & Triceps)',
        notes: 'Lead with the heavy press while you are fresh.',
        exercises: [
          ['Barbell Bench Press', 'chest', 4, '6-8', 150],
          ['Incline Dumbbell Press', 'chest', 3, '8-12', 120],
          ['Seated Dumbbell Shoulder Press', 'shoulders', 3, '8-12', 90],
          ['Lateral Raise', 'shoulders', 3, '12-15', 60],
          ['Triceps Pushdown', 'arms', 3, '10-15', 60],
          ['Overhead Triceps Extension', 'arms', 3, '10-12', 60],
        ],
      },
      {
        day_name: 'Day 2: Pull (Back & Biceps)',
        notes: 'Chase the stretch at the bottom of every row.',
        exercises: [
          ['Deadlift', 'back', 3, '5', 180],
          ['Pull-Up', 'back', 4, '6-10', 120],
          ['Seated Cable Row', 'back', 3, '10-12', 90],
          ['Face Pull', 'shoulders', 3, '15-20', 60],
          ['Barbell Curl', 'arms', 3, '8-12', 60],
          ['Hammer Curl', 'arms', 3, '10-12', 60],
        ],
      },
      {
        day_name: 'Day 3: Legs & Core',
        notes: 'Depth over load on the squat.',
        exercises: [
          ['Back Squat', 'legs', 4, '6-8', 180],
          ['Romanian Deadlift', 'legs', 3, '8-10', 120],
          ['Leg Press', 'legs', 3, '10-12', 120],
          ['Lying Leg Curl', 'legs', 3, '12-15', 60],
          ['Standing Calf Raise', 'legs', 4, '15-20', 45],
          ['Hanging Leg Raise', 'core', 3, '12-15', 60],
        ],
      },
      {
        day_name: 'Day 4: Push (Volume)',
        notes: 'Lighter than Day 1 — dumbbells and cables, more reps.',
        exercises: [
          ['Incline Barbell Bench Press', 'chest', 4, '8-10', 120],
          ['Cable Fly', 'chest', 3, '12-15', 60],
          ['Overhead Press', 'shoulders', 4, '8-10', 120],
          ['Front Raise', 'shoulders', 3, '12-15', 60],
          ['Close-Grip Bench Press', 'arms', 3, '8-10', 90],
          ['Triceps Dip', 'arms', 3, '10-15', 60],
        ],
      },
      {
        day_name: 'Day 5: Pull (Volume)',
        notes: 'Vertical pulling focus.',
        exercises: [
          ['Barbell Row', 'back', 4, '8-10', 120],
          ['Lat Pulldown', 'back', 3, '10-12', 90],
          ['One-Arm Dumbbell Row', 'back', 3, '10-12', 75],
          ['Rear Delt Fly', 'shoulders', 3, '15-20', 45],
          ['Preacher Curl', 'arms', 3, '10-12', 60],
          ['Cable Curl', 'arms', 3, '12-15', 45],
        ],
      },
      {
        day_name: 'Day 6: Legs & Conditioning',
        notes: 'Finish the week with unilateral work and ten minutes of cardio.',
        exercises: [
          ['Front Squat', 'legs', 4, '6-8', 150],
          ['Bulgarian Split Squat', 'legs', 3, '10-12', 90],
          ['Leg Extension', 'legs', 3, '12-15', 60],
          ['Hip Thrust', 'legs', 3, '10-12', 90],
          ['Seated Calf Raise', 'legs', 4, '15-20', 45],
          ['Rowing Machine', 'cardio', 1, '10 min', 0],
        ],
      },
    ],
  },
  {
    name: 'Upper / Lower — 4 Day',
    description: 'Strength-led four-day split: a heavy day and a volume day for each half.',
    goal: 'strength',
    level: 'intermediate',
    days_per_week: 4,
    days: [
      {
        day_name: 'Day 1: Upper (Strength)',
        notes: 'Work up to a hard set of five on the bench.',
        exercises: [
          ['Barbell Bench Press', 'chest', 5, '5', 180],
          ['Barbell Row', 'back', 4, '6-8', 150],
          ['Overhead Press', 'shoulders', 3, '6-8', 150],
          ['Lat Pulldown', 'back', 3, '8-10', 90],
          ['Barbell Curl', 'arms', 3, '8-10', 60],
          ['Skull Crusher', 'arms', 3, '8-10', 60],
        ],
      },
      {
        day_name: 'Day 2: Lower (Strength)',
        notes: 'Squat heavy, then hinge.',
        exercises: [
          ['Back Squat', 'legs', 5, '5', 210],
          ['Romanian Deadlift', 'legs', 4, '6-8', 150],
          ['Leg Press', 'legs', 3, '10-12', 120],
          ['Standing Calf Raise', 'legs', 4, '12-15', 45],
          ['Plank', 'core', 3, '60 sec', 45],
        ],
      },
      {
        day_name: 'Day 3: Upper (Hypertrophy)',
        notes: 'Same patterns, higher reps, shorter rests.',
        exercises: [
          ['Incline Dumbbell Press', 'chest', 4, '10-12', 90],
          ['Seated Cable Row', 'back', 4, '10-12', 90],
          ['Arnold Press', 'shoulders', 3, '10-12', 75],
          ['Lateral Raise', 'shoulders', 4, '15-20', 45],
          ['Hammer Curl', 'arms', 3, '12-15', 45],
          ['Triceps Pushdown', 'arms', 3, '12-15', 45],
        ],
      },
      {
        day_name: 'Day 4: Lower (Hypertrophy)',
        notes: 'Single-leg work and a hard finisher.',
        exercises: [
          ['Front Squat', 'legs', 4, '8-10', 120],
          ['Walking Lunge', 'legs', 3, '12 each', 90],
          ['Lying Leg Curl', 'legs', 4, '12-15', 60],
          ['Leg Extension', 'legs', 3, '15-20', 60],
          ['Seated Calf Raise', 'legs', 4, '15-20', 45],
          ['Cable Crunch', 'core', 3, '15-20', 45],
        ],
      },
    ],
  },
  {
    name: 'Full Body Starter — 3 Day',
    description: 'A first programme: three full-body sessions a week, one movement per pattern.',
    goal: 'general_fitness',
    level: 'beginner',
    days_per_week: 3,
    days: [
      {
        day_name: 'Day 1: Full Body A',
        notes: 'Learn the pattern before adding load.',
        exercises: [
          ['Goblet Squat', 'legs', 3, '10-12', 90],
          ['Dumbbell Bench Press', 'chest', 3, '10-12', 90],
          ['Seated Cable Row', 'back', 3, '10-12', 90],
          ['Plank', 'core', 3, '30 sec', 45],
        ],
      },
      {
        day_name: 'Day 2: Full Body B',
        notes: 'Hinge day — keep the back flat throughout.',
        exercises: [
          ['Romanian Deadlift', 'legs', 3, '10-12', 90],
          ['Lat Pulldown', 'back', 3, '10-12', 90],
          ['Seated Dumbbell Shoulder Press', 'shoulders', 3, '10-12', 90],
          ['Bicycle Crunch', 'core', 3, '15-20', 45],
        ],
      },
      {
        day_name: 'Day 3: Full Body C',
        notes: 'Add ten minutes of easy cardio at the end.',
        exercises: [
          ['Leg Press', 'legs', 3, '12-15', 90],
          ['Push-Up', 'chest', 3, '10-15', 60],
          ['One-Arm Dumbbell Row', 'back', 3, '10-12', 60],
          ['Dumbbell Curl', 'arms', 2, '12-15', 45],
          ['Treadmill Run', 'cardio', 1, '10 min', 0],
        ],
      },
    ],
  },
];

/** Item rows are [food_name, portion_size, calories, protein_g, carbs_g, fats_g]. */
const DIET_TEMPLATES = [
  {
    name: 'Fat Loss — 1800 kcal',
    description: 'A moderate deficit with protein held high, so training quality survives it.',
    goal: 'fat_loss',
    target_calories: 1800,
    target_protein_g: 150,
    target_carbs_g: 160,
    target_fats_g: 55,
    target_water_ml: 3500,
    meals: [
      {
        meal_name: 'Breakfast',
        meal_time: '08:00',
        items: [
          ['Oats (dry)', '50g', 195, 8.5, 33, 3.5],
          ['Egg White', '4 whites', 68, 14.4, 0.8, 0.4],
          ['Whole Egg', '1 egg', 78, 6.3, 0.6, 5.3],
        ],
      },
      {
        meal_name: 'Lunch',
        meal_time: '13:00',
        items: [
          ['Chicken Breast (grilled)', '150g', 248, 46.5, 0, 5.4],
          ['Brown Rice (cooked)', '150g', 185, 4, 39, 1.5],
          ['Mixed Vegetable Salad', '200g', 70, 3, 12, 0.6],
        ],
      },
      {
        meal_name: 'Snack',
        meal_time: '17:00',
        items: [
          ['Greek Yogurt (plain)', '150g', 89, 15, 5.4, 0.6],
          ['Almonds', '15g', 87, 3.2, 3.3, 7.5],
        ],
      },
      {
        meal_name: 'Dinner',
        meal_time: '20:30',
        items: [
          ['Rohu Fish', '180g', 175, 30, 0, 2.5],
          ['Roti / Chapati', '2 rotis', 208, 6, 40, 3.4],
          ['Spinach', '150g', 35, 4.4, 5.4, 0.6],
        ],
      },
    ],
  },
  {
    name: 'Clean Bulk — 3000 kcal',
    description: 'A controlled surplus for adding size without dragging body fat up with it.',
    goal: 'muscle_gain',
    target_calories: 3000,
    target_protein_g: 180,
    target_carbs_g: 380,
    target_fats_g: 85,
    target_water_ml: 4000,
    meals: [
      {
        meal_name: 'Breakfast',
        meal_time: '08:00',
        items: [
          ['Oats (dry)', '80g', 311, 13.5, 53, 5.5],
          ['Full Fat Milk', '250 ml', 160, 8, 12, 8.5],
          ['Banana', '1 medium', 105, 1.3, 27, 0.4],
          ['Peanut Butter', '2 tbsp', 188, 8, 6, 16],
        ],
      },
      {
        meal_name: 'Lunch',
        meal_time: '13:00',
        items: [
          ['Chicken Breast (grilled)', '200g', 330, 62, 0, 7.2],
          ['White Rice (cooked)', '250g', 325, 6.8, 70, 0.8],
          ['Toor Dal (cooked)', '150g', 174, 10.5, 30, 0.6],
        ],
      },
      {
        meal_name: 'Pre-Workout',
        meal_time: '17:30',
        items: [
          ['Whole Wheat Bread', '2 slices', 164, 8, 28, 2.2],
          ['Whey Protein', '1 scoop', 120, 24, 3, 1.5],
        ],
      },
      {
        meal_name: 'Post-Workout',
        meal_time: '20:00',
        items: [
          ['Whey Protein', '1 scoop', 120, 24, 3, 1.5],
          ['Sweet Potato (boiled)', '200g', 180, 4, 42, 0.4],
        ],
      },
      {
        meal_name: 'Dinner',
        meal_time: '21:30',
        items: [
          ['Paneer', '150g', 398, 27, 1.8, 31.2],
          ['Roti / Chapati', '3 rotis', 312, 9, 60, 5.1],
          ['Curd / Dahi', '150g', 92, 5.3, 7, 5],
        ],
      },
    ],
  },
  {
    name: 'High Protein Vegetarian — 2200 kcal',
    description: 'Hits 140g of protein with no meat and no fish.',
    goal: 'high_protein',
    target_calories: 2200,
    target_protein_g: 140,
    target_carbs_g: 230,
    target_fats_g: 70,
    target_water_ml: 3500,
    meals: [
      {
        meal_name: 'Breakfast',
        meal_time: '08:00',
        items: [
          ['Poha (cooked)', '200g', 260, 4.8, 56, 1],
          ['Curd / Dahi', '150g', 92, 5.3, 7, 5],
          ['Whey Protein', '1 scoop', 120, 24, 3, 1.5],
        ],
      },
      {
        meal_name: 'Lunch',
        meal_time: '13:00',
        items: [
          ['Soya Chunks (dry)', '60g', 207, 31, 20, 0.3],
          ['Brown Rice (cooked)', '200g', 246, 5.4, 52, 2],
          ['Rajma (boiled)', '150g', 191, 13, 34.5, 0.8],
        ],
      },
      {
        meal_name: 'Snack',
        meal_time: '17:00',
        items: [
          ['Peanuts', '30g', 170, 7.8, 4.8, 14.7],
          ['Green Tea', '1 cup', 2, 0, 0.5, 0],
        ],
      },
      {
        meal_name: 'Dinner',
        meal_time: '20:30',
        items: [
          ['Paneer', '120g', 318, 21.6, 1.4, 25],
          ['Roti / Chapati', '2 rotis', 208, 6, 40, 3.4],
          ['Broccoli', '150g', 51, 4.2, 10.5, 0.6],
        ],
      },
    ],
  },
  {
    name: 'Keto — 1900 kcal',
    description: 'Under 40g of carbs a day: fat-led, protein moderate.',
    goal: 'keto',
    target_calories: 1900,
    target_protein_g: 130,
    target_carbs_g: 35,
    target_fats_g: 140,
    target_water_ml: 4000,
    meals: [
      {
        meal_name: 'Breakfast',
        meal_time: '08:30',
        items: [
          ['Whole Egg', '3 eggs', 234, 18.9, 1.8, 15.9],
          ['Butter', '2 tsp', 72, 0, 0, 8],
          ['Avocado', '100g', 160, 2, 9, 15],
        ],
      },
      {
        meal_name: 'Lunch',
        meal_time: '13:30',
        items: [
          ['Chicken Thigh', '200g', 418, 52, 0, 21.8],
          ['Spinach', '200g', 46, 5.8, 7.2, 0.8],
          ['Olive Oil', '1 tbsp', 119, 0, 0, 13.5],
        ],
      },
      {
        meal_name: 'Snack',
        meal_time: '17:30',
        items: [
          ['Walnuts', '30g', 196, 4.5, 4.2, 19.5],
          ['Cheese Slice', '2 slices', 140, 8, 2, 11],
        ],
      },
      {
        meal_name: 'Dinner',
        meal_time: '20:30',
        items: [
          ['Salmon', '180g', 374, 36, 0, 23.4],
          ['Broccoli', '150g', 51, 4.2, 10.5, 0.6],
          ['Ghee', '2 tsp', 90, 0, 0, 10],
        ],
      },
    ],
  },
];

/**
 * Per-currency monthly add-on price. 499 is a sane monthly fee in rupees and
 * an absurd one in dollars — same reasoning as the starter plan prices in
 * verticals.js.
 */
const ADDON_PRICES = { INR: 499, USD: 15, EUR: 15, GBP: 12 };

export function addonPriceFor(currency) {
  return ADDON_PRICES[String(currency || 'INR').toUpperCase()] ?? ADDON_PRICES.INR;
}

/** What the migration writes, so bootstrap.js can tell an untouched settings
 * row from one an owner has already priced themselves. */
export const DEFAULT_ADDON_PRICE = ADDON_PRICES.INR;

export function seedFitnessLibraries(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM exercise_library').get().n === 0) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO exercise_library (name, muscle_group, equipment) VALUES (?, ?, ?)',
    );
    for (const row of EXERCISES) insert.run(...row);
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM food_library').get().n === 0) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO food_library (name, category, serving_unit, calories, protein_g, carbs_g, fats_g)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of FOODS) insert.run(...row);
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM workout_plans').get().n === 0) {
    const insertPlan = db.prepare(
      `INSERT INTO workout_plans (name, description, goal, level, days_per_week, is_template)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    const insertDay = db.prepare(
      'INSERT INTO workout_plan_days (plan_id, day_number, day_name, notes, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    const insertExercise = db.prepare(
      `INSERT INTO workout_plan_exercises
         (day_id, exercise_name, muscle_group, target_sets, target_reps, rest_seconds, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const template of WORKOUT_TEMPLATES) {
      const planId = insertPlan.run(
        template.name,
        template.description,
        template.goal,
        template.level,
        template.days_per_week,
      ).lastInsertRowid;
      template.days.forEach((day, dayIndex) => {
        const dayId = insertDay.run(planId, dayIndex + 1, day.day_name, day.notes ?? null, dayIndex).lastInsertRowid;
        day.exercises.forEach((ex, exIndex) => {
          insertExercise.run(dayId, ex[0], ex[1], ex[2], ex[3], ex[4], exIndex);
        });
      });
    }
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM diet_plans').get().n === 0) {
    const insertPlan = db.prepare(
      `INSERT INTO diet_plans (name, description, goal, target_calories, target_protein_g, target_carbs_g,
                               target_fats_g, target_water_ml, is_template)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const insertMeal = db.prepare(
      'INSERT INTO diet_plan_meals (plan_id, meal_name, meal_time, target_calories, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    const insertItem = db.prepare(
      `INSERT INTO diet_plan_items (meal_id, food_name, portion_size, calories, protein_g, carbs_g, fats_g, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const template of DIET_TEMPLATES) {
      const planId = insertPlan.run(
        template.name,
        template.description,
        template.goal,
        template.target_calories,
        template.target_protein_g,
        template.target_carbs_g,
        template.target_fats_g,
        template.target_water_ml,
      ).lastInsertRowid;
      template.meals.forEach((meal, mealIndex) => {
        // A meal's calorie target is the sum of what the trainer put in it, not
        // a second number to keep in sync by hand.
        const mealCalories = meal.items.reduce((sum, item) => sum + item[2], 0);
        const mealId = insertMeal.run(planId, meal.meal_name, meal.meal_time ?? null, mealCalories, mealIndex)
          .lastInsertRowid;
        meal.items.forEach((item, itemIndex) => {
          insertItem.run(mealId, item[0], item[1], item[2], item[3], item[4], item[5], itemIndex);
        });
      });
    }
  }
}
