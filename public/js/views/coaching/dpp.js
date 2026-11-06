import { coaching } from '../../coachingApi.js';
import { loadMath, mathHtml, mathNode, mathStylesheet } from '../../math.js';
import { closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, toast, today } from '../../ui.js';
import { batchOptions, fill, section, TEST_TYPE_LABEL } from './common.js';

/**
 * The DPP & test generator and the question paper a test carries.
 *
 *   openGenerator()   class, subject, topic and level in; a draft paper out
 *                     (Gemini, via POST /tests/generate), previewed with its
 *                     maths typeset, answer key, hints and solutions. Nothing
 *                     is saved until the teacher saves it as a test — and
 *                     opens it in the student app, if they choose.
 *   paperSection()    the paper on a test's page: every question with its
 *                     answer, edit / add / reorder / delete, open or close it
 *                     in the student app, and print it.
 *   printPaper()      the student paper, the answer key with solutions, or
 *                     both, laid out for A4 — the browser's print dialog
 *                     saves it as a PDF.
 */

const LETTERS = ['A', 'B', 'C', 'D'];
const CLASS_LEVELS = ['Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12', 'Dropper'];
const TOUGHNESS = [
  { value: 'mixed', label: 'Mixed (easy → hard)' },
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];
const MIXES = [
  { value: 'mcq', label: 'MCQ only (single correct)' },
  { value: 'mixed', label: 'MCQ + numerical (JEE Main style)' },
  { value: 'numeric', label: 'Numerical answer only' },
];
const DIFFICULTY_TONE = { easy: 'green', medium: 'amber', hard: 'red' };
// Minutes per question a sitting usually allows, by level.
const MINUTES_PER_QUESTION = { foundation: 1.5, board: 2, jee_main: 2.5, jee_advanced: 4, neet: 1, olympiad: 5 };
const NEGATIVE_BY_LEVEL = { jee_main: 1, jee_advanced: 1, neet: 1 };

const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** "Class 11" from a course or batch name like "Class 11 JEE 2027" / "12th NEET". */
function guessClass(text) {
  const m = String(text || '').match(/\b(6|7|8|9|10|11|12)(?:th)?\b/i);
  if (m) return `Class ${m[1]}`;
  return /dropper|repeater/i.test(text || '') ? 'Dropper' : '';
}

function guessLevel(text) {
  const t = String(text || '');
  if (/jee\s*adv/i.test(t)) return 'jee_advanced';
  if (/jee|iit/i.test(t)) return 'jee_main';
  if (/neet|medical/i.test(t)) return 'neet';
  if (/olymp/i.test(t)) return 'olympiad';
  if (/found/i.test(t)) return 'foundation';
  return 'board';
}

const answerText = (q) => (q.kind === 'mcq' ? `(${LETTERS[q.correct_option]})` : `${fmt(q.answer_value)}${q.answer_tolerance ? ` (± ${fmt(q.answer_tolerance)})` : ''}`);

/* ── A question, typeset ─────────────────────────────────────────────── */

/** One question as the teacher sees it: the answer marked, the hint and the
 * worked solution underneath. `actions` sit on its head row. */
function questionCard(q, number, { actions = null } = {}) {
  return h(
    'div',
    { class: 'dpp-q' },
    h(
      'div',
      { class: 'dpp-q-head' },
      h('span', { class: 'dpp-q-no' }, `Q${number}`),
      h('span', { class: 'badge' }, q.kind === 'mcq' ? 'MCQ' : 'Numerical'),
      q.difficulty ? h('span', { class: `badge dot ${DIFFICULTY_TONE[q.difficulty] || 'grey'}` }, q.difficulty) : null,
      h('span', { class: 'muted cb-small' }, `${fmt(q.marks)} marks`),
      h('div', { class: 'spacer' }),
      actions,
    ),
    mathNode(q.question, { className: 'dpp-q-text math-text' }),
    q.kind === 'mcq'
      ? h(
          'ol',
          { class: 'dpp-options' },
          ...q.options.map((o, i) =>
            h(
              'li',
              { class: i === q.correct_option ? 'is-correct' : '' },
              h('span', { class: 'dpp-opt-letter' }, LETTERS[i]),
              mathNode(o, { tag: 'span', className: 'math-text' }),
              i === q.correct_option ? renderIcon('check', { size: 15 }) : null,
            ),
          ),
        )
      : h('div', { class: 'dpp-numeric' }, renderIcon('check', { size: 15 }), 'Answer: ', h('strong', {}, answerText(q))),
    q.hint ? h('div', { class: 'dpp-hint' }, h('strong', {}, 'Hint: '), mathNode(q.hint, { tag: 'span', className: 'math-text' })) : null,
    q.solution
      ? h('details', { class: 'dpp-solution' }, h('summary', {}, 'Solution'), mathNode(q.solution, { className: 'math-text' }))
      : null,
  );
}

/* ── The generator ───────────────────────────────────────────────────── */

export async function openGenerator({ batches, courses, navigate, presetBatchId = null }) {
  const [info] = await Promise.all([coaching.generator(), loadMath().catch(() => null)]);
  const host = h('div', { class: 'dpp-gen' });
  openModal({
    title: 'Generate a DPP or test',
    subtitle: 'AI writes the questions, answer key and hints — you check them before students see them',
    icon: 'sparkle',
    wide: true,
    body: host,
  });

  if (!info.configured) {
    fill(
      host,
      emptyState('The generator needs Google Vertex AI. Set GOOGLE_CLOUD_PROJECT on the server (the same project as the member app’s AI coach) and restart it.', {
        icon: 'sparkle',
        title: 'The DPP generator is not set up',
      }),
    );
    return;
  }

  const subjectsFor = (batchId) => courses.find((c) => c.id === batches.find((b) => b.id === Number(batchId))?.course_id)?.subjects || [];
  const courseText = (batchId) => {
    const b = batches.find((x) => x.id === Number(batchId));
    return `${b?.course_name || ''} ${b?.name || ''}`;
  };
  const firstBatch = presetBatchId ?? batches[0]?.id;
  const spec = {
    batch_id: firstBatch,
    subject_id: subjectsFor(firstBatch)[0]?.id ?? '',
    subject: '',
    class_level: guessClass(courseText(firstBatch)),
    topic: '',
    level: guessLevel(courseText(firstBatch)),
    toughness: 'mixed',
    mix: 'mcq',
    count: 15,
    marks: 4,
    instructions: '',
  };

  function showForm(error = null) {
    const control = (name, label, input, { full = false, hint = null } = {}) =>
      h('label', { class: `field ${full ? 'full' : ''}` }, h('span', {}, label), input, hint ? h('div', { class: 'muted cb-small', style: 'margin-top:4px' }, hint) : null);
    const select = (name, options, value, onchange) =>
      h(
        'select',
        { name, onchange: (e) => onchange?.(e.target.value) },
        ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)),
      );

    const subjectSelect = select('subject_id', [...subjectsFor(spec.batch_id).map((s) => ({ value: s.id, label: s.name })), { value: '', label: 'Other subject…' }], spec.subject_id);
    const subjectOther = h('input', { name: 'subject', value: spec.subject, placeholder: 'e.g. Physics', style: spec.subject_id ? 'display:none;margin-top:6px' : 'margin-top:6px' });
    subjectSelect.addEventListener('change', () => {
      subjectOther.style.display = subjectSelect.value ? 'none' : '';
    });
    const batchSelect = select('batch_id', batchOptions(batches), spec.batch_id, (v) => {
      spec.batch_id = Number(v);
      spec.subject_id = subjectsFor(v)[0]?.id ?? '';
      spec.class_level = guessClass(courseText(v)) || spec.class_level;
      spec.level = guessLevel(courseText(v));
      read();
      showForm();
    });
    const topic = h('input', { name: 'topic', value: spec.topic, required: true, placeholder: 'e.g. Vectors — dot and cross product', maxlength: 200 });
    const classSelect = select('class_level', [{ value: '', label: '—' }, ...CLASS_LEVELS.map((c) => ({ value: c, label: c }))], spec.class_level);
    const levelSelect = select('level', info.levels.map((l) => ({ value: l.key, label: l.label })), spec.level);
    const toughSelect = select('toughness', TOUGHNESS, spec.toughness);
    const mixSelect = select('mix', MIXES, spec.mix);
    const count = h('input', { name: 'count', type: 'number', min: 1, max: info.max_questions, value: spec.count });
    const marks = h('input', { name: 'marks', type: 'number', min: 0.25, step: '0.25', value: spec.marks });
    const notes = h('textarea', { name: 'instructions', placeholder: 'Optional: “include 3 questions on projectile motion in vector form”, “Hinglish hints”' }, spec.instructions);

    function read() {
      spec.subject_id = subjectSelect.value ? Number(subjectSelect.value) : '';
      spec.subject = subjectOther.value.trim();
      spec.topic = topic.value.trim();
      spec.class_level = classSelect.value;
      spec.level = levelSelect.value;
      spec.toughness = toughSelect.value;
      spec.mix = mixSelect.value;
      spec.count = Math.max(1, Math.min(info.max_questions, Number(count.value) || 15));
      spec.marks = Number(marks.value) || 4;
      spec.instructions = notes.value.trim();
    }

    const left = info.daily_limit - info.used_today;
    const go = h('button', { class: 'btn primary', type: 'submit', disabled: left <= 0 }, renderIcon('sparkle', { size: 16 }), 'Generate paper');
    fill(
      host,
      h(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            read();
            if (!spec.topic) return toast('Type the topic', 'info');
            if (!spec.subject_id && !spec.subject) return toast('Pick or type the subject', 'info');
            generate();
          },
        },
        error ? h('div', { class: 'dpp-error' }, renderIcon('alert', { size: 16 }), error) : null,
        h(
          'div',
          { class: 'form-grid' },
          control('batch_id', 'Batch', batchSelect, { hint: 'The test is set for this batch' }),
          control('subject_id', 'Subject', h('div', {}, subjectSelect, subjectOther)),
          control('class_level', 'Class', classSelect),
          control('level', 'Level', levelSelect),
          control('topic', 'Topic / chapter', topic, { full: true }),
          control('toughness', 'Difficulty', toughSelect),
          control('mix', 'Question types', mixSelect),
          control('count', 'Questions', count, { hint: `Up to ${info.max_questions}` }),
          control('marks', 'Marks per question', marks),
          control('instructions', 'Notes for the generator', notes, { full: true }),
        ),
        h(
          'div',
          { class: 'modal-foot', style: 'padding:8px 0 0;border:none' },
          h('span', { class: 'muted cb-small', style: 'margin-right:auto' }, left > 0 ? `${left} of ${info.daily_limit} papers left today` : 'Today’s papers are used up — try tomorrow'),
          h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
          go,
        ),
      ),
    );
    topic.focus();
  }

  async function generate() {
    const started = Date.now();
    const elapsed = h('span', {}, '0s');
    const tick = setInterval(() => {
      if (!host.isConnected) return clearInterval(tick);
      elapsed.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);
    fill(
      host,
      h(
        'div',
        { class: 'dpp-working' },
        h('div', { class: 'dpp-spinner', 'aria-hidden': 'true' }),
        h('div', { class: 'cb-strong' }, `Writing ${spec.count} questions on ${spec.topic}…`),
        h('div', { class: 'muted cb-small' }, 'Each question is solved as it is written, so this takes a minute or so. ', elapsed),
      ),
    );
    try {
      const payload = { ...spec, subject_id: spec.subject_id || undefined, subject: spec.subject_id ? undefined : spec.subject };
      const result = await coaching.generatePaper(payload);
      clearInterval(tick);
      info.used_today = result.used_today;
      if (host.isConnected) showPreview(result);
    } catch (err) {
      clearInterval(tick);
      if (host.isConnected) showForm(err.message || 'The paper could not be generated');
    }
  }

  function showPreview(result) {
    const questions = result.questions.map((q) => ({ ...q }));
    const subjectName = result.spec.subject;
    const levelLabel = info.levels.find((l) => l.key === spec.level)?.label || '';
    const listHost = h('div', { class: 'dpp-list' });
    const summary = h('div', { class: 'muted cb-small' });

    const paint = () => {
      const total = questions.reduce((acc, q) => acc + Number(q.marks || 0), 0);
      summary.textContent = `${questions.length} questions · ${fmt(total)} marks${result.dropped ? ` · ${result.dropped} faulty question${result.dropped === 1 ? '' : 's'} left out` : ''}`;
      fill(
        listHost,
        ...questions.map((q, i) =>
          questionCard(q, i + 1, {
            actions: h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                title: 'Leave this question out',
                onclick: () => {
                  questions.splice(i, 1);
                  paint();
                },
              },
              renderIcon('trash', { size: 14 }),
            ),
          }),
        ),
      );
    };

    const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('div', { class: 'muted cb-small', style: 'margin-top:4px' }, hint) : null);
    const title = h('input', { value: `DPP: ${spec.topic}${levelLabel ? ` — ${levelLabel}` : ''}`.slice(0, 120), maxlength: 120 });
    const type = h('select', {}, ...Object.entries(TEST_TYPE_LABEL).map(([value, label]) => h('option', { value, selected: value === 'dpp' }, label)));
    const when = h('input', { type: 'date', value: today() });
    const duration = h('input', { type: 'number', min: 1, max: 600, value: Math.max(5, Math.round((questions.length * (MINUTES_PER_QUESTION[spec.level] || 2)) / 5) * 5), placeholder: 'No limit' });
    const negative = h('input', { type: 'number', min: 0, step: '0.25', value: NEGATIVE_BY_LEVEL[spec.level] ?? 0 });
    const reveal = h(
      'select',
      {},
      h('option', { value: 'submit', selected: true }, 'As soon as they submit (practice)'),
      h('option', { value: 'publish' }, 'Only when I publish the result'),
    );
    type.addEventListener('change', () => {
      reveal.value = type.value === 'dpp' ? 'submit' : 'publish';
    });
    const openNow = h('input', { type: 'checkbox', checked: true });

    const save = async (button) => {
      if (!questions.length) return toast('Every question was left out', 'info');
      if (!title.value.trim()) return toast('Give the test a title', 'info');
      button.disabled = true;
      try {
        const test = await coaching.createTest({
          batch_id: spec.batch_id,
          subject_id: spec.subject_id || undefined,
          title: title.value.trim(),
          test_type: type.value,
          test_date: when.value || today(),
          max_marks: questions.reduce((acc, q) => acc + Number(q.marks || 0), 0),
          negative_marking: Number(negative.value) || 0,
          duration_min: duration.value ? Number(duration.value) : undefined,
          answers_after: reveal.value,
          online: openNow.checked,
          class_level: spec.class_level || undefined,
          topic: spec.topic,
          level: spec.level,
          generated: true,
          syllabus: `${subjectName}: ${spec.topic}`.slice(0, 1000),
          questions,
        });
        closeModal();
        toast(openNow.checked ? 'Saved — it is in the student app now' : 'Saved — open it in the student app when you are ready');
        navigate(`/tests/${test.id}`);
      } catch (err) {
        toast(err.message || 'Could not save the test', 'error');
        button.disabled = false;
      }
    };
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, renderIcon('save', { size: 16 }), 'Save test');
    saveBtn.addEventListener('click', () => save(saveBtn));

    fill(
      host,
      h(
        'div',
        { class: 'dpp-preview-head' },
        h('div', {}, h('div', { class: 'cb-strong' }, `${subjectName} · ${spec.topic}`), summary),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => showForm() }, renderIcon('refresh', { size: 14 }), 'Change & regenerate'),
      ),
      h('div', { class: 'dpp-warn' }, renderIcon('info', { size: 15 }), 'AI can get an answer wrong. Read each answer and solution before students see the paper — you can edit any question after saving.'),
      listHost,
      h(
        'div',
        { class: 'dpp-save card' },
        h('h4', {}, 'Save as a test'),
        h(
          'div',
          { class: 'form-grid' },
          h('label', { class: 'field full' }, h('span', {}, 'Title'), title),
          field('Type', type),
          field('Date', when, 'Students can start it from this day'),
          field('Time limit (minutes)', duration, 'Empty for no limit'),
          field('Negative marks per wrong answer', negative),
          field('Show answers & solutions', reveal),
          h('label', { class: 'cb-check field full' }, openNow, 'Open it in the student app now — students in the batch can take it on their phones'),
        ),
        h('div', { class: 'modal-foot', style: 'padding:8px 0 0;border:none' }, h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Discard'), saveBtn),
      ),
    );
    paint();
  }

  showForm();
}

/* ── Editing one question ────────────────────────────────────────────── */

function openQuestionEditor({ question, number, onSave }) {
  const q = question
    ? { ...question, options: question.options ? [...question.options] : ['', '', '', ''] }
    : { kind: 'mcq', question: '', options: ['', '', '', ''], correct_option: 0, answer_value: '', answer_tolerance: '', hint: '', solution: '', marks: 4, difficulty: 'medium' };
  const preview = h('div', { class: 'dpp-edit-preview math-text' });
  const paintPreview = () => {
    preview.innerHTML = mathHtml(q.question || '');
  };

  const kind = h('select', {}, h('option', { value: 'mcq', selected: q.kind === 'mcq' }, 'MCQ (single correct)'), h('option', { value: 'numeric', selected: q.kind === 'numeric' }, 'Numerical answer'));
  const text = h('textarea', { rows: 4, placeholder: 'Use $…$ for maths, e.g. $\\vec{A}\\cdot\\vec{B} = AB\\cos\\theta$', oninput: (e) => { q.question = e.target.value; paintPreview(); } }, q.question);
  const optionInputs = LETTERS.map((letter, i) =>
    h(
      'label',
      { class: 'dpp-edit-option' },
      h('input', { type: 'radio', name: 'dpp-correct', checked: q.correct_option === i, onchange: () => { q.correct_option = i; }, 'aria-label': `Option ${letter} is correct` }),
      h('span', { class: 'dpp-opt-letter' }, letter),
      h('input', { value: q.options[i] || '', placeholder: `Option ${letter}`, oninput: (e) => { q.options[i] = e.target.value; } }),
    ),
  );
  const optionsBlock = h('div', { class: 'field full' }, h('span', {}, 'Options — tick the correct one'), ...optionInputs);
  const value = h('input', { type: 'number', step: 'any', value: q.answer_value ?? '', oninput: (e) => { q.answer_value = e.target.value; } });
  const tolerance = h('input', { type: 'number', step: 'any', min: 0, value: q.answer_tolerance || '', placeholder: 'Exact', oninput: (e) => { q.answer_tolerance = e.target.value; } });
  const numericBlock = h('div', { class: 'form-grid full', style: 'grid-column:1/-1' },
    h('label', { class: 'field' }, h('span', {}, 'Answer'), value),
    h('label', { class: 'field' }, h('span', {}, 'Accept ±'), tolerance));
  const showKind = () => {
    optionsBlock.style.display = kind.value === 'mcq' ? '' : 'none';
    numericBlock.style.display = kind.value === 'numeric' ? '' : 'none';
  };
  kind.addEventListener('change', () => {
    q.kind = kind.value;
    showKind();
  });
  const marks = h('input', { type: 'number', min: 0.25, step: '0.25', value: q.marks ?? 4, oninput: (e) => { q.marks = e.target.value; } });
  const hint = h('input', { value: q.hint || '', placeholder: 'One nudge towards the method', oninput: (e) => { q.hint = e.target.value; } });
  const solution = h('textarea', { rows: 4, oninput: (e) => { q.solution = e.target.value; } }, q.solution || '');

  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save question');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await onSave({ ...q, options: q.kind === 'mcq' ? q.options : null });
      closeModal();
    } catch (err) {
      toast(err.message || 'Could not save the question', 'error');
      saveBtn.disabled = false;
    }
  });

  openModal({
    title: question ? `Edit question ${number}` : 'Add a question',
    icon: 'edit',
    wide: true,
    body: h(
      'div',
      { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', {}, 'Type'), kind),
      h('label', { class: 'field' }, h('span', {}, 'Marks'), marks),
      h('label', { class: 'field full' }, h('span', {}, 'Question'), text, h('div', { class: 'muted cb-small', style: 'margin-top:6px' }, 'Preview'), preview),
      optionsBlock,
      numericBlock,
      h('label', { class: 'field full' }, h('span', {}, 'Hint'), hint),
      h('label', { class: 'field full' }, h('span', {}, 'Solution'), solution),
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), saveBtn],
  });
  showKind();
  loadMath().then(paintPreview).catch(paintPreview);
}

/* ── The paper on a test's page ──────────────────────────────────────── */

/** The question paper section of a test's page. `onChanged` reloads the page
 * when the paper changes something the page shows (the maximum, the marks). */
export function paperSection({ test, instituteName, onChanged }) {
  const host = h('div', {}, h('div', { class: 'muted cb-small', style: 'padding:12px' }, 'Loading the paper…'));
  const actions = h('div', { class: 'row' });
  let paper = null;

  // Questions go back with their ids, so answers already given still count.
  const saveAll = async (questions) => {
    paper = await coaching.savePaper(test.id, questions);
    toast(paper.attempts.submitted ? 'Paper saved — submitted attempts were regraded' : 'Paper saved');
    await onChanged?.();
  };

  const setOnline = async (online) => {
    try {
      await coaching.updateTest(test.id, { online });
      toast(online ? 'Open in the student app' : 'Closed — students can no longer start it');
      await onChanged?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  function paint() {
    const { questions, attempts } = paper;
    fill(
      actions,
      questions.length
        ? [
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => printPaper({ test, questions, instituteName, mode: 'paper' }) }, renderIcon('print', { size: 14 }), 'Print paper'),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => printPaper({ test, questions, instituteName, mode: 'key' }) }, renderIcon('fileText', { size: 14 }), 'Answer key'),
            test.online
              ? h('button', { class: 'btn sm', type: 'button', onclick: () => setOnline(false) }, renderIcon('lock', { size: 14 }), 'Close in app')
              : h('button', { class: 'btn sm primary', type: 'button', onclick: () => setOnline(true) }, renderIcon('smartphone', { size: 14 }), 'Open in student app'),
          ]
        : null,
      h(
        'button',
        {
          class: 'btn sm ghost',
          type: 'button',
          onclick: () => openQuestionEditor({ number: questions.length + 1, onSave: (q) => saveAll([...questions, q]) }),
        },
        renderIcon('plus', { size: 14 }),
        'Add question',
      ),
    );
    if (!questions.length) {
      fill(host, emptyState('No question paper. Add questions by hand, or use Generate DPP on the Tests page.', { icon: 'fileText' }));
      return;
    }
    const status = test.online
      ? test.test_date > today()
        ? `In the student app from ${date(test.test_date)}`
        : 'Open in the student app'
      : 'Not in the student app';
    fill(
      host,
      h(
        'div',
        { class: 'dpp-paper-status' },
        h('span', { class: `badge dot ${test.online ? 'green' : 'grey'}` }, status),
        h('span', { class: 'muted cb-small' }, [
          `${questions.length} questions · ${fmt(test.max_marks)} marks`,
          test.duration_min ? `${test.duration_min} min` : 'no time limit',
          test.answers_after === 'submit' ? 'answers shown on submit' : 'answers shown when published',
          attempts.started ? `${attempts.submitted} submitted${attempts.started > attempts.submitted ? `, ${attempts.started - attempts.submitted} in progress` : ''}` : null,
        ].filter(Boolean).join(' · ')),
      ),
      h(
        'div',
        { class: 'dpp-list' },
        ...questions.map((q, i) =>
          questionCard(q, i + 1, {
            actions: h(
              'div',
              { class: 'row', style: 'gap:2px' },
              i > 0
                ? h('button', {
                    class: 'btn sm ghost', type: 'button', title: 'Move up', 'aria-label': `Move question ${i + 1} up`,
                    onclick: () => {
                      const next = [...questions];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      saveAll(next).catch((err) => toast(err.message, 'error'));
                    },
                  }, renderIcon('arrowUp', { size: 14 }))
                : null,
              h('button', {
                class: 'btn sm ghost', type: 'button', title: 'Edit', 'aria-label': `Edit question ${i + 1}`,
                onclick: () => openQuestionEditor({ question: q, number: i + 1, onSave: (edited) => saveAll(questions.map((x) => (x.id === q.id ? { ...edited, id: q.id } : x))) }),
              }, renderIcon('edit', { size: 14 })),
              h('button', {
                class: 'btn sm ghost danger-text', type: 'button', title: 'Delete', 'aria-label': `Delete question ${i + 1}`,
                onclick: () =>
                  confirmDialog({
                    title: `Delete question ${i + 1}?`,
                    message: attempts.submitted ? 'Students who answered it lose those marks, and the paper is regraded.' : 'It is removed from the paper.',
                    confirmLabel: 'Delete question',
                    danger: true,
                    onConfirm: () => saveAll(questions.filter((x) => x.id !== q.id)),
                  }),
              }, renderIcon('trash', { size: 14 })),
            ),
          }),
        ),
      ),
    );
  }

  Promise.all([coaching.paper(test.id), loadMath().catch(() => null)])
    .then(([p]) => {
      paper = p;
      paint();
    })
    .catch((err) => fill(host, h('div', { class: 'dpp-error' }, err.message || 'Could not load the paper')));

  return section('Question paper', host, {
    icon: 'fileText',
    subtitle: test.generated ? 'Generated by AI — check each answer before students sit it' : 'Students can sit it in the app and are marked automatically',
    actions,
  });
}

/* ── Printing ────────────────────────────────────────────────────────── */

const PRINT_CSS = `
@page { size: A4; margin: 14mm 13mm 16mm; }
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #111; font-size: 12.5px; line-height: 1.5; margin: 0; }
.head { border: 1.5px solid #111; padding: 10px 14px; margin-bottom: 10px; }
.head h1 { font-size: 18px; margin: 0; text-align: center; letter-spacing: .02em; }
.head h2 { font-size: 14.5px; margin: 2px 0 6px; text-align: center; font-weight: 600; }
.meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; }
.fill { display: flex; gap: 24px; margin-top: 8px; font-size: 12px; }
.fill span { flex: 1; border-bottom: 1px solid #555; padding-bottom: 2px; }
.rules { font-size: 11.5px; margin: 0 0 12px; padding-left: 18px; color: #333; }
.section { font-size: 13px; font-weight: 700; background: #eee; padding: 4px 8px; margin: 14px 0 8px; border-left: 3px solid #111; }
.q { display: flex; gap: 8px; margin: 0 0 12px; break-inside: avoid; }
.no { font-weight: 700; min-width: 26px; }
.body { flex: 1; min-width: 0; }
.marks { font-size: 10.5px; color: #555; white-space: nowrap; }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 18px; margin-top: 5px; }
.opts.long { grid-template-columns: 1fr; }
.opt { display: flex; gap: 6px; }
.ansline { margin-top: 6px; font-size: 12px; }
.ansline span { display: inline-block; width: 140px; border-bottom: 1px solid #555; }
.keygrid { display: grid; grid-template-columns: repeat(5, 1fr); border: 1px solid #999; margin-bottom: 14px; }
.keygrid div { padding: 4px 8px; border: .5px solid #ccc; font-size: 12px; }
.sol { margin: 0 0 10px; break-inside: avoid; }
.sol .hint { color: #444; font-style: italic; }
.break { break-before: page; }
.foot { margin-top: 16px; text-align: center; font-size: 10.5px; color: #777; }
.katex { font-size: 1.05em; }
.math-error { color: #b91c1c; }
`;

/**
 * The paper in a print window: 'paper' (for students), 'key' (answer key,
 * hints and solutions, for the teacher) or 'both'. The browser's print
 * dialog saves it as a PDF.
 */
export async function printPaper({ test, questions, instituteName, mode = 'paper' }) {
  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) return toast('Allow pop-ups to print the paper', 'info');
  try {
    await loadMath();
  } catch {
    // The maths prints as its source; still a usable paper.
  }
  const math = (text) => mathHtml(text);
  const mcq = questions.filter((q) => q.kind === 'mcq');
  const numeric = questions.filter((q) => q.kind === 'numeric');
  const number = new Map(questions.map((q, i) => [q, i + 1]));
  const negative = Number(test.negative_marking) || 0;
  const subtitle = [test.batch_name, test.subject_name, test.class_level, test.topic].filter(Boolean).map(esc).join(' · ');

  const header = (label) => `
    <div class="head">
      <h1>${esc(instituteName || '')}</h1>
      <h2>${esc(test.title)}${label ? ` — ${esc(label)}` : ''}</h2>
      <div class="meta"><span>${subtitle}</span><span>Date: ${esc(date(test.test_date))}</span></div>
      <div class="meta"><span>Time: ${test.duration_min ? `${test.duration_min} minutes` : '—'}</span><span>Questions: ${questions.length}</span><span>Maximum marks: ${esc(fmt(test.max_marks))}</span></div>
      ${label ? '' : '<div class="fill"><span>Name:</span><span>Roll no.:</span><span>Batch:</span></div>'}
    </div>`;

  const questionHtml = (q) => {
    const long = q.kind === 'mcq' && q.options.some((o) => o.length > 38);
    return `<div class="q"><div class="no">${number.get(q)}.</div><div class="body">${math(q.question)}
      ${q.kind === 'mcq'
        ? `<div class="opts${long ? ' long' : ''}">${q.options.map((o, i) => `<div class="opt"><b>(${LETTERS[i]})</b><span>${math(o)}</span></div>`).join('')}</div>`
        : '<div class="ansline">Answer: <span></span></div>'}
      </div><div class="marks">[${esc(fmt(q.marks))}]</div></div>`;
  };

  const rules = [
    mcq.length ? `Section A has ${mcq.length} multiple-choice question${mcq.length === 1 ? '' : 's'}; each has exactly one correct option.` : null,
    numeric.length ? `Section B has ${numeric.length} numerical-answer question${numeric.length === 1 ? '' : 's'}; write the answer as a number.` : null,
    `Marks for each question are shown in brackets.${negative ? ` ${fmt(negative)} mark${negative === 1 ? ' is' : 's are'} deducted for each wrong answer.` : ' There is no negative marking.'}`,
  ].filter(Boolean);

  const paperHtml = `${header('')}
    <ol class="rules">${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
    ${mcq.length && numeric.length ? '<div class="section">Section A — Single correct option</div>' : ''}
    ${mcq.map(questionHtml).join('')}
    ${numeric.length && mcq.length ? '<div class="section">Section B — Numerical answer</div>' : ''}
    ${numeric.map(questionHtml).join('')}
    <div class="foot">— End of paper —</div>`;

  const keyHtml = `${header('Answer key & solutions')}
    <div class="keygrid">${questions.map((q, i) => `<div><b>${i + 1}.</b> ${esc(answerText(q))}</div>`).join('')}</div>
    ${questions
      .map(
        (q, i) => `<div class="sol"><b>${i + 1}. Answer ${esc(answerText(q))}</b>
          ${q.hint ? `<div class="hint">Hint: ${math(q.hint)}</div>` : ''}
          ${q.solution ? `<div>${math(q.solution)}</div>` : ''}</div>`,
      )
      .join('')}`;

  const content = mode === 'key' ? keyHtml : mode === 'both' ? `${paperHtml}<div class="break"></div>${keyHtml}` : paperHtml;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(test.title)}${mode === 'key' ? ' — Answer key' : ''}</title>
<link rel="stylesheet" href="${esc(mathStylesheet())}"><style>${PRINT_CSS}</style></head><body>${content}
<script>window.addEventListener('load', () => { (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(() => window.print(), 150)); });</script>
</body></html>`);
  win.document.close();
}
