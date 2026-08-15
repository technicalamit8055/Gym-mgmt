import { gymDatetimeOf, gymNowTime, utcTimestamp } from './clock.js';
import { badRequest } from './errors.js';
import { autoCloseFinishedVisits, expireOverdueSubscriptions } from './maintenance.js';
import { all, get, run, tx } from './db.js';
import { PHOTO_JOIN, PHOTO_PRESENT_COL, withPhotoUrl } from './photo.js';
import { today } from './validate.js';
import { moduleEnabled } from './verticals.js';

/**
 * How far back a rescan looks for a still-open visit to close.
 *
 * This used to be "same calendar day", which was wrong at both ends of the
 * day. `check_in` is stored in UTC, so for a gym in IST the calendar day
 * rolled over at 05:30 local: a member who checked in at 05:00 and rescanned
 * at 06:00 fell either side of the boundary, so the rescan was not recognised
 * as a checkout — it opened a *second* visit and, on a session-limited plan,
 * burned a second session. The same thing happened to anyone whose visit
 * crossed local midnight, in any timezone.
 *
 * A window is the right shape for the question regardless: "is this person
 * still inside from a visit they never closed" has nothing to do with which
 * date it is. 18 hours is longer than any plausible visit, and short enough
 * that the next day's first scan is always a fresh check-in rather than a
 * checkout of yesterday's abandoned visit.
 */
export const RESCAN_WINDOW_HOURS = 18;

/** The still-open visit a rescan should close, if there is one. Shared with
 * the QR desk, which shows "already inside" before offering the same toggle. */
export function openVisitFor(memberId) {
  return get(
    `SELECT * FROM attendance
     WHERE member_id = ? AND check_out IS NULL AND check_in > ?
     ORDER BY check_in DESC LIMIT 1`,
    [memberId, utcTimestamp(-RESCAN_WINDOW_HOURS * 3_600_000)],
  );
}

// a.check_in/a.check_out are stored UTC; every client-facing row renders them
// in the gym's own wall clock so the kiosk and attendance list show the time
// the member actually walked in, not a UTC-offset one. a.* comes first so
// these two overwrite its raw copies rather than adding a duplicate column.
export const ATTENDANCE_SELECT = `
  SELECT a.*, ${gymDatetimeOf('a.check_in')} AS check_in, ${gymDatetimeOf('a.check_out')} AS check_out,
         m.code AS member_code, m.first_name, m.last_name, m.photo_version,
         ${PHOTO_PRESENT_COL}
  FROM attendance a
  JOIN members m ON m.id = a.member_id
  ${PHOTO_JOIN}
`;

/** An attendance row as the front end wants it: photo_version swapped for the
 * URL that serves it. Rows here are keyed on member_id, not id (which is the
 * visit's own). */
export const publicVisit = (row) => withPhotoUrl(row, 'member_id');

/**
 * Which of a member's active passes applies right now.
 *
 * A gym member has at most one active subscription (the overlap guard in
 * subscriptions.js sees to that), so this only has real work to do for a
 * library student who can hold Morning *and* Evening passes at once — the
 * full-day upsell. Picks whichever shift's window contains the current
 * gym-local time; falls back to the most recently ending pass if none does
 * (an early or late arrival still gets checked in against *a* pass rather
 * than being turned away).
 */
function resolveShiftSubscription(memberId) {
  const subs = all(
    `SELECT s.*, sess.name AS session_name, sess.start_time, sess.end_time, sess.overnight
     FROM subscriptions s
     LEFT JOIN sessions sess ON sess.id = s.session_id
     WHERE s.member_id = ? AND s.status = 'active' AND ? BETWEEN s.start_date AND s.end_date
     ORDER BY s.end_date DESC`,
    [memberId, today()],
  );
  if (subs.length <= 1) return subs[0] ?? null;

  const nowTime = gymNowTime();
  const within = subs.find((s) => isWithinShift(s, nowTime));
  return within ?? subs[0];
}

/** True when `nowTime` (`HH:MM`, gym-local) falls inside a shift's window,
 * wrapping past midnight for an overnight shift like Night (22:00-06:00). */
function isWithinShift(session, nowTime) {
  if (!session.start_time || !session.end_time) return true; // no shift attached — nothing to enforce
  return session.overnight
    ? nowTime >= session.start_time || nowTime <= session.end_time
    : nowTime >= session.start_time && nowTime <= session.end_time;
}

/** Whether check-ins outside a member's shift window should be turned away.
 * Off by default so existing tenants see no behaviour change until they opt in. */
function shiftWindowEnforced() {
  return Boolean(get('SELECT enforce_shift_window FROM library_settings WHERE id = 1')?.enforce_shift_window);
}

/**
 * Shared by front-desk check-in, QR scan, WebAuthn check-in, and physical
 * device check-in — the four ways a member can be marked present all funnel
 * through the same rules.
 *
 * A rescan/re-tap while already checked in toggles them out instead of
 * creating a duplicate visit or a no-op "already in" response — this is the
 * only way a QR card or fingerprint punch (which carry no separate "leaving"
 * signal of their own) can ever mark someone as checked out. Checking out is
 * never blocked by membership status: a lapsed or frozen member can still
 * leave cleanly. Fresh check-ins are still gated on status/active
 * membership/session cap as before.
 */
export function performCheckIn(member, source) {
  autoCloseFinishedVisits();

  const openVisit = openVisitFor(member.id);
  if (openVisit) {
    run("UPDATE attendance SET check_out = datetime('now') WHERE id = ?", [openVisit.id]);
    return {
      action: 'checked_out',
      visit: publicVisit(get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [openVisit.id])),
    };
  }

  if (member.status === 'frozen') throw badRequest(`${member.first_name}'s membership is frozen`);
  if (member.status === 'inactive') throw badRequest(`${member.first_name}'s membership is inactive`);

  expireOverdueSubscriptions();
  const seatsOn = moduleEnabled('seats');
  // start_date/end_date are gym-local calendar dates, so the day they are
  // checked against has to be the gym's, not UTC's. A gym member has at most
  // one active subscription, so the plain query is exact for it; a library
  // student can hold more than one shift at once, which is what
  // resolveShiftSubscription() picks between. The plain path joins in the
  // member's own assigned batch (members.session_id) rather than a
  // subscription-level shift, since a gym subscription has none of its own.
  const sub = seatsOn
    ? resolveShiftSubscription(member.id)
    : get(
        `SELECT s.*, sess.name AS session_name, sess.start_time, sess.end_time, sess.overnight
         FROM subscriptions s
         JOIN members m ON m.id = s.member_id
         LEFT JOIN sessions sess ON sess.id = m.session_id
         WHERE s.member_id = ? AND s.status = 'active' AND ? BETWEEN s.start_date AND s.end_date
         ORDER BY s.end_date DESC LIMIT 1`,
        [member.id, today()],
      );
  if (!sub) throw badRequest(`${member.first_name} has no active membership — renew before checking in`);
  if (sub.sessions_total !== null && sub.sessions_used >= sub.sessions_total) {
    throw badRequest(`${member.first_name} has used all ${sub.sessions_total} sessions on this plan`);
  }
  if (sub.start_time && sub.end_time && shiftWindowEnforced() && !isWithinShift(sub, gymNowTime())) {
    throw badRequest(
      `${member.first_name}'s shift (${sub.session_name ?? 'assigned shift'}, ${sub.start_time}-${sub.end_time}) is not active right now`,
    );
  }

  // The seat this check-in belongs to, if the resolved pass has one —
  // recorded on the visit so autoCloseFinishedVisits() closes it against the
  // shift actually attended, not just the member's default assigned session.
  const seat =
    seatsOn && sub.session_id
      ? get(
          `SELECT sa.seat_id, se.code AS seat_code FROM seat_allocations sa
           JOIN seats se ON se.id = sa.seat_id
           WHERE sa.member_id = ? AND sa.session_id = ? AND sa.status = 'active'`,
          [member.id, sub.session_id],
        )
      : null;

  const visitId = tx(() => {
    const info = run('INSERT INTO attendance (member_id, source, seat_id, session_id) VALUES (?, ?, ?, ?)', [
      member.id,
      source,
      seat?.seat_id ?? null,
      seatsOn ? (sub.session_id ?? null) : null,
    ]);
    if (sub.sessions_total !== null) {
      run('UPDATE subscriptions SET sessions_used = sessions_used + 1 WHERE id = ?', [sub.id]);
    }
    return info.lastInsertRowid;
  });

  return {
    action: 'checked_in',
    visit: publicVisit(get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [visitId])),
    membership: {
      plan_id: sub.plan_id,
      end_date: sub.end_date,
      sessions_total: sub.sessions_total,
      sessions_left: sub.sessions_total === null ? null : sub.sessions_total - (sub.sessions_used + 1),
      session_id: sub.session_id ?? null,
      session_name: sub.session_name ?? null,
      seat_code: seat?.seat_code ?? null,
    },
  };
}
