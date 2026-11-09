/**
 * Reads a filled CoachBook OMR sheet out of a camera frame.
 *
 * Plain JavaScript over a grayscale buffer — no OpenCV. OpenCV.js is an 8 MB
 * download and this needs four steps of it, each a few dozen lines:
 *
 *   1. findSheet(): an adaptive threshold (each pixel against the mean of its
 *      neighbourhood, so a shadow across the page does not matter), connected
 *      components, and a shape test that keeps the solid, roughly square
 *      blobs. Every set of four of the largest is tried as the corner
 *      markers; a set must be the right size for the quadrilateral it forms,
 *      the right aspect, and have the dark orientation bar where the sheet
 *      says it is (which is also how an upside-down sheet is read upright).
 *   2. homography(): the 3×3 perspective transform from sheet millimetres to
 *      frame pixels, from the four marker centres. Nothing is warped — each
 *      bubble's sample points are simply projected into the frame.
 *   3. bubbleFill(): how dark a bubble's centre is against the paper just
 *      around it, 0 (blank) to 1 (solid ink). Local, so uneven light is fine.
 *   4. readSheet(): a threshold between blank and filled for this sheet
 *      (Otsu over every bubble), then each question's mark — one letter,
 *      blank, or several letters when more than one bubble is filled — and a
 *      list of the bubbles too close to call, for the teacher to look at.
 *
 * Everything here is pure and DOM-free so the tests can run it on synthetic
 * camera images in Node (tests/omr.test.js).
 */

import { MARKER_SIZE, MARKER_SPAN, MARKERS, ORIENTATION_BAR, ORIENTATION_BLANK, PAGE, sheetLayout } from './omrLayout.js';

const PAGE_W = PAGE.width;

/** Luma from RGBA bytes (a canvas ImageData's data). */
export function toGray(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return gray;
}

/** Halves (or more) a grayscale image by box-averaging, for the cheap live preview pass. */
export function downscale(gray, width, height, factor) {
  const f = Math.max(1, Math.trunc(factor));
  if (f === 1) return { gray, width, height };
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8Array(w * h);
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * width + x * f;
        for (let dx = 0; dx < f; dx++) sum += gray[row + dx];
      }
      out[y * w + x] = sum / area;
    }
  }
  return { gray: out, width: w, height: h };
}

/**
 * 1 where a pixel is clearly darker than its surroundings: below `ratio` of
 * the mean of the (2·radius+1)² square around it, from an integral image.
 */
export function binarize(gray, width, height, { radius, ratio = 0.7 } = {}) {
  const r = Math.max(2, Math.round(radius ?? Math.max(width, height) / 14));
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width, x + r + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      const count = (x1 - x0) * (y1 - y0);
      if (gray[y * width + x] * count < sum * ratio) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/**
 * The 4-connected dark regions of `mask` with their area, centroid, second
 * moments and bounding box. Regions outside [minArea, maxArea] are dropped.
 */
export function components(mask, width, height, { minArea = 1, maxArea = Infinity } = {}) {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const blobs = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (top) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      area += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (y > 0 && mask[i - width] && !seen[i - width]) (seen[i - width] = 1), (stack[top++] = i - width);
      if (y < height - 1 && mask[i + width] && !seen[i + width]) (seen[i + width] = 1), (stack[top++] = i + width);
    }
    if (area < minArea || area > maxArea) continue;
    const cx = sx / area;
    const cy = sy / area;
    blobs.push({
      area,
      x: cx,
      y: cy,
      vxx: sxx / area - cx * cx,
      vyy: syy / area - cy * cy,
      vxy: sxy / area - cx * cy,
      minX,
      maxX,
      minY,
      maxY,
    });
  }
  return blobs;
}

/**
 * Whether a blob is a solid, compact, roughly square shape — a corner marker
 * seen through a tilted camera — rather than text, a line or a ring.
 *
 * (vxx + vyy) / area is rotation-invariant: 1/6 for a solid square, 1/2π for
 * a disc, and larger for anything hollow or stretched. The eigenvalue ratio
 * of the covariance bounds how stretched it may be.
 */
export function isSquareLike(b) {
  const spread = (b.vxx + b.vyy) / b.area;
  const half = (b.vxx + b.vyy) / 2;
  const disc = Math.sqrt(Math.max(0, half * half - (b.vxx * b.vyy - b.vxy * b.vxy)));
  const elongation = (half + disc) / Math.max(half - disc, 1e-6);
  const fill = b.area / ((b.maxX - b.minX + 1) * (b.maxY - b.minY + 1));
  return b.maxX - b.minX >= 3 && b.maxY - b.minY >= 3 && spread > 0.12 && spread < 0.22 && elongation < 2.6 && fill > 0.45;
}

/**
 * The homography taking each `from` point to its `to` point (four of each),
 * as 9 numbers row-major with the last fixed at 1, or null when degenerate.
 */
export function homography(from, to) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      if (!factor) continue;
      for (let k = col; k < 9; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return [...Array.from({ length: 8 }, (_, i) => a[i][8] / a[i][i]), 1];
}

export function project(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Bilinear sample of the grayscale image; outside the frame reads as black. */
function sampleAt(gray, width, height, x, y) {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = gray[y0 * width + x0] * (1 - fx) + gray[y0 * width + x1] * fx;
  const bottom = gray[y1 * width + x0] * (1 - fx) + gray[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Mean brightness of a sheet-millimetre rectangle, sampled on a grid. */
function rectMean(image, H, rect, steps = 6) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const [x, y] = project(H, rect.x + ((i + 0.5) / steps) * rect.width, rect.y + ((j + 0.5) / steps) * rect.height);
      sum += sampleAt(image.gray, image.width, image.height, x, y);
      n += 1;
    }
  }
  return sum / n;
}

/**
 * Points on the printed sheet that are always bare paper: the margins along
 * the lines between the corner markers. Four points map onto any four
 * points, so a homography alone proves nothing; a candidate is only the
 * sheet if these all come out as even, bright paper. A wrong corner — a dark
 * patch on the table, a filled bubble — sends some of them across the table
 * or the printed grid, and the set stops looking like paper.
 *
 * "Even" is judged along each margin line against its near neighbours, not
 * against one level for the page, because light falls off across a sheet
 * on a desk — 40% from one side to the other is ordinary.
 */
const PAPER_LINES = [];
{
  const row = (y, from, to) => Array.from({ length: Math.floor((to - from) / 5) + 1 }, (_, i) => [from + i * 5, y]);
  const col = (x) => Array.from({ length: 23 }, (_, i) => [x, 28 + i * 11]);
  const right = PAGE_W - 26;
  PAPER_LINES.push(row(MARKERS.tl.y, 26, 76), row(MARKERS.tl.y, right - 50, right), row(MARKERS.bl.y, 26, 76), row(MARKERS.bl.y, right - 50, right));
  PAPER_LINES.push(col(MARKERS.tl.x), col(MARKERS.tr.x + 0.5));
}

/** Share of paper points that look like bare paper: near the brightest of their neighbours, and well clear of ink. */
function paperCheck(image, H, ink) {
  let good = 0;
  let total = 0;
  for (const line of PAPER_LINES) {
    const values = line.map(([x, y]) => {
      const [px, py] = project(H, x, y);
      return sampleAt(image.gray, image.width, image.height, px, py);
    });
    values.forEach((v, i) => {
      const local = Math.max(...values.slice(Math.max(0, i - 2), i + 3));
      total += 1;
      if (v >= local * 0.8 && v >= ink * 2.2 && v - ink > 50) good += 1;
    });
  }
  return good / total;
}

const SHEET_CORNERS = [MARKERS.tl, MARKERS.tr, MARKERS.br, MARKERS.bl].map((p) => [p.x, p.y]);
const SHEET_ASPECT = MARKER_SPAN.x / MARKER_SPAN.y;

/** The four points in clockwise order (image y points down), or null if they do not make a convex quadrilateral. */
function clockwise(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const ordered = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  for (let i = 0; i < 4; i++) {
    const p = ordered[i];
    const q = ordered[(i + 1) % 4];
    const r = ordered[(i + 2) % 4];
    if ((q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x) <= 0) return null;
  }
  return ordered;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Whether a blob is dark ink with bright paper all round it, as a printed
 * corner square is (the sheet keeps a clear margin around each). A dark
 * patch of wood grain or a shadow has mid-tones around it instead.
 */
function inkOnPaper(image, b) {
  const side = Math.sqrt(b.area);
  const at = (dx, dy) => sampleAt(image.gray, image.width, image.height, b.x + dx * side, b.y + dy * side);
  const ink = (at(0, 0) + at(0.2, 0.2) + at(-0.2, 0.2) + at(0.2, -0.2) + at(-0.2, -0.2)) / 5;
  const ring = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i * Math.PI) / 8;
    ring.push(at(Math.cos(angle) * 1.05, Math.sin(angle) * 1.05));
  }
  ring.sort((p, q) => p - q);
  const paper = ring[3]; // the 4th darkest of 16 — a stray mark on one side is allowed
  return paper - ink > 60 && paper > ink * 2.2;
}

function quadArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += q[i].x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * q[i].y;
  return Math.abs(s) / 2;
}

/**
 * Finds the sheet in a grayscale frame.
 *
 * Returns { found: true, H, corners, coverage } — H maps sheet millimetres to
 * frame pixels, corners are the marker centres TL, TR, BR, BL as they appear
 * in the frame, coverage is the share of the frame the sheet fills — or
 * { found: false, reason } with reason 'markers' (fewer than four corner
 * squares in view) or 'sheet' (squares, but none that make an upright sheet).
 */
export function findSheet(gray, width, height) {
  const image = { gray, width, height };
  const mask = binarize(gray, width, height);
  const frameArea = width * height;
  const blobs = components(mask, width, height, { minArea: Math.max(9, frameArea * 0.00002), maxArea: frameArea * 0.02 }).filter((b) => isSquareLike(b) && inkOnPaper(image, b));
  if (blobs.length < 4) return { found: false, reason: 'markers', candidates: blobs.length };

  const pool = blobs.sort((a, b) => b.area - a.area).slice(0, 12);
  let best = null;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        for (let l = k + 1; l < pool.length; l++) {
          const set = [pool[i], pool[j], pool[k], pool[l]];
          const areas = set.map((b) => b.area);
          if (Math.max(...areas) > Math.min(...areas) * 4) continue;
          const ordered = clockwise(set);
          if (!ordered) continue;
          // A marker is MARKER_SIZE² of the MARKER_SPAN rectangle; how far each
          // blob is from the area that predicts, in log terms.
          const expected = (quadArea(ordered) * MARKER_SIZE * MARKER_SIZE) / (MARKER_SPAN.x * MARKER_SPAN.y);
          const sizeErrors = set.map((b) => Math.abs(Math.log(b.area / expected)));
          if (Math.max(...sizeErrors) > 1.1) continue;
          const sizeError = sizeErrors.reduce((s, e) => s + e, 0) / 4;
          for (let rot = 0; rot < 4; rot++) {
            const quad = [0, 1, 2, 3].map((n) => ordered[(n + rot) % 4]);
            const aspect = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / (dist(quad[0], quad[3]) + dist(quad[1], quad[2]));
            const aspectError = Math.abs(Math.log(aspect / SHEET_ASPECT));
            if (aspectError > 0.45) continue;
            const H = homography(SHEET_CORNERS, quad.map((p) => [p.x, p.y]));
            if (!H) continue;
            const bar = rectMean(image, H, ORIENTATION_BAR);
            const blank = rectMean(image, H, ORIENTATION_BLANK);
            const contrast = (blank - bar) / Math.max(blank, 1);
            if (contrast < 0.25) continue;
            const even = paperCheck(image, H, bar);
            if (even < 0.85) continue;
            const score = contrast + even * 2 - aspectError * 0.5 - sizeError * 0.5;
            if (!best || score > best.score) best = { score, H, quad };
          }
        }
      }
    }
  }
  if (!best) return { found: false, reason: 'sheet', candidates: blobs.length };
  return {
    found: true,
    H: best.H,
    corners: best.quad.map((p) => ({ x: p.x, y: p.y })),
    coverage: quadArea(best.quad) / frameArea,
  };
}

/** The sample offsets (in units of the bubble radius) for a bubble's inside and its paper ring. */
const INNER = [[0, 0]];
for (let i = 0; i < 6; i++) INNER.push([0.3 * Math.cos((i * Math.PI) / 3), 0.3 * Math.sin((i * Math.PI) / 3)]);
for (let i = 0; i < 12; i++) INNER.push([0.6 * Math.cos((i * Math.PI) / 6 + 0.26), 0.6 * Math.sin((i * Math.PI) / 6 + 0.26)]);
const RING = Array.from({ length: 16 }, (_, i) => [1.32 * Math.cos((i * Math.PI) / 8 + 0.2), 1.32 * Math.sin((i * Math.PI) / 8 + 0.2)]);

/**
 * How filled a bubble is: 1 − (mean of its centre ÷ the paper around it),
 * clamped to 0…1. The paper level is a high percentile of a ring just
 * outside the printed circle, so a neighbour's ink on one side of the ring
 * does not drag it down.
 */
export function bubbleFill(image, H, cx, cy, r) {
  let inner = 0;
  for (const [dx, dy] of INNER) {
    const [x, y] = project(H, cx + dx * r, cy + dy * r);
    inner += sampleAt(image.gray, image.width, image.height, x, y);
  }
  inner /= INNER.length;
  const ring = RING.map(([dx, dy]) => {
    const [x, y] = project(H, cx + dx * r, cy + dy * r);
    return sampleAt(image.gray, image.width, image.height, x, y);
  }).sort((a, b) => a - b);
  const paper = ring[Math.floor(ring.length * 0.7)];
  return Math.min(1, Math.max(0, 1 - inner / Math.max(paper, 1)));
}

/** Otsu's threshold over values in 0…1 — the split that best separates two groups. */
export function otsu(values) {
  const bins = 64;
  const hist = new Array(bins).fill(0);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))] += 1;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let bestVar = -1;
  let bestT = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      bestT = t;
    }
  }
  return (bestT + 1) / bins;
}

/** The fill a bubble needs to count as marked is kept inside this band whatever Otsu says. */
const MIN_THRESHOLD = 0.28;
const MAX_THRESHOLD = 0.55;
/** A bubble this close to the threshold is "too close to call" and flagged for the teacher. */
const UNSURE_MARGIN = 0.07;
/** A second filled bubble this much fainter than the first is taken as an erased answer. */
const ERASED_RATIO = 0.55;

/** The options marked in one row of fills, and whether any is borderline. */
function readRow(fills, labels, threshold) {
  const order = fills.map((f, i) => i).sort((a, b) => fills[b] - fills[a]);
  let marked = order.filter((i) => fills[i] >= threshold);
  let unsure = fills.some((f) => Math.abs(f - threshold) < UNSURE_MARGIN);
  if (marked.length > 1 && fills[marked[1]] < fills[marked[0]] * ERASED_RATIO) {
    marked = [marked[0]];
    unsure = true;
  }
  return { value: marked.sort((a, b) => a - b).map((i) => labels[i]).join(''), unsure };
}

/**
 * Reads every question and the roll number off a found sheet.
 *
 * answers[i] is '' (blank), one letter, or several letters when more than
 * one bubble is filled — grading treats that as a wrong answer, the usual OMR
 * rule. unsure lists question numbers with a borderline bubble. roll is the
 * bubbled digits (4, or 6 on the exam-pattern sheets), or null with rollProblem 'blank', 'multiple' or
 * 'partial' when they cannot be read. `style` is the sheet style the test
 * was printed in (omrLayout.js OMR_STYLES), whose bubbles differ.
 */
export function readSheet(gray, width, height, H, { questions, options, style = 'coachbook' }) {
  const layout = sheetLayout({ questions, options, style });
  const image = { gray, width, height };
  const r = layout.bubbleRadius;
  const answerFills = layout.items.map((item) => item.bubbles.map((b) => bubbleFill(image, H, b.x, b.y, r)));
  const rollFills = layout.roll.map((column) => column.bubbles.map((b) => bubbleFill(image, H, b.x, b.y, r)));
  const all = [...answerFills.flat(), ...rollFills.flat()];
  const threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, otsu(all)));

  const answers = [];
  const unsure = [];
  layout.items.forEach((item, i) => {
    const row = readRow(answerFills[i], item.bubbles.map((b) => b.label), threshold);
    answers.push(row.value);
    if (row.unsure) unsure.push(item.number);
  });

  const digits = rollFills.map((fills) => readRow(fills, '0123456789'.split(''), threshold));
  let roll = null;
  let rollProblem = null;
  if (digits.some((d) => d.value.length > 1)) rollProblem = 'multiple';
  else if (digits.every((d) => !d.value)) rollProblem = 'blank';
  else {
    // Leading columns may be left blank ("  07"); a gap after the first digit may not.
    const firstFilled = digits.findIndex((d) => d.value);
    if (digits.slice(firstFilled).some((d) => !d.value)) rollProblem = 'partial';
    else roll = digits.map((d) => d.value || '0').join('');
  }

  return { answers, unsure, roll, rollProblem, rollUnsure: digits.some((d) => d.unsure), threshold, answerFills, rollFills };
}

/** Where a sheet-millimetre point lands in the frame — for drawing the read answers over the video. */
export const sheetToFrame = project;
