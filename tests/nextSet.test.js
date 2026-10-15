import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EFFORTS, learnGrid, parseRepRange, suggestNextSet, weightStep } from '../public/js/nextSet.js';

const set = (weight_kg, reps, extra = {}) => ({ set_type: 'normal', weight_kg, reps, ...extra });

describe('parseRepRange', () => {
  it('reads ranges, single targets and junk', () => {
    assert.deepEqual(parseRepRange('8-12'), { lo: 8, hi: 12, assumed: false });
    assert.deepEqual(parseRepRange('12–8'), { lo: 8, hi: 12, assumed: false });
    assert.deepEqual(parseRepRange('10'), { lo: 10, hi: 10, assumed: false });
    assert.deepEqual(parseRepRange(''), { lo: 8, hi: 12, assumed: true });
    assert.deepEqual(parseRepRange(null), { lo: 8, hi: 12, assumed: true });
  });
});

describe('weightStep', () => {
  it('steps by kit and unit', () => {
    assert.equal(weightStep('barbell'), 5);
    assert.equal(weightStep('smith_machine'), 5);
    assert.equal(weightStep('dumbbell'), 2.5);
    assert.equal(weightStep('machine'), 5);
    assert.equal(weightStep('barbell', 'lb'), 5);
    assert.equal(weightStep('machine', 'lb'), 10);
  });
});

describe('suggestNextSet — mid-session', () => {
  it('backs off after a set falls below the range (the lateral raise case)', () => {
    // 15 kg × 13, then 20 kg × 6 on an 8–15 target: 20 kg was too heavy.
    const next = suggestNextSet({
      targetReps: '8-15',
      equipment: 'dumbbell',
      doneThisSession: [set(15, 13), set(20, 6)],
    });
    assert.equal(next.code, 'drop_short');
    assert.equal(next.weight_kg, 15);
    // The middle of the range, not the top: they are tired now.
    assert.equal(next.reps, 12);
    assert.match(next.reason, /below your 8–15 reps/);
  });

  it('holds the weight when a set lands in range', () => {
    const next = suggestNextSet({ targetReps: '8-12', equipment: 'barbell', doneThisSession: [set(30, 10, { rpe: 8 })] });
    assert.equal(next.code, 'hold');
    assert.equal(next.weight_kg, 30);
    assert.equal(next.reps, 10);
  });

  it('allows a rep of fatigue after a hard set', () => {
    const next = suggestNextSet({ targetReps: '8-12', doneThisSession: [set(30, 10, { rpe: 9 })] });
    assert.equal(next.weight_kg, 30);
    assert.equal(next.reps, 9);
  });

  it('drops a step after a failed set', () => {
    const next = suggestNextSet({ targetReps: '8-12', equipment: 'barbell', doneThisSession: [set(30, 9, { rpe: 10 })] });
    assert.equal(next.code, 'drop_failed');
    assert.equal(next.weight_kg, 25);
  });

  it('goes up after an easy set or one past the top of the range', () => {
    const easy = suggestNextSet({ targetReps: '8-12', equipment: 'barbell', doneThisSession: [set(30, 10, { rpe: 6 })] });
    assert.equal(easy.code, 'up_easy');
    assert.equal(easy.weight_kg, 35);
    const tooMany = suggestNextSet({ targetReps: '8-12', equipment: 'machine', doneThisSession: [set(40, 15)] });
    assert.equal(tooMany.weight_kg, 45);
    assert.ok(tooMany.reps >= 8 && tooMany.reps <= 12);
  });

  it('ignores warmups and drop sets as a baseline', () => {
    const next = suggestNextSet({
      targetReps: '8-12',
      equipment: 'barbell',
      doneThisSession: [set(20, 15, { set_type: 'warmup' })],
      lastSession: [set(30, 10), set(30, 10)],
    });
    // Only a warmup so far: this is still the first working set.
    assert.equal(next.code, 'add_rep');
    assert.equal(next.weight_kg, 30);
    assert.equal(next.reps, 11);

    const afterDrop = suggestNextSet({
      targetReps: '8-12',
      doneThisSession: [set(30, 10, { rpe: 8 }), set(20, 12, { set_type: 'drop' })],
    });
    assert.equal(afterDrop.weight_kg, 30);
  });
});

describe('suggestNextSet — first set from last session', () => {
  it('adds a step once every set reached the top of the range', () => {
    const next = suggestNextSet({
      targetReps: '8-12',
      equipment: 'barbell',
      lastSession: [set(30, 12, { rpe: 8 }), set(30, 12), set(30, 12, { rpe: 7 })],
    });
    assert.equal(next.code, 'progress');
    assert.equal(next.weight_kg, 35);
    assert.ok(next.reps >= 8 && next.reps <= 12);
  });

  it('does not progress when the top was reached at a failing effort', () => {
    const next = suggestNextSet({ targetReps: '8-12', lastSession: [set(30, 12, { rpe: 10 }), set(30, 12, { rpe: 10 })] });
    assert.notEqual(next.code, 'progress');
    assert.equal(next.weight_kg, 30);
  });

  it('holds when some sets fell short, and resets when all did', () => {
    const some = suggestNextSet({ targetReps: '8-12', lastSession: [set(30, 9), set(30, 7)] });
    assert.equal(some.code, 'hold_build');
    assert.equal(some.weight_kg, 30);
    assert.equal(some.reps, 8);

    const all = suggestNextSet({ targetReps: '8-12', equipment: 'barbell', lastSession: [set(30, 6), set(30, 5)] });
    assert.equal(all.code, 'reset');
    assert.equal(all.weight_kg, 25);
  });

  it('asks for one more rep at the same weight otherwise', () => {
    const next = suggestNextSet({ targetReps: '8-12', lastSession: [set(25, 8), set(30, 10), set(30, 9)] });
    assert.equal(next.code, 'add_rep');
    assert.equal(next.weight_kg, 30);
    assert.equal(next.reps, 11);
  });

  it('says nothing without history', () => {
    assert.equal(suggestNextSet({ targetReps: '8-12' }), null);
    assert.equal(suggestNextSet({ targetReps: '8-12', lastSession: [set(20, 10, { set_type: 'warmup' })] }), null);
  });
});

describe('suggestNextSet — units and log types', () => {
  it('rounds to 5 lb steps for a pounds member and returns kilograms underneath', () => {
    // 30 kg is 66.1 lb; all sets topped out, so +5 lb rounds to 70 lb.
    const next = suggestNextSet({ targetReps: '8-12', unit: 'lb', lastSession: [set(30, 12), set(30, 12)] });
    assert.equal(next.weight_display, 70);
    assert.equal(next.weight_kg, 31.75);
    assert.match(next.reason, /lb/);
  });

  it('works in reps alone for bodyweight moves', () => {
    const first = suggestNextSet({ logType: 'reps', lastSession: [set(0, 10), set(0, 8)] });
    assert.equal(first.reps, 11);
    assert.equal(first.weight_kg, 0);
    const failed = suggestNextSet({ logType: 'reps', doneThisSession: [set(0, 12, { rpe: 10 })] });
    assert.equal(failed.reps, 11);
  });

  it('skips timed and distance work', () => {
    assert.equal(suggestNextSet({ logType: 'duration', lastSession: [set(0, 0)] }), null);
    assert.equal(suggestNextSet({ logType: 'distance_duration' }), null);
  });

  it('maps every effort chip to a valid RPE', () => {
    assert.deepEqual(EFFORTS.map((e) => e.rpe), [6, 8, 9, 10]);
  });
});

describe('learnGrid', () => {
  it('reads a 6.5 kg stack off the weights logged on it, in any order', () => {
    assert.deepEqual(learnGrid([6.5, 13, 19.5, 26]), { step: 6.5, base: 0 });
    assert.deepEqual(learnGrid([26, 6.5, 13, 13, 19.5]), { step: 6.5, base: 0 });
  });

  it('treats one pin typed in kg and logged in lb as one weight, so both units agree', () => {
    // 26, 32.5 and 39 lb stored in kg, plus the 32.5 lb pin typed by hand as 14.75 kg.
    const weights = [17.69, 14.74, 11.79, 14.75];
    assert.equal(learnGrid(weights, 'lb').step, 6.5);
    assert.ok(Math.abs(learnGrid(weights, 'kg').step - 2.95) < 0.01);
    const input = (unit) => ({
      targetReps: '8-12',
      equipment: 'cable',
      unit,
      doneThisSession: [set(14.75, 8, { rpe: 8 }), set(17.69, 6, { rpe: 6 })],
      loggedWeights: weights,
    });
    const kg = suggestNextSet(input('kg'));
    const lb = suggestNextSet(input('lb'));
    assert.ok(Math.abs(kg.weight_kg - lb.weight_kg) < 0.05, `${kg.weight_kg} kg vs ${lb.weight_kg} kg`);
    assert.equal(kg.reps, lb.reps);
  });

  it('picks up 1.25 kg plates', () => {
    assert.deepEqual(learnGrid([40, 41.25, 42.5, 45]), { step: 1.25, base: 0 });
  });

  it('keeps the offset of a 45 lb bar loaded in 5 lb pairs', () => {
    // 45, 55 and 65 lb, as they are stored in kg.
    assert.deepEqual(learnGrid([20.41, 24.95, 29.48], 'lb'), { step: 10, base: 5 });
  });

  it('evens out a kg stack shown in lb rather than drifting', () => {
    const grid = learnGrid([6.5, 13, 19.5, 26], 'lb');
    assert.ok(Math.abs(grid.step - 14.33) < 0.01);
    assert.equal(grid.base, 0);
  });

  it('trusts nothing under three weights, off the pattern, or outside sane steps', () => {
    assert.equal(learnGrid([6.5, 13]), null);
    assert.equal(learnGrid([6.5, 13, 17]), null);
    assert.equal(learnGrid([20, 40, 60]), null);
    assert.equal(learnGrid([10, 10.5, 11]), null);
    assert.equal(learnGrid([0, 0, 10, 20]), null);
  });
});

describe('suggestNextSet — learned steps', () => {
  it('goes up a 6.5 kg stack by 6.5, not the catalogue 5', () => {
    const next = suggestNextSet({ targetReps: '8-12', equipment: 'machine', loggedWeights: [6.5, 13], doneThisSession: [set(19.5, 14)] });
    assert.equal(next.code, 'up_easy');
    assert.equal(next.weight_kg, 26);
    assert.equal(next.step, 6.5);
    assert.equal(next.step_learned, true);
    assert.match(next.reason, /add 6\.5 kg/);
  });

  it('drops and progresses on the same stack', () => {
    const failed = suggestNextSet({ targetReps: '8-12', equipment: 'machine', loggedWeights: [6.5, 13, 19.5], doneThisSession: [set(26, 9, { rpe: 10 })] });
    assert.equal(failed.weight_kg, 19.5);
    const progress = suggestNextSet({
      targetReps: '8-12',
      equipment: 'machine',
      loggedWeights: [6.5, 13],
      lastSession: [set(19.5, 12, { rpe: 8 }), set(19.5, 12), set(19.5, 12)],
    });
    assert.equal(progress.code, 'progress');
    assert.equal(progress.weight_kg, 26);
  });

  it('learns within a first session from the sets just done, warmups included', () => {
    const next = suggestNextSet({
      targetReps: '8-12',
      equipment: 'machine',
      doneThisSession: [set(6.5, 15, { set_type: 'warmup' }), set(13, 14), set(19.5, 13)],
    });
    assert.equal(next.weight_kg, 26);
  });

  it('lands a lighter set on the bar-plus-plates grid', () => {
    // 65 lb × 3 on 8–12: the catalogue 5 lb step says 50, which needs 2.5s.
    const next = suggestNextSet({ targetReps: '8-12', equipment: 'barbell', unit: 'lb', loggedWeights: [20.41, 24.95], doneThisSession: [set(29.48, 3)] });
    assert.equal(next.code, 'drop_short');
    assert.equal(next.weight_display, 45);
  });

  it('suggests a kg stack in lb on the stack’s own rungs', () => {
    const next = suggestNextSet({ targetReps: '8-12', equipment: 'machine', unit: 'lb', loggedWeights: [6.5, 13, 19.5, 26], doneThisSession: [set(19.5, 14)] });
    assert.equal(next.weight_display, 57.3);
    assert.ok(Math.abs(next.weight_kg - 26) < 0.05);
  });

  it('falls back to the catalogue step without enough history', () => {
    const next = suggestNextSet({ targetReps: '8-12', equipment: 'machine', loggedWeights: [6.5], doneThisSession: [set(19.5, 14)] });
    // The catalogue's 5 kg grid: what a 6.5 kg stack got before it was learned.
    assert.equal(next.weight_kg, 25);
    assert.equal(next.step_learned, false);
  });
});
