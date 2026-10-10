/**
 * A member's daily calorie budget, MyFitnessPal-style: which targets they
 * follow, the calculator that suggests their own, and what their training
 * burns.
 *
 * Three places ask "what is this member's goal today?" — the Diet tab, the
 * trainer's adherence view and the hydration nudges — and all three must get
 * the same answer, so it lives here rather than in any one router.
 *
 * Burn is estimated as *net* METs (MET − 1) × kg × hours. The resting 1 MET is
 * already inside the BMR every target is built on, so counting it again on top
 * would quietly hand a member an extra 70-odd kcal for every hour they log.
 */

import { all, get } from './db.js';
import { DEFAULT_DIET_TARGETS } from './fitness.js';
import { today } from './validate.js';

export const SEXES = ['male', 'female', 'other'];

/** Daily life *outside* the gym — the factor on BMR. Training is deliberately
 * not in here: it is either logged and added back, or folded in separately by
 * suggestTargets(), and counting it in both places is the classic way calorie
 * apps double-count a workout. */
export const ACTIVITY_LEVELS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
};

/** Gross METs for an hour of resistance training at each effort. */
export const TRAINING_INTENSITIES = {
  light: 3.5,
  moderate: 5,
  hard: 6,
};

export const NUTRITION_GOALS = ['lose', 'maintain', 'gain'];
export const ADDBACK_OPTIONS = [0, 50, 100];

/** Fallback body weight for burn estimates before a member has weighed in. */
const DEFAULT_WEIGHT_KG = 70;
/** A logger left running overnight must not credit a day's worth of food. */
const MAX_WORKOUT_SECONDS = 3 * 3600;
/** Roughly one working set plus its rest, for sessions saved without a timer. */
const SECONDS_PER_SET = 150;
/** One kilogram of body fat, as near as anyone can say. */
const KCAL_PER_KG = 7700;

/**
 * Things a member does outside the logger, with Compendium of Physical
 * Activities METs. `icon` is a name from the client's icon set.
 */
export const ACTIVITY_TYPES = [
  { key: 'walking', label: 'Walking', met: 3.5, icon: 'activity' },
  { key: 'brisk_walking', label: 'Brisk walking', met: 4.3, icon: 'activity' },
  { key: 'running', label: 'Running (easy pace)', met: 8.3, icon: 'zap' },
  { key: 'running_fast', label: 'Running (fast pace)', met: 11, icon: 'zap' },
  { key: 'cycling', label: 'Cycling', met: 6.8, icon: 'activity' },
  { key: 'swimming', label: 'Swimming', met: 6, icon: 'droplet' },
  { key: 'skipping', label: 'Skipping rope', met: 11, icon: 'zap' },
  { key: 'hiit', label: 'HIIT / circuit', met: 8, icon: 'flame' },
  { key: 'elliptical', label: 'Elliptical', met: 5, icon: 'activity' },
  { key: 'rowing', label: 'Rowing machine', met: 7, icon: 'activity' },
  { key: 'stair_climber', label: 'Stair climber', met: 9, icon: 'trendUp' },
  { key: 'yoga', label: 'Yoga', met: 2.5, icon: 'yoga' },
  { key: 'pilates', label: 'Pilates', met: 3, icon: 'yoga' },
  { key: 'dance', label: 'Dance / Zumba', met: 6.5, icon: 'music' },
  { key: 'hiking', label: 'Hiking', met: 6, icon: 'mapPin' },
  { key: 'football', label: 'Football', met: 7, icon: 'trophy' },
  { key: 'cricket', label: 'Cricket', met: 4.8, icon: 'trophy' },
  { key: 'badminton', label: 'Badminton', met: 5.5, icon: 'trophy' },
  { key: 'basketball', label: 'Basketball', met: 6.5, icon: 'trophy' },
  { key: 'tennis', label: 'Tennis', met: 7.3, icon: 'trophy' },
  { key: 'other', label: 'Other activity', met: 4, icon: 'heartPulse' },
];
export const ACTIVITY_KEYS = ACTIVITY_TYPES.map((a) => a.key);

const round = (n, step = 1) => Math.round(n / step) * step;

/** Whole years between a YYYY-MM-DD birth date and `on`. */
export function ageOn(birthDate, on = today()) {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = on.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Fibre at 14 g per 1000 kcal (the US dietary guideline) and sugar capped at
 * 10% of energy (WHO) — what a trainer's plan or the defaults imply, since
 * neither carries its own numbers for these. */
export function fiberSugarFor(calories) {
  return {
    target_fiber_g: round((calories / 1000) * 14),
    target_sugar_g: round((calories * 0.1) / 4),
  };
}

/* ── Calculator ───────────────────────────────────────────────────────── */

/**
 * Suggested daily targets from body stats.
 *
 *   BMR        Mifflin-St Jeor — the best-validated of the standard equations.
 *   base       BMR × daily-life factor.
 *   training   the average daily cost of the member's stated training, but
 *              only the share they will NOT be adding back from their logs —
 *              with 100% add-back it is zero, because the logs will cover it.
 *   goal       ± rate × 7700 / 7 kcal a day.
 *
 * Protein scales with training effort (1.4–2.0 g/kg) and is lifted while
 * cutting, when it is what protects muscle. Fat takes a fixed share of
 * energy (with a floor per kg for hormone health), carbs take the rest.
 *
 * Calories never go below 1200 (women) / 1500 (men) — the floor every major
 * tracker uses — and `floored` says when that happened, so the member is told
 * their chosen rate was too aggressive rather than left to wonder.
 */
export function suggestTargets({
  weight_kg,
  height_cm,
  age,
  sex,
  activity_level = 'light',
  training_days = 0,
  training_intensity = 'moderate',
  goal = 'maintain',
  goal_rate_kg = 0.5,
  exercise_addback_pct = 100,
}) {
  const sexOffset = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;
  const bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + sexOffset;
  const base = bmr * (ACTIVITY_LEVELS[activity_level] ?? ACTIVITY_LEVELS.light);

  const sessionMet = TRAINING_INTENSITIES[training_intensity] ?? TRAINING_INTENSITIES.moderate;
  const trainingPerDay = ((sessionMet - 1) * weight_kg * training_days) / 7;
  const trainingBuiltIn = trainingPerDay * (1 - exercise_addback_pct / 100);
  const maintenance = base + trainingBuiltIn;

  const rate = goal === 'maintain' ? 0 : goal_rate_kg;
  const goalAdjustment = ((goal === 'lose' ? -1 : 1) * rate * KCAL_PER_KG) / 7;

  const floor = sex === 'male' ? 1500 : 1200;
  const raw = maintenance + goalAdjustment;
  const calories = round(Math.max(raw, floor), 10);

  const proteinPerKg = { light: 1.4, moderate: 1.6, hard: 2 }[training_intensity] ?? 1.6;
  const protein = round(weight_kg * Math.min(2.2, proteinPerKg + (goal === 'lose' ? 0.2 : 0)));
  const fats = round(Math.max(weight_kg * 0.6, (calories * (goal === 'lose' ? 0.25 : 0.3)) / 9));
  const carbs = Math.max(0, round((calories - protein * 4 - fats * 9) / 4));

  // 35 ml a kilo, plus half a litre on each training day spread over the week.
  const water = round(weight_kg * 35 + (500 * training_days) / 7, 250);

  return {
    bmr: round(bmr),
    maintenance: round(maintenance),
    training_per_day: round(trainingPerDay),
    training_built_in: round(trainingBuiltIn),
    goal_adjustment: round(goalAdjustment),
    floored: raw < floor,
    targets: {
      target_calories: calories,
      target_protein_g: protein,
      target_carbs_g: carbs,
      target_fats_g: fats,
      ...fiberSugarFor(calories),
      target_water_ml: water,
    },
  };
}

/* ── Burn ─────────────────────────────────────────────────────────────── */

const netKcal = (met, kg, seconds) => Math.max(0, (met - 1) * kg * (seconds / 3600));

/**
 * One logged session's burn. The effort comes from the RPE the member logged
 * when there is one, else from the training intensity they told the
 * calculator, else moderate. A session saved without a timer is costed by its
 * set count instead.
 */
export function workoutCalories({ duration_seconds, total_sets, avg_rpe, weight_kg, intensity }) {
  let met = TRAINING_INTENSITIES[intensity] ?? TRAINING_INTENSITIES.moderate;
  if (avg_rpe) met = avg_rpe <= 5 ? TRAINING_INTENSITIES.light : avg_rpe <= 7.5 ? TRAINING_INTENSITIES.moderate : TRAINING_INTENSITIES.hard;
  const seconds = Math.min(MAX_WORKOUT_SECONDS, duration_seconds > 0 ? duration_seconds : (total_sets || 0) * SECONDS_PER_SET);
  return Math.round(netKcal(met, weight_kg || DEFAULT_WEIGHT_KG, seconds));
}

export function activityCalories(activityKey, minutes, weightKg) {
  const type = ACTIVITY_TYPES.find((a) => a.key === activityKey) ?? ACTIVITY_TYPES.at(-1);
  return Math.round(netKcal(type.met, weightKg || DEFAULT_WEIGHT_KG, minutes * 60));
}

/* ── Reads ────────────────────────────────────────────────────────────── */

/** The member's weight as of `onDate` — the last weigh-in on or before it, or
 * their first one if every weigh-in is later (better than a made-up 70 kg). */
export function weightOn(memberId, onDate = today()) {
  return (
    get(
      'SELECT weight_kg FROM body_weight_logs WHERE member_id = ? AND log_date <= ? ORDER BY log_date DESC LIMIT 1',
      [memberId, onDate],
    )?.weight_kg
    ?? get('SELECT weight_kg FROM body_weight_logs WHERE member_id = ? ORDER BY log_date LIMIT 1', [memberId])?.weight_kg
    ?? null
  );
}

/** The stored profile, or an all-defaults one the client can render a form
 * from. Sex and birth date fall back to what the front desk recorded. */
export function nutritionProfile(memberId) {
  const row = get('SELECT * FROM member_nutrition_profiles WHERE member_id = ?', [memberId]);
  const member = get('SELECT gender, date_of_birth FROM members WHERE id = ?', [memberId]) ?? {};
  const deskSex = SEXES.includes(member.gender) ? member.gender : null;
  return {
    use_own_targets: 0,
    target_calories: null,
    target_protein_g: null,
    target_carbs_g: null,
    target_fats_g: null,
    target_fiber_g: null,
    target_sugar_g: null,
    target_water_ml: null,
    exercise_addback_pct: 100,
    height_cm: null,
    activity_level: 'light',
    training_days: 4,
    training_intensity: 'moderate',
    goal: 'maintain',
    goal_rate_kg: 0.5,
    goal_weight_kg: null,
    ...row,
    sex: row?.sex ?? deskSex,
    birth_date: row?.birth_date ?? member.date_of_birth ?? null,
  };
}

function trainerPlanFor(memberId) {
  return get(
    `SELECT p.* FROM member_diet_assignments a JOIN diet_plans p ON p.id = a.plan_id
     WHERE a.member_id = ? AND a.status = 'active'`,
    [memberId],
  );
}

/**
 * The targets a member is actually following, and where they came from.
 *
 *   own      they switched to their own (or have no trainer plan but set some)
 *   trainer  an assigned plan, which wins by default — the member opts out
 *   default  nothing set by anyone yet
 *
 * A member whose plan is unassigned after they had set their own falls back
 * to their own rather than to the generic defaults: those numbers are theirs.
 */
export function effectiveDietTargets(memberId) {
  const profile = nutritionProfile(memberId);
  const plan = trainerPlanFor(memberId);
  const hasOwn = Boolean(profile.target_calories);
  const addback = profile.exercise_addback_pct;

  if (hasOwn && (profile.use_own_targets || !plan)) {
    const derived = fiberSugarFor(profile.target_calories);
    return {
      source: 'own',
      exercise_addback_pct: addback,
      targets: {
        target_calories: profile.target_calories,
        target_protein_g: profile.target_protein_g ?? 0,
        target_carbs_g: profile.target_carbs_g ?? 0,
        target_fats_g: profile.target_fats_g ?? 0,
        target_fiber_g: profile.target_fiber_g ?? derived.target_fiber_g,
        target_sugar_g: profile.target_sugar_g ?? derived.target_sugar_g,
        target_water_ml: profile.target_water_ml ?? DEFAULT_DIET_TARGETS.target_water_ml,
      },
    };
  }

  const source = plan ?? DEFAULT_DIET_TARGETS;
  return {
    source: plan ? 'trainer' : 'default',
    exercise_addback_pct: addback,
    targets: {
      target_calories: source.target_calories,
      target_protein_g: source.target_protein_g,
      target_carbs_g: source.target_carbs_g,
      target_fats_g: source.target_fats_g,
      ...fiberSugarFor(source.target_calories),
      target_water_ml: source.target_water_ml,
    },
  };
}

/**
 * Everything a member burned on `logDate`: logged workouts (costed at save
 * time; older sessions from before costing existed are estimated now) and
 * the activities they added by hand.
 */
export function exerciseForDay(memberId, logDate) {
  const weightKg = weightOn(memberId, logDate);
  const intensity = get('SELECT training_intensity FROM member_nutrition_profiles WHERE member_id = ?', [memberId])
    ?.training_intensity;

  const workouts = all(
    `SELECT l.id, l.workout_name, l.duration_seconds, l.total_sets, l.calories_burned,
            (SELECT AVG(s.rpe) FROM workout_log_sets s WHERE s.log_id = l.id AND s.rpe IS NOT NULL) AS avg_rpe
     FROM workout_logs l WHERE l.member_id = ? AND l.log_date = ? ORDER BY l.started_at`,
    [memberId, logDate],
  ).map((w) => ({
    id: w.id,
    workout_name: w.workout_name,
    duration_seconds: w.duration_seconds,
    calories: w.calories_burned ?? workoutCalories({ ...w, weight_kg: weightKg, intensity }),
  }));

  const activities = all(
    'SELECT * FROM activity_logs WHERE member_id = ? AND log_date = ? ORDER BY created_at, id',
    [memberId, logDate],
  );

  const total = workouts.reduce((s, w) => s + w.calories, 0) + activities.reduce((s, a) => s + a.calories, 0);
  return { workouts, activities, total_burned: total, weight_kg: weightKg };
}
