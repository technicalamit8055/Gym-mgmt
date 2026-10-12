import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SETTLE_CHARS, answerTokens, plainLength } from '../public/js/coachText.js';

describe('coachText — plainLength', () => {
  it('strips double asterisks', () => {
    assert.equal(plainLength('Hello **world**!'), 'Hello world!'.length);
    assert.equal(plainLength('No markers here'), 'No markers here'.length);
    assert.equal(plainLength('**867 calories**, **62g protein**'), '867 calories, 62g protein'.length);
  });
});

describe('coachText — answerTokens', () => {
  it('splits plain text into word tokens', () => {
    const tokens = answerTokens('Hello world');
    assert.deepEqual(tokens, [
      { text: 'Hello ', kind: '', end: 6 },
      { text: 'world', kind: '', end: 11 },
    ]);
  });

  it('marks bold sections', () => {
    const tokens = answerTokens('Stay at **40 kg** today');
    const boldText = tokens.filter((t) => t.kind === 'bold').map((t) => t.text).join('');
    assert.equal(boldText.trim(), '40 kg');
  });

  it('identifies kcal and protein chips', () => {
    const raw = "You've eaten 867 calories so far today, with 62g protein.";
    const tokens = answerTokens(raw);
    const kcal = tokens.find((t) => t.kind === 'kcal');
    const protein = tokens.find((t) => t.kind === 'protein');

    assert.ok(kcal, 'kcal chip found');
    assert.equal(kcal.text, '867 calories');
    assert.ok(protein, 'protein chip found');
    assert.equal(protein.text, '62g protein');
  });

  it('handles bold markers around chips', () => {
    const raw = 'You still have **2413 calories, 82g protein** left.';
    const tokens = answerTokens(raw);
    const kcal = tokens.find((t) => t.kind === 'kcal');
    const protein = tokens.find((t) => t.kind === 'protein');

    assert.ok(kcal);
    assert.ok(protein);
  });

  it('reports SETTLE_CHARS constant', () => {
    assert.equal(typeof SETTLE_CHARS, 'number');
    assert.ok(SETTLE_CHARS > 0);
  });
});
