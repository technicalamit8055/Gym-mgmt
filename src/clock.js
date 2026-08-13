import { getTenantTimezone } from './db.js';

/**
 * Every instant this app stores — `created_at`, `check_in`, `check_out` — is
 * UTC, because that is what SQLite's `datetime('now')` produces and an instant
 * has no timezone to lose. Every *calendar date* it stores — `joined_on`,
 * `paid_on`, `start_date`, `end_date`, `frozen_on` — is the gym's own local
 * date, because "the day Rahul paid" is a wall-clock fact about the gym, not
 * about UTC.
 *
 * This module is the only place that knows how to cross between the two. Using
 * SQLite's bare `date('now')` anywhere else silently means "today in UTC",
 * which for a gym in IST (UTC+5:30) is still yesterday until 05:30 — exactly
 * when the morning batch arrives.
 */

/**
 * Minutes that `timeZone` is ahead of UTC at instant `at`.
 *
 * Formatting an instant into the target zone and reading it back as if it were
 * UTC is the standard no-dependency way to get this: the gap between the two
 * *is* the offset. Going through Intl rather than a stored number is what
 * makes DST handle itself — a gym in a DST zone gets a different answer in
 * summer than in winter.
 */
function zoneOffsetMinutes(timeZone, at) {
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
 * How far ahead of UTC the current gym is, in minutes.
 *
 * Falls back to the *server's* own zone when the gym has set no timezone,
 * which is the only sensible answer for a single-gym or dev install and
 * matches what SQLite's `'localtime'` modifier would have done.
 */
export function gymOffsetMinutes() {
  const timeZone = getTenantTimezone();
  const now = new Date();
  if (!timeZone) return -now.getTimezoneOffset();

  const bucket = `${timeZone}|${Math.floor(now.getTime() / 3_600_000)}`;
  let minutes = offsetCache.get(bucket);
  if (minutes === undefined) {
    try {
      minutes = zoneOffsetMinutes(timeZone, now);
    } catch {
      return -now.getTimezoneOffset(); // unrecognised zone name — don't break the request over it
    }
    offsetCache.clear(); // single-entry cache; the bucket key already carries the hour
    offsetCache.set(bucket, minutes);
  }
  return minutes;
}

/** `±N minutes` rather than `±HH:MM`, because the former works on every SQLite version. */
const modifier = (minutes) => `${minutes >= 0 ? '+' : ''}${Math.round(minutes)} minutes`;

/**
 * The pair of SQLite datetime modifiers that convert a stored UTC instant to
 * the gym's wall-clock time and back again.
 */
export function localtimeModifiers() {
  const minutes = gymOffsetMinutes();
  return [modifier(minutes), modifier(-minutes)];
}

/**
 * SQL expression for the gym-local calendar date of a stored-UTC column, for
 * the cases where a query has to group or filter by "which day was this".
 *
 * The offset is this process's own integer, never request input, so
 * interpolating it is safe. It is also *today's* offset applied to historical
 * rows: exact for a zone without DST (India, most of Asia), and off by an hour
 * for rows either side of a DST boundary elsewhere — the same tradeoff
 * autoCloseFinishedVisits() has always made, and the best SQLite can do
 * without a timezone database.
 */
export function gymDateOf(column) {
  return `date(${column}, '${modifier(gymOffsetMinutes())}')`;
}

/** As gymDateOf, but keeping the time — for gym-local hour/weekday buckets. */
export function gymDatetimeOf(column) {
  return `datetime(${column}, '${modifier(gymOffsetMinutes())}')`;
}

/** Now, shifted into the gym's wall clock so the UTC getters read it out. */
const gymNow = () => new Date(Date.now() + gymOffsetMinutes() * 60_000);

/** `YYYY-MM-DD` — today, where the gym is. */
export function gymToday() {
  return gymNow().toISOString().slice(0, 10);
}

/** `MM-DD` — today's month and day, where the gym is. */
export function gymMonthDay() {
  return gymNow().toISOString().slice(5, 10);
}

/** `HH:MM` — the current time of day, where the gym is. Comparable directly
 * against sessions.start_time/end_time, which are typed in the same shape —
 * see performCheckIn()'s shift resolution in checkin.js. */
export function gymNowTime() {
  return gymNow().toISOString().slice(11, 16);
}

/**
 * A UTC instant, `offsetMs` from now, in the exact `YYYY-MM-DD HH:MM:SS` shape
 * SQLite's `datetime('now')` writes — so it compares directly against a stored
 * `check_in`/`check_out` with no conversion either side.
 *
 * Deriving these here rather than letting SQLite say `datetime('now')` inline
 * keeps a single source of truth for the current instant, which is also what
 * makes time-dependent behaviour testable without a live clock.
 */
export function utcTimestamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}
