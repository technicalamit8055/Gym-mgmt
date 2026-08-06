import { getTenantTimezone, run } from './db.js';

/**
 * Flips memberships whose end date has passed to "expired". Cheap enough to run
 * before any read that reports on membership state, which keeps the numbers
 * honest without a background scheduler.
 */
export function expireOverdueSubscriptions() {
  return run(
    "UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND end_date < date('now')",
  ).changes;
}

/**
 * Minutes that `timeZone` is ahead of UTC right now.
 *
 * Formatting an instant into the target zone and reading it back as if it were
 * UTC is the standard no-dependency way to get this: the gap between the two
 * *is* the offset. Going through Intl rather than a stored number is what
 * makes DST handle itself — a gym in a DST zone gets a different answer in
 * summer than in winter, which is exactly right for a "shift ends at 21:00"
 * rule that a human typed in wall-clock time.
 */
function offsetMinutes(timeZone, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  // Intl renders midnight as hour "24" under hour12:false in some engines.
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

// One Intl.DateTimeFormat construction per zone per hour is plenty: offsets
// only ever change on a DST boundary, always on a minute boundary.
const offsetCache = new Map();

/**
 * The pair of SQLite datetime modifiers that convert UTC -> the gym's
 * wall-clock time and back again.
 *
 * `'localtime'`/`'utc'` (the server's own zone) stays the answer when a gym
 * has set no timezone, which keeps single-tenant and dev behaviour identical
 * to what it was. `±N minutes` rather than the `±HH:MM` modifier because the
 * former works on every SQLite version.
 */
function localtimeModifiers() {
  const timeZone = getTenantTimezone();
  if (!timeZone) return ['localtime', 'utc'];

  const now = new Date();
  const bucket = `${timeZone}|${Math.floor(now.getTime() / 3_600_000)}`;
  let minutes = offsetCache.get(bucket);
  if (minutes === undefined) {
    try {
      minutes = offsetMinutes(timeZone, now);
    } catch {
      return ['localtime', 'utc']; // unrecognised zone name — don't break check-outs over it
    }
    offsetCache.clear(); // single-entry cache; the bucket key already carries the hour
    offsetCache.set(bucket, minutes);
  }
  return [`${minutes >= 0 ? '+' : ''}${minutes} minutes`, `${minutes >= 0 ? '-' : '+'}${Math.abs(minutes)} minutes`];
}

/**
 * Closes any open visit whose member has an assigned gym session (e.g. a
 * 5am-10am morning batch) once that session's end time has passed for the
 * day the visit started. Members with no assigned session are unaffected —
 * their visits only close on an explicit checkout or the toggle-on-rescan
 * in performCheckIn().
 *
 * sessions.start_time/end_time are wall-clock hours as a gym admin would
 * type them ("05:00"), so the session's end instant for a given visit has to
 * be computed in the *gym's* timezone and converted back to UTC to compare
 * against/store alongside check_in and check_out, which are always UTC
 * (SQLite's `datetime('now')` default). The server's own timezone is only the
 * right answer for a single-gym install — on the platform it is whatever
 * region the machine happens to run in, which is why the modifiers below are
 * bound per request from the gym's own setting.
 *
 * Lazy, like expireOverdueSubscriptions() above: there is no scheduler (the
 * Fly.io deployment suspends the machine when idle, so an in-process timer
 * would not reliably fire at the session's end time anyway), so this runs
 * before any read/write that reports on attendance instead.
 */
export function autoCloseFinishedVisits() {
  const [toLocal, toUtc] = localtimeModifiers();
  return run(
    `
    UPDATE attendance
    SET check_out = datetime(date(attendance.check_in, ?) || ' ' || sessions.end_time, ?)
    FROM members, sessions
    WHERE attendance.member_id = members.id
      AND members.session_id = sessions.id
      AND attendance.check_out IS NULL
      AND datetime('now') >= datetime(date(attendance.check_in, ?) || ' ' || sessions.end_time, ?)
  `,
    [toLocal, toUtc, toLocal, toUtc],
  ).changes;
}
