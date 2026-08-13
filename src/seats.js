import { addDays, today } from './validate.js';
import { all, get, run } from './db.js';
import { conflict, notFound } from './errors.js';
import { releaseLapsedSeatAllocations } from './maintenance.js';

/**
 * Seat allocation lifecycle: the one thing in SeatBook that is genuinely new
 * (everything else in the plan maps 1:1 onto members/plans/subscriptions).
 *
 * Every function here is plain — bare get()/all()/run(), never tx() — because
 * allocateOrExtend() is called from inside subscriptions.js's own tx() when a
 * pass is sold, and src/db.js's tx() issues a bare BEGIN that cannot nest.
 *
 * The core guarantee is not "checked", it is structural: a partial unique
 * index (idx_seat_alloc_live, on (seat_id, session_id) WHERE status='active')
 * makes double-booking impossible at the database level. The pre-check SELECT
 * in each function below exists only to turn a raw SQLITE_CONSTRAINT into a
 * message that names who is holding the seat — see seatConflictMessage().
 */

const SQLITE_CONSTRAINT_UNIQUE = 2067;

function seatConflictMessage(holder) {
  const name = `${holder.first_name} ${holder.last_name}`.trim();
  return `Seat ${holder.seat_code} is held by ${name} (${holder.member_code}) in the ${holder.shift_name} shift until ${holder.end_date}`;
}

/** The active allocation for one (seat, shift) cell, with enough joined
 * detail to build a friendly conflict message — or null if it is vacant. */
export function seatHolder(seatId, sessionId) {
  return get(
    `SELECT sa.*, se.code AS seat_code, sess.name AS shift_name,
            m.first_name, m.last_name, m.code AS member_code
     FROM seat_allocations sa
     JOIN seats se ON se.id = sa.seat_id
     JOIN sessions sess ON sess.id = sa.session_id
     JOIN members m ON m.id = sa.member_id
     WHERE sa.seat_id = ? AND sa.session_id = ? AND sa.status = 'active'`,
    [seatId, sessionId],
  );
}

/** A fresh allocation. Throws conflict() naming the current holder if the
 * seat is taken for this shift, or if this member already holds a different
 * seat in the same shift (one desk per student per shift). */
export function allocateSeat({ seatId, sessionId, memberId, subscriptionId = null, startDate, endDate, note = null }) {
  // A seat past its hold window belongs to no one yet — release it first so
  // this allocate doesn't 409 against a holder who should already be gone.
  releaseLapsedSeatAllocations();

  const seat = get('SELECT * FROM seats WHERE id = ?', [seatId]);
  if (!seat) throw notFound('Seat not found');
  if (seat.status !== 'available') throw conflict('That seat is not available');
  if (!get('SELECT id FROM sessions WHERE id = ?', [sessionId])) throw notFound('Shift not found');

  const holder = seatHolder(seatId, sessionId);
  if (holder) throw conflict(seatConflictMessage(holder));

  const memberHeld = get(
    `SELECT se.code AS seat_code FROM seat_allocations sa JOIN seats se ON se.id = sa.seat_id
     WHERE sa.member_id = ? AND sa.session_id = ? AND sa.status = 'active'`,
    [memberId, sessionId],
  );
  if (memberHeld) throw conflict(`This student already holds seat ${memberHeld.seat_code} in this shift`);

  try {
    const info = run(
      `INSERT INTO seat_allocations (seat_id, session_id, member_id, subscription_id, start_date, end_date, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [seatId, sessionId, memberId, subscriptionId, startDate, endDate, note],
    );
    return get('SELECT * FROM seat_allocations WHERE id = ?', [info.lastInsertRowid]);
  } catch (err) {
    if (err.errcode !== SQLITE_CONSTRAINT_UNIQUE) throw err;
    const again = seatHolder(seatId, sessionId);
    throw again ? conflict(seatConflictMessage(again)) : conflict('That seat was just taken for this shift');
  }
}

/** Bumps an existing allocation's end_date and/or repoints it at a new
 * subscription — used by renewal and by resume's end_date credit. Never
 * touches seat_id: that is transferSeat()'s job. */
export function extendSeatAllocation(allocationId, { endDate, subscriptionId } = {}) {
  const existing = get('SELECT * FROM seat_allocations WHERE id = ?', [allocationId]);
  if (!existing) throw notFound('Seat allocation not found');

  const fields = [];
  const params = [];
  if (endDate !== undefined) {
    fields.push('end_date = ?');
    params.push(endDate);
  }
  if (subscriptionId !== undefined) {
    fields.push('subscription_id = ?');
    params.push(subscriptionId);
  }
  if (!fields.length) return existing;

  run(`UPDATE seat_allocations SET ${fields.join(', ')} WHERE id = ?`, [...params, allocationId]);
  return get('SELECT * FROM seat_allocations WHERE id = ?', [allocationId]);
}

/**
 * What a sale actually wants: keep the student's existing desk in this shift
 * if they already have one (renewal), otherwise seat them fresh (first sale).
 * This is the one subscriptions.js calls — it never inserts a second row for
 * a continuing tenancy, which is what keeps the seat map a single-row-per-cell
 * read.
 */
export function allocateOrExtend({ seatId, sessionId, memberId, subscriptionId, startDate, endDate, note }) {
  const current = get(
    "SELECT * FROM seat_allocations WHERE member_id = ? AND session_id = ? AND status = 'active'",
    [memberId, sessionId],
  );
  if (current) {
    if (seatId && current.seat_id !== seatId) {
      throw conflict('This student already holds a different seat in this shift — transfer it instead of reassigning');
    }
    return extendSeatAllocation(current.id, { endDate, subscriptionId });
  }
  // No seat picked and none already held: a pass can exist with no seat
  // assigned yet (the student is on the waitlist, or staff will seat them
  // later from the map) — not every call site has a seat to offer.
  if (!seatId) return null;
  return allocateSeat({ seatId, sessionId, memberId, subscriptionId, startDate, endDate, note });
}

/** Frees a seat — cancellation, an early vacate, or the lazy lapse sweep in
 * maintenance.js. `reason` is free text stored for the seat's own history. */
export function releaseSeat(allocationId, { reason = 'manual' } = {}) {
  const existing = get("SELECT * FROM seat_allocations WHERE id = ? AND status = 'active'", [allocationId]);
  if (!existing) throw notFound('Active seat allocation not found');
  run(
    "UPDATE seat_allocations SET status = 'released', released_on = ?, released_reason = ? WHERE id = ?",
    [today(), reason, allocationId],
  );
  return get('SELECT * FROM seat_allocations WHERE id = ?', [allocationId]);
}

/**
 * Moves a live allocation to a different seat, same student/shift/dates.
 *
 * Ordered release-then-allocate, not a wrapped update: idx_seat_alloc_member_shift
 * forbids two active rows for the same (member, session), so the old row has
 * to stop being active before the new one can start. If the target turns out
 * to be taken, the source is put back exactly as it was — "atomic" here means
 * the caller never observes a student with no seat at all.
 */
export function transferSeat(allocationId, newSeatId) {
  const existing = get("SELECT * FROM seat_allocations WHERE id = ? AND status = 'active'", [allocationId]);
  if (!existing) throw notFound('Active seat allocation not found');
  if (existing.seat_id === newSeatId) return existing;

  const targetSeat = get('SELECT * FROM seats WHERE id = ?', [newSeatId]);
  if (!targetSeat) throw notFound('Seat not found');
  if (targetSeat.status !== 'available') throw conflict('That seat is not available');

  const holder = seatHolder(newSeatId, existing.session_id);
  if (holder) throw conflict(seatConflictMessage(holder));

  run(
    "UPDATE seat_allocations SET status = 'released', released_on = ?, released_reason = 'transferred' WHERE id = ?",
    [today(), allocationId],
  );
  try {
    const info = run(
      `INSERT INTO seat_allocations (seat_id, session_id, member_id, subscription_id, start_date, end_date, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newSeatId,
        existing.session_id,
        existing.member_id,
        existing.subscription_id,
        existing.start_date,
        existing.end_date,
        existing.note,
      ],
    );
    return get('SELECT * FROM seat_allocations WHERE id = ?', [info.lastInsertRowid]);
  } catch (err) {
    // Lost a race against another allocate landing on the target between the
    // check above and this insert — restore the source rather than leaving
    // the student seatless.
    run(
      "UPDATE seat_allocations SET status = 'active', released_on = NULL, released_reason = NULL WHERE id = ?",
      [allocationId],
    );
    if (err.errcode !== SQLITE_CONSTRAINT_UNIQUE) throw err;
    const again = seatHolder(newSeatId, existing.session_id);
    throw again ? conflict(seatConflictMessage(again)) : conflict('That seat was just taken for this shift');
  }
}

/** occupied -> plain and paid up; expiring -> ends within a week; expired ->
 * past end_date but still within the hold window (not yet swept); dues ->
 * caught up on shift time but owes money; frozen -> paused, seat held. Priority
 * top-to-bottom, since more than one can technically be true at once and the
 * map can only paint one colour per tile. */
function allocationState(row, asOf) {
  if (row.subscription_status === 'frozen') return 'frozen';
  if (row.end_date < asOf) return 'expired';
  if (row.balance_due > 0) return 'dues';
  if (row.end_date <= addDays(asOf, 7)) return 'expiring';
  return 'occupied';
}

/**
 * Everything the seat map screen needs in one call: every zone, every seat,
 * every shift, and a flat occupancy list keyed by (seat_id, session_id) —
 * not a seat x shift matrix. A vacant cell is simply absent, which keeps the
 * payload roughly a third the size of a dense grid once most halls are only
 * partly full, and the client builds its lookup Map in one pass.
 */
export function seatMap({ on } = {}) {
  releaseLapsedSeatAllocations();
  const asOf = on || today();
  const shifts = all('SELECT * FROM sessions ORDER BY sort_order, start_time');
  const zones = all('SELECT * FROM seat_zones ORDER BY sort_order, name');
  const seats = all('SELECT * FROM seats ORDER BY zone_id, row_label, col_index, id');

  const allocations = all(`
    SELECT sa.seat_id, sa.session_id, sa.member_id, sa.subscription_id, sa.end_date,
           m.first_name, m.last_name, m.code AS member_code,
           sub.status AS subscription_status,
           COALESCE(sub.price, 0) - COALESCE(sub.discount, 0) + COALESCE(sub.addon_total, 0)
             - COALESCE(pay.paid, 0) AS balance_due
    FROM seat_allocations sa
    JOIN members m ON m.id = sa.member_id
    LEFT JOIN subscriptions sub ON sub.id = sa.subscription_id
    LEFT JOIN (
      SELECT subscription_id, COALESCE(SUM(amount), 0) AS paid
      FROM payments WHERE subscription_id IS NOT NULL GROUP BY subscription_id
    ) pay ON pay.subscription_id = sa.subscription_id
    WHERE sa.status = 'active'
  `);

  const occupancy = allocations.map((row) => ({
    seat_id: row.seat_id,
    session_id: row.session_id,
    member_id: row.member_id,
    subscription_id: row.subscription_id,
    member_name: `${row.first_name} ${row.last_name}`.trim(),
    member_code: row.member_code,
    end_date: row.end_date,
    balance_due: row.balance_due,
    state: allocationState(row, asOf),
  }));

  const totals = {
    zones: zones.length,
    seats: seats.length,
    shifts: shifts.length,
    cells: seats.length * shifts.length,
    occupied: occupancy.length,
    expiring: occupancy.filter((o) => o.state === 'expiring').length,
    expired: occupancy.filter((o) => o.state === 'expired').length,
    dues: occupancy.filter((o) => o.state === 'dues').length,
    frozen: occupancy.filter((o) => o.state === 'frozen').length,
  };

  return { as_of: asOf, shifts, zones, seats, occupancy, totals };
}

/**
 * "What frees up by this date" — the operational screen this category runs
 * on. Seats already vacant right now count too; a hall filling up for next
 * month needs both lists, not just the ones about to turn over.
 */
export function seatVacancy({ on } = {}) {
  releaseLapsedSeatAllocations();
  const targetDate = on || today();
  const seats = all("SELECT id, code FROM seats WHERE status = 'available'");
  const shifts = all('SELECT id, name FROM sessions ORDER BY sort_order, start_time');
  const active = all("SELECT seat_id, session_id, end_date FROM seat_allocations WHERE status = 'active'");
  const activeByCell = new Map(active.map((a) => [`${a.seat_id}:${a.session_id}`, a]));

  const freeingUp = active
    .filter((a) => a.end_date < targetDate)
    .map((a) => {
      const seat = seats.find((s) => s.id === a.seat_id);
      const shift = shifts.find((s) => s.id === a.session_id);
      return {
        seat_id: a.seat_id,
        seat_code: seat?.code ?? null,
        session_id: a.session_id,
        shift_name: shift?.name ?? null,
        end_date: a.end_date,
      };
    });

  const alreadyVacant = [];
  for (const seat of seats) {
    for (const shift of shifts) {
      if (activeByCell.has(`${seat.id}:${shift.id}`)) continue;
      alreadyVacant.push({ seat_id: seat.id, seat_code: seat.code, session_id: shift.id, shift_name: shift.name });
    }
  }

  return {
    on: targetDate,
    already_vacant: alreadyVacant,
    freeing_up: freeingUp,
    totals: { already_vacant: alreadyVacant.length, freeing_up: freeingUp.length },
  };
}
