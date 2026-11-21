/**
 * Gym leaderboards: who lifts the most on an exercise among this gym's
 * members, and a head-to-head between two of them.
 *
 * Scoped to the gym on purpose. Every tenant has its own database, so "my gym"
 * is the friend group members already have, and a board of 50-300 people who
 * see each other on the floor is more motivating than a global one.
 *
 * Read straight off workout_log_sets rather than exercise_prs: the monthly
 * board needs per-date bests that exercise_prs does not keep, and a deleted
 * session should leave the board too (exercise_prs deliberately survives one).
 *
 * Nobody appears until they opt in (member_social.show_on_leaderboard). A
 * member who has not opted in can still look, and sees the rank they would
 * have, which is the nudge to join.
 */

import { all, get, run } from './db.js';
import { fitnessSettings } from './fitness.js';
import { PHOTO_JOIN, PHOTO_PRESENT_COL, withPhotoUrl } from './photo.js';
import { addDays, today } from './validate.js';

export const LEADERBOARD_METRICS = ['heaviest', 'e1rm', 'volume'];
export const LEADERBOARD_PERIODS = ['month', 'all'];

/** Epley overestimates badly past about a dozen reps, so a 20-rep set of
 * curls must not outrank a real heavy triple on the 1RM board. */
const MAX_E1RM_REPS = 12;

/** The lifts every gym gets a board for, whether or not anyone has logged
 * them yet. Names match the seeded exercise_library. */
export const FEATURED_EXERCISES = [
  'Barbell Bench Press',
  'Back Squat',
  'Deadlift',
  'Overhead Press',
  'Barbell Row',
  'Lat Pulldown',
  'Leg Press',
  'Barbell Curl',
];

/** Other exercises earn a board once this many visible members have logged them. */
const MIN_PARTICIPANTS_FOR_HUB = 3;

const MAX_ROWS = 50;

/** A set staff removed (lb_hidden) still counts for the member's own records,
 * just not on the board. */
export const QUALIFYING = `s.set_type IN ('normal', 'drop', 'failure') AND s.completed = 1 AND s.weight_kg > 0 AND s.reps > 0 AND s.lb_hidden = 0`;

export function leaderboardConfig() {
  const s = fitnessSettings();
  return { enabled: s.leaderboard_enabled !== 0, default_visible: s.leaderboard_default_visible === 1 };
}

/**
 * SQL for "this member shows on the boards", given `m` (members) and `soc`
 * (member_social, LEFT JOINed). A member's own answer wins; with no answer the
 * gym's default applies; a staff block beats both.
 */
export function visibleSql() {
  const fallback = leaderboardConfig().default_visible ? 1 : 0;
  return `(COALESCE(soc.staff_blocked, 0) = 0 AND m.status = 'active'
           AND (soc.show_on_leaderboard = 1 OR (COALESCE(soc.member_decided, 0) = 0 AND ${fallback} = 1)))`;
}

const METRIC_SQL = {
  heaviest: 'MAX(s.weight_kg)',
  e1rm: `MAX(CASE WHEN s.reps <= ${MAX_E1RM_REPS} THEN s.est_1rm_kg ELSE 0 END)`,
  volume: 'MAX(s.weight_kg * s.reps)',
};

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

export function periodStart(period) {
  return period === 'month' ? `${today().slice(0, 7)}-01` : null;
}

/** "Rahul V." unless the member chose a nickname. */
function defaultDisplayName(member) {
  const last = String(member.last_name ?? '').trim();
  return `${String(member.first_name ?? '').trim()}${last ? ` ${last[0].toUpperCase()}.` : ''}`;
}

export function socialSettings(memberId) {
  const member = get('SELECT first_name, last_name FROM members WHERE id = ?', [memberId]);
  const row = get(
    'SELECT show_on_leaderboard, display_name, updated_at, member_decided, staff_blocked FROM member_social WHERE member_id = ?',
    [memberId],
  );
  const config = leaderboardConfig();
  const decided = row?.member_decided === 1;
  const blocked = row?.staff_blocked === 1;
  return {
    enabled: config.enabled,
    show_on_leaderboard: !blocked && (decided ? row.show_on_leaderboard === 1 : config.default_visible),
    display_name: row?.display_name ?? null,
    default_name: defaultDisplayName(member ?? {}),
    blocked,
    // null until the member has answered the prompt once, either way.
    decided_at: decided ? row.updated_at : null,
  };
}

export function saveSocialSettings(memberId, { show_on_leaderboard, display_name }) {
  run(
    `INSERT INTO member_social (member_id, show_on_leaderboard, display_name, member_decided, updated_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT (member_id) DO UPDATE SET
       show_on_leaderboard = excluded.show_on_leaderboard,
       display_name = excluded.display_name,
       member_decided = 1,
       updated_at = excluded.updated_at`,
    [memberId, show_on_leaderboard ? 1 : 0, display_name || null],
  );
  return socialSettings(memberId);
}

/**
 * Every member's three bests on one exercise, for members who are on the board
 * plus `viewerId` (who may not be). One grouped scan; a gym's sets for a
 * single exercise are a few thousand rows at most.
 */
function bestsFor(exerciseName, { since, viewerId, memberIds } = {}) {
  const params = [exerciseName];
  let where = `s.exercise_name = ? COLLATE NOCASE AND ${QUALIFYING}`;
  if (since) {
    where += ' AND l.log_date >= ?';
    params.push(since);
  }
  const visible = visibleSql();
  let who;
  if (memberIds) {
    who = `m.id IN (${memberIds.map(() => '?').join(', ')})`;
    params.push(...memberIds);
  } else {
    who = `(${visible} OR m.id = ?)`;
    params.push(viewerId ?? 0);
  }
  return all(
    `SELECT m.id AS member_id, m.first_name, m.last_name, m.photo_version, ${PHOTO_PRESENT_COL},
            soc.display_name,
            CASE WHEN ${visible} THEN 1 ELSE 0 END AS visible,
            ${METRIC_SQL.heaviest} AS heaviest_kg,
            ${METRIC_SQL.e1rm} AS e1rm_kg,
            ${METRIC_SQL.volume} AS volume_kg
     FROM workout_log_sets s
     JOIN workout_logs l ON l.id = s.log_id
     JOIN members m ON m.id = l.member_id
     LEFT JOIN member_social soc ON soc.member_id = m.id
     ${PHOTO_JOIN}
     WHERE ${where} AND ${who}
     GROUP BY m.id`,
    params,
  ).map((row) => {
    const { first_name, last_name, display_name, ...rest } = withPhotoUrl(row, 'member_id');
    return {
      ...rest,
      name: display_name || defaultDisplayName({ first_name, last_name }),
      visible: row.visible === 1,
      heaviest_kg: round1(row.heaviest_kg),
      e1rm_kg: round1(row.e1rm_kg),
      volume_kg: round1(row.volume_kg),
    };
  });
}

/** Standard competition ranking (1, 2, 2, 4) on `key`, best first. */
function ranked(rows, key) {
  const sorted = rows.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key] || a.member_id - b.member_id);
  let rank = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row[key] < sorted[index - 1][key]) rank = index + 1;
    return { ...row, rank };
  });
}

const publicRow = (row, key, viewerId) => ({
  rank: row.rank,
  member_id: row.member_id,
  name: row.member_id === viewerId ? 'You' : row.name,
  photo_url: row.photo_url,
  value_kg: row[key],
  is_me: row.member_id === viewerId,
});

export function exerciseLeaderboard(exerciseName, { metric, period, viewerId }) {
  const key = `${metric}_kg`;
  const rows = bestsFor(exerciseName, { since: periodStart(period), viewerId });
  const viewer = socialSettings(viewerId);
  const joined = viewer.show_on_leaderboard;
  // The list everyone sees holds only members who joined. A viewer who has
  // not joined is ranked separately, as if they had (that's the pitch to
  // join), without pushing anyone on the real list down a place.
  const board = ranked(rows.filter((r) => r.visible), key);
  const meRow = ranked(rows.filter((r) => r.visible || r.member_id === viewerId), key).find((r) => r.member_id === viewerId) ?? null;
  return {
    exercise_name: exerciseName,
    metric,
    period,
    joined,
    blocked: viewer.blocked,
    total: board.length,
    items: board.slice(0, MAX_ROWS).map((r) => publicRow(r, key, viewerId)),
    me: meRow ? publicRow(meRow, key, viewerId) : null,
  };
}

/** The boards worth showing on the hub: the featured lifts plus anything enough
 * members at this gym actually train, each with its leader and the viewer's rank. */
export function boardExercises(period) {
  const since = periodStart(period);
  const params = [];
  let dateClause = '';
  if (since) {
    dateClause = 'AND l.log_date >= ?';
    params.push(since);
  }
  const popular = all(
    `SELECT s.exercise_name, COUNT(DISTINCT l.member_id) AS n
     FROM workout_log_sets s
     JOIN workout_logs l ON l.id = s.log_id
     JOIN members m ON m.id = l.member_id
     LEFT JOIN member_social soc ON soc.member_id = m.id
     WHERE ${QUALIFYING} ${dateClause} AND ${visibleSql()}
     GROUP BY s.exercise_name COLLATE NOCASE
     HAVING n >= ?
     ORDER BY n DESC
     LIMIT 20`,
    [...params, MIN_PARTICIPANTS_FOR_HUB],
  ).map((r) => r.exercise_name);

  const seen = new Set();
  return [...FEATURED_EXERCISES, ...popular].filter((name) => {
    const k = name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function leaderboardHub({ metric, period, viewerId }) {
  const names = boardExercises(period);
  const library = new Map(
    all('SELECT name, muscle_group, equipment FROM exercise_library').map((e) => [e.name.toLowerCase(), e]),
  );
  return names.map((name) => {
    const board = exerciseLeaderboard(name, { metric, period, viewerId });
    const lib = library.get(name.toLowerCase());
    return {
      exercise_name: name,
      muscle_group: lib?.muscle_group ?? null,
      equipment: lib?.equipment ?? null,
      participants: board.total,
      leader: board.items[0] ?? null,
      me: board.me,
    };
  });
}

/**
 * Head-to-head on one exercise. `gap_pct` is how far behind the viewer is on
 * each metric (negative when ahead), the way Hevy's "↓ 66%" reads: 22 vs 65 is
 * 66% short. "Stronger" goes by estimated 1RM, the fairest single number.
 */
export function compareMembers(exerciseName, { viewerId, otherId, period }) {
  const rows = bestsFor(exerciseName, { since: periodStart(period), memberIds: [viewerId, otherId] });
  const other = get(
    `SELECT m.id, CASE WHEN ${visibleSql()} THEN 1 ELSE 0 END AS visible
     FROM members m LEFT JOIN member_social soc ON soc.member_id = m.id WHERE m.id = ?`,
    [otherId],
  );
  if (!other || other.visible !== 1) return null;

  const blank = (id) => {
    const m = get(`SELECT m.id AS member_id, m.first_name, m.last_name, m.photo_version, ${PHOTO_PRESENT_COL},
                          soc.display_name
                   FROM members m LEFT JOIN member_social soc ON soc.member_id = m.id ${PHOTO_JOIN} WHERE m.id = ?`, [id]);
    const { first_name, last_name, display_name, ...rest } = withPhotoUrl(m, 'member_id');
    return { ...rest, name: display_name || defaultDisplayName({ first_name, last_name }), heaviest_kg: 0, e1rm_kg: 0, volume_kg: 0 };
  };
  const pick = (id) => {
    const row = rows.find((r) => r.member_id === id) ?? blank(id);
    return {
      member_id: row.member_id,
      name: row.name,
      photo_url: row.photo_url,
      heaviest_kg: row.heaviest_kg,
      e1rm_kg: row.e1rm_kg,
      volume_kg: row.volume_kg,
    };
  };
  const me = pick(viewerId);
  const them = pick(otherId);
  const gap = (mine, theirs) => {
    const top = Math.max(mine, theirs);
    if (!top || mine === theirs) return 0;
    return Math.round(((theirs - mine) / top) * 100);
  };
  let stronger = null;
  if (me.e1rm_kg !== them.e1rm_kg) stronger = me.e1rm_kg > them.e1rm_kg ? 'me' : 'them';

  return {
    exercise_name: exerciseName,
    period,
    me,
    them,
    stronger,
    metrics: LEADERBOARD_METRICS.map((metric) => ({
      metric,
      mine: me[`${metric}_kg`],
      theirs: them[`${metric}_kg`],
      gap_pct: gap(me[`${metric}_kg`], them[`${metric}_kg`]),
    })),
  };
}

/* ── Staff moderation ─────────────────────────────────────────────────── */
// The unit staff act on is one exercise in one session (log_id + exercise
// name): a faked entry is usually every set of it, and hiding only the top set
// would just promote the next fake one.

/** A jump this big over the member's own previous best gets a second look. */
const FLAG_RATIO = 1.5;
const FLAG_MIN_JUMP_KG = 10;
const FLAG_WINDOW_DAYS = 30;

const staffName = (row) => `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();

/**
 * Recent lifts that jumped well past the member's previous best on that
 * exercise, not yet checked by staff. Only members who show on the boards:
 * a hidden member's typo hurts nobody.
 */
export function flaggedLifts() {
  const since = addDays(today(), -FLAG_WINDOW_DAYS);
  const rows = all(
    `SELECT * FROM (
       SELECT s.id AS set_id, l.id AS log_id, s.exercise_name, s.weight_kg, s.reps, l.log_date,
              m.id AS member_id, m.first_name, m.last_name, m.code AS member_code, soc.display_name,
              (SELECT MAX(s2.weight_kg)
                 FROM workout_log_sets s2 JOIN workout_logs l2 ON l2.id = s2.log_id
                WHERE l2.member_id = l.member_id AND s2.exercise_name = s.exercise_name COLLATE NOCASE
                  AND s2.set_type IN ('normal', 'drop', 'failure') AND s2.completed = 1 AND s2.weight_kg > 0
                  AND (l2.log_date < l.log_date OR (l2.log_date = l.log_date AND l2.id < l.id))) AS previous_best_kg
         FROM workout_log_sets s
         JOIN workout_logs l ON l.id = s.log_id
         JOIN members m ON m.id = l.member_id
         LEFT JOIN member_social soc ON soc.member_id = m.id
        WHERE ${QUALIFYING} AND s.lb_reviewed = 0 AND l.log_date >= ? AND ${visibleSql()}
     )
     WHERE previous_best_kg > 0 AND weight_kg >= previous_best_kg * ? AND weight_kg - previous_best_kg >= ?
     ORDER BY log_date DESC, weight_kg DESC
     LIMIT 300`,
    [since, FLAG_RATIO, FLAG_MIN_JUMP_KG],
  );
  // One entry per exercise per session, at its heaviest set.
  const seen = new Set();
  return rows
    .filter((r) => {
      const key = `${r.log_id}|${r.exercise_name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100)
    .map((r) => ({
      log_id: r.log_id,
      member_id: r.member_id,
      member_name: staffName(r),
      member_code: r.member_code,
      display_name: r.display_name,
      exercise_name: r.exercise_name,
      weight_kg: r.weight_kg,
      reps: r.reps,
      previous_best_kg: r.previous_best_kg,
      log_date: r.log_date,
    }));
}

const VALUE_SQL = {
  heaviest: 's.weight_kg',
  e1rm: 's.est_1rm_kg',
  volume: 's.weight_kg * s.reps',
};

/** One board as staff see it: real names, and the session each best came
 * from so it can be removed. */
export function staffBoard(exerciseName, { metric, period }) {
  const params = [exerciseName];
  let where = `s.exercise_name = ? COLLATE NOCASE AND ${QUALIFYING}`;
  if (metric === 'e1rm') where += ` AND s.reps <= ${MAX_E1RM_REPS}`;
  const since = periodStart(period);
  if (since) {
    where += ' AND l.log_date >= ?';
    params.push(since);
  }
  const rows = all(
    `SELECT * FROM (
       SELECT s.id AS set_id, l.id AS log_id, s.exercise_name, s.weight_kg, s.reps, l.log_date, s.lb_reviewed,
              m.id AS member_id, m.first_name, m.last_name, m.code AS member_code, soc.display_name,
              ${VALUE_SQL[metric]} AS value_kg,
              ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY ${VALUE_SQL[metric]} DESC, l.log_date, s.id) AS rn
         FROM workout_log_sets s
         JOIN workout_logs l ON l.id = s.log_id
         JOIN members m ON m.id = l.member_id
         LEFT JOIN member_social soc ON soc.member_id = m.id
        WHERE ${where} AND ${visibleSql()}
     ) WHERE rn = 1 AND value_kg > 0
     ORDER BY value_kg DESC, member_id
     LIMIT 100`,
    params,
  );
  let rank = 0;
  return rows.map((r, i) => {
    if (i === 0 || r.value_kg < rows[i - 1].value_kg) rank = i + 1;
    return {
      rank,
      log_id: r.log_id,
      member_id: r.member_id,
      member_name: staffName(r),
      member_code: r.member_code,
      display_name: r.display_name,
      exercise_name: r.exercise_name,
      weight_kg: r.weight_kg,
      reps: r.reps,
      value_kg: round1(r.value_kg),
      log_date: r.log_date,
      reviewed: r.lb_reviewed === 1,
    };
  });
}

/** Sets one exercise in one session apart; returns how many rows changed. */
export function markSessionLift(logId, exerciseName, { hidden, reviewed }) {
  const sets = [];
  const params = [];
  if (hidden !== undefined) {
    sets.push('lb_hidden = ?');
    params.push(hidden ? 1 : 0);
  }
  if (reviewed !== undefined) {
    sets.push('lb_reviewed = ?');
    params.push(reviewed ? 1 : 0);
  }
  return run(`UPDATE workout_log_sets SET ${sets.join(', ')} WHERE log_id = ? AND exercise_name = ? COLLATE NOCASE`, [
    ...params,
    logId,
    exerciseName,
  ]).changes;
}

export function hiddenLifts() {
  return all(
    `SELECT l.id AS log_id, s.exercise_name, MAX(s.weight_kg) AS weight_kg, l.log_date,
            m.id AS member_id, m.first_name, m.last_name, m.code AS member_code
       FROM workout_log_sets s
       JOIN workout_logs l ON l.id = s.log_id
       JOIN members m ON m.id = l.member_id
      WHERE s.lb_hidden = 1
      GROUP BY l.id, s.exercise_name COLLATE NOCASE
      ORDER BY l.log_date DESC
      LIMIT 200`,
  ).map((r) => ({ ...r, member_name: staffName(r) }));
}

export function blockedMembers() {
  return all(
    `SELECT m.id AS member_id, m.first_name, m.last_name, m.code AS member_code, soc.blocked_reason, soc.blocked_at
       FROM member_social soc JOIN members m ON m.id = soc.member_id
      WHERE soc.staff_blocked = 1
      ORDER BY soc.blocked_at DESC`,
  ).map((r) => ({ ...r, member_name: staffName(r) }));
}

export function setMemberBlocked(memberId, blocked, reason) {
  run(
    `INSERT INTO member_social (member_id, show_on_leaderboard, member_decided, staff_blocked, blocked_reason, blocked_at, updated_at)
     VALUES (?, 0, 0, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END, datetime('now'))
     ON CONFLICT (member_id) DO UPDATE SET
       staff_blocked = excluded.staff_blocked,
       blocked_reason = excluded.blocked_reason,
       blocked_at = excluded.blocked_at`,
    [memberId, blocked ? 1 : 0, blocked ? reason || null : null, blocked ? 1 : 0],
  );
}
