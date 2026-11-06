import { coaching } from '../../coachingApi.js';
import { loadMath, mathNode } from '../../math.js';
import { confirmDialog, date, h, renderIcon, toast } from '../../ui.js';
import { fill, TEST_TYPE_LABEL } from './common.js';

/**
 * Sitting a DPP or test in the student app (src/coaching/papers.js).
 *
 *   onlineTestsCard()  the Tests tab's list of papers to sit, with where the
 *                      student is on each
 *   openTest()         a pushed screen: the paper's details and Start; then
 *                      one question at a time with a navigator, the clock,
 *                      hints and autosave; then the score, and — once the
 *                      teacher allows it — the answer key and solutions
 *
 * The server keeps the clock: it says how many seconds are left and refuses
 * answers after the deadline (plus a short grace), so a phone's clock or a
 * reload cannot buy time. Answers save as they are tapped, so a dropped
 * connection or a closed app loses nothing; when time runs out with the app
 * closed, the server submits what was saved.
 */

const LETTERS = ['A', 'B', 'C', 'D'];
const SAVE_DELAY_MS = 800;
const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STATUS = {
  not_started: { label: 'New', tone: 'blue' },
  in_progress: { label: 'In progress', tone: 'amber' },
  submitted: { label: 'Done', tone: 'green' },
};

export function testPlayerScreens({ openScreen, registerCleanup }) {
  /** The Tests tab's card: papers to sit in the app. */
  function onlineTestsCard(items) {
    if (!items?.length) return null;
    return h(
      'div',
      { class: 'cbp-card' },
      h('h3', { class: 'cbp-title' }, 'DPPs & tests to take'),
      h('p', { class: 'cbp-sub' }, 'Answer on your phone — marked as soon as you submit'),
      ...items.map((t) =>
        h(
          'button',
          { class: 'dpp-row', type: 'button', onclick: () => openTest(t) },
          h(
            'div',
            { class: 'cb-grow' },
            h('div', { class: 'cb-strong' }, t.title),
            h(
              'div',
              { class: 'muted cb-small' },
              [t.subject_name, plural(t.questions, 'question'), t.duration_min ? `${t.duration_min} min` : null, date(t.test_date)].filter(Boolean).join(' · '),
            ),
          ),
          t.status === 'submitted'
            ? h('span', { class: 'dpp-row-score' }, fmt(t.score), h('small', {}, `/${fmt(t.max_marks)}`))
            : h('span', { class: `badge dot ${STATUS[t.status].tone}` }, STATUS[t.status].label),
          renderIcon('chevronRight', { size: 16 }),
        ),
      ),
    );
  }

  function openTest(t) {
    return openScreen({
      title: t.title,
      subtitle: [TEST_TYPE_LABEL[t.test_type], t.subject_name].filter(Boolean).join(' · '),
      render: async () => {
        const [paper] = await Promise.all([coaching.portal.testPaper(t.id), loadMath().catch(() => null)]);
        const root = h('div', { class: 'cbp-stack dpp-player' });
        show(root, paper);
        return root;
      },
    });
  }

  function show(root, paper) {
    if (paper.attempt.status === 'in_progress') return sit(root, paper);
    if (paper.attempt.status === 'submitted') return result(root, paper);
    return intro(root, paper);
  }

  /* — before starting — */

  function intro(root, paper) {
    const { test } = paper;
    const mcq = paper.questions.filter((q) => q.kind === 'mcq').length;
    const numeric = paper.questions.length - mcq;
    const start = h('button', { class: 'btn primary dpp-start', type: 'button', disabled: !paper.can_start }, renderIcon('play', { size: 16 }), 'Start now');
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        show(root, await coaching.portal.startTest(test.id));
      } catch (err) {
        toast(err.message, 'error');
        start.disabled = false;
      }
    });
    fill(
      root,
      h(
        'div',
        { class: 'cbp-card dpp-intro' },
        h('div', { class: 'dpp-intro-grid' },
          h('div', {}, h('strong', {}, paper.questions.length), h('span', {}, 'questions')),
          h('div', {}, h('strong', {}, fmt(test.max_marks)), h('span', {}, 'marks')),
          h('div', {}, h('strong', {}, test.duration_min ? `${test.duration_min}` : '∞'), h('span', {}, test.duration_min ? 'minutes' : 'no time limit'))),
        test.topic ? h('div', { class: 'cb-small' }, h('strong', {}, 'Topic: '), test.topic, test.level_label ? ` · ${test.level_label}` : '') : null,
        h(
          'ul',
          { class: 'dpp-rules' },
          mcq ? h('li', {}, `${plural(mcq, 'multiple-choice question')} — tap the one correct option.`) : null,
          numeric ? h('li', {}, `${plural(numeric, 'numerical question')} — type the answer as a number.`) : null,
          h('li', {}, test.negative_marking ? `${fmt(test.negative_marking)} mark${test.negative_marking === 1 ? '' : 's'} cut for each wrong answer. Leave a question blank if unsure.` : 'No marks are cut for wrong answers.'),
          test.duration_min ? h('li', {}, 'The clock starts when you tap Start and keeps running if you leave. When time is up, your saved answers are submitted.') : null,
          h('li', {}, 'Hints are free — use them when stuck.'),
          h('li', {}, test.answers_after === 'submit' ? 'You see the answers and solutions as soon as you submit.' : 'Answers and solutions appear when your teacher publishes the result.'),
        ),
        paper.can_start ? start : h('div', { class: 'dpp-blocked' }, renderIcon('lock', { size: 15 }), paper.blocked_reason || 'This test is not open'),
      ),
      // Published without an attempt: the paper with its solutions, to learn from.
      paper.revealed ? review(paper) : null,
    );
  }

  /* — sitting the test — */

  function sit(root, paper) {
    const { test, questions } = paper;
    const answers = { ...paper.attempt.answers };
    const hints = new Set(paper.attempt.hints_used);
    let index = Math.max(0, questions.findIndex((q) => answers[q.id] === undefined));
    if (index === -1) index = 0;
    let secondsLeft = paper.attempt.seconds_left;
    let saveTimer = null;
    let saving = Promise.resolve();
    let finished = false;

    const timer = h('span', { class: 'dpp-timer' });
    const progress = h('span', { class: 'muted cb-small' });
    const nav = h('div', { class: 'dpp-nav', role: 'tablist', 'aria-label': 'Questions' });
    const body = h('div', { class: 'cbp-card dpp-question' });
    const submitBtn = h('button', { class: 'btn sm primary', type: 'button' }, 'Submit');

    const answeredCount = () => questions.filter((q) => answers[q.id] !== undefined && answers[q.id] !== '').length;

    function save() {
      clearTimeout(saveTimer);
      saveTimer = null;
      saving = coaching.portal
        .saveTestAnswers(test.id, { answers, hints_used: [...hints] })
        .then((res) => {
          if (res?.seconds_left !== null && res?.seconds_left !== undefined) secondsLeft = Math.max(0, res.seconds_left);
        })
        .catch((err) => {
          if (err.status === 409) finish({ auto: true });
        });
      return saving;
    }
    const queueSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DELAY_MS);
    };

    async function finish({ auto = false } = {}) {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      clearTimeout(saveTimer);
      submitBtn.disabled = true;
      try {
        await saving;
        const done = await coaching.portal.submitTest(test.id, { answers, hints_used: [...hints] });
        if (auto) toast('Time is up — your answers were submitted', 'info');
        if (root.isConnected) show(root, done);
      } catch (err) {
        // Already submitted (time ran out on the server): show where it stands.
        try {
          const now = await coaching.portal.testPaper(test.id);
          if (root.isConnected) show(root, now);
        } catch {
          finished = false;
          submitBtn.disabled = false;
          toast(err.message || 'Could not submit — check the connection and try again', 'error');
        }
      }
    }

    const confirmSubmit = () => {
      const left = questions.length - answeredCount();
      confirmDialog({
        title: 'Submit the test?',
        message: left ? `${plural(left, 'question')} not answered yet. You cannot change answers after submitting.` : 'You cannot change answers after submitting.',
        confirmLabel: 'Submit',
        onConfirm: () => finish(),
      });
    };
    submitBtn.addEventListener('click', confirmSubmit);

    function paintTimer() {
      if (secondsLeft === null) {
        timer.textContent = '';
        return;
      }
      timer.textContent = clock(secondsLeft);
      timer.classList.toggle('is-low', secondsLeft <= 60);
    }
    const ticker = setInterval(() => {
      if (!root.isConnected) {
        clearInterval(ticker);
        if (saveTimer) save();
        return;
      }
      if (secondsLeft === null) return;
      secondsLeft = Math.max(0, secondsLeft - 1);
      paintTimer();
      if (secondsLeft === 0) finish({ auto: true });
    }, 1000);
    registerCleanup?.(() => {
      clearInterval(ticker);
      if (saveTimer) save();
    });

    function paintNav() {
      progress.textContent = `${answeredCount()}/${questions.length} answered`;
      fill(
        nav,
        ...questions.map((q, i) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(i === index),
              'aria-label': `Question ${i + 1}${answers[q.id] !== undefined ? ', answered' : ''}`,
              class: `dpp-nav-chip${i === index ? ' is-current' : ''}${answers[q.id] !== undefined ? ' is-answered' : ''}`,
              onclick: () => go(i),
            },
            String(i + 1),
          ),
        ),
      );
      nav.children[index]?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    }

    function setAnswer(q, value) {
      if (value === null || value === '' || value === undefined) delete answers[q.id];
      else answers[q.id] = value;
      paintNav();
      queueSave();
    }

    function paintQuestion() {
      const q = questions[index];
      const hintShown = hints.has(q.id);
      const hintBox = h('div', { class: 'dpp-hint', hidden: !hintShown }, h('strong', {}, 'Hint: '), q.hint ? mathNode(q.hint, { tag: 'span' }) : '');
      const hintBtn = q.hint && !hintShown
        ? h('button', {
            class: 'btn sm ghost', type: 'button',
            onclick: (e) => {
              hints.add(q.id);
              hintBox.hidden = false;
              e.currentTarget.remove();
              queueSave();
            },
          }, renderIcon('sparkle', { size: 14 }), 'Show hint')
        : null;

      let answerArea;
      if (q.kind === 'mcq') {
        answerArea = h(
          'div',
          { class: 'dpp-choices', role: 'radiogroup' },
          ...q.options.map((o, i) =>
            h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String(answers[q.id] === i),
                class: `dpp-choice${answers[q.id] === i ? ' is-picked' : ''}`,
                onclick: () => {
                  setAnswer(q, answers[q.id] === i ? null : i);
                  paintQuestion();
                },
              },
              h('span', { class: 'dpp-opt-letter' }, LETTERS[i]),
              mathNode(o, { tag: 'span', className: 'math-text' }),
            ),
          ),
        );
      } else {
        const input = h('input', {
          type: 'text',
          inputmode: 'decimal',
          class: 'dpp-numeric-input',
          placeholder: 'Your answer',
          value: answers[q.id] ?? '',
          'aria-label': 'Your answer',
          oninput: (e) => {
            const v = e.target.value.trim().replace(/,/g, '.');
            setAnswer(q, v === '' || v === '-' || v === '.' ? null : v);
          },
        });
        answerArea = h('div', { class: 'dpp-numeric-wrap' }, input, h('span', { class: 'muted cb-small' }, 'Type a number — decimals allowed'));
      }

      fill(
        body,
        h('div', { class: 'dpp-q-head' }, h('span', { class: 'dpp-q-no' }, `Q${index + 1}`), h('span', { class: 'muted cb-small' }, `${fmt(q.marks)} marks${q.kind === 'numeric' ? ' · numerical' : ''}`), h('div', { class: 'spacer' }), hintBtn),
        mathNode(q.question, { className: 'dpp-q-text math-text' }),
        answerArea,
        hintBox,
        h(
          'div',
          { class: 'dpp-steps' },
          h('button', { class: 'btn', type: 'button', disabled: index === 0, onclick: () => go(index - 1) }, renderIcon('chevronLeft', { size: 16 }), 'Previous'),
          index < questions.length - 1
            ? h('button', { class: 'btn primary', type: 'button', onclick: () => go(index + 1) }, 'Next', renderIcon('chevronRight', { size: 16 }))
            : h('button', { class: 'btn primary', type: 'button', onclick: confirmSubmit }, 'Finish & submit'),
        ),
      );
    }

    function go(i) {
      index = Math.max(0, Math.min(questions.length - 1, i));
      paintNav();
      paintQuestion();
      root.scrollIntoView?.({ block: 'start' });
    }

    fill(root, h('div', { class: 'dpp-bar' }, timer, progress, h('div', { class: 'spacer' }), submitBtn), nav, body);
    paintTimer();
    paintNav();
    paintQuestion();
    if (secondsLeft === 0) finish({ auto: true });
  }

  /* — after submitting — */

  function result(root, paper) {
    const { test, attempt } = paper;
    const pct = test.max_marks ? Math.max(0, Math.round((attempt.score / test.max_marks) * 100)) : 0;
    fill(
      root,
      h(
        'div',
        { class: 'cbp-card dpp-result' },
        h('div', { class: 'dpp-result-score' }, h('strong', {}, fmt(attempt.score)), h('span', {}, `out of ${fmt(test.max_marks)} · ${pct}%`)),
        h(
          'div',
          { class: 'dpp-intro-grid' },
          h('div', { class: 'is-good' }, h('strong', {}, attempt.correct), h('span', {}, 'correct')),
          h('div', { class: 'is-bad' }, h('strong', {}, attempt.wrong), h('span', {}, 'wrong')),
          h('div', {}, h('strong', {}, attempt.skipped), h('span', {}, 'skipped')),
        ),
        attempt.rank ? h('div', { class: 'cb-small', style: 'text-align:center' }, `Rank ${attempt.rank} of ${paper.appeared} in the batch`) : null,
        paper.revealed ? null : h('div', { class: 'dpp-blocked' }, renderIcon('lock', { size: 15 }), 'Answers and solutions appear when your teacher publishes the result.'),
      ),
      paper.revealed ? review(paper) : null,
    );
  }

  /** Every question with the student's answer, the right one and the working. */
  function review(paper) {
    const mine = paper.attempt.answers || {};
    return h(
      'div',
      { class: 'cbp-stack' },
      h('h3', { class: 'cbb-section' }, 'Answers & solutions'),
      ...paper.questions.map((q, i) => {
        const given = mine[q.id];
        const tone = q.result === 'correct' ? 'green' : q.result === 'wrong' ? 'red' : 'grey';
        return h(
          'div',
          { class: 'cbp-card dpp-question' },
          h(
            'div',
            { class: 'dpp-q-head' },
            h('span', { class: 'dpp-q-no' }, `Q${i + 1}`),
            q.result ? h('span', { class: `badge dot ${tone}` }, q.result === 'correct' ? 'Correct' : q.result === 'wrong' ? 'Wrong' : 'Skipped') : null,
          ),
          mathNode(q.question, { className: 'dpp-q-text math-text' }),
          q.kind === 'mcq'
            ? h(
                'div',
                { class: 'dpp-choices is-review' },
                ...q.options.map((o, j) =>
                  h(
                    'div',
                    { class: `dpp-choice${j === q.correct_option ? ' is-correct' : ''}${Number(given) === j && j !== q.correct_option ? ' is-wrong' : ''}` },
                    h('span', { class: 'dpp-opt-letter' }, LETTERS[j]),
                    mathNode(o, { tag: 'span', className: 'math-text' }),
                    Number(given) === j && given !== undefined ? h('span', { class: 'dpp-yours' }, 'Your answer') : null,
                  ),
                ),
              )
            : h(
                'div',
                { class: 'dpp-numeric' },
                h('div', {}, 'Correct answer: ', h('strong', {}, fmt(q.answer_value))),
                given !== undefined ? h('div', { class: 'muted' }, `Your answer: ${given}`) : null,
              ),
          q.solution ? h('details', { class: 'dpp-solution', open: q.result === 'wrong' }, h('summary', {}, 'Solution'), mathNode(q.solution, { className: 'math-text' })) : null,
        );
      }),
    );
  }

  return { onlineTestsCard, openTest };
}
