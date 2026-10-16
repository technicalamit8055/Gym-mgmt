import { get, run, tx } from '../db.js';
import { addDays, today } from '../validate.js';
import { starterCourseFeeFor } from '../verticals.js';

/**
 * A new institute's starter catalogue: one course with its subjects, one
 * batch to enroll into, and a three-installment fee structure, so the first
 * admission works without a tour of the setup screens. Guarded on the
 * tenant having no course yet, so it can never stomp real data.
 */

/** "2026-2027" for a session starting this academic year (April onward). */
export function academicYearFor(isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${start + 1}`;
}

export function seedCoachingStarter(vertical, currency = 'INR') {
  const starter = vertical.starterCourse;
  if (!starter) return 0;
  if (get('SELECT COUNT(*) AS n FROM academic_courses').n > 0) return 0;

  const start = today();
  return tx(() => {
    const course = run(
      'INSERT INTO academic_courses (name, code, target_exam, academic_year, description) VALUES (?, ?, ?, ?, ?)',
      [starter.name, starter.code, starter.target_exam, academicYearFor(start), 'Starter course — rename it, or add your own.'],
    );
    const courseId = Number(course.lastInsertRowid);
    starter.subjects.forEach((subject, i) => {
      run('INSERT INTO academic_subjects (course_id, name, code, sort_order) VALUES (?, ?, ?, ?)', [courseId, subject.name, subject.code, i]);
    });
    const b = starter.batch;
    run(
      `INSERT INTO academic_batches (course_id, name, code, capacity, room, weekdays, start_time, end_time, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [courseId, b.name, b.code, b.capacity, b.room, b.weekdays, b.start_time, b.end_time, start, addDays(start, 364)],
    );
    const fee = starter.feeStructure;
    run('INSERT INTO fee_structures (course_id, name, total_fee, installments, interval_days) VALUES (?, ?, ?, ?, ?)', [
      courseId,
      fee.name,
      starterCourseFeeFor(vertical, currency),
      fee.installments,
      fee.interval_days,
    ]);
    return 1;
  });
}
