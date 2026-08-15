import { gymMonthDay, localtimeModifiers } from './clock.js';
import { config } from './config.js';
import { run, get, all } from './db.js';
import { today, addDays } from './validate.js';
import { moduleEnabled } from './verticals.js';
import { birthdayMessage, getWhatsAppStatus, reminderMessage, sendWhatsAppMessage } from './whatsapp.js';

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
 * Closes any open visit whose shift has ended for the day the visit started.
 * Gym-only: a gym batch is a work shift with a real end time a member is
 * expected to leave by, so auto-closing at that instant is the right default.
 * A library seat, by contrast, is time the student paid for and is free to
 * leave early or stay put in — SeatBook never auto-checks anyone out, on
 * purpose, so a student's sitting only ends when they scan out themselves
 * (see performCheckIn()'s rescan-to-checkout toggle in checkin.js).
 *
 * Which shift applies is `attendance.session_id` if the check-in recorded one,
 * falling back to the member's own assigned `session_id` (the plain gym-batch
 * case this always supported). Visits with neither are unaffected — they only
 * close on an explicit checkout or the toggle-on-rescan in performCheckIn().
 *
 * sessions.start_time/end_time are wall-clock hours as typed ("05:00"), so
 * the shift's end instant for a given visit has to be computed in the *gym's*
 * timezone and converted back to UTC to compare against/store alongside
 * check_in and check_out, which are always UTC (SQLite's `datetime('now')`
 * default). The server's own timezone is only the right answer for a
 * single-gym install — on the platform it is whatever region the machine
 * happens to run in, which is why the modifiers below are bound per request
 * from the gym's own setting.
 *
 * A shift flagged `overnight` (22:00-06:00) ends the *next* calendar day
 * relative to the visit's start — without the extra day, "06:00 of the
 * check-in's own day" is a time already in the past, and every night-shift
 * visit would auto-close the instant it opened.
 *
 * Lazy, like expireOverdueSubscriptions() above: there is no scheduler (the
 * Fly.io deployment suspends the machine when idle, so an in-process timer
 * would not reliably fire at the session's end time anyway), so this runs
 * before any read/write that reports on attendance instead.
 */
export function autoCloseFinishedVisits() {
  if (moduleEnabled('seats')) return 0;

  const [toLocal, toUtc] = localtimeModifiers();
  const shiftEndAt =
    "datetime(date(attendance.check_in, ?) || ' ' || sessions.end_time, CASE WHEN sessions.overnight = 1 THEN '+1 day' ELSE '+0 days' END, ?)";
  return run(
    `
    UPDATE attendance
    SET check_out = ${shiftEndAt}
    FROM members, sessions
    WHERE sessions.id = COALESCE(attendance.session_id, members.session_id)
      AND attendance.check_out IS NULL
      AND datetime('now') >= ${shiftEndAt}
  `,
    [toLocal, toUtc, toLocal, toUtc],
  ).changes;
}

/**
 * Releases a seat whose paid-for time has lapsed, once the hold grace period
 * (library_settings.seat_hold_days) has also passed — before that, the seat
 * stays reserved in case the student comes back to renew. A frozen
 * subscription's seat is excluded unconditionally: a paused pass must never
 * lose its desk, no matter how long its stored end_date has already been in
 * the past — see the lifecycle test this guards.
 *
 * Separate from expireOverdueSubscriptions(): that one runs on every
 * members-list read for gym tenants too, and this one only matters — and is
 * only ever called — for a seats-enabled tenant.
 */
export function releaseLapsedSeatAllocations() {
  const holdDays = get('SELECT seat_hold_days FROM library_settings WHERE id = 1')?.seat_hold_days ?? 0;
  const cutoff = addDays(today(), -holdDays);
  return run(
    `UPDATE seat_allocations SET status = 'released', released_on = ?, released_reason = 'lapsed'
      WHERE status = 'active' AND end_date < ?
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s WHERE s.id = seat_allocations.subscription_id AND s.status = 'frozen'
        )`,
    [today(), cutoff],
  ).changes;
}

/** As releaseLapsedSeatAllocations(), for lockers. Shares seat_hold_days
 * rather than a locker-specific setting — one "how long do we hold a spot"
 * knob for the whole hall, not two to keep in sync. */
export function releaseLapsedLockerAllocations() {
  const holdDays = get('SELECT seat_hold_days FROM library_settings WHERE id = 1')?.seat_hold_days ?? 0;
  const cutoff = addDays(today(), -holdDays);
  return run(
    `UPDATE locker_allocations SET status = 'released', released_on = ?, released_reason = 'lapsed'
      WHERE status = 'active' AND end_date < ?
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s WHERE s.id = locker_allocations.subscription_id AND s.status = 'frozen'
        )`,
    [today(), cutoff],
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

/**
 * Sends a birthday wish to every member of *the current gym* whose birthday
 * (month and day, ignoring birth year) is today, in the gym's own timezone.
 *
 * Must be called inside a tenantStorage context, same as
 * sendAutomatedRenewalReminders() above — the scheduler in server.js is what
 * walks the tenants.
 *
 * Wishes already sent today are excluded by joining against whatsapp_logs
 * rather than by a "last_wished_on" column, so the sweep is safe to run
 * hourly: a member gets at most one wish a day no matter how often it fires.
 *
 * @param {object} [opts]
 * @param {string} [opts.gymName] Name to render into {{gym_name}}.
 * @returns {number} How many wishes were queued.
 */
export function sendAutomatedBirthdayWishes({ gymName = config.gymName } = {}) {
  try {
    const settings = get('SELECT auto_birthday, birthday_template FROM whatsapp_settings WHERE id = 1');
    if (!settings?.auto_birthday || !getWhatsAppStatus().connected) return 0;

    const now = today();
    const monthDay = gymMonthDay();

    const celebrating = all(
      `SELECT id, first_name, last_name, phone
       FROM members
       WHERE date_of_birth IS NOT NULL
         AND strftime('%m-%d', date_of_birth) = ?
         AND phone IS NOT NULL AND TRIM(phone) != ''
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_logs l
           WHERE l.member_id = members.id
             AND l.type = 'birthday'
             AND l.status = 'sent'
             AND date(l.sent_at) = ?
         )`,
      [monthDay, now],
    );

    for (const member of celebrating) {
      // Queued, not awaited: sendWhatsAppMessage paces sends internally and
      // logs both outcomes, so there is nothing useful to block on here.
      sendWhatsAppMessage({
        phone: member.phone,
        message: birthdayMessage(member, { gymName, template: settings.birthday_template }),
        type: 'birthday',
        memberId: member.id,
      }).catch((err) => console.error('[whatsapp] birthday wish failed:', err.message));
    }

    return celebrating.length;
  } catch (err) {
    console.error('[whatsapp] birthday-wish sweep failed:', err.message);
    return 0;
  }
}

