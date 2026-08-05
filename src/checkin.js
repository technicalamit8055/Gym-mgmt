import { badRequest } from './errors.js';
import { expireOverdueSubscriptions } from './maintenance.js';
import { get, run, tx } from './db.js';

export const ATTENDANCE_SELECT = `
  SELECT a.*, m.code AS member_code, m.first_name, m.last_name, m.photo_url
  FROM attendance a JOIN members m ON m.id = a.member_id
`;

/**
 * Shared by front-desk check-in, WebAuthn check-in, and physical device
 * check-in — the three ways a member can be marked present all funnel
 * through the same rules (status, active membership, session limits,
 * same-day idempotency).
 */
export function performCheckIn(member, source) {
  if (member.status === 'frozen') throw badRequest(`${member.first_name}'s membership is frozen`);
  if (member.status === 'inactive') throw badRequest(`${member.first_name}'s membership is inactive`);

  expireOverdueSubscriptions();
  const sub = get(
    "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' AND date('now') BETWEEN start_date AND end_date ORDER BY end_date DESC LIMIT 1",
    [member.id],
  );
  if (!sub) throw badRequest(`${member.first_name} has no active membership — renew before checking in`);
  if (sub.sessions_total !== null && sub.sessions_used >= sub.sessions_total) {
    throw badRequest(`${member.first_name} has used all ${sub.sessions_total} sessions on this plan`);
  }

  const openVisit = get(
    "SELECT * FROM attendance WHERE member_id = ? AND check_out IS NULL AND date(check_in) = date('now')",
    [member.id],
  );
  if (openVisit) {
    return {
      already_in: true,
      visit: get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [openVisit.id]),
    };
  }

  const visitId = tx(() => {
    const info = run('INSERT INTO attendance (member_id, source) VALUES (?, ?)', [member.id, source]);
    if (sub.sessions_total !== null) {
      run('UPDATE subscriptions SET sessions_used = sessions_used + 1 WHERE id = ?', [sub.id]);
    }
    return info.lastInsertRowid;
  });

  return {
    already_in: false,
    visit: get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [visitId]),
    membership: {
      plan_id: sub.plan_id,
      end_date: sub.end_date,
      sessions_total: sub.sessions_total,
      sessions_left: sub.sessions_total === null ? null : sub.sessions_total - (sub.sessions_used + 1),
    },
  };
}
