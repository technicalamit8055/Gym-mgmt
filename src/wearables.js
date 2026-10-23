/**
 * Wearables: daily activity a member's watch or phone already counted —
 * steps, active calories, distance, exercise minutes — brought into the app
 * so the Home tab can show it and the diet budget can credit it.
 *
 * Sources ("providers"):
 *   health_connect  Android's on-device store, which Fitbit, Samsung Health,
 *                   Google Fit, Garmin, Pixel Watch and Strava all write to.
 *                   The GymVym app reads it (HealthConnectPlugin.kt) and posts
 *                   daily totals here; the server never talks to Google.
 *
 * A cloud provider (Strava, say) slots in as another provider whose tokens go
 * in member_wearable_connections.credentials and whose sync runs here instead
 * of on the phone. Strava's terms allow its data to be shown only to the
 * member it belongs to, so nothing here is ever exposed to other members.
 *
 * Days are gym-local dates, like every other log_date. The phone buckets by
 * its own calendar day, which is the same day for anyone living near their gym.
 */

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
