/**
 * The "what next?" engine behind the suggestion chip on the set table: given
 * the plan's rep target, what the member has already done this session and
 * what they did last time, it proposes the next set's weight and reps.
 *
 * Plain rules, not a model — the same double progression a coach would use
 * (and what Liftosaur and MacroFactor do): work up through the rep range at a
 * weight, add a step once the top of the range comes easily, and back off when
 * a set falls short or fails. That keeps it instant, free and working with no
 * signal on the gym floor; the Ask Coach chat is there for the "why?".
 *
 * No DOM here, so node's test runner imports it as-is.
 */

const LB_PER_KG = 2.20462;

/** The effort chips under a ticked set, as the RPE they are stored as. */
export const EFFORTS = [
  { rpe: 6, key: 'easy', label: 'Easy' },
  { rpe: 8, key: 'good', label: 'Good' },
  { rpe: 9, key: 'hard', label: 'Hard' },
  { rpe: 10, key: 'failed', label: 'Failed' },
];

/** The range used when the plan gives none — the classic hypertrophy band. */
const DEFAULT_RANGE = { lo: 8, hi: 12, assumed: true };

/** "8-12", "8–12", "10", "12 reps" → { lo, hi }. Anything unreadable falls
 * back to 8–12 and says so with `assumed`. */
export function parseRepRange(text) {
  const nums = (String(text ?? '').match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n <= 100);
  if (!nums.length) return { ...DEFAULT_RANGE };
  const lo = Math.min(nums[0], nums[1] ?? nums[0]);
  const hi = Math.max(nums[0], nums[1] ?? nums[0]);
  return { lo, hi, assumed: false };
}

/** The smallest sensible jump on this kit, in the member's display unit: a
 * pair of 2.5 kg plates on a bar (gyms rarely have 1.25 kg ones), the next
 * dumbbell in the rack, the next pin on a stack. */
export function weightStep(equipment, unit = 'kg') {
  if (unit === 'lb') return equipment === 'machine' ? 10 : 5;
  if (equipment === 'machine' || equipment === 'barbell' || equipment === 'smith_machine') return 5;
  if (equipment === 'kettlebell') return 4;
  return 2.5;
}

const fix = (value) => Math.round(value * 100) / 100;
const roundTo = (value, step) => fix(Math.round(value / step) * step);
const toDisplay = (kg, unit) => (unit === 'lb' ? Math.round(kg * LB_PER_KG * 10) / 10 : kg);
const toKg = (display, unit) => (unit === 'lb' ? Math.round((display / LB_PER_KG) * 100) / 100 : display);
/** What a weight is shown to: 0.1 lb, or 0.01 kg for 1.25 kg plates. */
const precisionOf = (unit) => (unit === 'lb' ? 0.1 : 0.01);

/** Fewer distinct weights than this and any spacing could be chance. */
const MIN_LEARNED_WEIGHTS = 3;
/** A learned step outside these bounds is a member who jumps in big leaps (or
 * a typo), not the kit's real increment, so the catalogue default wins. */
const LEARNED_STEP_BOUNDS = { kg: { min: 1, max: 10 }, lb: { min: 2, max: 25 } };

/**
 * The jump this member's kit actually makes, read off the weights they have
 * logged on it: 6.5, 13, 19.5 and 26 kg is a 6.5 kg stack, whatever the
 * catalogue says a "machine" does; 40, 41.25 and 42.5 is a gym with 1.25 kg
 * plates. The step is the smallest gap, trusted only when every weight sits on
 * that grid. `base` is where the grid starts, for a 45 lb bar that goes 45,
 * 55, 65 rather than 50, 60.
 *
 * The step is averaged over the whole span, so a kg stack seen in lb (14.3,
 * 28.7, 43) comes out as one even 14.33 lb step rather than drifting.
 *
 * @param {number[]} weightsKg every weight logged on the exercise, any order
 * @returns {{ step: number, base: number } | null} in the display unit
 */
export function learnGrid(weightsKg = [], unit = 'kg') {
  const precision = precisionOf(unit);
  // Each weight within rounding of a rung: kg logged in lb lands on 4.54, 9.07…
  const tolerance = unit === 'lb' ? 0.25 : 0.05;
  const sorted = [
    ...new Set(weightsKg.map(Number).filter((kg) => kg > 0).map((kg) => roundTo(toDisplay(kg, unit), precision))),
  ].sort((a, b) => a - b);
  // One plate typed two ways is one weight: 32.5 lb stored as 14.74 kg and the
  // same stack pin typed as 14.75 kg would otherwise be a 0.01 kg "step".
  const values = [];
  for (const value of sorted) if (!values.length || value - values[values.length - 1] > tolerance) values.push(value);
  if (values.length < MIN_LEARNED_WEIGHTS) return null;

  const smallest = Math.min(...values.slice(1).map((value, i) => value - values[i]));
  const span = values[values.length - 1] - values[0];
  const step = span / Math.round(span / smallest);
  const bounds = LEARNED_STEP_BOUNDS[unit] ?? LEARNED_STEP_BOUNDS.kg;
  if (step < bounds.min || step > bounds.max) return null;

  const fits = values.every((value) => {
    const rungs = (value - values[0]) / step;
    return Math.abs(rungs - Math.round(rungs)) * step <= tolerance;
  });
  if (!fits) return null;
  const base = ((values[0] % step) + step) % step;
  // A base within rounding of a whole step is no offset at all.
  return { step, base: base < tolerance || step - base < tolerance ? 0 : base };
}

/** Epley, as estimate1rm() in src/fitness.js. */
const oneRepMax = (weight, reps) => weight * (1 + reps / 30);
/** The reps Epley says a weight allows at the same effort. */
const repsAt = (max, weight) => Math.floor(30 * (max / weight - 1));
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** A set that tells us something about working capacity: done, not a warmup,
 * with reps on it. Drop sets are deliberately lighter, so they never set the
 * baseline for the next straight set. */
const isWorking = (set) => set && set.set_type !== 'warmup' && set.set_type !== 'drop' && Number(set.reps) > 0;

const rpeOf = (set) => (set?.rpe == null || set.rpe === '' ? null : Number(set.rpe));

/**
 * The next set's numbers, or null when there is nothing to go on (a first
 * ever session) or the exercise is not counted in reps.
 *
 * @param {object} input
 * @param {string} [input.targetReps] the plan's target, e.g. "8-12"
 * @param {string} [input.equipment] catalogue equipment key
 * @param {'kg'|'lb'} [input.unit] the member's display unit
 * @param {'weight_reps'|'reps'|string} [input.logType]
 * @param {Array} [input.doneThisSession] this exercise's ticked sets so far, in order
 * @param {Array} [input.lastSession] this exercise's sets from its most recent session
 * @param {number[]} [input.loggedWeights] recent distinct kg weights logged on
 *   this exercise, which teach learnGrid() the kit's real step
 * @returns {{weight_kg: number, weight_display: number, reps: number, code: string, reason: string,
 *   step: number, step_learned: boolean} | null}
 */
export function suggestNextSet({
  targetReps,
  equipment,
  unit = 'kg',
  logType = 'weight_reps',
  doneThisSession = [],
  lastSession = [],
  loggedWeights = [],
} = {}) {
  if (logType !== 'weight_reps' && logType !== 'reps') return null;
  const range = parseRepRange(targetReps);
  const { lo, hi } = range;
  const rangeText = lo === hi ? `${lo} reps` : `${lo}–${hi} reps`;
  const done = doneThisSession.filter(isWorking);
  const before = lastSession.filter(isWorking);

  if (logType === 'reps') return suggestReps({ done, before });

  // Warmups and drop sets count here: they were still real weights on the kit.
  const learned = learnGrid(
    [...loggedWeights, ...doneThisSession, ...lastSession].map((entry) => Number(entry?.weight_kg ?? entry)),
    unit,
  );
  const grid = learned ?? { step: weightStep(equipment, unit), base: 0 };
  const precision = precisionOf(unit);
  const step = roundTo(grid.step, precision);
  // Every suggested weight is a rung on the grid: base + n × step.
  const rung = (n) => roundTo(grid.base + n * grid.step, precision);
  const rungOf = (value) => (value - grid.base) / grid.step;
  const lowest = grid.base > 0 ? 0 : 1;
  const up = (value) => rung(Math.round(rungOf(value)) + 1);
  const down = (value) => rung(Math.max(lowest, Math.round(rungOf(value)) - 1));
  // The slack keeps a weight already on the grid from flooring to the rung below.
  const atOrBelow = (value) => rung(Math.max(lowest, Math.floor(rungOf(value) + 0.05)));

  const label = (display) => `${display} ${unit}`;
  const result = (display, reps, code, reason) => ({
    weight_kg: toKg(display, unit),
    weight_display: display,
    reps: Math.max(1, Math.round(reps)),
    code,
    reason,
    step,
    step_learned: Boolean(learned),
  });

  // ── Mid-session: react to the set just done ──────────────────────────────
  const last = [...done].reverse().find((set) => Number(set.weight_kg) > 0);
  if (last) {
    const weight = roundTo(toDisplay(Number(last.weight_kg), unit), precision);
    const reps = Number(last.reps);
    const rpe = rpeOf(last);
    const max = oneRepMax(weight, reps);
    const mid = Math.round((lo + hi) / 2);
    const setNo = done.indexOf(last) + 1;

    if (reps < lo) {
      // What this set says the member can lift for the middle of the range,
      // rounded down: they are only getting more tired from here.
      const lighter = Math.min(atOrBelow(max / (1 + mid / 30)), down(weight));
      // Epley flatters a lighter weight late in a session, so the aim is the
      // middle of the range, not the top: a fresh 15 kg × 13 does not mean a
      // tired 15 kg × 15 after a set to failure.
      const aim = clamp(repsAt(max, lighter), lo, mid);
      return result(lighter, aim, 'drop_short',
        `Set ${setNo} was ${reps} reps at ${label(weight)} — below your ${rangeText}. Go lighter to stay in range.`);
    }
    if (rpe === 10) {
      const lighter = down(weight);
      return result(lighter, clamp(reps, lo, hi), 'drop_failed',
        `Set ${setNo} went to failure. Drop a step so the next set is all good reps.`);
    }
    if (reps > hi || (rpe != null && rpe <= 6)) {
      const heavier = up(weight);
      const aim = clamp(repsAt(max, heavier), lo, hi);
      const why = reps > hi ? `${reps} reps is past the top of your ${rangeText}` : `that felt easy`;
      return result(heavier, aim, 'up_easy', `Set ${setNo}: ${why} — add ${label(step)}.`);
    }
    // In range and not to failure: hold the weight; a hard set allows one
    // rep of fatigue rather than chasing the same count.
    const aim = rpe === 9 ? Math.max(lo, reps - 1) : reps;
    return result(weight, aim, 'hold',
      `Set ${setNo} landed in your ${rangeText}. Stay at ${label(weight)} and aim for ${aim}.`);
  }

  // ── First working set: progress on last session ─────────────────────────
  const loaded = before.filter((set) => Number(set.weight_kg) > 0);
  if (!loaded.length) return null;
  const topKg = Math.max(...loaded.map((set) => Number(set.weight_kg)));
  const atTop = loaded.filter((set) => Number(set.weight_kg) === topKg);
  const top = roundTo(toDisplay(topKg, unit), precision);
  const bestReps = Math.max(...atTop.map((set) => Number(set.reps)));
  const knownRpes = atTop.map(rpeOf).filter((rpe) => rpe != null);

  const allTopped = atTop.every((set) => Number(set.reps) >= hi) && knownRpes.every((rpe) => rpe <= 8);
  if (allTopped) {
    const heavier = up(top);
    const aim = clamp(repsAt(oneRepMax(top, bestReps), heavier), lo, hi);
    return result(heavier, aim, 'progress',
      `Last time every set at ${label(top)} reached ${hi}+ reps. Time to go up ${label(step)}.`);
  }
  if (atTop.every((set) => Number(set.reps) < lo)) {
    const lighter = down(top);
    return result(lighter, lo, 'reset',
      `Last time ${label(top)} stayed under ${lo} reps. Drop a step and build back up.`);
  }
  if (atTop.some((set) => Number(set.reps) < lo)) {
    return result(top, lo, 'hold_build',
      `Some sets at ${label(top)} fell short of ${lo} last time. Stay there and get every set into range.`);
  }
  const aim = Math.min(hi, bestReps + 1);
  return result(top, aim, 'add_rep',
    aim > bestReps
      ? `Beat last time: ${label(top)} for ${aim} (best was ${bestReps}).`
      : `Match last time: ${label(top)} for ${aim}.`);
}

/** Reps-only moves (push-ups, pull-ups): there is no load to change, so a set
 * just tries to beat the last one. */
function suggestReps({ done, before }) {
  const result = (reps, code, reason) => ({ weight_kg: 0, weight_display: 0, reps: Math.max(1, reps), code, reason });
  const last = done[done.length - 1];
  if (last) {
    const reps = Number(last.reps);
    const rpe = rpeOf(last);
    if (rpe === 10) return result(reps - 1, 'drop_failed', `Last set went to failure — aim for ${Math.max(1, reps - 1)} clean reps.`);
    if (rpe != null && rpe <= 6) return result(reps + 1, 'up_easy', `That felt easy — try ${reps + 1}.`);
    return result(rpe === 9 ? Math.max(1, reps - 1) : reps, 'hold', `Aim to match your last set.`);
  }
  if (!before.length) return null;
  const best = Math.max(...before.map((set) => Number(set.reps)));
  return result(best + 1, 'add_rep', `Beat last time: ${best + 1} reps (best was ${best}).`);
}
