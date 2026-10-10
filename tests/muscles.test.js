import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

/**
 * The move from eight coarse muscle groups to Hevy's twenty: the name-based
 * re-filing, and upgrading a gym database written before it.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-muscles-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { closeDb, getDb, tenantStorage } = await import('../src/db.js');
const { MUSCLE_GROUPS, muscleGroupOf } = await import('../src/muscles.js');

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('muscleGroupOf', () => {
  it('passes a current group through, normalising its spelling', () => {
    assert.equal(muscleGroupOf('biceps'), 'biceps');
    assert.equal(muscleGroupOf('Upper Back'), 'upper_back');
    assert.equal(muscleGroupOf('lower-back'), 'lower_back');
  });

  it('refuses anything that is not a group', () => {
    assert.equal(muscleGroupOf('quads'), null);
    assert.equal(muscleGroupOf(''), null);
    assert.equal(muscleGroupOf(undefined), null);
  });

  it('files a seeded exercise where the seed now puts it', () => {
    assert.equal(muscleGroupOf('back', 'Lat Pulldown'), 'lats');
    assert.equal(muscleGroupOf('legs', 'Romanian Deadlift'), 'hamstrings');
    assert.equal(muscleGroupOf('arms', 'Skull Crusher'), 'triceps');
  });

  it('places anything else by its name, with a default per legacy group', () => {
    assert.equal(muscleGroupOf('legs', 'Leg Curl (Machine)'), 'hamstrings');
    assert.equal(muscleGroupOf('legs', 'Calf Press'), 'calves');
    assert.equal(muscleGroupOf('back', 'Barbell Shrug'), 'traps');
    assert.equal(muscleGroupOf('arms', 'Cable Kickback'), 'triceps');
    assert.equal(muscleGroupOf('arms', 'Spider Curl'), 'biceps');
    assert.equal(muscleGroupOf('legs', ''), 'quadriceps');
    assert.equal(muscleGroupOf('core', 'Dead Bug'), 'abdominals');
  });

  it('every answer is a current group', () => {
    for (const legacy of ['back', 'legs', 'arms', 'core']) {
      assert.ok(MUSCLE_GROUPS.includes(muscleGroupOf(legacy, 'Anything At All')));
    }
  });
});

describe('upgrading a gym database', () => {
  const file = path.join(tmpDir, 'old-gym.db');

  // The tables as they were created before the Hevy list, CHECK and all, with
  // rows on the old groups. Templates are left empty so the seeder, which
  // writes the new groups, runs on the upgrade open too.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE exercise_library (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      muscle_group TEXT NOT NULL
                   CHECK (muscle_group IN ('chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body')),
      equipment    TEXT NOT NULL DEFAULT 'barbell',
      instructions TEXT,
      is_custom    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_exercise_library_group ON exercise_library(muscle_group);
    INSERT INTO exercise_library (name, muscle_group, equipment, is_custom) VALUES
      ('Lat Pulldown', 'back', 'cable', 0),
      ('House Leg Curl', 'legs', 'machine', 1),
      ('Barbell Bench Press', 'chest', 'barbell', 0);

    CREATE TABLE workout_plan_exercises (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id        INTEGER NOT NULL,
      exercise_name TEXT NOT NULL,
      muscle_group  TEXT NOT NULL
                    CHECK (muscle_group IN ('chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body')),
      target_sets   INTEGER NOT NULL DEFAULT 3 CHECK (target_sets > 0),
      target_reps   TEXT NOT NULL DEFAULT '8-12',
      target_rpe    REAL,
      rest_seconds  INTEGER NOT NULL DEFAULT 90 CHECK (rest_seconds >= 0),
      notes         TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_workout_exercises_day ON workout_plan_exercises(day_id);
    INSERT INTO workout_plan_exercises (day_id, exercise_name, muscle_group) VALUES (999, 'Triceps Pushdown', 'arms');

    CREATE TABLE workout_log_sets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id        INTEGER NOT NULL,
      exercise_name TEXT NOT NULL,
      muscle_group  TEXT NOT NULL DEFAULT 'full_body',
      set_number    INTEGER NOT NULL,
      set_type      TEXT NOT NULL DEFAULT 'normal',
      weight_kg     REAL NOT NULL DEFAULT 0,
      reps          INTEGER NOT NULL DEFAULT 0,
      rpe           REAL,
      est_1rm_kg    REAL NOT NULL DEFAULT 0,
      is_pr         INTEGER NOT NULL DEFAULT 0,
      completed     INTEGER NOT NULL DEFAULT 1,
      notes         TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO workout_log_sets (log_id, exercise_name, muscle_group, set_number) VALUES (1, 'Plank', 'core', 1);
  `);
  old.close();

  const db = tenantStorage.run({ dbFile: file }, () => getDb());
  const groupOf = (table, column, name) => db.prepare(`SELECT muscle_group FROM ${table} WHERE ${column} = ?`).get(name).muscle_group;

  it('drops the old CHECK, keeping the indexes', () => {
    for (const table of ['exercise_library', 'workout_plan_exercises']) {
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      assert.doesNotMatch(sql, /CHECK \(muscle_group/);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((i) => i.name);
    assert.ok(indexes.includes('idx_exercise_library_group'));
    assert.ok(indexes.includes('idx_workout_exercises_day'));
  });

  it('re-files every row on a legacy group', () => {
    assert.equal(groupOf('exercise_library', 'name', 'Lat Pulldown'), 'lats');
    assert.equal(groupOf('exercise_library', 'name', 'House Leg Curl'), 'hamstrings');
    assert.equal(groupOf('exercise_library', 'name', 'Barbell Bench Press'), 'chest');
    assert.equal(groupOf('workout_plan_exercises', 'exercise_name', 'Triceps Pushdown'), 'triceps');
    assert.equal(groupOf('workout_log_sets', 'exercise_name', 'Plank'), 'abdominals');
  });

  it('seeds the templates onto the new groups', () => {
    const legacy = db
      .prepare("SELECT COUNT(*) AS n FROM workout_plan_exercises WHERE muscle_group IN ('back', 'legs', 'arms', 'core')")
      .get().n;
    assert.equal(legacy, 0);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM workout_plans').get().n > 0);
  });
});
