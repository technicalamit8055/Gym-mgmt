import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { config } from '../config.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { allocateOrExtend, releaseSeat } from '../seats.js';
import { addDays, parse, today, toInt } from '../validate.js';
import { moduleEnabled } from '../verticals.js';
import { freezeMessage, getWhatsAppStatus, sendWhatsAppMessage } from '../whatsapp.js';

import { sendAutoReceiptIfEnabled } from './payments.js';

export const subscriptionRoutes = Router();
subscriptionRoutes.use(requireAuth);

const SUB_SELECT = `
  SELECT s.*, p.name AS plan_name, p.duration_days,
         m.code AS member_code, m.first_name, m.last_name,
         sess.name AS session_name,
         COALESCE(pay.total, 0) AS paid,
         (s.price - s.discount + s.addon_total) - COALESCE(pay.total, 0) AS due
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  JOIN members m ON m.id = s.member_id
  LEFT JOIN sessions sess ON sess.id = s.session_id
  LEFT JOIN (SELECT subscription_id, SUM(amount) AS total FROM payments GROUP BY subscription_id) pay
    ON pay.subscription_id = s.id
`;

subscriptionRoutes.get('/', (req, res) => {
  expireOverdueSubscriptions();
  const where = [];
  const params = [];

  if (req.query.member_id) {
    where.push('s.member_id = ?');
    params.push(Number(req.query.member_id));
  }
  if (req.query.status) {
    where.push('s.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.expiring_in) {
    where.push("s.status = 'active' AND s.end_date <= date('now', ?)");
    params.push(`+${toInt(req.query.expiring_in, 7)} day`);
  }
  if (req.query.due === 'true') {
    where.push('(s.price - s.discount + s.addon_total) - COALESCE(pay.total, 0) > 0');
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(toInt(req.query.limit, 50), 500);
  res.json({
    items: all(`${SUB_SELECT} ${clause} ORDER BY s.end_date DESC, s.id DESC LIMIT ?`, [...params, limit]),
  });
});

subscriptionRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int', required: true },
    plan_id: { type: 'int', required: true },
    start_date: { type: 'date' },
    discount: { type: 'number', min: 0, default: 0 },
    note: { type: 'string', max: 300 },
    payment_amount: { type: 'number', min: 0 },
    payment_method: { type: 'enum', values: ['cash', 'card', 'upi', 'bank', 'online'], default: 'cash' },
    reference: { type: 'string', max: 80 },
    // Below this line: meaningful only once a shift is in play (a library
    // pass). A gym sale never sends these, and both stay null throughout.
    session_id: { type: 'int', min: 1 },
    seat_id: { type: 'int', min: 1 },
  });

  const member = get('SELECT * FROM members WHERE id = ?', [body.member_id]);
  if (!member) throw notFound('Member not found');
  const plan = get('SELECT * FROM plans WHERE id = ?', [body.plan_id]);
  if (!plan) throw notFound('Plan not found');
  if (!plan.active) throw badRequest('That plan is archived and cannot be sold');

  // The plan's own lock wins when there's a conflict; a bare mismatch (rather
  // than silently overriding one or the other) is what stops a seat sold
  // through the wrong shift's plan.
  if (plan.session_id != null && body.session_id != null && body.session_id !== plan.session_id) {
    throw badRequest('This plan is locked to a different shift', { session_id: "must match the plan's shift" });
  }
  const sessionId = body.session_id ?? plan.session_id ?? null;
  let session = null;
  if (sessionId != null) {
    session = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) throw notFound('Shift not found');
  }

  // The shift surcharge is folded into price up front — there is no separate
  // "surcharge" column, so every existing `price - discount` reader keeps
  // working unchanged.
  const total = plan.price + (session?.price ?? 0);
  if (body.discount > total) {
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
  const startDate = body.start_date || (current && current.end_date >= today() ? addDays(current.end_date, 1) : today());
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

  let paymentId = null;
  const result = tx(() => {
    const info = run(
      `INSERT INTO subscriptions
         (member_id, plan_id, session_id, start_date, end_date, price, discount, sessions_total, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member.id,
        plan.id,
        sessionId,
        startDate,
        endDate,
        total,
        body.discount,
        plan.sessions ?? null,
        'active',
        body.note ?? null,
      ],
    );
    const subscriptionId = Number(info.lastInsertRowid);

    // Seated inside the same transaction a failed sale rolls back with it —
    // there is no window where a subscription exists with no matching seat
    // row, or a seat is held by a subscription that was never actually paid
    // for. Renewal-aware: keeps the student's existing desk if they already
    // have one in this shift, seats them fresh otherwise.
    if (seatsOn && sessionId) {
      allocateOrExtend({
        seatId: body.seat_id ?? null,
        sessionId,
        memberId: member.id,
        subscriptionId,
        startDate,
        endDate,
      });
    }

    if (body.payment_amount > 0) {
      const payInfo = run(
        'INSERT INTO payments (member_id, subscription_id, amount, method, paid_on, reference, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          member.id,
          subscriptionId,
          body.payment_amount,
          body.payment_method,
          today(),
          body.reference ?? null,
          `Payment for ${plan.name}`,
        ],
      );
      paymentId = Number(payInfo.lastInsertRowid);
    }
    if (member.status !== 'active') {
      run("UPDATE members SET status = 'active', updated_at = datetime('now') WHERE id = ?", [member.id]);
    }
    return subscriptionId;
  });

  if (paymentId) {
    sendAutoReceiptIfEnabled(paymentId, req).catch((err) =>
      console.error('[whatsapp] auto-receipt for membership failed:', err.message),
    );
  }

  res.status(201).json(get(`${SUB_SELECT} WHERE s.id = ?`, [result]));
});

subscriptionRoutes.post('/:id/freeze', requireRole(...MANAGES_BILLING), (req, res) => {
  const sub = loadSubscription(req.params.id);
  if (sub.status !== 'active') throw badRequest('Only an active membership can be frozen');
  run("UPDATE subscriptions SET status = 'frozen', frozen_on = ? WHERE id = ?", [today(), sub.id]);
  run("UPDATE members SET status = 'frozen', updated_at = datetime('now') WHERE id = ?", [sub.member_id]);

  const updated = get(`${SUB_SELECT} WHERE s.id = ?`, [sub.id]);
  sendAutoFreezeNoticeIfEnabled(updated, req).catch((err) =>
    console.error('[whatsapp] auto-freeze notice failed:', err.message),
  );
  res.json(updated);
});

/** Fire-and-forget WhatsApp notice for a freshly frozen membership — mirrors
 * sendAutoReceiptIfEnabled so the member hears it from the gym, not just
 * finds out at the door next time their card doesn't work. */
async function sendAutoFreezeNoticeIfEnabled(sub, req) {
  try {
    const member = get('SELECT phone FROM members WHERE id = ?', [sub.member_id]);
    if (!member?.phone) return;

    const settings = get('SELECT auto_freeze, freeze_template FROM whatsapp_settings WHERE id = 1');
    if (settings?.auto_freeze && getWhatsAppStatus().connected) {
      const gymName = req?.tenant?.gym_name || config.gymName || 'GymBook';
      await sendWhatsAppMessage({
        phone: member.phone,
        message: freezeMessage(sub, { gymName, template: settings.freeze_template }),
        type: 'freeze',
        memberId: sub.member_id,
      });
    }
  } catch (err) {
    console.error('[whatsapp] could not send freeze notice:', err.message);
  }
}

subscriptionRoutes.post('/:id/resume', requireRole(...MANAGES_BILLING), (req, res) => {
  const sub = loadSubscription(req.params.id);
  if (sub.status !== 'frozen') throw badRequest('Only a frozen membership can be resumed');

  // Give back the days the membership sat frozen.
  const frozenDays = sub.frozen_on
    ? Math.max(
        Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${sub.frozen_on}T00:00:00Z`)) / 86_400_000),
        0,
      )
    : 0;

  const newEndDate = addDays(sub.end_date, frozenDays);

  // One transaction: a resume that credited the subscription's end_date but
  // failed to move the seat with it would leave the seat map showing a desk
  // as free that the student just paid to keep.
  tx(() => {
    run("UPDATE subscriptions SET status = 'active', frozen_on = NULL, end_date = ? WHERE id = ?", [newEndDate, sub.id]);
    run("UPDATE members SET status = 'active', updated_at = datetime('now') WHERE id = ?", [sub.member_id]);
    if (moduleEnabled('seats')) {
      run("UPDATE seat_allocations SET end_date = ? WHERE subscription_id = ? AND status = 'active'", [
        newEndDate,
        sub.id,
      ]);
    }
    if (moduleEnabled('lockers')) {
      run("UPDATE locker_allocations SET end_date = ? WHERE subscription_id = ? AND status = 'active'", [
        newEndDate,
        sub.id,
      ]);
    }
  });

  res.json({ ...get(`${SUB_SELECT} WHERE s.id = ?`, [sub.id]), days_credited: frozenDays });
});

subscriptionRoutes.post('/:id/cancel', requireRole(...MANAGES_BILLING), (req, res) => {
  const sub = loadSubscription(req.params.id);
  if (sub.status === 'cancelled') throw badRequest('This membership is already cancelled');
  tx(() => {
    run("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?", [sub.id]);
    if (moduleEnabled('seats')) {
      const allocation = get("SELECT id FROM seat_allocations WHERE subscription_id = ? AND status = 'active'", [sub.id]);
      if (allocation) releaseSeat(allocation.id, { reason: 'cancelled' });
    }
    if (moduleEnabled('lockers')) {
      run(
        "UPDATE locker_allocations SET status = 'released', released_on = ?, released_reason = 'cancelled' WHERE subscription_id = ? AND status = 'active'",
        [today(), sub.id],
      );
    }
  });
  res.json(get(`${SUB_SELECT} WHERE s.id = ?`, [sub.id]));
});

function loadSubscription(rawId) {
  const sub = get('SELECT * FROM subscriptions WHERE id = ?', [Number(rawId)]);
  if (!sub) throw notFound('Membership not found');
  return sub;
}
