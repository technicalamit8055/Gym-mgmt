import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import {
  MUSCLE_GROUPS,
  WORKOUT_GOALS,
  WORKOUT_LEVELS,
} from '../fitness.js';
import { parse, today, toInt } from '../validate.js';
import { requireModule } from '../verticals.js';

/**
 * Workout programming: the templates a gym keeps on the shelf, the per-member
 * copies a trainer edits, and the read side of what members have actually
 * logged against them.
 *
 * Open to every staff role rather than the billing pair. Programming is a
 * trainer's job — locking it to admin/manager would mean the one person
 * qualified to write a routine has to ask someone else to type it in. Money
 * still is not: selling the add-on lives in fitnessAddons.js behind
 * MANAGES_BILLING.
 */
export const workoutRoutes = Router();
workoutRoutes.use(requireAuth, requireModule('fitness'));

const PLAN_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 100 },
  description: { type: 'string', max: 1000 },
  goal: { type: 'enum', values: WORKOUT_GOALS, default: 'general_fitness' },
  level: { type: 'enum', values: WORKOUT_LEVELS, default: 'intermediate' },
  days_per_week: { type: 'int', min: 1, max: 7, default: 4 },
};

/**
 * The days-and-exercises tree, hand-checked rather than run through parse().
 *
 * parse() is a flat field checker by design (see validate.js), and a routine is
 * two levels of array — so this walks it and reports errors under a path the
 * client can point at ("days.2.exercises.0.exercise_name"), which is what lets
 * the builder highlight the offending row instead of just toasting.
 */
function parseDays(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest('A routine needs a list of days', { days: 'must be a list' });
  if (raw.length > 7) throw badRequest('A week has seven days', { days: 'at most 7' });

  const errors = {};
  const days = raw.map((day, dayIndex) => {
    const dayName = String(day?.day_name ?? '').trim();
    if (!dayName) errors[`days.${dayIndex}.day_name`] = 'is required';
    if (dayName.length > 120) errors[`days.${dayIndex}.day_name`] = 'must be at most 120 characters';

    const rawExercises = Array.isArray(day?.exercises) ? day.exercises : [];
    const exercises = rawExercises.map((exercise, exIndex) => {
      const path = `days.${dayIndex}.exercises.${exIndex}`;
      const name = String(exercise?.exercise_name ?? '').trim();
      if (!name) errors[`${path}.exercise_name`] = 'is required';

      const muscleGroup = String(exercise?.muscle_group ?? 'full_body').trim();
      if (!MUSCLE_GROUPS.includes(muscleGroup)) {
        errors[`${path}.muscle_group`] = `must be one of: ${MUSCLE_GROUPS.join(', ')}`;
      }

      const sets = Number(exercise?.target_sets ?? 3);
      if (!Number.isInteger(sets) || sets < 1 || sets > 20) {
        errors[`${path}.target_sets`] = 'must be a whole number from 1 to 20';
      }

      const rest = Number(exercise?.rest_seconds ?? 90);
      if (!Number.isInteger(rest) || rest < 0 || rest > 900) {
        errors[`${path}.rest_seconds`] = 'must be a whole number of seconds up to 900';
      }

      const rpe = exercise?.target_rpe === undefined || exercise?.target_rpe === null || exercise?.target_rpe === ''
        ? null
        : Number(exercise.target_rpe);
      if (rpe !== null && (!Number.isFinite(rpe) || rpe < 1 || rpe > 10)) {
        errors[`${path}.target_rpe`] = 'must be between 1 and 10';
      }

      return {
        exercise_name: name.slice(0, 120),
        muscle_group: muscleGroup,
        target_sets: sets,
        target_reps: String(exercise?.target_reps ?? '8-12').trim().slice(0, 30) || '8-12',
        target_rpe: rpe,
        rest_seconds: rest,
        notes: exercise?.notes ? String(exercise.notes).trim().slice(0, 300) : null,
      };
    });

    return {
      day_name: dayName.slice(0, 120),
      notes: day?.notes ? String(day.notes).trim().slice(0, 500) : null,
      exercises,
    };
  });

  if (Object.keys(errors).length) throw badRequest('Some rows in this routine need attention', errors);
  return days;
}

/** Writes the whole tree under `planId`, replacing whatever was there. Days
 * are cheap and a routine is edited as a whole document in the builder, so
 * delete-and-reinsert beats diffing rows the client never identified. */
function writeDays(planId, days) {
  run('DELETE FROM workout_plan_days WHERE plan_id = ?', [planId]);
  days.forEach((day, dayIndex) => {
    const dayId = run(
      'INSERT INTO workout_plan_days (plan_id, day_number, day_name, notes, sort_order) VALUES (?, ?, ?, ?, ?)',
      [planId, dayIndex + 1, day.day_name, day.notes, dayIndex],
    ).lastInsertRowid;
    day.exercises.forEach((exercise, exIndex) => {
      run(
        `INSERT INTO workout_plan_exercises
           (day_id, exercise_name, muscle_group, target_sets, target_reps, target_rpe, rest_seconds, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dayId,
          exercise.exercise_name,
          exercise.muscle_group,
          exercise.target_sets,
          exercise.target_reps,
          exercise.target_rpe,
          exercise.rest_seconds,
          exercise.notes,
          exIndex,
        ],
      );
    });
  });
}

/** A plan with its days and each day's exercises, which is the only shape the
 * builder and the member portal ever want it in. */
export function workoutPlanTree(planId) {
  const plan = get('SELECT * FROM workout_plans WHERE id = ?', [planId]);
  if (!plan) return null;
  const days = all('SELECT * FROM workout_plan_days WHERE plan_id = ? ORDER BY sort_order, day_number', [planId]);
  return {
    ...plan,
    days: days.map((day) => ({
      ...day,
      exercises: all('SELECT * FROM workout_plan_exercises WHERE day_id = ? ORDER BY sort_order, id', [day.id]),
    })),
  };
}

/* ── Templates ─────────────────────────────────────────────────────────── */

workoutRoutes.get('/templates', (_req, res) => {
  res.json({
    items: all(`
      SELECT wp.*,
             (SELECT COUNT(*) FROM workout_plan_days d WHERE d.plan_id = wp.id) AS day_count,
             (SELECT COUNT(*) FROM workout_plan_exercises e
                JOIN workout_plan_days d ON d.id = e.day_id WHERE d.plan_id = wp.id) AS exercise_count,
             (SELECT COUNT(*) FROM member_workout_assignments a
                WHERE a.plan_id = wp.id AND a.status = 'active') AS active_members
      FROM workout_plans wp
      WHERE wp.is_template = 1
      ORDER BY wp.name
    `),
  });
});

workoutRoutes.post('/templates', (req, res) => {
  const body = parse(req.body, PLAN_FIELDS);
  const days = parseDays(req.body?.days) ?? [];

  const planId = tx(() => {
    const info = run(
      `INSERT INTO workout_plans (name, description, goal, level, days_per_week, is_template, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [body.name, body.description ?? null, body.goal, body.level, body.days_per_week, req.user.id],
    );
    writeDays(info.lastInsertRowid, days);
    return info.lastInsertRowid;
  });

  res.status(201).json(workoutPlanTree(planId));
});

workoutRoutes.get('/templates/:id', (req, res) => {
  const plan = workoutPlanTree(Number(req.params.id));
  if (!plan) throw notFound('Workout plan not found');
  res.json(plan);
});

workoutRoutes.put('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = get('SELECT id FROM workout_plans WHERE id = ?', [id]);
  if (!existing) throw notFound('Workout plan not found');

  const body = parse(req.body, PLAN_FIELDS);
  const days = parseDays(req.body?.days);

  tx(() => {
    run(
      `UPDATE workout_plans
       SET name = ?, description = ?, goal = ?, level = ?, days_per_week = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [body.name, body.description ?? null, body.goal, body.level, body.days_per_week, id],
    );
    // Omitting `days` edits the header only, which is what a rename should do —
    // an absent key must never be read as "delete every day".
    if (days) writeDays(id, days);
  });

  res.json(workoutPlanTree(id));
});

workoutRoutes.delete('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  const assigned = get(
    "SELECT COUNT(*) AS n FROM member_workout_assignments WHERE plan_id = ? AND status = 'active'",
    [id],
  ).n;
  if (assigned > 0) {
    throw badRequest(
      `${assigned} member${assigned === 1 ? '' : 's'} are still training on this plan — reassign them first`,
    );
  }
  const info = run('DELETE FROM workout_plans WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Workout plan not found');
  res.json({ ok: true });
});

/* ── Assignment ────────────────────────────────────────────────────────── */

/**
 * Puts a plan on a member.
 *
 * `customise` clones the template into a member-owned plan (is_template = 0)
 * so a trainer can tune the sets for this one person without editing the gym's
 * shelf copy. Without it the member trains directly off the template, and a
 * later edit to the template reaches everyone on it — which is the right
 * default for a plain "everyone does PPL" gym.
 */
workoutRoutes.post('/assign', (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    plan_id: { type: 'int', required: true, min: 1 },
    start_date: { type: 'date', default: today() },
    end_date: { type: 'date' },
    notes: { type: 'string', max: 500 },
    customise: { type: 'boolean', default: 0 },
  });

  if (!get('SELECT id FROM members WHERE id = ?', [body.member_id])) throw notFound('Member not found');
  const source = get('SELECT * FROM workout_plans WHERE id = ?', [body.plan_id]);
  if (!source) throw notFound('Workout plan not found');
  if (body.end_date && body.end_date < body.start_date) {
    throw badRequest('The end date cannot fall before the start date', { end_date: 'is before the start date' });
  }

  const assignmentId = tx(() => {
    let planId = source.id;

    if (body.customise) {
      const tree = workoutPlanTree(source.id);
      planId = run(
        `INSERT INTO workout_plans (name, description, goal, level, days_per_week, is_template, member_id, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [tree.name, tree.description, tree.goal, tree.level, tree.days_per_week, body.member_id, req.user.id],
      ).lastInsertRowid;
      writeDays(planId, tree.days);
    }

    // The partial unique index allows exactly one live routine per member, so
    // the incumbent has to step down inside this same transaction.
    run(
      "UPDATE member_workout_assignments SET status = 'archived' WHERE member_id = ? AND status = 'active'",
      [body.member_id],
    );
    return run(
      `INSERT INTO member_workout_assignments (member_id, plan_id, assigned_by, start_date, end_date, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [body.member_id, planId, req.user.id, body.start_date, body.end_date ?? null, body.notes ?? null],
    ).lastInsertRowid;
  });

  const assignment = get('SELECT * FROM member_workout_assignments WHERE id = ?', [assignmentId]);
  res.status(201).json({ ...assignment, plan: workoutPlanTree(assignment.plan_id) });
});

workoutRoutes.post('/unassign/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId);
  const info = run(
    "UPDATE member_workout_assignments SET status = 'archived' WHERE member_id = ? AND status = 'active'",
    [memberId],
  );
  if (!info.changes) throw notFound('That member has no workout plan assigned');
  res.json({ ok: true });
});

/* ── Member view ───────────────────────────────────────────────────────── */

workoutRoutes.get('/members/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Member not found');

  const assignment = get(
    `SELECT a.*, u.name AS assigned_by_name
     FROM member_workout_assignments a
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.member_id = ? AND a.status = 'active'`,
    [memberId],
  );

  const logs = all(
    `SELECT * FROM workout_logs WHERE member_id = ? ORDER BY log_date DESC, id DESC LIMIT ?`,
    [memberId, Math.min(toInt(req.query.limit, 20), 100)],
  );

  res.json({
    assignment: assignment ? { ...assignment, plan: workoutPlanTree(assignment.plan_id) } : null,
    logs,
    prs: all('SELECT * FROM exercise_prs WHERE member_id = ? ORDER BY est_1rm_kg DESC', [memberId]),
    stats: get(
      `SELECT COUNT(*) AS total_workouts,
              COALESCE(SUM(total_volume_kg), 0) AS lifetime_volume_kg,
              COALESCE(SUM(duration_seconds), 0) AS lifetime_seconds,
              MAX(log_date) AS last_workout_on
       FROM workout_logs WHERE member_id = ?`,
      [memberId],
    ),
  });
});

/** One session, sets included — the drill-down behind a row in the history
 * table, for a trainer checking what a member actually did. */
workoutRoutes.get('/logs/:id', (req, res) => {
  const log = get(
    `SELECT l.*, m.code AS member_code, m.first_name, m.last_name
     FROM workout_logs l JOIN members m ON m.id = l.member_id WHERE l.id = ?`,
    [Number(req.params.id)],
  );
  if (!log) throw notFound('Workout log not found');
  res.json({
    ...log,
    sets: all('SELECT * FROM workout_log_sets WHERE log_id = ? ORDER BY sort_order, id', [log.id]),
  });
});

/* ── Exercise library ──────────────────────────────────────────────────── */

workoutRoutes.get('/exercises', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.muscle_group) {
    where.push('muscle_group = ?');
    params.push(String(req.query.muscle_group));
  }
  if (req.query.q) {
    where.push('name LIKE ?');
    params.push(`%${String(req.query.q)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    items: all(`SELECT * FROM exercise_library ${clause} ORDER BY muscle_group, name`, params),
  });
});

workoutRoutes.post('/exercises', (req, res) => {
  const body = parse(req.body, {
    name: { type: 'string', required: true, min: 2, max: 120 },
    muscle_group: { type: 'enum', values: MUSCLE_GROUPS, required: true },
    equipment: {
      type: 'enum',
      values: ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight', 'cardio'],
      default: 'barbell',
    },
    instructions: { type: 'string', max: 1000 },
  });

  const existing = get('SELECT * FROM exercise_library WHERE name = ? COLLATE NOCASE', [body.name]);
  // Returned rather than refused: a trainer typing "Incline Bench" into the
  // picker wants the exercise, and whether it already existed is not their
  // problem to resolve.
  if (existing) return res.json(existing);

  const info = run(
    'INSERT INTO exercise_library (name, muscle_group, equipment, instructions, is_custom) VALUES (?, ?, ?, ?, 1)',
    [body.name, body.muscle_group, body.equipment, body.instructions ?? null],
  );
  return res.status(201).json(get('SELECT * FROM exercise_library WHERE id = ?', [info.lastInsertRowid]));
});

workoutRoutes.delete('/exercises/:id', (req, res) => {
  const id = Number(req.params.id);
  const exercise = get('SELECT * FROM exercise_library WHERE id = ?', [id]);
  if (!exercise) throw notFound('Exercise not found');
  // The seeded catalogue is the shared vocabulary every template is written
  // against; only a gym's own additions are theirs to remove.
  if (!exercise.is_custom) throw badRequest('Standard exercises cannot be deleted');
  run('DELETE FROM exercise_library WHERE id = ?', [id]);
  res.json({ ok: true });
});
