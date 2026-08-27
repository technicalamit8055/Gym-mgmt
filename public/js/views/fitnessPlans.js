import { api, session } from '../api.js';
import {
  append,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  h,
  money,
  openModal,
  renderIcon,
  table,
  toast,
} from '../ui.js';

/**
 * The gym's Diet & Workout catalogue: the routines and diets on the shelf, the
 * exercise and food databases they are written against, and what the tracker
 * costs a member per month.
 *
 * Five tabs in one view rather than five routes. They are one job — setting up
 * the feature — and a trainer building a routine reaches for the exercise
 * library constantly, which a hash-route boundary would turn into losing their
 * half-built plan.
 */

const MUSCLE_GROUPS = [
  { value: 'chest', label: 'Chest' },
  { value: 'back', label: 'Back' },
  { value: 'legs', label: 'Legs' },
  { value: 'shoulders', label: 'Shoulders' },
  { value: 'arms', label: 'Arms' },
  { value: 'core', label: 'Core' },
  { value: 'cardio', label: 'Cardio' },
  { value: 'full_body', label: 'Full body' },
];

const WORKOUT_GOALS = [
  { value: 'muscle_gain', label: 'Muscle gain' },
  { value: 'fat_loss', label: 'Fat loss' },
  { value: 'strength', label: 'Strength' },
  { value: 'endurance', label: 'Endurance' },
  { value: 'general_fitness', label: 'General fitness' },
];

const LEVELS = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' },
];

const DIET_GOALS = [
  { value: 'fat_loss', label: 'Fat loss' },
  { value: 'muscle_gain', label: 'Muscle gain' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'keto', label: 'Keto' },
  { value: 'high_protein', label: 'High protein' },
];

const FOOD_CATEGORIES = [
  { value: 'protein', label: 'Protein' },
  { value: 'carbs', label: 'Carbs' },
  { value: 'fats', label: 'Fats' },
  { value: 'fruits', label: 'Fruit & veg' },
  { value: 'dairy', label: 'Dairy' },
  { value: 'supplements', label: 'Supplements' },
  { value: 'meal', label: 'Full meal' },
  { value: 'general', label: 'Other' },
];

const EQUIPMENT = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight', 'cardio'];

const labelOf = (options, value) => options.find((o) => o.value === value)?.label ?? value;

/**
 * Wraps an async click handler.
 *
 * The builders and previews fetch before they can open anything, so a failed
 * request needs somewhere to land — untouched, it is an unhandled rejection and
 * the button just appears inert, which is the worst of both outcomes.
 */
const clickAsync = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message || 'Something went wrong', 'error');
  }
};

const GOAL_TONE = {
  muscle_gain: 'blue',
  strength: 'amber',
  fat_loss: 'green',
  endurance: 'blue',
  general_fitness: 'grey',
  maintenance: 'grey',
  keto: 'amber',
  high_protein: 'blue',
};

/* ── Workout template builder ──────────────────────────────────────────── */

/**
 * The routine builder: a day list, each holding an exercise list, both
 * reorderable and both editable in place.
 *
 * Local state repainted wholesale on every change rather than a diffing render:
 * a routine is a dozen rows, repainting it is imperceptible, and it means an
 * added exercise can never desync from the array behind it. `getValue()` is
 * what the form submit reads.
 */
function workoutDaysEditor(initialDays = [], exerciseLibrary = []) {
  const days = initialDays.map((day) => ({
    day_name: day.day_name,
    notes: day.notes ?? '',
    exercises: (day.exercises ?? []).map((e) => ({
      exercise_name: e.exercise_name,
      muscle_group: e.muscle_group,
      target_sets: e.target_sets ?? 3,
      target_reps: e.target_reps ?? '8-12',
      rest_seconds: e.rest_seconds ?? 90,
      notes: e.notes ?? '',
    })),
  }));

  const wrap = h('div', { class: 'fit-builder' });
  const byName = new Map(exerciseLibrary.map((e) => [e.name, e]));

  function exerciseRow(day, exercise, dayIndex, exIndex) {
    const nameInput = h('input', {
      class: 'fit-cell-name',
      value: exercise.exercise_name,
      list: 'fit-exercise-options',
      placeholder: 'Exercise',
      oninput: (event) => {
        exercise.exercise_name = event.target.value;
        // Picking from the library fills the muscle group in, so the trainer
        // types one field instead of two.
        const known = byName.get(event.target.value);
        if (known) {
          exercise.muscle_group = known.muscle_group;
          groupSelect.value = known.muscle_group;
        }
      },
    });
    const groupSelect = h(
      'select',
      { class: 'fit-cell-group', onchange: (event) => { exercise.muscle_group = event.target.value; } },
      ...MUSCLE_GROUPS.map((g) =>
        h('option', { value: g.value, selected: g.value === exercise.muscle_group }, g.label),
      ),
    );

    return h(
      'div',
      { class: 'fit-ex-row' },
      h('span', { class: 'fit-ex-handle' }, String(exIndex + 1)),
      nameInput,
      groupSelect,
      h('input', {
        class: 'fit-cell-num',
        type: 'number',
        min: 1,
        max: 20,
        value: exercise.target_sets,
        title: 'Sets',
        oninput: (event) => { exercise.target_sets = Number(event.target.value); },
      }),
      h('input', {
        class: 'fit-cell-reps',
        value: exercise.target_reps,
        title: 'Reps',
        placeholder: '8-12',
        oninput: (event) => { exercise.target_reps = event.target.value; },
      }),
      h('input', {
        class: 'fit-cell-num',
        type: 'number',
        min: 0,
        max: 900,
        step: 15,
        value: exercise.rest_seconds,
        title: 'Rest (seconds)',
        oninput: (event) => { exercise.rest_seconds = Number(event.target.value); },
      }),
      h(
        'button',
        {
          class: 'icon-btn sm',
          type: 'button',
          title: 'Move up',
          disabled: exIndex === 0,
          onclick: () => {
            [day.exercises[exIndex - 1], day.exercises[exIndex]] = [day.exercises[exIndex], day.exercises[exIndex - 1]];
            paint();
          },
        },
        '↑',
      ),
      h(
        'button',
        {
          class: 'icon-btn sm',
          type: 'button',
          title: 'Move down',
          disabled: exIndex === day.exercises.length - 1,
          onclick: () => {
            [day.exercises[exIndex + 1], day.exercises[exIndex]] = [day.exercises[exIndex], day.exercises[exIndex + 1]];
            paint();
          },
        },
        '↓',
      ),
      h(
        'button',
        {
          class: 'icon-btn sm danger',
          type: 'button',
          title: 'Remove exercise',
          onclick: () => {
            day.exercises.splice(exIndex, 1);
            paint();
          },
        },
        renderIcon('close', { size: 14 }),
      ),
    );
  }

  function paint() {
    clear(wrap);
    days.forEach((day, dayIndex) => {
      const card = h(
        'div',
        { class: 'fit-day-card' },
        h(
          'div',
          { class: 'fit-day-head' },
          h('input', {
            class: 'fit-day-name',
            value: day.day_name,
            placeholder: `Day ${dayIndex + 1}: e.g. Push (Chest & Triceps)`,
            oninput: (event) => { day.day_name = event.target.value; },
          }),
          h(
            'button',
            {
              class: 'icon-btn sm',
              type: 'button',
              title: 'Move day up',
              disabled: dayIndex === 0,
              onclick: () => {
                [days[dayIndex - 1], days[dayIndex]] = [days[dayIndex], days[dayIndex - 1]];
                paint();
              },
            },
            '↑',
          ),
          h(
            'button',
            {
              class: 'icon-btn sm',
              type: 'button',
              title: 'Move day down',
              disabled: dayIndex === days.length - 1,
              onclick: () => {
                [days[dayIndex + 1], days[dayIndex]] = [days[dayIndex], days[dayIndex + 1]];
                paint();
              },
            },
            '↓',
          ),
          h(
            'button',
            {
              class: 'icon-btn sm danger',
              type: 'button',
              title: 'Remove day',
              onclick: () => {
                days.splice(dayIndex, 1);
                paint();
              },
            },
            renderIcon('trash', { size: 14 }),
          ),
        ),
        h('input', {
          class: 'fit-day-notes',
          value: day.notes,
          placeholder: 'Coaching note for this day (optional)',
          oninput: (event) => { day.notes = event.target.value; },
        }),
        day.exercises.length
          ? h(
              'div',
              { class: 'fit-ex-list' },
              h(
                'div',
                { class: 'fit-ex-row fit-ex-header' },
                h('span', {}, '#'),
                h('span', {}, 'Exercise'),
                h('span', {}, 'Muscle'),
                h('span', {}, 'Sets'),
                h('span', {}, 'Reps'),
                h('span', {}, 'Rest'),
                h('span', { style: 'grid-column:span 3' }, ''),
              ),
              ...day.exercises.map((exercise, exIndex) => exerciseRow(day, exercise, dayIndex, exIndex)),
            )
          : h('div', { class: 'fit-empty-inline' }, 'No exercises in this day yet.'),
        h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              day.exercises.push({
                exercise_name: '',
                muscle_group: 'chest',
                target_sets: 3,
                target_reps: '8-12',
                rest_seconds: 90,
                notes: '',
              });
              paint();
            },
          },
          '＋ Add exercise',
        ),
      );
      wrap.append(card);
    });

    wrap.append(
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          disabled: days.length >= 7,
          onclick: () => {
            days.push({ day_name: `Day ${days.length + 1}`, notes: '', exercises: [] });
            paint();
          },
        },
        days.length >= 7 ? 'A week only has seven days' : '＋ Add training day',
      ),
    );
  }

  paint();
  return {
    node: wrap,
    // Blank rows are dropped rather than sent for the server to reject: a
    // trainer who added a day and changed their mind should not have to delete
    // it before saving.
    getValue: () =>
      days
        .map((day) => ({ ...day, exercises: day.exercises.filter((e) => e.exercise_name.trim()) }))
        .filter((day) => day.day_name.trim()),
  };
}

async function openWorkoutTemplateForm({ template, onSaved }) {
  const [{ items: library }, full] = await Promise.all([
    api.exercises(),
    template ? api.workoutTemplate(template.id) : Promise.resolve(null),
  ]);

  const editor = workoutDaysEditor(full?.days ?? [], library);
  const form = buildForm(
    [
      { name: 'name', label: 'Plan name', required: true, full: true, value: full?.name ?? '', placeholder: 'e.g. Push / Pull / Legs — 6 Day' },
      { name: 'goal', label: 'Goal', type: 'select', options: WORKOUT_GOALS, value: full?.goal ?? 'muscle_gain' },
      { name: 'level', label: 'Level', type: 'select', options: LEVELS, value: full?.level ?? 'intermediate' },
      { name: 'days_per_week', label: 'Days per week', type: 'number', min: 1, max: 7, value: full?.days_per_week ?? 4 },
      { name: 'description', label: 'Description', type: 'textarea', full: true, value: full?.description ?? '' },
    ],
    {
      wide: true,
      submitLabel: template ? 'Save plan' : 'Create plan',
      onSubmit: async (values) => {
        const payload = { ...values, days_per_week: Number(values.days_per_week), days: editor.getValue() };
        if (template) await api.updateWorkoutTemplate(template.id, payload);
        else await api.createWorkoutTemplate(payload);
        closeModal();
        toast(template ? 'Workout plan updated' : 'Workout plan created');
        await onSaved();
      },
    },
  );

  form.querySelector('.form-grid').after(
    h(
      'div',
      { class: 'fit-builder-wrap' },
      h('h4', { class: 'fit-builder-title' }, 'Training days'),
      // One shared datalist for every exercise input in the builder, so typing
      // "bench" offers the catalogue instead of nothing.
      h(
        'datalist',
        { id: 'fit-exercise-options' },
        ...library.map((e) => h('option', { value: e.name }, `${labelOf(MUSCLE_GROUPS, e.muscle_group)} · ${e.equipment}`)),
      ),
      editor.node,
    ),
  );

  openModal({ title: template ? `Edit · ${template.name}` : 'New workout plan', body: form, wide: true });
}

/* ── Diet template builder ─────────────────────────────────────────────── */

function dietMealsEditor(initialMeals = [], foodLibrary = []) {
  const meals = initialMeals.map((meal) => ({
    meal_name: meal.meal_name,
    meal_time: meal.meal_time ?? '',
    notes: meal.notes ?? '',
    items: (meal.items ?? []).map((i) => ({
      food_name: i.food_name,
      portion_size: i.portion_size,
      calories: i.calories,
      protein_g: i.protein_g,
      carbs_g: i.carbs_g,
      fats_g: i.fats_g,
    })),
  }));

  const wrap = h('div', { class: 'fit-builder' });
  const byName = new Map(foodLibrary.map((f) => [f.name, f]));

  function itemRow(meal, item, itemIndex) {
    const inputs = {};
    const setNumbers = (source) => {
      for (const field of ['calories', 'protein_g', 'carbs_g', 'fats_g']) {
        item[field] = source[field];
        inputs[field].value = source[field];
      }
    };

    const nameInput = h('input', {
      class: 'fit-cell-name',
      value: item.food_name,
      list: 'fit-food-options',
      placeholder: 'Food',
      oninput: (event) => {
        item.food_name = event.target.value;
        // Picking a library food fills its macros in, which is the whole point
        // of having a food database rather than a notes field.
        const known = byName.get(event.target.value);
        if (known) {
          item.portion_size = known.serving_unit;
          inputs.portion_size.value = known.serving_unit;
          setNumbers(known);
          paint();
        }
      },
    });

    const numberCell = (field, title) => {
      const input = h('input', {
        class: 'fit-cell-num',
        type: 'number',
        min: 0,
        step: field === 'calories' ? 1 : 0.1,
        value: item[field],
        title,
        oninput: (event) => {
          item[field] = Number(event.target.value);
          paint();
        },
      });
      inputs[field] = input;
      return input;
    };

    inputs.portion_size = h('input', {
      class: 'fit-cell-reps',
      value: item.portion_size,
      placeholder: '100g',
      title: 'Portion',
      oninput: (event) => { item.portion_size = event.target.value; },
    });

    return h(
      'div',
      { class: 'fit-item-row' },
      h('span', { class: 'fit-ex-handle' }, String(itemIndex + 1)),
      nameInput,
      inputs.portion_size,
      numberCell('calories', 'Calories'),
      numberCell('protein_g', 'Protein (g)'),
      numberCell('carbs_g', 'Carbs (g)'),
      numberCell('fats_g', 'Fats (g)'),
      h(
        'button',
        {
          class: 'icon-btn sm danger',
          type: 'button',
          title: 'Remove food',
          onclick: () => {
            meal.items.splice(itemIndex, 1);
            paint();
          },
        },
        renderIcon('close', { size: 14 }),
      ),
    );
  }

  function paint() {
    clear(wrap);
    meals.forEach((meal, mealIndex) => {
      const totals = meal.items.reduce(
        (acc, i) => ({
          calories: acc.calories + (i.calories || 0),
          protein_g: acc.protein_g + (i.protein_g || 0),
          carbs_g: acc.carbs_g + (i.carbs_g || 0),
          fats_g: acc.fats_g + (i.fats_g || 0),
        }),
        { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0 },
      );

      wrap.append(
        h(
          'div',
          { class: 'fit-day-card' },
          h(
            'div',
            { class: 'fit-day-head' },
            h('input', {
              class: 'fit-day-name',
              value: meal.meal_name,
              placeholder: 'e.g. Breakfast',
              oninput: (event) => { meal.meal_name = event.target.value; },
            }),
            h('input', {
              class: 'fit-meal-time',
              type: 'time',
              value: meal.meal_time,
              title: 'Suggested time',
              oninput: (event) => { meal.meal_time = event.target.value; },
            }),
            h(
              'button',
              {
                class: 'icon-btn sm',
                type: 'button',
                title: 'Move up',
                disabled: mealIndex === 0,
                onclick: () => {
                  [meals[mealIndex - 1], meals[mealIndex]] = [meals[mealIndex], meals[mealIndex - 1]];
                  paint();
                },
              },
              '↑',
            ),
            h(
              'button',
              {
                class: 'icon-btn sm',
                type: 'button',
                title: 'Move down',
                disabled: mealIndex === meals.length - 1,
                onclick: () => {
                  [meals[mealIndex + 1], meals[mealIndex]] = [meals[mealIndex], meals[mealIndex + 1]];
                  paint();
                },
              },
              '↓',
            ),
            h(
              'button',
              {
                class: 'icon-btn sm danger',
                type: 'button',
                title: 'Remove meal',
                onclick: () => {
                  meals.splice(mealIndex, 1);
                  paint();
                },
              },
              renderIcon('trash', { size: 14 }),
            ),
          ),
          meal.items.length
            ? h(
                'div',
                { class: 'fit-ex-list' },
                h(
                  'div',
                  { class: 'fit-item-row fit-ex-header' },
                  h('span', {}, '#'),
                  h('span', {}, 'Food'),
                  h('span', {}, 'Portion'),
                  h('span', {}, 'Kcal'),
                  h('span', {}, 'P'),
                  h('span', {}, 'C'),
                  h('span', {}, 'F'),
                  h('span', {}, ''),
                ),
                ...meal.items.map((item, itemIndex) => itemRow(meal, item, itemIndex)),
                h(
                  'div',
                  { class: 'fit-meal-total' },
                  h('strong', {}, `${Math.round(totals.calories)} kcal`),
                  h('span', {}, `P ${Math.round(totals.protein_g)}g`),
                  h('span', {}, `C ${Math.round(totals.carbs_g)}g`),
                  h('span', {}, `F ${Math.round(totals.fats_g)}g`),
                ),
              )
            : h('div', { class: 'fit-empty-inline' }, 'No foods in this meal yet.'),
          h(
            'button',
            {
              class: 'btn sm ghost',
              type: 'button',
              onclick: () => {
                meal.items.push({ food_name: '', portion_size: '100g', calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0 });
                paint();
              },
            },
            '＋ Add food',
          ),
        ),
      );
    });

    wrap.append(
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          disabled: meals.length >= 12,
          onclick: () => {
            meals.push({ meal_name: '', meal_time: '', notes: '', items: [] });
            paint();
          },
        },
        '＋ Add meal',
      ),
    );
  }

  paint();
  return {
    node: wrap,
    getValue: () =>
      meals
        .map((meal) => ({
          ...meal,
          meal_time: meal.meal_time || null,
          items: meal.items.filter((i) => i.food_name.trim()),
        }))
        .filter((meal) => meal.meal_name.trim()),
    dayTotals: () =>
      meals
        .flatMap((m) => m.items)
        .reduce(
          (acc, i) => ({
            calories: acc.calories + (i.calories || 0),
            protein_g: acc.protein_g + (i.protein_g || 0),
            carbs_g: acc.carbs_g + (i.carbs_g || 0),
            fats_g: acc.fats_g + (i.fats_g || 0),
          }),
          { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0 },
        ),
  };
}

async function openDietTemplateForm({ template, onSaved }) {
  const [{ items: library }, full] = await Promise.all([
    api.foods(),
    template ? api.dietTemplate(template.id) : Promise.resolve(null),
  ]);

  const editor = dietMealsEditor(full?.meals ?? [], library);
  const form = buildForm(
    [
      { name: 'name', label: 'Plan name', required: true, full: true, value: full?.name ?? '', placeholder: 'e.g. Fat Loss — 1800 kcal' },
      { name: 'goal', label: 'Goal', type: 'select', options: DIET_GOALS, value: full?.goal ?? 'fat_loss' },
      { name: 'target_calories', label: 'Daily calories', type: 'number', required: true, min: 500, max: 10000, value: full?.target_calories ?? 2000 },
      { name: 'target_protein_g', label: 'Protein (g)', type: 'number', min: 0, value: full?.target_protein_g ?? 150 },
      { name: 'target_carbs_g', label: 'Carbs (g)', type: 'number', min: 0, value: full?.target_carbs_g ?? 200 },
      { name: 'target_fats_g', label: 'Fats (g)', type: 'number', min: 0, value: full?.target_fats_g ?? 60 },
      { name: 'target_water_ml', label: 'Water (ml)', type: 'number', min: 0, value: full?.target_water_ml ?? 3000 },
      { name: 'description', label: 'Description', type: 'textarea', full: true, value: full?.description ?? '' },
    ],
    {
      wide: true,
      submitLabel: template ? 'Save diet' : 'Create diet',
      onSubmit: async (values) => {
        const payload = {
          ...values,
          target_calories: Number(values.target_calories),
          target_protein_g: Number(values.target_protein_g),
          target_carbs_g: Number(values.target_carbs_g),
          target_fats_g: Number(values.target_fats_g),
          target_water_ml: Number(values.target_water_ml),
          meals: editor.getValue(),
        };
        if (template) await api.updateDietTemplate(template.id, payload);
        else await api.createDietTemplate(payload);
        closeModal();
        toast(template ? 'Diet plan updated' : 'Diet plan created');
        await onSaved();
      },
    },
  );

  form.querySelector('.form-grid').after(
    h(
      'div',
      { class: 'fit-builder-wrap' },
      h('h4', { class: 'fit-builder-title' }, 'Meals'),
      h(
        'datalist',
        { id: 'fit-food-options' },
        ...library.map((f) => h('option', { value: f.name }, `${f.calories} kcal / ${f.serving_unit}`)),
      ),
      editor.node,
    ),
  );

  openModal({ title: template ? `Edit · ${template.name}` : 'New diet plan', body: form, wide: true });
}

/* ── Tabs ──────────────────────────────────────────────────────────────── */

const macroPills = (plan) =>
  h(
    'div',
    { class: 'fit-macro-pills' },
    h('span', { class: 'fit-pill kcal' }, `${plan.target_calories} kcal`),
    h('span', { class: 'fit-pill protein' }, `P ${plan.target_protein_g}g`),
    h('span', { class: 'fit-pill carbs' }, `C ${plan.target_carbs_g}g`),
    h('span', { class: 'fit-pill fats' }, `F ${plan.target_fats_g}g`),
  );

async function renderWorkoutTemplates(reload) {
  const { items } = await api.workoutTemplates();
  const grid = h('div', { class: 'fit-card-grid' });

  if (!items.length) {
    grid.append(h('div', { class: 'empty' }, 'No workout plans yet — build your first routine.'));
  }

  for (const template of items) {
    grid.append(
      h(
        'div',
        { class: 'card fit-plan-card' },
        h(
          'div',
          { class: 'fit-plan-head' },
          h('div', { class: 'fit-plan-icon' }, renderIcon('weight', { size: 20 })),
          h(
            'div',
            {},
            h('div', { class: 'fit-plan-name' }, template.name),
            h(
              'div',
              { class: 'row', style: 'gap:6px;margin-top:4px' },
              h('span', { class: `badge ${GOAL_TONE[template.goal] || 'grey'}` }, labelOf(WORKOUT_GOALS, template.goal)),
              h('span', { class: 'badge grey' }, labelOf(LEVELS, template.level)),
            ),
          ),
        ),
        template.description ? h('p', { class: 'muted fit-plan-desc' }, template.description) : null,
        h(
          'div',
          { class: 'fit-plan-stats' },
          h('div', {}, h('strong', {}, template.day_count), h('span', {}, 'days')),
          h('div', {}, h('strong', {}, template.exercise_count), h('span', {}, 'exercises')),
          h('div', {}, h('strong', {}, template.active_members), h('span', {}, 'on this plan')),
        ),
        h(
          'div',
          { class: 'row wrap', style: 'gap:6px' },
          h(
            'button',
            { class: 'btn sm', onclick: clickAsync(() => openWorkoutTemplateForm({ template, onSaved: reload })) },
            'Edit routine',
          ),
          h(
            'button',
            {
              class: 'btn sm ghost',
              onclick: clickAsync(async () => {
                const full = await api.workoutTemplate(template.id);
                openModal({
                  title: full.name,
                  wide: true,
                  body: h(
                    'div',
                    { class: 'fit-preview' },
                    ...full.days.map((day) =>
                      h(
                        'div',
                        { class: 'fit-preview-day' },
                        h('h4', {}, day.day_name),
                        day.notes ? h('p', { class: 'muted' }, day.notes) : null,
                        table(
                          [
                            { label: 'Exercise', render: (r) => r.exercise_name },
                            { label: 'Muscle', render: (r) => h('span', { class: 'badge grey' }, labelOf(MUSCLE_GROUPS, r.muscle_group)) },
                            { label: 'Sets × reps', render: (r) => `${r.target_sets} × ${r.target_reps}` },
                            { label: 'Rest', align: 'right', render: (r) => `${r.rest_seconds}s` },
                          ],
                          day.exercises,
                          { empty: 'No exercises' },
                        ),
                      ),
                    ),
                  ),
                });
              }),
            },
            'Preview',
          ),
          h(
            'button',
            {
              class: 'btn sm danger',
              onclick: () =>
                confirmDialog({
                  title: `Delete ${template.name}?`,
                  message: 'The routine and all of its days are removed. Members already assigned to it must be reassigned first.',
                  confirmLabel: 'Delete plan',
                  danger: true,
                  onConfirm: async () => {
                    await api.deleteWorkoutTemplate(template.id);
                    toast('Workout plan deleted');
                    await reload();
                  },
                }),
            },
            'Delete',
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'fit-tab-head' },
      h('p', { class: 'muted' }, 'Routines your trainers assign to members. Editing a plan reaches everyone training on it.'),
      h(
        'button',
        { class: 'btn primary', onclick: clickAsync(() => openWorkoutTemplateForm({ onSaved: reload })) },
        '＋ New workout plan',
      ),
    ),
    grid,
  );
}

async function renderDietTemplates(reload) {
  const { items } = await api.dietTemplates();
  const grid = h('div', { class: 'fit-card-grid' });

  if (!items.length) {
    grid.append(h('div', { class: 'empty' }, 'No diet plans yet — build your first one.'));
  }

  for (const template of items) {
    grid.append(
      h(
        'div',
        { class: 'card fit-plan-card' },
        h(
          'div',
          { class: 'fit-plan-head' },
          h('div', { class: 'fit-plan-icon diet' }, renderIcon('apple', { size: 20 })),
          h(
            'div',
            {},
            h('div', { class: 'fit-plan-name' }, template.name),
            h(
              'div',
              { style: 'margin-top:4px' },
              h('span', { class: `badge ${GOAL_TONE[template.goal] || 'grey'}` }, labelOf(DIET_GOALS, template.goal)),
            ),
          ),
        ),
        template.description ? h('p', { class: 'muted fit-plan-desc' }, template.description) : null,
        macroPills(template),
        h(
          'div',
          { class: 'fit-plan-stats' },
          h('div', {}, h('strong', {}, template.meal_count), h('span', {}, 'meals')),
          h('div', {}, h('strong', {}, template.item_count), h('span', {}, 'foods')),
          h('div', {}, h('strong', {}, template.active_members), h('span', {}, 'on this diet')),
        ),
        h(
          'div',
          { class: 'row wrap', style: 'gap:6px' },
          h('button', { class: 'btn sm', onclick: clickAsync(() => openDietTemplateForm({ template, onSaved: reload })) }, 'Edit meals'),
          h(
            'button',
            {
              class: 'btn sm ghost',
              onclick: clickAsync(async () => {
                const full = await api.dietTemplate(template.id);
                openModal({
                  title: full.name,
                  wide: true,
                  body: h(
                    'div',
                    { class: 'fit-preview' },
                    macroPills(full),
                    ...full.meals.map((meal) =>
                      h(
                        'div',
                        { class: 'fit-preview-day' },
                        h('h4', {}, `${meal.meal_name}${meal.meal_time ? ` · ${meal.meal_time}` : ''}`),
                        table(
                          [
                            { label: 'Food', render: (r) => r.food_name },
                            { label: 'Portion', render: (r) => h('span', { class: 'muted' }, r.portion_size) },
                            { label: 'Kcal', align: 'right', render: (r) => r.calories },
                            { label: 'P', align: 'right', render: (r) => `${r.protein_g}g` },
                            { label: 'C', align: 'right', render: (r) => `${r.carbs_g}g` },
                            { label: 'F', align: 'right', render: (r) => `${r.fats_g}g` },
                          ],
                          meal.items,
                          { empty: 'No foods' },
                        ),
                      ),
                    ),
                  ),
                });
              }),
            },
            'Preview',
          ),
          h(
            'button',
            {
              class: 'btn sm danger',
              onclick: () =>
                confirmDialog({
                  title: `Delete ${template.name}?`,
                  message: 'The diet and all of its meals are removed. Members already on it must be reassigned first.',
                  confirmLabel: 'Delete diet',
                  danger: true,
                  onConfirm: async () => {
                    await api.deleteDietTemplate(template.id);
                    toast('Diet plan deleted');
                    await reload();
                  },
                }),
            },
            'Delete',
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'fit-tab-head' },
      h('p', { class: 'muted' }, 'Calorie and macro targets, with the meals that get a member there.'),
      h('button', { class: 'btn primary', onclick: clickAsync(() => openDietTemplateForm({ onSaved: reload })) }, '＋ New diet plan'),
    ),
    grid,
  );
}

/**
 * A searchable catalogue with a live filter.
 *
 * Filtering happens in the browser off one fetch rather than a request per
 * keystroke: the whole library is a few hundred rows, so a round trip per
 * letter would be slower and worse.
 */
function libraryTab({ items, columns, filters, searchPlaceholder, onAdd, addLabel, intro }) {
  let query = '';
  let filter = '';
  const body = h('div', {});

  function paint() {
    const needle = query.trim().toLowerCase();
    const rows = items.filter(
      (item) => (!filter || item[filters.key] === filter) && (!needle || item.name.toLowerCase().includes(needle)),
    );
    clear(body).append(
      h('div', { class: 'muted fit-count' }, `${rows.length} of ${items.length}`),
      table(columns, rows, { empty: 'Nothing matches that search' }),
    );
  }

  const search = h('input', {
    type: 'search',
    placeholder: searchPlaceholder,
    oninput: (event) => {
      query = event.target.value;
      paint();
    },
  });

  const chips = h(
    'div',
    { class: 'fit-chip-row' },
    ...[{ value: '', label: 'All' }, ...filters.options].map((option) =>
      h(
        'button',
        {
          class: `fit-chip${option.value === filter ? ' active' : ''}`,
          type: 'button',
          onclick: (event) => {
            filter = option.value;
            for (const el of chips.children) el.classList.remove('active');
            event.currentTarget.classList.add('active');
            paint();
          },
        },
        option.label,
      ),
    ),
  );

  paint();
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'fit-tab-head' },
      h('p', { class: 'muted' }, intro),
      onAdd ? h('button', { class: 'btn primary', onclick: onAdd }, addLabel) : null,
    ),
    h('div', { class: 'fit-library-controls' }, search, chips),
    body,
  );
}

async function renderExerciseLibrary(reload) {
  const { items } = await api.exercises();
  return libraryTab({
    items,
    intro: 'The vocabulary every routine is written against. Add your own for anything unusual in your gym.',
    searchPlaceholder: 'Search exercises…',
    filters: { key: 'muscle_group', options: MUSCLE_GROUPS },
    addLabel: '＋ Add exercise',
    onAdd: () =>
      openModal({
        title: 'Add an exercise',
        body: buildForm(
          [
            { name: 'name', label: 'Exercise name', required: true, full: true, placeholder: 'e.g. Landmine Press' },
            { name: 'muscle_group', label: 'Muscle group', type: 'select', options: MUSCLE_GROUPS },
            {
              name: 'equipment',
              label: 'Equipment',
              type: 'select',
              options: EQUIPMENT.map((e) => ({ value: e, label: e.replace(/^./, (c) => c.toUpperCase()) })),
            },
            { name: 'instructions', label: 'Cues (optional)', type: 'textarea', full: true },
          ],
          {
            submitLabel: 'Add exercise',
            onSubmit: async (values) => {
              await api.createExercise(values);
              closeModal();
              toast('Exercise added');
              await reload();
            },
          },
        ),
      }),
    columns: [
      { label: 'Exercise', render: (r) => h('strong', {}, r.name) },
      { label: 'Muscle', render: (r) => h('span', { class: 'badge grey' }, labelOf(MUSCLE_GROUPS, r.muscle_group)) },
      { label: 'Equipment', render: (r) => h('span', { class: 'muted', style: 'text-transform:capitalize' }, r.equipment) },
      { label: 'Source', render: (r) => (r.is_custom ? h('span', { class: 'badge blue' }, 'Yours') : h('span', { class: 'muted' }, 'Standard')) },
      {
        label: '',
        align: 'right',
        render: (r) =>
          r.is_custom
            ? h(
                'button',
                {
                  class: 'btn sm danger',
                  onclick: clickAsync(async () => {
                    await api.deleteExercise(r.id);
                    toast('Exercise removed');
                    await reload();
                  }),
                },
                'Remove',
              )
            : null,
      },
    ],
  });
}

async function renderFoodLibrary(reload) {
  const { items } = await api.foods();
  return libraryTab({
    items,
    intro: 'Calories and macros per serving. Members search this when logging their meals.',
    searchPlaceholder: 'Search foods…',
    filters: { key: 'category', options: FOOD_CATEGORIES },
    addLabel: '＋ Add food',
    onAdd: () =>
      openModal({
        title: 'Add a food',
        body: buildForm(
          [
            { name: 'name', label: 'Food name', required: true, full: true, placeholder: 'e.g. Protein Ladoo' },
            { name: 'category', label: 'Category', type: 'select', options: FOOD_CATEGORIES },
            { name: 'serving_unit', label: 'Serving', value: '100g', hint: 'What the numbers below describe' },
            { name: 'calories', label: 'Calories', type: 'number', required: true, min: 0 },
            { name: 'protein_g', label: 'Protein (g)', type: 'number', min: 0, step: '0.1' },
            { name: 'carbs_g', label: 'Carbs (g)', type: 'number', min: 0, step: '0.1' },
            { name: 'fats_g', label: 'Fats (g)', type: 'number', min: 0, step: '0.1' },
          ],
          {
            submitLabel: 'Add food',
            onSubmit: async (values) => {
              await api.createFood({
                ...values,
                calories: Number(values.calories),
                protein_g: Number(values.protein_g || 0),
                carbs_g: Number(values.carbs_g || 0),
                fats_g: Number(values.fats_g || 0),
              });
              closeModal();
              toast('Food added');
              await reload();
            },
          },
        ),
      }),
    columns: [
      { label: 'Food', render: (r) => h('strong', {}, r.name) },
      { label: 'Serving', render: (r) => h('span', { class: 'muted' }, r.serving_unit) },
      { label: 'Kcal', align: 'right', render: (r) => r.calories },
      { label: 'Protein', align: 'right', render: (r) => `${r.protein_g}g` },
      { label: 'Carbs', align: 'right', render: (r) => `${r.carbs_g}g` },
      { label: 'Fats', align: 'right', render: (r) => `${r.fats_g}g` },
      { label: 'Category', render: (r) => h('span', { class: 'badge grey' }, labelOf(FOOD_CATEGORIES, r.category)) },
      {
        label: '',
        align: 'right',
        render: (r) =>
          r.is_custom
            ? h(
                'button',
                {
                  class: 'btn sm danger',
                  onclick: clickAsync(async () => {
                    await api.deleteFood(r.id);
                    toast('Food removed');
                    await reload();
                  }),
                },
                'Remove',
              )
            : null,
      },
    ],
  });
}

async function renderAddonSettings(reload) {
  const [{ settings, stats, bundled_plans: bundledPlans }, subscribers] = await Promise.all([
    api.fitnessAddonSettings(),
    api.fitnessAddons({ status: 'active' }),
  ]);

  const canEdit = session.managesBilling;

  const form = buildForm(
    [
      {
        name: 'enabled',
        label: 'Charge for Diet & Workout tracking',
        type: 'select',
        value: String(settings.enabled),
        options: [
          { value: '1', label: 'Yes — sell it as a monthly add-on' },
          { value: '0', label: 'No — every member gets it free' },
        ],
        full: true,
        hint: 'Turning this off removes the paywall for everyone, including members who never bought the add-on.',
      },
      { name: 'monthly_price', label: 'Monthly price', type: 'number', min: 0, step: '0.01', value: settings.monthly_price },
      {
        name: 'trial_days',
        label: 'Free trial (days)',
        type: 'number',
        min: 0,
        max: 365,
        value: settings.trial_days,
        hint: 'Counted from the day a member joined. 0 for no trial.',
      },
      {
        name: 'description',
        label: 'Pitch shown on the member paywall',
        type: 'textarea',
        full: true,
        value: settings.description,
      },
    ],
    {
      submitLabel: 'Save settings',
      onSubmit: async (values) => {
        await api.updateFitnessAddonSettings({
          enabled: values.enabled === '1',
          monthly_price: Number(values.monthly_price),
          trial_days: Number(values.trial_days),
          description: values.description,
        });
        toast('Add-on settings saved');
        await reload();
      },
    },
  );
  form.querySelector('.modal-foot').style.padding = '8px 0 0';
  if (!canEdit) {
    for (const input of form.querySelectorAll('input, select, textarea, button')) input.disabled = true;
  }

  return h(
    'div',
    { class: 'grid cols-2 top' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'fit-card-title' }, renderIcon('wallet', { size: 16 }), ' Add-on pricing')),
      canEdit
        ? null
        : h('p', { class: 'muted', style: 'font-size:13px' }, 'Only an owner or manager can change what this costs.'),
      form,
    ),
    h(
      'div',
      { class: 'grid', style: 'gap:16px;align-content:start' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'How it is selling')),
        h(
          'div',
          { class: 'fit-plan-stats' },
          h('div', {}, h('strong', {}, stats.active_subscribers), h('span', {}, 'paying now')),
          h('div', {}, h('strong', {}, money(stats.lifetime_revenue)), h('span', {}, 'billed to date')),
          h(
            'div',
            {},
            h('strong', {}, settings.enabled ? money(settings.monthly_price) : 'Free'),
            h('span', {}, 'per month'),
          ),
        ),
        bundledPlans.length
          ? h(
              'p',
              { class: 'muted', style: 'font-size:13px;margin:12px 0 0' },
              'Included free with: ',
              ...bundledPlans.map((p, i) => h('span', {}, i ? ', ' : '', h('strong', {}, p.name))),
              '. Edit a plan on the Plans page to bundle it.',
            )
          : h(
              'p',
              { class: 'muted', style: 'font-size:13px;margin:12px 0 0' },
              'No membership plan bundles this yet. Tick "includes fitness add-on" on a premium plan to throw it in.',
            ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Active subscribers')),
        table(
          [
            { label: 'Member', render: (r) => h('a', { href: `#/members/${r.member_id}` }, `${r.first_name} ${r.last_name || ''}`.trim()) },
            { label: 'Code', render: (r) => h('span', { class: 'muted' }, r.member_code) },
            { label: 'Paid until', render: (r) => r.end_date },
            { label: 'Billed', align: 'right', render: (r) => money(r.price) },
          ],
          subscribers.items,
          { empty: 'Nobody has bought the add-on yet' },
        ),
      ),
    ),
  );
}

/* ── View ──────────────────────────────────────────────────────────────── */

const TABS = [
  { key: 'workouts', label: 'Workout plans', icon: 'weight', render: renderWorkoutTemplates },
  { key: 'diets', label: 'Diet plans', icon: 'apple', render: renderDietTemplates },
  { key: 'exercises', label: 'Exercise library', icon: 'activity', render: renderExerciseLibrary },
  { key: 'foods', label: 'Food library', icon: 'flame', render: renderFoodLibrary },
  { key: 'pricing', label: 'Pricing & add-on', icon: 'wallet', render: renderAddonSettings },
];

export async function renderFitnessPlans() {
  let active = 'workouts';
  const body = h('div', { class: 'fit-tab-body' });
  const tabs = h('div', { class: 'fit-tabs' });

  async function paintBody() {
    clear(body).append(h('div', { class: 'empty' }, 'Loading…'));
    try {
      clear(body).append(await TABS.find((t) => t.key === active).render(show.bind(null, active)));
    } catch (err) {
      clear(body).append(
        h(
          'div',
          { class: 'empty' },
          h('div', {}, err.message || 'Could not load this tab'),
          h('button', { class: 'btn sm', style: 'margin-top:12px', onclick: () => paintBody() }, 'Try again'),
        ),
      );
    }
  }

  async function show(key) {
    active = key;
    for (const el of tabs.children) el.classList.toggle('active', el.dataset.key === key);
    await paintBody();
  }

  append(
    tabs,
    TABS.map((tab) =>
      h(
        'button',
        {
          class: `fit-tab${tab.key === active ? ' active' : ''}`,
          type: 'button',
          dataset: { key: tab.key },
          onclick: () => show(tab.key),
        },
        renderIcon(tab.icon, { size: 15 }),
        h('span', {}, tab.label),
      ),
    ),
  );

  await paintBody();
  return h('div', { class: 'grid', style: 'gap:16px' }, tabs, body);
}
