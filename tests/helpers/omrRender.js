import assert from 'node:assert/strict';
import { MARKER_SIZE, MARKERS, ORIENTATION_BAR, PAGE, sheetLayout } from '../../public/js/omrLayout.js';
import { homography, project } from '../../public/js/omrScan.js';

/**
 * A camera frame of a filled sheet: the sheet drawn at 6 px/mm, then seen
 * through a perspective transform onto a dark table, with light falling off
 * across the page, a little blur and sensor noise.
 */
export function renderSheet({ questions, options, style = 'coachbook', answers, roll, quad, frame, light = [1, 0.62], seed = 7, fillRadius = 0.92, fillInk = 45 }) {
  const S = 6;
  const W = PAGE.width * S;
  const Hh = PAGE.height * S;
  const sheet = new Uint8Array(W * Hh).fill(238);
  const layout = sheetLayout({ questions, options, style });
  const disc = (cx, cy, r, value) => {
    for (let y = Math.floor((cy - r) * S); y <= Math.ceil((cy + r) * S); y++) {
      for (let x = Math.floor((cx - r) * S); x <= Math.ceil((cx + r) * S); x++) {
        if (Math.hypot(x / S - cx, y / S - cy) <= r) sheet[y * W + x] = value;
      }
    }
  };
  const ring = (cx, cy, r, value) => {
    for (let y = Math.floor((cy - r - 1) * S); y <= Math.ceil((cy + r + 1) * S); y++) {
      for (let x = Math.floor((cx - r - 1) * S); x <= Math.ceil((cx + r + 1) * S); x++) {
        if (Math.abs(Math.hypot(x / S - cx, y / S - cy) - r) < 0.17) sheet[y * W + x] = value;
      }
    }
  };
  const rect = (x0, y0, w, h, value) => {
    for (let y = Math.round(y0 * S); y < Math.round((y0 + h) * S); y++) for (let x = Math.round(x0 * S); x < Math.round((x0 + w) * S); x++) sheet[y * W + x] = value;
  };
  for (const m of Object.values(MARKERS)) rect(m.x - MARKER_SIZE / 2, m.y - MARKER_SIZE / 2, MARKER_SIZE, MARKER_SIZE, 20);
  rect(ORIENTATION_BAR.x, ORIENTATION_BAR.y, ORIENTATION_BAR.width, ORIENTATION_BAR.height, 20);
  // Header "text": rows of short dark strokes, and a filled example bubble.
  for (let line = 0; line < 8; line++) for (let word = 0; word < 14; word++) rect(22 + word * 9, 24 + line * 8, 6, 1.6, 60);
  disc(35, 92, 2, 25);
  // The exam-pattern sheets' printed frames and rules, as thin dark lines.
  const outline = (x, y, w, h, value) => {
    rect(x, y, w, 0.15, value);
    rect(x, y + h, w, 0.15, value);
    rect(x, y, 0.15, h, value);
    rect(x + w, y, 0.15, h, value);
  };
  for (const col of layout.columns) {
    if (!col.frame || !col.used) continue;
    outline(col.frame.x, col.frame.y, col.frame.width, col.frame.height, 90);
    rect(col.frame.x, col.headerRule, col.frame.width, 0.15, 90);
    for (const y of col.dividers) rect(col.frame.x + 1.2, y, col.frame.width - 2.4, 0.1, 150);
  }
  if (layout.rollPanel) outline(layout.rollPanel.x, layout.rollPanel.y, layout.rollPanel.width, layout.rollPanel.height, 90);
  for (const item of layout.items) for (const b of item.bubbles) ring(b.x, b.y, layout.bubbleRadius, 120);
  for (const col of layout.roll) for (const b of col.bubbles) ring(b.x, b.y, layout.bubbleRadius, 120);
  layout.items.forEach((item, i) => {
    for (const letter of answers[i] || '') {
      const b = item.bubbles.find((x) => x.label === letter);
      disc(b.x, b.y, layout.bubbleRadius * fillRadius, fillInk);
    }
  });
  [...(roll || '')].forEach((d, i) => {
    if (d === ' ') return;
    const b = layout.roll[i].bubbles[Number(d)];
    disc(b.x, b.y, layout.bubbleRadius * fillRadius, fillInk);
  });

  const page = [[0, 0], [PAGE.width, 0], [PAGE.width, PAGE.height], [0, PAGE.height]];
  const toFrame = homography(page, quad);
  const toSheet = homography(quad, page);
  assert.ok(toFrame && toSheet);
  let state = seed;
  const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const raw = new Float32Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const [sx, sy] = project(toSheet, x, y);
      let v;
      if (sx >= 0 && sy >= 0 && sx < PAGE.width && sy < PAGE.height) {
        v = sheet[Math.floor(sy * S) * W + Math.floor(sx * S)];
        v *= light[0] + (light[1] - light[0]) * (x / frame.width);
      } else {
        v = 70 + 25 * Math.sin(x / 9) * Math.cos(y / 13);
      }
      raw[y * frame.width + x] = v;
    }
  }
  const gray = new Uint8Array(raw.length);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(frame.height - 1, Math.max(0, y + dy));
        const xx = Math.min(frame.width - 1, Math.max(0, x + dx));
        sum += raw[yy * frame.width + xx];
        n += 1;
      }
      gray[y * frame.width + x] = Math.max(0, Math.min(255, sum / n + (rand() - 0.5) * 18));
    }
  }
  return gray;
}

export function sampleAnswers(questions, options, seed) {
  let s = seed;
  const rand = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const letters = 'ABCDE'.slice(0, options);
  return Array.from({ length: questions }, (_, i) => {
    if (i % 11 === 5) return '';
    if (i % 17 === 9) return letters[0] + letters[2];
    return letters[Math.floor(rand() * options)];
  });
}
