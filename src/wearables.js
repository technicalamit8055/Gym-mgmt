/**
 * Wearables: daily activity a member's watch or phone already counted —
 * steps, active calories, distance, exercise minutes — brought into the app
 * so the Home tab can show it and the diet budget can credit it.
 *
 * Sources ("providers"):
 *   health_connect  Android's on-device store, which Fitbit, Samsung Health,
 *                   Google Fit, Garmin, Pixel Watch and Strava all write to.
 *                   The GymVym app reads it (HealthConnectPlugin.kt) and posts
 *                   daily totals here; the server never talks to Google. The
 *                   phone also writes the member's workouts and meals back
 *                   into it, from healthConnectExport() below.
 *
 * A cloud provider (Strava, say) slots in as another provider whose tokens go
 * in member_wearable_connections.credentials and whose sync runs here instead
 * of on the phone. Strava's terms allow its data to be shown only to the
 * member it belongs to, so nothing here is ever exposed to other members.
 *
 * Days are gym-local dates, like every other log_date. The phone buckets by
 * its own calendar day, which is the same day for anyone living near their gym.
 */

import { gymDateOf, gymOffsetMinutes } from './clock.js';
import { all, get, run, tx } from './db.js';
import { addDays, today } from './validate.js';

export const WEARABLE_PROVIDERS = ['health_connect'];

/** How far back a sync may write, and how far back Health Connect lets a new
 * app read anyway. */
export const SYNC_WINDOW_DAYS = 30;

/** The daily step goal the Home ring fills towards. */
export const STEP_GOAL = 10_000;

const METRICS = ['steps', 'active_calories', 'distance_m', 'active_minutes'];

/** What a sync may claim for one day, with headroom over anything human. */
const METRIC_MAX = { steps: 200_000, active_calories: 15_000, distance_m: 500_000, active_minutes: 1440 };

export function connectionsFor(memberId) {
  return all(
    'SELECT provider, connected_at, last_synced_at FROM member_wearable_connections WHERE member_id = ? ORDER BY connected_at',
    [memberId],
  );
}

export function connectionFor(memberId, provider) {
  return get('SELECT * FROM member_wearable_connections WHERE member_id = ? AND provider = ?', [memberId, provider]);
}

export function connectWearable(memberId, provider) {
  run(
    'INSERT INTO member_wearable_connections (member_id, provider) VALUES (?, ?) ON CONFLICT (member_id, provider) DO NOTHING',
    [memberId, provider],
  );
}

/** Unlinks a source and forgets everything it sent: a member who disconnects
 * expects their data gone, not kept quietly. */
export function disconnectWearable(memberId, provider) {
  return tx(() => {
    run('DELETE FROM member_daily_activity WHERE member_id = ? AND provider = ?', [memberId, provider]);
    return run('DELETE FROM member_wearable_connections WHERE member_id = ? AND provider = ?', [memberId, provider]).changes > 0;
  });
}

/**
 * The days a sync may store, cleaned: inside the window, not after today (a
 * phone a timezone ahead of the gym can be on tomorrow already — that day is
 * dropped, not refused), one entry per date with the last one winning, and
 * every metric a whole number in range or null (not shared by the source).
 * Returns null for a payload that is not a list of days at all.
 */
export function cleanSyncDays(days) {
  if (!Array.isArray(days) || days.length > SYNC_WINDOW_DAYS + 1) return null;
  const todayIso = today();
  const oldest = addDays(todayIso, -SYNC_WINDOW_DAYS);
  const byDate = new Map();
  for (const day of days) {
    if (!day || typeof day !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date ?? '')) return null;
    if (day.date > todayIso || day.date < oldest) continue;
    const row = { date: day.date };
    for (const metric of METRICS) {
      const value = day[metric];
      if (value === null || value === undefined) row[metric] = null;
      else if (!Number.isFinite(value) || value < 0) return null;
      else row[metric] = Math.min(Math.round(value), METRIC_MAX[metric]);
    }
    byDate.set(day.date, row);
  }
  return [...byDate.values()];
}

export function saveDailyActivity(memberId, provider, days) {
  tx(() => {
    for (const day of days) {
      run(
        `INSERT INTO member_daily_activity (member_id, log_date, provider, steps, active_calories, distance_m, active_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (member_id, log_date, provider) DO UPDATE SET
           steps = excluded.steps, active_calories = excluded.active_calories,
           distance_m = excluded.distance_m, active_minutes = excluded.active_minutes,
           synced_at = datetime('now')`,
        [memberId, day.date, provider, day.steps, day.active_calories, day.distance_m, day.active_minutes],
      );
    }
    run(
      "UPDATE member_wearable_connections SET last_synced_at = datetime('now') WHERE member_id = ? AND provider = ?",
      [memberId, provider],
    );
  });
}

/**
 * Each day's activity from `from` to `to`, one row per date with data. Two
 * sources counting the same walk must not double it, so each metric is the
 * highest any connected source reported — not the sum.
 */
export function dailyActivity(memberId, from, to) {
  return all(
    `SELECT log_date, MAX(steps) AS steps, MAX(active_calories) AS active_calories,
            MAX(distance_m) AS distance_m, MAX(active_minutes) AS active_minutes,
            GROUP_CONCAT(provider) AS providers, MAX(synced_at) AS synced_at
     FROM member_daily_activity WHERE member_id = ? AND log_date BETWEEN ? AND ?
     GROUP BY log_date ORDER BY log_date`,
    [memberId, from, to],
  ).map(({ providers, ...day }) => ({ ...day, providers: providers.split(',') }));
}

export function activityOn(memberId, logDate) {
  return dailyActivity(memberId, logDate, logDate)[0] ?? null;
}

/* ── Sending the other way: workouts and meals out to Health Connect ──── */

/** How many days back the phone keeps Health Connect in step with the app. */
export const EXPORT_DAYS = 7;

/** When a meal "happened" if it was logged on another day than it belongs to
 * (filled in later, say): a typical time for that meal, gym-local. */
const MEAL_TIMES = {
  breakfast: '08:30',
  lunch: '13:30',
  snack: '16:30',
  pre_workout: '17:30',
  post_workout: '19:30',
  dinner: '20:30',
};

const MINUTE = 60_000;
const utcMs = (sqlUtc) => Date.parse(`${sqlUtc.replace(' ', 'T')}Z`);

/**
 * What the phone writes to Health Connect so Google Fit, Samsung Health and
 * the rest show it: the workouts finished in the logger, and every food entry,
 * for the last EXPORT_DAYS days. Hand-logged activities (a run, a walk) are
 * left out — the watch that counted them has usually written them already.
 *
 * Each item's `id` is its Health Connect clientRecordId, stable for the
 * life of the row and unique across gyms (member ids are per gym), so a
 * rewrite updates the record and a deleted row's record can be found again.
 * Times come from the rows alone, never from the clock, so an unchanged row
 * exports identically and the phone can skip rewriting it. They are UTC
 * instants; every record lasts at least a minute, as Health Connect
 * requires, and one that would end in the future is held back until it doesn't.
 */
export function healthConnectExport(memberId, tenantSlug) {
  const to = today();
  const from = addDays(to, -(EXPORT_DAYS - 1));
  const now = Date.now();
  const prefix = `gymvym.${tenantSlug}`;

  const workouts = all(
    `SELECT id, workout_name, started_at, ended_at, duration_seconds, total_sets, log_date
     FROM workout_logs WHERE member_id = ? AND log_date BETWEEN ? AND ? ORDER BY started_at`,
    [memberId, from, to],
  ).flatMap((w) => {
    const started = utcMs(w.started_at);
    let start = started;
    let end;
    if (w.ended_at && utcMs(w.ended_at) > started) {
      end = utcMs(w.ended_at);
    } else if (w.duration_seconds > 0) {
      end = started + w.duration_seconds * 1000;
    } else {
      // Saved without a timer: it ended when it was saved, and lasted what
      // its sets take, as the burn estimate assumes.
      end = started;
      start = started - Math.max(w.total_sets * 150, 60) * 1000;
    }
    if (end > now) return [];
    start = Math.min(start, end - MINUTE);
    return {
      id: `${prefix}.workout.${w.id}`,
      date: w.log_date,
      title: w.workout_name,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  });

  const offsetMs = gymOffsetMinutes() * MINUTE;
  const meals = all(
    `SELECT e.id, e.meal_type, e.food_name, e.calories, e.protein_g, e.carbs_g, e.fats_g, e.fiber_g, e.sugar_g,
            e.logged_at, d.log_date, ${gymDateOf('e.logged_at')} = d.log_date AS on_day
     FROM diet_log_entries e JOIN diet_logs d ON d.id = e.diet_log_id
     WHERE d.member_id = ? AND d.log_date BETWEEN ? AND ? ORDER BY e.logged_at, e.id`,
    [memberId, from, to],
  ).flatMap((e) => {
    const at = e.on_day ? utcMs(e.logged_at) : Date.parse(`${e.log_date}T${MEAL_TIMES[e.meal_type]}:00Z`) - offsetMs;
    if (at > now) return []; // Planned ahead: sent once its mealtime has passed.
    return {
      id: `${prefix}.meal.${e.id}`,
      date: e.log_date,
      name: e.food_name,
      meal_type: e.meal_type,
      time: new Date(at).toISOString(),
      calories: e.calories,
      protein_g: e.protein_g,
      carbs_g: e.carbs_g,
      fats_g: e.fats_g,
      fiber_g: e.fiber_g,
      sugar_g: e.sugar_g,
    };
  });

  // scope: whose records these are, so a phone two members share keeps
  // track of what it wrote for each apart.
  return { scope: `${tenantSlug}.${memberId}`, from, to, workouts, meals };
}

/** The Connected apps screen and the Home card: what is linked, and the
 * last `days` days with gaps left out. */
export function wearableSummary(memberId, { days = 7 } = {}) {
  const to = today();
  return {
    providers: WEARABLE_PROVIDERS,
    connections: connectionsFor(memberId),
    step_goal: STEP_GOAL,
    days: dailyActivity(memberId, addDays(to, -(days - 1)), to),
  };
}
