import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { get, run } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import {
  LEADERBOARD_METRICS,
  LEADERBOARD_PERIODS,
  blockedMembers,
  boardExercises,
  flaggedLifts,
  hiddenLifts,
  leaderboardConfig,
  markSessionLift,
  setMemberBlocked,
  staffBoard,
} from '../leaderboard.js';
import { parse } from '../validate.js';
import { requireModule } from '../verticals.js';

/**
 * The staff side of the gym leaderboards (src/leaderboard.js): switching them
 * on or off, and keeping them honest.
 *
 * Trainers moderate. They are on the floor and know whether Rahul really
 * curls 60 kg. The gym-wide switches stay with the owner and manager, like
 * the rest of the add-on's settings.
 */
export const leaderboardAdminRoutes = Router();
leaderboardAdminRoutes.use(requireAuth, requireModule('fitness'));

const MODERATES = ['admin', 'manager', 'trainer'];

leaderboardAdminRoutes.get('/settings', (_req, res) => {
  res.json(leaderboardConfig());
});

leaderboardAdminRoutes.put('/settings', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    enabled: { type: 'boolean' },
    default_visible: { type: 'boolean' },
  });
  const columns = { enabled: 'leaderboard_enabled', default_visible: 'leaderboard_default_visible' };
  const keys = Object.keys(body);
  if (!keys.length) throw badRequest('Nothing to update');
  run(
    `UPDATE fitness_addon_settings SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
    keys.map((k) => (body[k] ? 1 : 0)),
  );
  res.json(leaderboardConfig());
});

/** Everything the moderation tab shows on open. */
leaderboardAdminRoutes.get('/overview', requireRole(...MODERATES), (_req, res) => {
  res.json({
    settings: leaderboardConfig(),
    flagged: flaggedLifts(),
    hidden: hiddenLifts(),
    blocked: blockedMembers(),
    exercises: boardExercises('all'),
  });
});

leaderboardAdminRoutes.get('/board', requireRole(...MODERATES), (req, res) => {
  const exercise = String(req.query.exercise ?? '').trim();
  if (!exercise || exercise.length > 120) throw badRequest('Choose an exercise', { exercise: 'required' });
  const metric = LEADERBOARD_METRICS.includes(req.query.metric) ? req.query.metric : 'heaviest';
  const period = LEADERBOARD_PERIODS.includes(req.query.period) ? req.query.period : 'all';
  res.json({ exercise_name: exercise, metric, period, items: staffBoard(exercise, { metric, period }) });
});

const liftBody = (body) =>
  parse(body, {
    log_id: { type: 'int', required: true, min: 1 },
    exercise_name: { type: 'string', required: true, min: 1, max: 120 },
  });

/** `action`: remove (off the boards), restore (back on, and marked checked),
 * approve (checked, it's real: stops it being flagged again). */
leaderboardAdminRoutes.post('/lifts/:action', requireRole(...MODERATES), (req, res) => {
  const { log_id: logId, exercise_name: exerciseName } = liftBody(req.body);
  const change = { remove: { hidden: true }, restore: { hidden: false, reviewed: true }, approve: { reviewed: true } }[req.params.action];
  if (!change) throw notFound('Unknown action');
  if (!markSessionLift(logId, exerciseName, change)) throw notFound('That lift was not found');
  res.json({ ok: true });
});

leaderboardAdminRoutes.post('/members/:id/block', requireRole(...MODERATES), (req, res) => {
  const memberId = Number(req.params.id);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Member not found');
  const body = parse(req.body ?? {}, { reason: { type: 'string', max: 200 } });
  setMemberBlocked(memberId, true, body.reason);
  res.json({ ok: true });
});

leaderboardAdminRoutes.post('/members/:id/unblock', requireRole(...MODERATES), (req, res) => {
  const memberId = Number(req.params.id);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Member not found');
  setMemberBlocked(memberId, false);
  res.json({ ok: true });
});
