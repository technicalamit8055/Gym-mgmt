import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EFFORTS, parseRepRange, suggestNextSet, weightStep } from '../public/js/nextSet.js';

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
