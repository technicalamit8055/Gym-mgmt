import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { DIET_GOALS } from '../fitness.js';
import { parse, today, toInt } from '../validate.js';
import { requireModule } from '../verticals.js';

/**
 * Diet programming, the mirror image of workouts.js: templates on the shelf,
 * per-member copies, and the read side of what a member has actually eaten.
 *
 * Open to every staff role for the same reason — the trainer writing the plan
 * should be the one typing it in.
 */
export const dietRoutes = Router();
dietRoutes.use(requireAuth, requireModule('fitness'));

const PLAN_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 100 },
  description: { type: 'string', max: 1000 },
  goal: { type: 'enum', values: DIET_GOALS, default: 'maintenance' },
  target_calories: { type: 'int', required: true, min: 500, max: 10000 },
  target_protein_g: { type: 'int', min: 0, max: 1000, default: 0 },
  target_carbs_g: { type: 'int', min: 0, max: 2000, default: 0 },
  target_fats_g: { type: 'int', min: 0, max: 1000, default: 0 },
  target_water_ml: { type: 'int', min: 0, max: 15000, default: 3000 },
};

/**
 * The meals-and-items tree. Hand-checked for the same reason parseDays is in
 * workouts.js: parse() is flat by design, and errors need a path the builder
 * can point at.
 */
function parseMeals(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest('A diet needs a list of meals', { meals: 'must be a list' });
  if (raw.length > 12) throw badRequest('Twelve meals is already a lot', { meals: 'at most 12' });

  const errors = {};
  const meals = raw.map((meal, mealIndex) => {
    const name = String(meal?.meal_name ?? '').trim();
    if (!name) errors[`meals.${mealIndex}.meal_name`] = 'is required';

    const mealTime = meal?.meal_time ? String(meal.meal_time).trim() : null;
    if (mealTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(mealTime)) {
      errors[`meals.${mealIndex}.meal_time`] = 'must be a time formatted HH:MM';
    }

    const rawItems = Array.isArray(meal?.items) ? meal.items : [];
    const items = rawItems.map((item, itemIndex) => {
      const path = `meals.${mealIndex}.items.${itemIndex}`;
      const foodName = String(item?.food_name ?? '').trim();
      if (!foodName) errors[`${path}.food_name`] = 'is required';

      const numbers = {};
      for (const [field, max] of [['calories', 5000], ['protein_g', 500], ['carbs_g', 1000], ['fats_g', 500]]) {
        const value = Number(item?.[field] ?? 0);
        if (!Number.isFinite(value) || value < 0 || value > max) {
          errors[`${path}.${field}`] = `must be a number from 0 to ${max}`;
        }
        numbers[field] = value;
      }

      return {
        food_name: foodName.slice(0, 120),
        portion_size: String(item?.portion_size ?? '100g').trim().slice(0, 60) || '100g',
        // Calories are whole numbers on every label; macros are not.
        calories: Math.round(numbers.calories),
        protein_g: numbers.protein_g,
        carbs_g: numbers.carbs_g,
        fats_g: numbers.fats_g,
        notes: item?.notes ? String(item.notes).trim().slice(0, 300) : null,
      };
    });

    return {
      meal_name: name.slice(0, 60),
      meal_time: mealTime,
      notes: meal?.notes ? String(meal.notes).trim().slice(0, 500) : null,
      items,
    };
  });

  if (Object.keys(errors).length) throw badRequest('Some rows in this diet need attention', errors);
  return meals;
}

function writeMeals(planId, meals) {
  run('DELETE FROM diet_plan_meals WHERE plan_id = ?', [planId]);
  meals.forEach((meal, mealIndex) => {
    // A meal's calorie target is the sum of what is in it, never a second
    // number for a trainer to keep in sync by hand.
    const mealCalories = meal.items.reduce((sum, item) => sum + item.calories, 0);
    const mealId = run(
      'INSERT INTO diet_plan_meals (plan_id, meal_name, meal_time, target_calories, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [planId, meal.meal_name, meal.meal_time, mealCalories, meal.notes, mealIndex],
    ).lastInsertRowid;
    meal.items.forEach((item, itemIndex) => {
      run(
        `INSERT INTO diet_plan_items
           (meal_id, food_name, portion_size, calories, protein_g, carbs_g, fats_g, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mealId,
          item.food_name,
          item.portion_size,
          item.calories,
          item.protein_g,
          item.carbs_g,
          item.fats_g,
          item.notes,
          itemIndex,
        ],
      );
    });
  });
}

export function dietPlanTree(planId) {
  const plan = get('SELECT * FROM diet_plans WHERE id = ?', [planId]);
  if (!plan) return null;
  const meals = all('SELECT * FROM diet_plan_meals WHERE plan_id = ? ORDER BY sort_order, id', [planId]);
  return {
    ...plan,
    meals: meals.map((meal) => ({
      ...meal,
      items: all('SELECT * FROM diet_plan_items WHERE meal_id = ? ORDER BY sort_order, id', [meal.id]),
    })),
  };
}

/* ── Templates ─────────────────────────────────────────────────────────── */

dietRoutes.get('/templates', (_req, res) => {
  res.json({
    items: all(`
      SELECT dp.*,
             (SELECT COUNT(*) FROM diet_plan_meals m WHERE m.plan_id = dp.id) AS meal_count,
             (SELECT COUNT(*) FROM diet_plan_items i
                JOIN diet_plan_meals m ON m.id = i.meal_id WHERE m.plan_id = dp.id) AS item_count,
             (SELECT COUNT(*) FROM member_diet_assignments a
                WHERE a.plan_id = dp.id AND a.status = 'active') AS active_members
      FROM diet_plans dp
      WHERE dp.is_template = 1
      ORDER BY dp.name
    `),
  });
});

dietRoutes.post('/templates', (req, res) => {
  const body = parse(req.body, PLAN_FIELDS);
  const meals = parseMeals(req.body?.meals) ?? [];

  const planId = tx(() => {
    const info = run(
      `INSERT INTO diet_plans (name, description, goal, target_calories, target_protein_g, target_carbs_g,
                               target_fats_g, target_water_ml, is_template, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        body.name,
        body.description ?? null,
        body.goal,
        body.target_calories,
        body.target_protein_g,
        body.target_carbs_g,
        body.target_fats_g,
        body.target_water_ml,
        req.user.id,
      ],
    );
    writeMeals(info.lastInsertRowid, meals);
    return info.lastInsertRowid;
  });

  res.status(201).json(dietPlanTree(planId));
});

dietRoutes.get('/templates/:id', (req, res) => {
  const plan = dietPlanTree(Number(req.params.id));
  if (!plan) throw notFound('Diet plan not found');
  res.json(plan);
});

dietRoutes.put('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM diet_plans WHERE id = ?', [id])) throw notFound('Diet plan not found');

  const body = parse(req.body, PLAN_FIELDS);
  const meals = parseMeals(req.body?.meals);

  tx(() => {
    run(
      `UPDATE diet_plans
       SET name = ?, description = ?, goal = ?, target_calories = ?, target_protein_g = ?,
           target_carbs_g = ?, target_fats_g = ?, target_water_ml = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        body.name,
        body.description ?? null,
        body.goal,
        body.target_calories,
        body.target_protein_g,
        body.target_carbs_g,
        body.target_fats_g,
        body.target_water_ml,
        id,
      ],
    );
    // An absent `meals` key edits the targets only — it must never read as
    // "delete every meal".
    if (meals) writeMeals(id, meals);
  });

  res.json(dietPlanTree(id));
});

dietRoutes.delete('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  const assigned = get(
    "SELECT COUNT(*) AS n FROM member_diet_assignments WHERE plan_id = ? AND status = 'active'",
    [id],
  ).n;
  if (assigned > 0) {
    throw badRequest(`${assigned} member${assigned === 1 ? '' : 's'} are still on this diet — reassign them first`);
  }
  const info = run('DELETE FROM diet_plans WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Diet plan not found');
  res.json({ ok: true });
});

/* ── Assignment ────────────────────────────────────────────────────────── */

dietRoutes.post('/assign', (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    plan_id: { type: 'int', required: true, min: 1 },
    start_date: { type: 'date', default: today() },
    end_date: { type: 'date' },
    notes: { type: 'string', max: 500 },
    customise: { type: 'boolean', default: 0 },
  });

  if (!get('SELECT id FROM members WHERE id = ?', [body.member_id])) throw notFound('Member not found');
  const source = get('SELECT * FROM diet_plans WHERE id = ?', [body.plan_id]);
  if (!source) throw notFound('Diet plan not found');
  if (body.end_date && body.end_date < body.start_date) {
    throw badRequest('The end date cannot fall before the start date', { end_date: 'is before the start date' });
  }

  const assignmentId = tx(() => {
    let planId = source.id;

    // Same reasoning as the workout clone: calorie targets are the thing most
    // often tuned per person, and tuning them must not move everyone else.
    if (body.customise) {
      const tree = dietPlanTree(source.id);
      planId = run(
        `INSERT INTO diet_plans (name, description, goal, target_calories, target_protein_g, target_carbs_g,
                                 target_fats_g, target_water_ml, is_template, member_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          tree.name,
          tree.description,
          tree.goal,
          tree.target_calories,
          tree.target_protein_g,
          tree.target_carbs_g,
          tree.target_fats_g,
          tree.target_water_ml,
          body.member_id,
          req.user.id,
        ],
      ).lastInsertRowid;
      writeMeals(planId, tree.meals);
    }

    run("UPDATE member_diet_assignments SET status = 'archived' WHERE member_id = ? AND status = 'active'", [
      body.member_id,
    ]);
    return run(
      `INSERT INTO member_diet_assignments (member_id, plan_id, assigned_by, start_date, end_date, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [body.member_id, planId, req.user.id, body.start_date, body.end_date ?? null, body.notes ?? null],
    ).lastInsertRowid;
  });

  const assignment = get('SELECT * FROM member_diet_assignments WHERE id = ?', [assignmentId]);
  res.status(201).json({ ...assignment, plan: dietPlanTree(assignment.plan_id) });
});

dietRoutes.post('/unassign/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId);
  const info = run(
    "UPDATE member_diet_assignments SET status = 'archived' WHERE member_id = ? AND status = 'active'",
    [memberId],
  );
  if (!info.changes) throw notFound('That member has no diet plan assigned');
  res.json({ ok: true });
});

/* ── Member view ───────────────────────────────────────────────────────── */

dietRoutes.get('/members/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Member not found');

  const assignment = get(
    `SELECT a.*, u.name AS assigned_by_name
     FROM member_diet_assignments a
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.member_id = ? AND a.status = 'active'`,
    [memberId],
  );

  // The adherence read: what was logged each day next to what was targeted, so
  // a trainer can see a pattern rather than one day's numbers.
  const days = all(
    `SELECT dl.log_date, dl.water_ml,
            COALESCE(SUM(e.calories), 0) AS calories,
            COALESCE(SUM(e.protein_g), 0) AS protein_g,
            COALESCE(SUM(e.carbs_g), 0) AS carbs_g,
            COALESCE(SUM(e.fats_g), 0) AS fats_g,
            COUNT(e.id) AS entry_count
     FROM diet_logs dl
     LEFT JOIN diet_log_entries e ON e.diet_log_id = dl.id
     WHERE dl.member_id = ?
     GROUP BY dl.id
     ORDER BY dl.log_date DESC
     LIMIT ?`,
    [memberId, Math.min(toInt(req.query.limit, 21), 120)],
  );

  const plan = assignment ? dietPlanTree(assignment.plan_id) : null;
  const target = plan?.target_calories ?? 0;
  // Adherence is the share of logged days that landed within 15% of target —
  // a band, because hitting a calorie number exactly is not a thing anyone
  // does, and "close enough, most days" is what actually predicts results.
  const onTarget = target ? days.filter((d) => Math.abs(d.calories - target) <= target * 0.15).length : 0;

  res.json({
    assignment: assignment ? { ...assignment, plan } : null,
    days,
    adherence_pct: days.length && target ? Math.round((onTarget / days.length) * 100) : null,
  });
});

/** One day's food, entry by entry — the drill-down behind a row in the
 * adherence table. */
dietRoutes.get('/members/:memberId/day', (req, res) => {
  const memberId = Number(req.params.memberId);
  const logDate = String(req.query.date || today());
  const log = get('SELECT * FROM diet_logs WHERE member_id = ? AND log_date = ?', [memberId, logDate]);
  res.json({
    log_date: logDate,
    water_ml: log?.water_ml ?? 0,
    entries: log
      ? all('SELECT * FROM diet_log_entries WHERE diet_log_id = ? ORDER BY logged_at, id', [log.id])
      : [],
  });
});

/* ── Food library ──────────────────────────────────────────────────────── */

dietRoutes.get('/foods', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.category) {
    where.push('category = ?');
    params.push(String(req.query.category));
  }
  if (req.query.q) {
    where.push('name LIKE ?');
    params.push(`%${String(req.query.q)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({ items: all(`SELECT * FROM food_library ${clause} ORDER BY category, name`, params) });
});

dietRoutes.post('/foods', (req, res) => {
  const body = parse(req.body, {
    name: { type: 'string', required: true, min: 2, max: 120 },
    category: {
      type: 'enum',
      values: ['protein', 'carbs', 'fats', 'fruits', 'dairy', 'supplements', 'meal', 'general'],
      default: 'general',
    },
    serving_unit: { type: 'string', max: 60, default: '100g' },
    calories: { type: 'int', required: true, min: 0, max: 5000 },
    protein_g: { type: 'number', min: 0, max: 500, default: 0 },
    carbs_g: { type: 'number', min: 0, max: 1000, default: 0 },
    fats_g: { type: 'number', min: 0, max: 500, default: 0 },
  });

  const existing = get('SELECT * FROM food_library WHERE name = ? COLLATE NOCASE', [body.name]);
  if (existing) return res.json(existing);

  const info = run(
    `INSERT INTO food_library (name, category, serving_unit, calories, protein_g, carbs_g, fats_g, is_custom)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [body.name, body.category, body.serving_unit, body.calories, body.protein_g, body.carbs_g, body.fats_g],
  );
  return res.status(201).json(get('SELECT * FROM food_library WHERE id = ?', [info.lastInsertRowid]));
});

dietRoutes.delete('/foods/:id', (req, res) => {
  const id = Number(req.params.id);
  const food = get('SELECT * FROM food_library WHERE id = ?', [id]);
  if (!food) throw notFound('Food not found');
  if (!food.is_custom) throw badRequest('Standard foods cannot be deleted');
  run('DELETE FROM food_library WHERE id = ?', [id]);
  res.json({ ok: true });
});
