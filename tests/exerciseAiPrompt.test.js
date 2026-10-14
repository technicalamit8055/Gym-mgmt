import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Minimal mock environment for loading exerciseCatalog view helper in Node
globalThis.window = { location: { pathname: '/' } };
globalThis.document = {
  createElement: () => ({ setAttribute: () => {}, addEventListener: () => {} }),
  addEventListener: () => {},
};

const { buildExerciseAiPrompt, textToExercises } = await import('../public/js/views/exerciseCatalog.js');

describe('buildExerciseAiPrompt', () => {
  it('includes step-wise instructions instruction with numbering in generated prompt', () => {
    const prompt = buildExerciseAiPrompt({
      topic: 'core',
      count: 15,
      format: 'csv',
      muscleGroups: ['abdominals'],
      equipment: ['bodyweight'],
      skipNames: [],
    });

    assert.match(prompt, /instructions: write instructions step-wise \(e\.g\. 1, 2, 3, 4 etc\.\)/);
    assert.match(prompt, /covering setup, the movement, and key form cues/);
    assert.match(prompt, /Wrap any value that contains a comma or line break in double quotes/);
  });

  it('includes step-wise instructions for JSON format', () => {
    const prompt = buildExerciseAiPrompt({
      topic: 'glutes',
      count: 10,
      format: 'json',
      muscleGroups: ['glutes'],
      equipment: ['barbell'],
      skipNames: [],
    });

    assert.match(prompt, /instructions: write instructions step-wise \(e\.g\. 1, 2, 3, 4 etc\.\)/);
  });

  it('parses step-wise instructions from JSON array with newline separators', () => {
    const json = JSON.stringify([
      {
        name: 'Hip Thrust',
        muscle_group: 'glutes',
        equipment: 'barbell',
        instructions: [
          '1. Sit against a bench with a barbell over hips.',
          '2. Drive through heels to extend hips.',
          '3. Squeeze glutes at top and lower under control.',
        ],
      },
    ]);

    const rows = textToExercises(json);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].instructions,
      '1. Sit against a bench with a barbell over hips.\n2. Drive through heels to extend hips.\n3. Squeeze glutes at top and lower under control.',
    );
  });
});
