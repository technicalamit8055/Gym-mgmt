import { all, get } from '../db.js';

/**
 * Timetable collision detection.
 *
 * Two lectures on the same weekday clash when their times overlap
 * (start < other.end && other.start < end — back-to-back 4:00–5:00 and
 * 5:00–6:00 is fine) and they share any one of:
 *
 * - the teacher — one person cannot be in two rooms;
 * - the room — two batches cannot sit in one hall;
 * - the batch — one group of students cannot be in two lectures.
 *
 * Rooms are free text, so they are compared trimmed and case-insensitively:
 * "Room 101" and "room 101 " are the same room.
 *
 * Clashes are returned rather than thrown, so the route can refuse with the
 * full list (409) and the screen can show exactly what collides. A room that
 * has fewer desks than the batch has students is a warning, not a clash: the
 * lecture can still happen, just with extra chairs.
 */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const sameRoom = (a, b) => Boolean(a && b) && a.trim().toLowerCase() === b.trim().toLowerCase();

export const overlaps = (a, b) => a.start_time < b.end_time && b.start_time < a.end_time;

export const SLOT_SELECT = `
  SELECT t.*, b.name AS batch_name, b.code AS batch_code, b.course_id, s.name AS subject_name, s.code AS subject_code,
         u.name AS faculty_name, COALESCE(t.room, b.room) AS effective_room
  FROM academic_timetable t
  JOIN academic_batches b ON b.id = t.batch_id
  JOIN academic_subjects s ON s.id = t.subject_id
  LEFT JOIN users u ON u.id = t.faculty_id
`;

/**
 * Every active lecture `slot` would collide with. `slot` is
 * { batch_id, faculty_id, weekday, start_time, end_time, room }; `excludeId`
 * leaves out the row being edited.
 */
export function findConflicts(slot, { excludeId = null } = {}) {
  const batch = get('SELECT room FROM academic_batches WHERE id = ?', [slot.batch_id]);
  const room = slot.room || batch?.room || null;
  const sameDay = all(`${SLOT_SELECT} WHERE t.active = 1 AND t.weekday = ? AND t.id != ?`, [slot.weekday, excludeId ?? 0]);
  const conflicts = [];
  for (const other of sameDay) {
    if (!overlaps(slot, other)) continue;
    const reasons = [];
    if (slot.faculty_id && other.faculty_id === slot.faculty_id) reasons.push('faculty');
    if (sameRoom(room, other.effective_room)) reasons.push('room');
    if (other.batch_id === slot.batch_id) reasons.push('batch');
    if (reasons.length) conflicts.push({ ...other, reasons });
  }
  return conflicts;
}

/** Human sentence for one conflict, used in the 409 message and the screen. */
export function describeConflict(conflict) {
  const when = `${WEEKDAYS[conflict.weekday]} ${conflict.start_time}–${conflict.end_time}`;
  const parts = conflict.reasons.map((reason) =>
    reason === 'faculty'
      ? `${conflict.faculty_name} is already teaching ${conflict.batch_name}`
      : reason === 'room'
        ? `${conflict.effective_room} is taken by ${conflict.batch_name}`
        : `${conflict.batch_name} already has ${conflict.subject_name}`,
  );
  return `${when}: ${parts.join('; ')}`;
}

/** Non-blocking warnings for a slot: the room is smaller than the batch. */
export function capacityWarnings(slot) {
  const batch = get(
    `SELECT b.name, b.room, (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS students
     FROM academic_batches b WHERE b.id = ?`,
    [slot.batch_id],
  );
  const roomName = slot.room || batch?.room;
  if (!batch || !roomName) return [];
  const room = get('SELECT name, capacity FROM classrooms WHERE name = ? COLLATE NOCASE', [roomName.trim()]);
  if (room && batch.students > room.capacity) {
    return [`${room.name} seats ${room.capacity}, but ${batch.name} has ${batch.students} students`];
  }
  return [];
}

/**
 * Every clash in the current timetable, each pair once — the "check the
 * whole week" view, for clashes created before a slot was edited or by a
 * staff member who saved one anyway.
 */
export function allConflicts() {
  const slots = all(`${SLOT_SELECT} WHERE t.active = 1 ORDER BY t.weekday, t.start_time`);
  const found = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (a.weekday !== b.weekday || !overlaps(a, b)) continue;
      const reasons = [];
      if (a.faculty_id && a.faculty_id === b.faculty_id) reasons.push('faculty');
      if (sameRoom(a.effective_room, b.effective_room)) reasons.push('room');
      if (a.batch_id === b.batch_id) reasons.push('batch');
      if (reasons.length) found.push({ a, b, reasons });
    }
  }
  return found;
}
