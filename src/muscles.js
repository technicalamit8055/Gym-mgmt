import { EXERCISES } from './fitnessSeed.js';

/**
 * The muscle groups an exercise is filed under — Hevy's list, in the order its
 * "Muscle Group" filter shows them.
 *
 * Kept free of db.js so the tenant migration (db.js → here) and the routes can
 * both import it without a cycle.
 */
export const MUSCLE_GROUPS = [
  'abdominals',
  'abductors',
  'adductors',
  'biceps',
  'calves',
  'cardio',
  'chest',
  'forearms',
  'full_body',
  'glutes',
  'hamstrings',
  'lats',
  'lower_back',
  'neck',
  'quadriceps',
  'shoulders',
  'traps',
  'triceps',
  'upper_back',
  'other',
];

/** The coarse groups used before the Hevy list. Still accepted on input — a
 * workout left open on a phone across the upgrade carries them — and turned
 * into a precise group by muscleGroupOf(). */
export const LEGACY_MUSCLE_GROUPS = ['back', 'legs', 'arms', 'core'];

/** "lower_back" → "Lower Back". */
export const muscleLabel = (group) =>
  String(group ?? '')
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const SEEDED = new Map(EXERCISES.map(([name, group]) => [name.toLowerCase(), group]));

/** Where an exercise filed under a legacy group most likely belongs, read off
 * its name. Order matters: "Leg Curl" is a hamstring move before it is a curl. */
const LEGACY_RULES = {
  back: [
    [/shrug/, 'traps'],
    [/pull-?down|pull-?up|chin-?up|pullover|\blats?\b/, 'lats'],
    [/deadlift|rack pull|good morning|hyperextension|back extension/, 'lower_back'],
  ],
  legs: [
    [/calf|calves/, 'calves'],
    [/abduct/, 'abductors'],
    [/adduct/, 'adductors'],
    [/leg curl|hamstring|romanian|\brdl\b|stiff|good morning|nordic/, 'hamstrings'],
    [/hip thrust|glute|bridge|kickback/, 'glutes'],
  ],
  arms: [
    [/wrist|forearm|reverse curl|farmer/, 'forearms'],
    [/tricep|push-?down|skull|dip|close-?grip|kickback|extension/, 'triceps'],
  ],
  core: [],
};

/** Where a legacy group goes when its name says nothing more specific. */
const LEGACY_DEFAULTS = { back: 'upper_back', legs: 'quadriceps', arms: 'biceps', core: 'abdominals' };

/**
 * The current muscle group for `value`, or null when it is not one.
 *
 * Accepts the legacy coarse groups too: a seeded exercise goes to the group
 * the seed now files it under, anything else is placed by its name.
 */
export function muscleGroupOf(value, exerciseName = '') {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (MUSCLE_GROUPS.includes(key)) return key;
  if (!LEGACY_MUSCLE_GROUPS.includes(key)) return null;
  const name = String(exerciseName ?? '').trim().toLowerCase();
  const seeded = SEEDED.get(name);
  if (seeded) return seeded;
  return LEGACY_RULES[key].find(([pattern]) => pattern.test(name))?.[1] ?? LEGACY_DEFAULTS[key];
}

/**
 * Moves a gym's database onto the Hevy muscle list: drops the old CHECK on the
 * two tables that had one (validation lives in the routes now, against
 * MUSCLE_GROUPS) and re-files every row still on a legacy group. Takes a raw
 * handle — it runs from db.js's migration list, before getDb() can find it.
 * Idempotent: the rebuild is guarded on the old CHECK, the re-filing on rows
 * still carrying a legacy value.
 */
export function migrateMuscleGroups(db) {
  for (const table of ['exercise_library', 'workout_plan_exercises']) dropMuscleCheck(db, table);

  const legacy = LEGACY_MUSCLE_GROUPS.map(() => '?').join(',');
  for (const [table, nameColumn] of [
    ['exercise_library', 'name'],
    ['workout_plan_exercises', 'exercise_name'],
    ['workout_log_sets', 'exercise_name'],
  ]) {
    const rows = db
      .prepare(`SELECT DISTINCT ${nameColumn} AS name, muscle_group FROM ${table} WHERE muscle_group IN (${legacy})`)
      .all(...LEGACY_MUSCLE_GROUPS);
    const update = db.prepare(`UPDATE ${table} SET muscle_group = ? WHERE ${nameColumn} = ? AND muscle_group = ?`);
    for (const row of rows) update.run(muscleGroupOf(row.muscle_group, row.name), row.name, row.muscle_group);
  }
}

/** SQLite cannot drop a constraint, so the table is rebuilt from its own
 * CREATE statement minus the CHECK — which keeps any column added later by
 * ensureColumn — and its indexes are recreated from theirs. */
function dropMuscleCheck(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const check = /\s*CHECK\s*\(\s*muscle_group\s+IN\s*\([^)]*\)\s*\)/i;
  if (!row || !check.test(row.sql)) return;

  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table)
    .map((index) => index.sql);
  const createNew = row.sql
    .replace(check, '')
    .replace(new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["\`]?${table}["\`]?`, 'i'), `CREATE TABLE ${table}_new`);

  db.exec('BEGIN');
  try {
    db.exec(createNew);
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    for (const sql of indexes) db.exec(sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
