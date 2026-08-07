import { utcTimestamp } from './clock.js';
import { badRequest } from './errors.js';
import { autoCloseFinishedVisits, expireOverdueSubscriptions } from './maintenance.js';
import { get, run, tx } from './db.js';
import { PHOTO_JOIN, PHOTO_PRESENT_COL, withPhotoUrl } from './photo.js';
import { today } from './validate.js';

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

export const ATTENDANCE_SELECT = `
  SELECT a.*, m.code AS member_code, m.first_name, m.last_name, m.photo_version,
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
  // start_date/end_date are gym-local calendar dates, so the day they are
  // checked against has to be the gym's, not UTC's.
  const sub = get(
    "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' AND ? BETWEEN start_date AND end_date ORDER BY end_date DESC LIMIT 1",
    [member.id, today()],
  );
  if (!sub) throw badRequest(`${member.first_name} has no active membership — renew before checking in`);
  if (sub.sessions_total !== null && sub.sessions_used >= sub.sessions_total) {
    throw badRequest(`${member.first_name} has used all ${sub.sessions_total} sessions on this plan`);
  }

  const visitId = tx(() => {
    const info = run('INSERT INTO attendance (member_id, source) VALUES (?, ?)', [member.id, source]);
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
    },
  };
}
