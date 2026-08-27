/**
 * The rules behind the Diet & Workout feature that more than one route needs:
 * who is entitled to it, what a set is worth, and when a lift becomes a
 * personal record.
 *
 * Kept out of the routers because entitlement in particular is asked three
 * ways — the staff console asks about a member, the member portal asks about
 * itself, and the billing route asks before taking money — and all three have
 * to agree.
 *
 * Weight is kilograms everywhere in this file and in the database. Pounds are
 * a display unit the client converts at the edge: a member switching units
 * mid-programme must not silently rewrite their own history, and a PR has to
 * stay comparable across that switch.
 */

import { all, get, run } from './db.js';
import { addDays, addMonths, today } from './validate.js';

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body'];
export const SET_TYPES = ['normal', 'warmup', 'drop', 'failure'];
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout'];
export const WORKOUT_GOALS = ['muscle_gain', 'fat_loss', 'strength', 'endurance', 'general_fitness'];
export const WORKOUT_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const DIET_GOALS = ['fat_loss', 'muscle_gain', 'maintenance', 'keto', 'high_protein'];

/**
 * Epley's estimate: what a set of `reps` at `weight` projects to for a single.
 *
 * Rounded to one decimal because the input is already an approximation and a
 * PR that moves by 0.03 kg between sessions is noise, not progress. A single
 * is its own 1RM, which the formula gets right on its own at reps = 1.
 */
export function estimate1rm(weightKg, reps) {
  const weight = Number(weightKg) || 0;
  const count = Number(reps) || 0;
  if (weight <= 0 || count <= 0) return 0;
  return Math.round(weight * (1 + count / 30) * 10) / 10;
}

/** A warmup is deliberately not a candidate: it is submaximal by definition,
 * so counting it would let a light single poison the member's PR wall. */
const COUNTS_TOWARDS_PR = new Set(['normal', 'drop', 'failure']);

export function fitnessSettings() {
  return (
    get('SELECT * FROM fitness_addon_settings WHERE id = 1') ?? {
      id: 1,
      enabled: 1,
      monthly_price: 499,
      trial_days: 0,
      description: 'Unlock personalised Diet & Workout tracking with trainer guidance.',
    }
  );
}

/**
 * Retires add-ons whose last paid day has passed.
 *
 * Called from the read paths rather than a timer, the same way
 * expireOverdueSubscriptions() is: an add-on that lapsed overnight has to read
 * as lapsed on the first request of the morning, whether or not a sweep has
 * run. Cheap — the partial index means this touches only live rows.
 */
export function expireLapsedFitnessAddons() {
  run("UPDATE member_fitness_addons SET status = 'expired' WHERE status = 'active' AND end_date < ?", [today()]);
}

/**
 * Whether `memberId` may use the tracker, and on what basis.
 *
 * Four ways in, checked in the order a member would expect to be told about
 * them: the gym does not charge at all, they bought the add-on, their
 * membership plan bundles it, or they are inside a free trial. `source` is
 * null when none apply, which is what raises the portal paywall.
 */
export function fitnessAccessFor(memberId) {
  expireLapsedFitnessAddons();
  const settings = fitnessSettings();

  const addon = get(
    "SELECT * FROM member_fitness_addons WHERE member_id = ? AND status = 'active' ORDER BY end_date DESC LIMIT 1",
    [memberId],
  );

  // Bundled entitlement rides on the membership: it lasts exactly as long as
  // the membership does, so an expired plan takes the tracker with it.
  const bundled = get(
    `SELECT p.name AS plan_name, s.end_date
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.member_id = ? AND s.status = 'active' AND p.includes_fitness_addon = 1 AND s.end_date >= ?
     ORDER BY s.end_date DESC LIMIT 1`,
    [memberId, today()],
  );

  // Anchored on the join date, so a trial is a welcome offer rather than
  // something a member can restart by clicking around.
  const member = get('SELECT joined_on FROM members WHERE id = ?', [memberId]);
  const trialEndsOn = settings.trial_days > 0 && member ? addDays(member.joined_on, settings.trial_days) : null;
  const onTrial = Boolean(trialEndsOn) && today() <= trialEndsOn;

  let source = null;
  if (!settings.enabled) source = 'free';
  else if (addon) source = 'addon';
  else if (bundled) source = 'plan';
  else if (onTrial) source = 'trial';

  return {
    has_access: source !== null,
    source,
    addon: addon ?? null,
    is_bundled: Boolean(bundled),
    bundled_plan: bundled?.plan_name ?? null,
    trial_ends_on: onTrial ? trialEndsOn : null,
    settings: {
      enabled: settings.enabled,
      monthly_price: settings.monthly_price,
      trial_days: settings.trial_days,
      description: settings.description,
    },
    // Valid-until, whichever entitlement is carrying them — the one date the
    // member and the front desk both care about.
    valid_until: addon?.end_date ?? bundled?.end_date ?? (onTrial ? trialEndsOn : null),
  };
}

/**
 * Extends a member's add-on by `months`, or opens a new one.
 *
 * Extension rather than a second row, for the reason the partial unique index
 * exists (see the migration in db.js): entitlement stays a single-row read.
 * A renewal bought early stacks onto the unused tail instead of throwing it
 * away — the same courtesy subscriptions.js extends to memberships.
 */
export function activateFitnessAddon({ memberId, months = 1, price, startDate, paymentId, userId, note }) {
  const from = startDate || today();
  const existing = get(
    "SELECT * FROM member_fitness_addons WHERE member_id = ? AND status = 'active' ORDER BY end_date DESC LIMIT 1",
    [memberId],
  );

  if (existing) {
    // Extend from whichever is later: an add-on still running keeps its
    // remaining days, a lapsed-today one restarts from today.
    const base = existing.end_date >= from ? existing.end_date : addDays(from, -1);
    run(
      `UPDATE member_fitness_addons
       SET end_date = ?, price = price + ?, payment_id = COALESCE(?, payment_id),
           assigned_by = COALESCE(?, assigned_by), notes = COALESCE(?, notes)
       WHERE id = ?`,
      [addMonths(base, months), price, paymentId ?? null, userId ?? null, note ?? null, existing.id],
    );
    return get('SELECT * FROM member_fitness_addons WHERE id = ?', [existing.id]);
  }

  const info = run(
    `INSERT INTO member_fitness_addons (member_id, start_date, end_date, price, payment_id, assigned_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [memberId, from, addMonths(addDays(from, -1), months), price, paymentId ?? null, userId ?? null, note ?? null],
  );
  return get('SELECT * FROM member_fitness_addons WHERE id = ?', [info.lastInsertRowid]);
}

/**
 * Records whatever `sets` beat the member's stored best, and returns the PRs.
 *
 * A PR here means a new best *estimated* 1RM for that exercise, not merely a
 * heavier bar: 100 kg × 5 is a better set than 105 kg × 1, and a wall that
 * ranked the single above it would be telling the member the wrong thing.
 * max_weight_kg/max_reps are the actual set that produced the estimate, so the
 * wall can say "112.5 kg × 5" rather than an abstract projection.
 *
 * Idempotent per set: called once, inside the transaction that writes the log.
 */
export function recordPersonalRecords(memberId, sets) {
  const best = new Map();
  for (const set of sets) {
    if (!COUNTS_TOWARDS_PR.has(set.set_type) || !set.completed) continue;
    const oneRm = estimate1rm(set.weight_kg, set.reps);
    if (oneRm <= 0) continue;
    const incumbent = best.get(set.exercise_name);
    if (!incumbent || oneRm > incumbent.est_1rm_kg) {
      best.set(set.exercise_name, { ...set, est_1rm_kg: oneRm });
    }
  }

  const prs = [];
  for (const [exerciseName, set] of best) {
    const previous = get('SELECT * FROM exercise_prs WHERE member_id = ? AND exercise_name = ?', [
      memberId,
      exerciseName,
    ]);
    if (previous && previous.est_1rm_kg >= set.est_1rm_kg) continue;

    if (previous) {
      run(
        `UPDATE exercise_prs
         SET max_weight_kg = ?, max_reps = ?, est_1rm_kg = ?, achieved_at = datetime('now'), log_set_id = ?
         WHERE id = ?`,
        [set.weight_kg, set.reps, set.est_1rm_kg, set.id ?? null, previous.id],
      );
    } else {
      run(
        `INSERT INTO exercise_prs (member_id, exercise_name, max_weight_kg, max_reps, est_1rm_kg, log_set_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [memberId, exerciseName, set.weight_kg, set.reps, set.est_1rm_kg, set.id ?? null],
      );
    }
    if (set.id) run('UPDATE workout_log_sets SET is_pr = 1 WHERE id = ?', [set.id]);

    prs.push({
      exercise_name: exerciseName,
      weight_kg: set.weight_kg,
      reps: set.reps,
      est_1rm_kg: set.est_1rm_kg,
      previous_est_1rm_kg: previous?.est_1rm_kg ?? null,
    });
  }
  return prs;
}

/**
 * The member's last logged set for each of `exerciseNames`, which is the
 * "Previous" column in the set table — the single most useful number on the
 * screen, because it is what the member is trying to beat.
 *
 * One query for the whole session rather than one per exercise: a 6-exercise
 * day would otherwise be six round trips before the first set is even entered.
 */
export function previousSetsFor(memberId, exerciseNames) {
  if (!exerciseNames.length) return {};
  const placeholders = exerciseNames.map(() => '?').join(', ');
  const rows = all(
    `SELECT s.exercise_name, s.weight_kg, s.reps, s.est_1rm_kg, l.log_date
     FROM workout_log_sets s
     JOIN workout_logs l ON l.id = s.log_id
     WHERE l.member_id = ? AND s.exercise_name IN (${placeholders})
       AND s.set_type != 'warmup' AND s.completed = 1
     ORDER BY s.exercise_name, l.log_date DESC, s.id DESC`,
    [memberId, ...exerciseNames],
  );

  const out = {};
  for (const row of rows) {
    // Rows arrive newest-first per exercise, so the first one wins.
    if (!out[row.exercise_name]) out[row.exercise_name] = row;
  }
  return out;
}

/** Totals a finished session, so the summary modal and the history list read
 * the same numbers the database stores. Warmups count towards volume — they
 * were still lifted — but sets left unticked do not. */
export function summariseSets(sets) {
  let volume = 0;
  let reps = 0;
  let completed = 0;
  for (const set of sets) {
    if (!set.completed) continue;
    completed += 1;
    reps += set.reps;
    volume += set.weight_kg * set.reps;
  }
  return {
    total_sets: completed,
    total_reps: reps,
    total_volume_kg: Math.round(volume * 10) / 10,
  };
}
