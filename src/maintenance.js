import { localtimeModifiers } from './clock.js';
import { config } from './config.js';
import { run, get, all } from './db.js';
import { today, addDays } from './validate.js';
import { getWhatsAppStatus, reminderMessage, sendWhatsAppMessage } from './whatsapp.js';

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

/**
 * Sends a renewal reminder to every member of *the current gym* whose
 * membership lapses today or in `reminder_days_before` days.
 *
 * Must be called inside a tenantStorage context — every read and every
 * delivery-log write below lands in whichever database that context names, so
 * calling it bare would sweep the fallback dev database and nothing else. The
 * scheduler in server.js is what walks the tenants.
 *
 * Reminders already sent today are excluded by joining against whatsapp_logs
 * rather than by a "reminded_at" column, so the sweep is safe to run hourly:
 * a member gets at most one reminder a day no matter how often it fires.
 *
 * @param {object} [opts]
 * @param {string} [opts.gymName] Name to render into {{gym_name}}.
 * @returns {number} How many reminders were queued.
 */
export function sendAutomatedRenewalReminders({ gymName = config.gymName } = {}) {
  try {
    const settings = get('SELECT auto_reminder, reminder_days_before, reminder_template FROM whatsapp_settings WHERE id = 1');
    if (!settings?.auto_reminder || !getWhatsAppStatus().connected) return 0;

    const now = today();
    const target = addDays(now, settings.reminder_days_before ?? 3);

    const expiring = all(
      `SELECT s.id, s.member_id, s.end_date, m.first_name, m.last_name, m.phone, p.name AS plan_name
       FROM subscriptions s
       JOIN members m ON m.id = s.member_id
       JOIN plans p ON p.id = s.plan_id
       WHERE s.status = 'active'
         AND s.end_date IN (?, ?)
         AND m.phone IS NOT NULL AND TRIM(m.phone) != ''
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_logs l
           WHERE l.member_id = s.member_id
             AND l.type = 'reminder'
             AND l.status = 'sent'
             AND date(l.sent_at) = ?
         )`,
      [target, now, now],
    );

    for (const sub of expiring) {
      // Queued, not awaited: sendWhatsAppMessage paces sends internally and
      // logs both outcomes, so there is nothing useful to block on here.
      sendWhatsAppMessage({
        phone: sub.phone,
        message: reminderMessage(sub, { gymName, template: settings.reminder_template }),
        type: 'reminder',
        memberId: sub.member_id,
      }).catch((err) => console.error('[whatsapp] reminder failed:', err.message));
    }

    return expiring.length;
  } catch (err) {
    console.error('[whatsapp] renewal-reminder sweep failed:', err.message);
    return 0;
  }
}

