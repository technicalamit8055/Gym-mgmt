import { coaching } from '../../coachingApi.js';
import { ensureCameraPermission } from '../../nativePermissions.js';
import { MAX_QUESTIONS, OPTION_LABELS, sheetLayout } from '../../omrLayout.js';
import { findSheet, readSheet, sheetToFrame, toGray } from '../../omrScan.js';
import { closeModal, h, openModal, renderIcon, toast } from '../../ui.js';
import { fill, fullName, reportSend, section } from './common.js';

/**
 * OMR sheet marking: the test page's OMR card (paper shape, answer key,
 * printable sheets, per-question analysis) and the phone scanner.
 *
 * The scanner runs the reader in js/omrScan.js on the live camera: a cheap
 * pass on a small copy of each frame finds the sheet and steadies the
 * outline; once the corners hold still for a few frames it reads the
 * full-resolution frame, matches the bubbled roll number to the roster, and
 * shows the read for a glance. Save sends the raw marks to the server, which
 * grades them against the key and re-ranks the batch. With auto-save on, a
 * clean read (one roster match, nothing borderline) saves itself — a teacher
 * then only swaps sheets.
 */

const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/** The client's copy of the server's marking rule, for the live preview only — the server's score is the one saved. */
function grade(key, answers, { marksCorrect, negative }) {
  let correct = 0;
  let wrong = 0;
  let blank = 0;
  let bonus = 0;
  const outcome = key.map((k, i) => {
    const a = answers[i] || '';
    if (k === '*') return (bonus += 1), 'bonus';
    if (!a) return (blank += 1), 'blank';
    if (a.length === 1 && k.includes(a)) return (correct += 1), 'correct';
    return (wrong += 1), 'wrong';
  });
  return { correct, wrong, blank, bonus, outcome, score: Math.round(((correct + bonus) * marksCorrect - wrong * negative) * 100) / 100 };
}

/** Splits a typed key the way the server does (src/coaching/omr.js), for the live counter. */
function previewKey(text, options) {
  const allowed = OPTION_LABELS.slice(0, options);
  const entries = [];
  const upper = String(text || '').toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    if (/[\s,.;:|/\\\-\d]/.test(ch)) continue;
    if (ch === '(' || ch === '[') {
      const close = upper.indexOf(ch === '(' ? ')' : ']', i);
      if (close < 0) return { entries, error: `Question ${entries.length + 1}: close the ${ch}` };
      entries.push(upper.slice(i + 1, close).replace(/[\s,]/g, ''));
      i = close;
      continue;
    }
    entries.push(ch);
  }
  const bad = entries.findIndex((e) => e !== '*' && (!e || [...e].some((l) => !allowed.includes(l))));
  return { entries, error: bad >= 0 ? `Question ${bad + 1}: “${entries[bad] || 'blank'}” is not ${allowed.join('/')} or *` : null };
}

const keyText = (key) => (key || []).map((k) => (k.length > 1 && k !== '*' ? `(${k})` : k)).reduce((acc, k, i) => acc + (i && i % 5 === 0 ? ' ' : '') + k, '');

/* ── Setting the paper up ───────────────────────────────────────────── */

function openOmrSetup({ test, state, onSaved }) {
  const field = (label, control, hint) =>
    h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, hint) : null);
  const questions = h('input', { type: 'number', min: 1, max: MAX_QUESTIONS, value: state.questions ?? '' , placeholder: 'e.g. 60' });
  const options = h('select', {}, h('option', { value: 4 }, '4 (A–D)'), h('option', { value: 5 }, '5 (A–E)'));
  options.value = String(state.options ?? 4);
  const marks = h('input', { type: 'number', min: 0.25, step: '0.25', value: state.marks_correct ?? 4 });
  const key = h('textarea', { rows: 5, placeholder: 'ABCDA BCDAB … — spaces and question numbers are ignored. (AC) accepts A or C, * is a bonus question.', spellcheck: false, autocapitalize: 'characters' });
  key.value = keyText(state.answer_key);
  const counter = h('div', { class: 'muted cb-small omr-key-count' });
  const grid = h('div', { class: 'omr-key-grid' });
  const error = h('div', { class: 'field-error', style: 'display:none' });

  const refresh = () => {
    const q = Number(questions.value) || 0;
    const { entries, error: problem } = previewKey(key.value, Number(options.value));
    counter.textContent = key.value.trim()
      ? `${entries.length} of ${q || '?'} answers${problem ? ` · ${problem}` : entries.length > q && q ? ' · too many' : ''}`
      : 'No key yet — you can print sheets now and add the key after the test.';
    counter.classList.toggle('is-bad', Boolean(problem) || (q && entries.length > q));
    fill(grid, ...Array.from({ length: Math.min(q, MAX_QUESTIONS) }, (_, i) =>
      h('span', { class: `omr-key-cell${entries[i] ? '' : ' is-empty'}` }, h('b', {}, i + 1), entries[i] || '·')));
  };
  for (const el of [questions, options, key]) el.addEventListener('input', refresh);
  options.addEventListener('change', refresh);
  refresh();

  const usePaper = state.paper_key
    ? h('button', {
        class: 'btn sm ghost',
        type: 'button',
        onclick: () => {
          questions.value = state.paper_key.length;
          options.value = '4';
          key.value = keyText(state.paper_key);
          refresh();
        },
      }, renderIcon('copy', { size: 14 }), `Use the question paper’s ${state.paper_key.length} answers`)
    : null;

  const save = h('button', { class: 'btn primary' }, 'Save');
  save.addEventListener('click', async () => {
    error.style.display = 'none';
    save.disabled = true;
    try {
      const saved = await coaching.saveOmr(test.id, {
        questions: Number(questions.value),
        options: Number(options.value),
        marks_correct: Number(marks.value),
        answer_key: key.value.trim() || null,
      });
      closeModal();
      toast(saved.answer_key ? (saved.scanned ? `Key saved — ${saved.scanned} sheets re-marked` : 'Answer key saved') : 'Sheet set up — add the key when it is ready');
      onSaved?.(saved);
    } catch (err) {
      error.textContent = err.message;
      error.style.display = '';
      save.disabled = false;
    }
  });

  openModal({
    title: state.configured ? 'OMR answer key' : 'Set up the OMR sheet',
    icon: 'scan',
    wide: true,
    body: h(
      'div',
      { class: 'grid', style: 'gap:14px' },
      h(
        'div',
        { class: 'form-grid' },
        field('Questions', questions, `Up to ${MAX_QUESTIONS} on one sheet`),
        field('Options per question', options),
        field('Marks per correct answer', marks, test.negative_marking ? `A wrong answer costs ${fmt(test.negative_marking)} (set on the test)` : 'No negative marking (set on the test)'),
      ),
      h('label', { class: 'field full' }, h('span', {}, 'Answer key'), key, counter),
      usePaper,
      grid,
      state.scanned ? h('p', { class: 'muted cb-small' }, `${state.scanned} sheets are already scanned — a changed key re-marks all of them, and their parents get a fresh scorecard on the next publish.`) : null,
      error,
    ),
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
  });
}

/** The test page's OMR card. Loads itself, so the test page does not wait on it. */
export function omrSection({ test, navigate, onChanged }) {
  // The buttons sit in the body rather than the card's title row: four of
  // them do not fit beside the title on a phone.
  const actions = h('div', { class: 'row omr-actions' });
  const content = h('div', { class: 'muted cb-small' }, 'Loading…');
  const card = section('OMR sheets', h('div', {}, actions, content), {
    icon: 'scan',
    subtitle: 'Print one sheet, photocopy it, and mark the whole batch with your phone’s camera.',
  });
  const body = content;

  const download = async (named) => {
    try {
      await coaching.omrSheet(test.id, { named });
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const paint = (state) => {
    const setup = () => openOmrSetup({ test, state, onSaved: () => onChanged?.() });
    if (!state.configured) {
      fill(actions, h('button', { class: 'btn sm primary', onclick: setup }, renderIcon('plus', { size: 14 }), 'Set up OMR sheet'));
      fill(body, h('p', { class: 'muted' }, 'Set the number of questions to get a printable answer sheet. After the test, enter the key and scan each filled sheet — marks, ranks and parent scorecards follow automatically.'));
      return;
    }
    fill(
      actions,
      h('button', { class: 'btn sm ghost', onclick: setup }, renderIcon('edit', { size: 14 }), 'Answer key'),
      h('button', { class: 'btn sm ghost', onclick: () => download(false) }, renderIcon('download', { size: 14 }), 'Sheet PDF'),
      h('button', { class: 'btn sm ghost', onclick: () => download(true), title: 'One page per student, name printed and roll number already bubbled' }, renderIcon('users', { size: 14 }), 'Named sheets'),
      h('button', {
        class: 'btn sm primary',
        disabled: !state.answer_key,
        title: state.answer_key ? '' : 'Enter the answer key first',
        onclick: () => navigate(`/tests/${test.id}/scan`),
      }, renderIcon('camera', { size: 14 }), 'Scan sheets'),
    );
    const stats = state.question_stats || [];
    const hardest = [...stats].filter((s) => s.correct_pct !== null).sort((a, b) => a.correct_pct - b.correct_pct).slice(0, 5);
    fill(
      body,
      h(
        'div',
        { class: 'omr-summary' },
        h('span', { class: 'badge violet' }, `${state.questions} questions × ${state.options} options`),
        h('span', { class: 'badge' }, `+${fmt(state.marks_correct)} / −${fmt(test.negative_marking || 0)}`),
        state.answer_key ? h('span', { class: 'badge dot green' }, 'Key entered') : h('span', { class: 'badge dot amber' }, 'No answer key yet'),
        h('span', { class: 'muted' }, `${state.scanned} of ${state.roster.length} sheets scanned`),
      ),
      stats.length
        ? h(
            'div',
            { class: 'omr-analysis' },
            h('div', { class: 'cb-strong cb-small' }, 'Question by question — share of the batch who got it right'),
            h('div', { class: 'omr-qstats' }, ...stats.map((s) => h(
              'span',
              {
                class: `omr-qstat ${s.correct_pct < 40 ? 'is-low' : s.correct_pct < 70 ? 'is-mid' : 'is-high'}`,
                title: `Q${s.number} · key ${s.key} · ${fmt(s.correct_pct)}% right · ${fmt(s.blank_pct)}% left blank${s.common_wrong ? ` · ${s.common_wrong.count} chose ${s.common_wrong.answer}` : ''}`,
              },
              h('b', {}, s.number),
              `${Math.round(s.correct_pct)}%`,
            ))),
            hardest.length
              ? h('p', { class: 'muted cb-small' }, `Discuss in class: ${hardest.map((s) => `Q${s.number} (${Math.round(s.correct_pct)}% right${s.common_wrong ? `, most chose ${s.common_wrong.answer}` : ''})`).join(' · ')}`)
              : null,
          )
        : null,
    );
  };

  coaching.omr(test.id).then(paint, (err) => fill(body, h('p', { class: 'muted' }, err.message || 'Could not load the OMR sheet')));
  return card;
}

/* ── The scanner ────────────────────────────────────────────────────── */

const AUTO_KEY = 'cb-omr-autosave';
const readAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) === '1';
  } catch {
    return false;
  }
};
const writeAuto = (on) => {
  try {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0');
  } catch {
    /* private mode — the toggle just will not be remembered */
  }
};

const LIVE_SIZE = 640;
const STEADY_FRAMES = 3;
const TICK_MS = 160;

export async function renderOmrScanner({ params, setTitle, setActions, navigate }) {
  const testId = Number(params[0]);
  let state = await coaching.omr(testId);
  if (!state.configured || !state.answer_key) {
    toast('Enter the answer key before scanning', 'info');
    navigate(`/tests/${testId}`);
    return h('div', {});
  }
  setTitle(`Scan · ${state.test.title}`);
  const paper = { questions: state.questions, options: state.options };
  const scheme = { marksCorrect: state.marks_correct, negative: state.test.negative_marking || 0 };
  const layout = sheetLayout(paper);

  const video = h('video', { class: 'omr-video', playsinline: '', muted: true, autoplay: true });
  const overlay = h('canvas', { class: 'omr-overlay' });
  const status = h('div', { class: 'omr-status' }, 'Starting the camera…');
  const stage = h('div', { class: 'omr-stage' }, video, overlay, status);
  const progress = h('div', { class: 'omr-progress' });
  const review = h('div', { class: 'omr-review', hidden: true });
  const auto = h('input', { type: 'checkbox', checked: readAuto(), onchange: (e) => writeAuto(e.target.checked) });
  const torchBtn = h('button', { class: 'btn sm ghost', hidden: true, type: 'button' }, renderIcon('zap', { size: 14 }), 'Light');
  const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const scanNow = h('button', { class: 'btn sm ghost', type: 'button', title: 'Read whatever is in view now' }, renderIcon('scan', { size: 14 }), 'Scan now');

  const small = document.createElement('canvas');
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  const full = document.createElement('canvas');
  const fullCtx = full.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let track = null;
  let wakeLock = null;
  let running = false;
  let paused = false;
  let previous = null;
  let steady = 0;
  let waitForSwap = false;
  let missing = 0;
  let forceCapture = false;
  let autoTimer = null;

  video.muted = true;
  /** The stage takes the frame's own shape, so one scale maps frame pixels to the overlay on both axes. */
  const setAspect = (w, h2) => {
    if (w && h2) stage.style.setProperty('--ar', `${w} / ${h2}`);
  };
  video.addEventListener('loadedmetadata', () => setAspect(video.videoWidth, video.videoHeight));

  const say = (text, tone = '') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const paintProgress = () => {
    const done = state.roster.filter((r) => r.scanned).length;
    fill(
      progress,
      h('span', { class: 'cb-strong' }, `${done} of ${state.roster.length} scanned`),
      h('div', { class: 'omr-bar' }, h('span', { style: `width:${state.roster.length ? (done / state.roster.length) * 100 : 0}%` })),
    );
  };

  /* Drawing over the video. Display px = frame px × (shown width ÷ video width). */
  const fitOverlay = () => {
    const ratio = window.devicePixelRatio || 1;
    overlay.width = Math.round(overlay.clientWidth * ratio);
    overlay.height = Math.round(overlay.clientHeight * ratio);
    return overlay.getContext('2d');
  };
  const drawQuad = (corners, frameWidth, colour) => {
    const ctx = fitOverlay();
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!corners) return;
    const k = overlay.width / frameWidth;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 3 * (window.devicePixelRatio || 1);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
    ctx.closePath();
    ctx.stroke();
  };

  /** Freezes the captured frame on the overlay with a dot on every bubble read, coloured by what it scored. */
  const drawRead = (H, read, outcome) => {
    const ctx = fitOverlay();
    const k = overlay.width / full.width;
    ctx.drawImage(full, 0, 0, overlay.width, overlay.height);
    const colours = { correct: '#16a34a', wrong: '#dc2626', bonus: '#7c3aed' };
    const dot = (x, y, colour, r) => {
      const [fx, fy] = sheetToFrame(H, x, y);
      ctx.beginPath();
      ctx.arc(fx * k, fy * k, r, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
    };
    const radius = Math.max(3, 5 * k * (full.width / 1000));
    layout.items.forEach((item, i) => {
      const unsure = read.unsure.includes(item.number);
      for (const b of item.bubbles) {
        if (!(read.answers[i] || '').includes(b.label)) continue;
        dot(b.x, b.y, unsure ? '#f59e0b' : colours[outcome[i]] || '#2563eb', radius);
      }
    });
    layout.roll.forEach((column, d) => {
      const digit = read.roll?.[d];
      const b = column.bubbles.find((x) => x.label === digit);
      if (b) dot(b.x, b.y, '#2563eb', radius);
    });
  };

  /* The live loop. */
  const stop = () => {
    running = false;
    clearTimeout(autoTimer);
    for (const t of stream?.getTracks() || []) t.stop();
    stream = null;
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  };

  const grabSmall = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const s = Math.min(1, LIVE_SIZE / Math.max(vw, vh));
    small.width = Math.round(vw * s);
    small.height = Math.round(vh * s);
    smallCtx.drawImage(video, 0, 0, small.width, small.height);
    const img = smallCtx.getImageData(0, 0, small.width, small.height);
    return { gray: toGray(img.data, small.width, small.height), width: small.width, height: small.height, scale: s };
  };

  const tick = () => {
    if (!running) return;
    if (!stage.isConnected) return stop();
    if (!paused && video.videoWidth) {
      try {
        const frame = grabSmall();
        const found = findSheet(frame.gray, frame.width, frame.height);
        const corners = found.found ? found.corners.map((p) => ({ x: p.x / frame.scale, y: p.y / frame.scale })) : null;
        if (!found.found) {
          missing += 1;
          if (waitForSwap && missing >= 2) waitForSwap = false;
          drawQuad(null, video.videoWidth);
          steady = 0;
          previous = null;
          say(waitForSwap ? 'Show the next sheet' : found.reason === 'markers' ? 'Fit all four black corner squares in view' : 'Hold the whole sheet flat and upright in view');
          if (forceCapture) {
            forceCapture = false;
            capture(null);
          }
        } else {
          missing = 0;
          const diag = Math.hypot(video.videoWidth, video.videoHeight);
          const moved = previous ? Math.max(...corners.map((p, i) => Math.hypot(p.x - previous[i].x, p.y - previous[i].y))) / diag : 1;
          steady = moved < 0.012 ? steady + 1 : 0;
          previous = corners;
          if (waitForSwap && !forceCapture) {
            drawQuad(corners, video.videoWidth, 'rgba(255,255,255,0.6)');
            say('Saved — take this sheet away and show the next one');
          } else if (found.coverage < 0.22 && !forceCapture) {
            drawQuad(corners, video.videoWidth, '#f59e0b');
            say('Move closer — let the sheet fill the screen', 'warn');
          } else {
            drawQuad(corners, video.videoWidth, steady >= STEADY_FRAMES - 1 ? '#22c55e' : '#38bdf8');
            say(steady >= STEADY_FRAMES - 1 ? 'Reading…' : 'Hold steady…', 'ok');
            if (steady >= STEADY_FRAMES || forceCapture) {
              forceCapture = false;
              capture(found.H.map((v, i) => (i < 6 ? v / frame.scale : v)));
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    setTimeout(tick, TICK_MS);
  };

  /**
   * Reads the full-resolution frame. `fallbackH` (the live pass's mapping,
   * scaled up) is used if the full frame somehow will not give the corners.
   */
  const capture = (fallbackH, source = video) => {
    const width = source.videoWidth || source.naturalWidth;
    const height = source.videoHeight || source.naturalHeight;
    const s = Math.min(1, 2400 / Math.max(width, height));
    full.width = Math.round(width * s);
    full.height = Math.round(height * s);
    setAspect(full.width, full.height);
    fullCtx.drawImage(source, 0, 0, full.width, full.height);
    const gray = toGray(fullCtx.getImageData(0, 0, full.width, full.height).data, full.width, full.height);
    const found = findSheet(gray, full.width, full.height);
    const H = found.found ? found.H : fallbackH?.map((v, i) => (i < 6 ? v * s : v));
    if (!H) {
      say('Could not find the sheet in that picture — try again with all four corners in view', 'warn');
      return;
    }
    const read = readSheet(gray, full.width, full.height, H, paper);
    navigator.vibrate?.(40);
    paused = true;
    say('Check the read, then save', 'ok');
    showReview(read, H);
  };

  /* The review card. */
  const showReview = (read, H) => {
    clearTimeout(autoTimer);
    const answers = [...read.answers];
    const unsure = new Set(read.unsure);
    const matches = read.roll ? state.roster.filter((r) => r.roll_digits === read.roll) : [];
    let chosen = matches.length === 1 ? matches[0].member_id : '';

    const picker = h(
      'select',
      { class: 'omr-student' },
      h('option', { value: '' }, 'Choose the student…'),
      ...state.roster.map((r) => h('option', { value: r.member_id }, `${r.scanned ? '✓ ' : ''}${fullName(r)}${r.roll_number ? ` · ${r.roll_number}` : ''}`)),
    );
    picker.value = String(chosen);
    const rollNote = h('div', { class: 'cb-small' });
    const scoreLine = h('div', { class: 'omr-score' });
    const grid = h('div', { class: 'omr-answers' });
    const save = h('button', { class: 'btn primary' }, renderIcon('check', { size: 16 }), 'Save & next');
    const retry = h('button', { class: 'btn ghost' }, renderIcon('refresh', { size: 15 }), 'Rescan');

    const cancelAuto = () => {
      if (!autoTimer) return;
      clearTimeout(autoTimer);
      autoTimer = null;
      fill(save, renderIcon('check', { size: 16 }), 'Save & next');
    };

    const paintRoll = () => {
      const student = state.roster.find((r) => r.member_id === Number(chosen));
      const problem = {
        blank: 'No roll number bubbled — choose the student.',
        multiple: 'Two bubbles filled in a roll-number column — choose the student.',
        partial: 'The roll number has a gap — choose the student.',
      }[read.rollProblem];
      let text;
      let tone = '';
      if (problem) [text, tone] = [problem, 'warn'];
      else if (!matches.length) [text, tone] = [`Roll ${read.roll} is not on this batch’s roster — choose the student.`, 'warn'];
      else if (matches.length > 1) [text, tone] = [`Roll ${read.roll} matches ${matches.length} students — choose one.`, 'warn'];
      else text = `Roll ${read.roll}${read.rollUnsure ? ' (check — a bubble was faint)' : ''}`;
      if (student?.scanned) [text, tone] = [`${text} ${fullName(student)} is already scanned — saving replaces that sheet.`, 'warn'];
      rollNote.textContent = text;
      rollNote.dataset.tone = tone;
    };

    const paint = () => {
      const g = grade(state.answer_key, answers, scheme);
      fill(
        scoreLine,
        h('b', {}, `${fmt(g.score)} / ${fmt(state.test.max_marks)}`),
        h('span', { class: 'ok' }, `${g.correct} right`),
        h('span', { class: 'bad' }, `${g.wrong} wrong`),
        h('span', {}, `${g.blank} blank`),
        g.bonus ? h('span', {}, `${g.bonus} bonus`) : null,
        unsure.size ? h('span', { class: 'warn' }, `${unsure.size} to check`) : null,
      );
      fill(grid, ...layout.items.map((item, i) => {
        const a = answers[i];
        const cls = ['omr-q', `is-${g.outcome[i]}`, a.length > 1 ? 'is-multi' : '', unsure.has(item.number) ? 'is-unsure' : ''].join(' ');
        return h(
          'button',
          {
            type: 'button',
            class: cls,
            title: `Q${item.number}: read ${a || 'blank'}, key ${state.answer_key[i]} — tap to change`,
            onclick: () => {
              cancelAuto();
              // Cycle blank → A → B → … → blank; a multi-mark starts the cycle over.
              const cycle = ['', ...OPTION_LABELS.slice(0, paper.options)];
              answers[i] = cycle[(cycle.indexOf(a) + 1) % cycle.length];
              unsure.delete(item.number);
              paint();
            },
          },
          h('b', {}, item.number),
          h('span', {}, a || '–'),
          g.outcome[i] === 'wrong' ? h('small', {}, state.answer_key[i]) : null,
        );
      }));
      drawRead(H, { ...read, answers, unsure: [...unsure] }, g.outcome);
    };

    const resume = () => {
      cancelAuto();
      review.hidden = true;
      paused = false;
      steady = 0;
      previous = null;
      setAspect(video.videoWidth, video.videoHeight);
      drawQuad(null, 1);
    };

    const doSave = async () => {
      cancelAuto();
      const memberId = Number(chosen);
      if (!memberId) {
        toast('Choose which student this sheet belongs to', 'info');
        picker.focus();
        return;
      }
      save.disabled = true;
      try {
        const result = await coaching.saveOmrScan(testId, { member_id: memberId, answers });
        const student = state.roster.find((r) => r.member_id === memberId);
        Object.assign(student, { scanned: true, score: result.score, correct: result.correct, wrong: result.wrong, blank: result.blank });
        paintProgress();
        toast(`${fullName(student)} · ${fmt(result.score)}/${fmt(result.max_marks)} · rank ${result.rank ?? '—'} of ${result.appeared} so far`);
        waitForSwap = true;
        missing = 0;
        resume();
      } catch (err) {
        toast(err.message || 'Could not save that sheet', 'error');
        save.disabled = false;
      }
    };

    picker.addEventListener('change', () => {
      cancelAuto();
      chosen = picker.value;
      paintRoll();
    });
    save.addEventListener('click', doSave);
    retry.addEventListener('click', resume);
    review.onkeydown = (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'SELECT') {
        e.preventDefault();
        doSave();
      }
    };

    paintRoll();
    paint();
    fill(
      review,
      h('div', { class: 'omr-review-head' }, picker, rollNote),
      scoreLine,
      grid,
      h('div', { class: 'omr-legend muted cb-small' }, 'Green right · red wrong (key shown) · amber: faint or several bubbles, check the sheet · tap a question to change it'),
      h('div', { class: 'row omr-review-actions' }, retry, h('div', { class: 'spacer' }), save),
    );
    review.hidden = false;
    review.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });

    const clean = matches.length === 1 && !matches[0].scanned && !unsure.size && !read.rollUnsure && !read.rollProblem;
    if (auto.checked && clean) {
      let left = 2;
      const count = () => {
        if (left <= 0) {
          autoTimer = null;
          doSave();
          return;
        }
        fill(save, renderIcon('check', { size: 16 }), `Saving in ${left}…`);
        left -= 1;
        autoTimer = setTimeout(count, 700);
      };
      count();
    }
  };

  /* Students still to scan, and marking the rest absent. */
  const openRemaining = () => {
    const left = state.roster.filter((r) => !r.scanned);
    const markAbsent = async (rows) => {
      try {
        await coaching.saveMarks(testId, rows.map((r) => ({ member_id: r.member_id, is_absent: true })));
        toast(`${rows.length} marked absent`);
        closeModal();
        state = await coaching.omr(testId);
        paintProgress();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    openModal({
      title: `${left.length} still to scan`,
      icon: 'users',
      body: left.length
        ? h('div', { class: 'omr-left' }, ...left.map((r) => h(
            'div',
            { class: 'omr-left-row' },
            h('div', {}, h('div', { class: 'cb-strong' }, fullName(r)), h('div', { class: 'muted cb-small' }, r.roll_number ? `Roll ${r.roll_number} · bubbles ${r.roll_digits ?? '—'}` : 'No roll number')),
            r.marked_by_hand ? h('span', { class: 'badge' }, 'Marks typed in') : h('button', { class: 'btn sm ghost', onclick: () => markAbsent([r]) }, 'Absent'),
          )))
        : h('p', { class: 'muted' }, 'Every sheet is scanned.'),
      footer: left.length
        ? [h('button', { class: 'btn ghost', onclick: closeModal }, 'Close'), h('button', { class: 'btn', onclick: () => markAbsent(left.filter((r) => !r.marked_by_hand)) }, 'Mark the rest absent')]
        : [h('button', { class: 'btn', onclick: closeModal }, 'Close')],
    });
  };

  const openPublish = () => {
    const notify = h('input', { type: 'checkbox', checked: true });
    const go = h('button', { class: 'btn primary' }, renderIcon('send', { size: 15 }), 'Publish result');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const res = await coaching.publishTest(testId, notify.checked);
        closeModal();
        toast('Result published');
        if (notify.checked) reportSend(res.whatsapp, { what: 'scorecards', none: 'Every parent already has this scorecard' });
        stop();
        navigate(`/tests/${testId}`);
      } catch (err) {
        toast(err.message, 'error');
        go.disabled = false;
      }
    });
    const done = state.roster.filter((r) => r.scanned).length;
    openModal({
      title: `Publish ${state.test.title}?`,
      icon: 'trophy',
      body: h(
        'div',
        { class: 'grid', style: 'gap:10px' },
        h('p', { class: 'muted' }, `${done} of ${state.roster.length} sheets scanned. The result and ranks show in the student app.`),
        h('label', { class: 'cb-check' }, notify, 'WhatsApp each parent the scorecard — marks, rank, and right / wrong / unattempted'),
      ),
      footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Not yet'), go],
    });
  };

  /* Camera start, with the fallbacks a classroom phone needs. */
  const start = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      say('This browser will not share the camera here — use “Photo” to take a picture instead', 'warn');
      return;
    }
    try {
      await ensureCameraPermission();
      stream = await navigator.mediaDevices.getUserMedia({
        // 4:3, the sensor's own shape on most phones: a 16:9 mode is a crop of
        // it, and an A4 sheet (1 : 1.41) fills a 4:3 frame better anyway.
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
    } catch (err) {
      say(err?.name === 'NotAllowedError' ? 'Camera permission is off — allow it, or use “Photo”' : 'Could not start the camera — use “Photo” instead', 'warn');
      return;
    }
    if (!stage.isConnected) return stop();
    video.srcObject = stream;
    await video.play().catch(() => {});
    [track] = stream.getVideoTracks();
    const caps = track?.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    if (caps.torch) {
      let on = false;
      torchBtn.hidden = false;
      torchBtn.onclick = () => {
        on = !on;
        track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
        torchBtn.classList.toggle('is-on', on);
      };
    }
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* the screen may dim — not worth bothering the teacher about */
    }
    running = true;
    tick();
  };

  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      capture(null, img);
    };
    img.onerror = () => toast('Could not open that photo', 'error');
    img.src = URL.createObjectURL(file);
  });
  scanNow.addEventListener('click', () => {
    if (!running) return;
    waitForSwap = false;
    forceCapture = true;
  });

  setActions(
    h('button', { class: 'btn ghost', onclick: openRemaining }, renderIcon('users', { size: 15 }), 'Still to scan'),
    h('button', { class: 'btn primary', onclick: openPublish }, renderIcon('send', { size: 15 }), 'Finish & publish'),
  );
  paintProgress();
  window.addEventListener('hashchange', stop, { once: true });
  setTimeout(start, 0);

  return h(
    'div',
    { class: 'cb-page omr-scan' },
    h('a', { class: 'cb-back', href: `#/tests/${testId}`, onclick: stop }, renderIcon('arrowLeft', { size: 15 }), state.test.title),
    progress,
    stage,
    h(
      'div',
      { class: 'row omr-tools' },
      h('label', { class: 'cb-check' }, auto, 'Auto-save clean sheets'),
      h('div', { class: 'spacer' }),
      torchBtn,
      scanNow,
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => photoInput.click() }, renderIcon('image', { size: 14 }), 'Photo'),
      photoInput,
    ),
    review,
    h('p', { class: 'muted cb-small' }, 'Lay the sheet flat in good light and hold the phone straight above it. When all four black corner squares are in view the outline turns green and the sheet is read on its own.'),
  );
}
