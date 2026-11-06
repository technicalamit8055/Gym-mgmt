import { get, run, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { expireOverdueSubscriptions } from './maintenance.js';
import { allocateOrExtend } from './seats.js';
import { addDays, today } from './validate.js';
import { moduleEnabled } from './verticals.js';

/**
 * Selling a membership (a gym membership or a study-hall pass): the one place
 * that decides its dates, guards against overlaps, seats a SeatBook student
 * and records the payment that came with it.
 *
 * The desk's "Sell membership" (routes/subscriptions.js) and a member's own
 * online payment, once the desk confirms it (onlinePayments.js), both come
 * through here, so a sale behaves the same whichever way the money arrived.
 *
 * Returns { subscriptionId, paymentId } — paymentId is null when no payment
 * was taken. Sending the receipt is the caller's job: it needs the request's
 * gym name and logo, which this layer does not have.
 */
export function sellMembership({
  memberId,
  planId,
  startDate: requestedStart = null,
  discount = 0,
  note = null,
  sessionId: requestedSession = null,
  seatId = null,
  payment = null,
}) {
  const member = get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Member not found');
  const plan = get('SELECT * FROM plans WHERE id = ?', [planId]);
  if (!plan) throw notFound('Plan not found');
  if (!plan.active) throw badRequest('That plan is archived and cannot be sold');

  // The plan's own lock wins when there's a conflict; a bare mismatch (rather
  // than silently overriding one or the other) is what stops a seat sold
  // through the wrong shift's plan.
  if (plan.session_id != null && requestedSession != null && requestedSession !== plan.session_id) {
    throw badRequest('This plan is locked to a different shift', { session_id: "must match the plan's shift" });
  }
  const sessionId = requestedSession ?? plan.session_id ?? null;
  let session = null;
  if (sessionId != null) {
    session = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw notFound('Shift not found');
  }

  // The shift surcharge is folded into price up front — there is no separate
  // "surcharge" column, so every existing `price - discount` reader keeps
  // working unchanged.
  const total = membershipPrice(plan, session);
  if (discount > total) {
    throw badRequest('Discount cannot exceed the plan price', { discount: 'cannot exceed the plan price' });
  }

  expireOverdueSubscriptions();

  // `session_id IS ?`, not `= ?`: for a gym, session_id is NULL on both
  // sides, and `= NULL` is NULL — never true — which would silently let a
  // gym member stack two overlapping memberships. IS is SQLite's null-safe
  // comparison, so the same guard covers both products with one query.
  const current = get(
    "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' AND session_id IS ? ORDER BY end_date DESC LIMIT 1",
    [member.id, sessionId],
  );

  // Signup often leaves the shift undecided (session_id NULL) and a seat gets
  // assigned to that same membership minutes later once a shift is picked.
  // That is one membership, not two, so it must not sail past the check above
  // as a different "slot" — but two *different* real shifts (Morning then
  // Evening) are genuinely separate seats and must still both be allowed.
  // Hence this only fires when a shift is being set for the first time, never
  // shift-to-shift or shift-to-none.
  const noShiftYet =
    sessionId != null
      ? get(
          "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' AND session_id IS NULL ORDER BY end_date DESC LIMIT 1",
          [member.id],
        )
      : null;

  // A renewal picks up the day after the current one (in this shift) ends, so
  // members never lose days they already paid for.
  const startDate = requestedStart || (current && current.end_date >= today() ? addDays(current.end_date, 1) : today());
  if (current && startDate <= current.end_date) {
    throw conflict(
      sessionId
        ? `This student already has a pass for this shift until ${current.end_date}`
        : `This member already has an active membership until ${current.end_date}`,
    );
  }
  if (noShiftYet && startDate <= noShiftYet.end_date) {
    throw conflict(
      `This member already has an active membership until ${noShiftYet.end_date} — assign the seat to it instead of selling a new one`,
    );
  }

  const endDate = addDays(startDate, plan.duration_days - 1);
  const seatsOn = moduleEnabled('seats');

  return tx(() => {
    const info = run(
      `INSERT INTO subscriptions
         (member_id, plan_id, session_id, start_date, end_date, price, discount, sessions_total, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [member.id, plan.id, sessionId, startDate, endDate, total, discount, plan.sessions ?? null, 'active', note ?? null],
    );
    const subscriptionId = Number(info.lastInsertRowid);

    // Seated inside the same transaction a failed sale rolls back with it —
    // there is no window where a subscription exists with no matching seat
    // row, or a seat is held by a subscription that was never actually paid
    // for. Renewal-aware: keeps the student's existing desk if they already
    // have one in this shift, seats them fresh otherwise.
    if (seatsOn && sessionId) {
      allocateOrExtend({ seatId: seatId ?? null, sessionId, memberId: member.id, subscriptionId, startDate, endDate });
    }

    let paymentId = null;
    if (payment && payment.amount > 0) {
      const payInfo = run(
        'INSERT INTO payments (member_id, subscription_id, amount, method, paid_on, reference, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          member.id,
          subscriptionId,
          payment.amount,
          payment.method || 'cash',
          payment.paidOn || today(),
          payment.reference ?? null,
          payment.note ?? `Payment for ${plan.name}`,
        ],
      );
      paymentId = Number(payInfo.lastInsertRowid);
    }
    if (member.status !== 'active') {
      run("UPDATE members SET status = 'active', updated_at = datetime('now') WHERE id = ?", [member.id]);
    }
    return { subscriptionId, paymentId };
  });
}

/** What a plan costs in a shift: the plan price plus that shift's surcharge. */
export function membershipPrice(plan, session = null) {
  return plan.price + (session?.price ?? 0);
}
