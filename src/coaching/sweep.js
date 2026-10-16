import { all } from '../db.js';
import { addDays, today } from '../validate.js';
import { moduleEnabled } from '../verticals.js';
import { whatsappReady } from '../whatsapp.js';
import { INSTALLMENT_SELECT } from './fees.js';
import { coachingSettings, sendInstallmentReminder } from './notify.js';

/**
 * The hourly fee-reminder sweep (called from server.js inside each tenant's
 * context, beside the renewal reminders):
 *
 * - **Due soon** — an unpaid installment due in exactly
 *   `fee_reminder_days_before` days gets the "is due on" message, once.
 * - **Overdue** — one past its date gets the "still pending" message, and
 *   again every `overdue_reminder_days` until it is cleared, so a defaulter is
 *   followed up without a parent getting a message every hour.
 *
 * reminder_sent_at is the only state: it is stamped when a reminder is
 * queued (and put back if it fails — see notify.js), so re-running the sweep
 * is always safe.
 */
export function sendCoachingFeeReminders({ gymName, currency = 'INR' } = {}) {
  try {
    if (!moduleEnabled('installments')) return 0;
    const settings = coachingSettings();
    if (!settings.fee_reminders || !whatsappReady()) return 0;

    const now = today();
    const target = addDays(now, settings.fee_reminder_days_before ?? 3);
    const overdueEvery = Math.max(1, settings.overdue_reminder_days ?? 7);
    const due = all(
      `SELECT inst.*, fp.member_id, c.name AS course_name, m.first_name, m.last_name, m.phone, m.emergency_phone
       FROM (${INSTALLMENT_SELECT}) inst
       JOIN student_fee_plans fp ON fp.id = inst.plan_id
       JOIN academic_courses c ON c.id = fp.course_id
       JOIN members m ON m.id = fp.member_id
       WHERE fp.status = 'active' AND inst.balance > 0.005 AND m.status = 'active'
         AND (
           (inst.due_date = ? AND (inst.reminder_sent_at IS NULL OR date(inst.reminder_sent_at) < ?))
           OR (
             inst.due_date < ?
             AND (
               inst.reminder_sent_at IS NULL
               -- the "due soon" nudge doesn't count: the first overdue one
               -- goes the day after the due date, not a whole interval later
               OR date(inst.reminder_sent_at) <= inst.due_date
               OR date(inst.reminder_sent_at) <= date(?, ?)
             )
           )
         )`,
      [now, target, now, now, now, `-${overdueEvery} days`],
    );
    let queued = 0;
    for (const installment of due) {
      if (sendInstallmentReminder(installment, { instituteName: gymName, currency, now })) queued += 1;
    }
    return queued;
  } catch (err) {
    console.error('[coaching] fee-reminder sweep failed:', err.message);
    return 0;
  }
}
