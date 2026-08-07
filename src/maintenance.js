import { localtimeModifiers } from './clock.js';
import { run } from './db.js';
import { today } from './validate.js';

/**
 * Flips memberships whose end date has passed to "expired". Cheap enough to run
 * before any read that reports on membership state, which keeps the numbers
 * honest without a background scheduler.
 *
 * `end_date` is a gym-local calendar date, so the comparison has to be against
 * the gym's today: under UTC an IST gym would have expired every membership
 * five and a half hours early.
 */
export function expireOverdueSubscriptions() {
  return run("UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND end_date < ?", [
    today(),
  ]).changes;
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
