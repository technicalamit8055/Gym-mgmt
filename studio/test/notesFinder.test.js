import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { findClassNotes } from '../src/notesFinder.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-notes-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh export folder per test. */
const folder = () => {
  n += 1;
  const dir = path.join(root, `case-${n}`);
  fs.mkdirSync(dir);
  return dir;
};
const write = (file, bytes, ageMs = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
};

describe('finding the class’s Note 3 export', () => {
  it('picks the newest PDF written since the class began', async () => {
    const dir = folder();
    const classStart = Date.now() - 60 * 60_000;
    write(path.join(dir, 'Monday physics.pdf'), 500, 3 * 24 * 60 * 60_000); // an earlier lecture
    write(path.join(dir, 'early draft.pdf'), 300, 30 * 60_000);
    write(path.join(dir, 'Rotational motion.pdf'), 800, 60_000);
    write(path.join(dir, 'slide.png'), 900);
    const found = await findClassNotes(dir, { since: classStart, settleMs: 50 });
    assert.equal(found.name, 'Rotational motion.pdf');
    assert.equal(found.size, 800);
  });

  it('finds nothing when the only PDFs are from before the class', async () => {
    const dir = folder();
    write(path.join(dir, 'yesterday.pdf'), 500, 24 * 60 * 60_000);
    assert.equal(await findClassNotes(dir, { since: Date.now() - 60 * 60_000, settleMs: 10 }), null);
  });

  it('looks into dated subfolders, two levels down and no further', async () => {
    const dir = folder();
    write(path.join(dir, '2026', '11-04', 'class.pdf'), 400);
    write(path.join(dir, 'a', 'b', 'c', 'too-deep.pdf'), 400);
    const found = await findClassNotes(dir, { since: Date.now() - 60_000, settleMs: 10 });
    assert.equal(found.name, 'class.pdf');
  });

  it('waits out a PDF that is still being written', async () => {
    const dir = folder();
    const file = path.join(dir, 'exporting.pdf');
    write(file, 100);
    const growing = setTimeout(() => fs.appendFileSync(file, Buffer.alloc(100, 2)), 40);
    assert.equal(await findClassNotes(dir, { since: Date.now() - 60_000, settleMs: 150 }), null, 'half a file is not sent');
    clearTimeout(growing);
    const done = await findClassNotes(dir, { since: Date.now() - 60_000, settleMs: 50 });
    assert.equal(done.size, 200);
  });

  it('ignores an empty file and a folder that is not there', async () => {
    const dir = folder();
    write(path.join(dir, 'empty.pdf'), 0);
    assert.equal(await findClassNotes(dir, { since: 0, settleMs: 10 }), null);
    assert.equal(await findClassNotes(path.join(dir, 'missing'), { since: 0, settleMs: 10 }), null);
    assert.equal(await findClassNotes('', { since: 0 }), null);
  });
});
