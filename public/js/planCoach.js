import { ApiError } from './api.js';
import { answerTokens } from './coachText.js';
import { exerciseMedia, h, openModal, renderIcon, toast } from './ui.js';

/**
 * The AI coach inside a workout plan builder: rate the plan for muscle
 * building, ask what is missing, or ask for the best exercises for a muscle,
 * then put a suggestion into the plan with one tap. Shared by the member
 * app's plan editor (views/portal.js) and the staff template builder
 * (views/fitnessPlans.js); each passes how to read its draft, how to ask its
 * own route, and how to add or swap an exercise in its own state.
 *
 * The sheet opens over the builder and the builder repaints underneath as
 * suggestions go in, so every new question is about the plan as it is now.
 */

/** The muscles "Best exercises for…" offers, with the name used in the question. */
export const MUSCLE_CHOICES = [
  ['Chest', 'chest'],
  ['Back', 'back (lats and upper back)'],
  ['Shoulders', 'shoulders'],
  ['Biceps', 'biceps'],
  ['Triceps', 'triceps'],
  ['Quads', 'quads'],
  ['Hamstrings', 'hamstrings'],
  ['Glutes', 'glutes'],
  ['Calves', 'calves'],
  ['Abs', 'abs and core'],
];

/** The questions behind the quick prompts, shared by both coach sheets. */
export const RATE_PLAN_QUESTION = 'Rate this plan for building muscle. What would make it better?';
export const MISSING_QUESTION = 'Which muscles are under-trained or missing in this plan, and what should I add?';
export const bestExercisesQuestion = (words) =>
  `What are the best exercises for ${words} for building muscle, and which day of my plan should they go on?`;

const MAX_DAYS = 7;
/** The day picker's value for "a new day". */
const NEW_DAY = 'new';

/** Shown on the volume chart even at zero sets, so a missing muscle stands out. */
const MAJOR_MUSCLES = ['chest', 'lats', 'upper_back', 'shoulders', 'quadriceps', 'hamstrings', 'glutes', 'biceps', 'triceps', 'calves', 'abdominals'];

const muscleLabel = (group) =>
  String(group ?? '')
    .split('_')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ''))
    .join(' ');

const restLabel = (seconds) => (seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`);

/** The answer with its **bold** runs, as the Ask Coach sheet shows them. */
const answerNode = (raw) =>
  h(
    'p',
    { class: 'pc-answer' },
    ...answerTokens(raw).map((token) => (token.kind ? h('strong', {}, token.text) : token.text)),
  );

/** Under ~8 direct sets a week is low for growth, 8-20 the productive range,
 * past ~25 more than most people recover from — the same lines the coach is told. */
const volumeZone = (sets) => (sets < 8 ? 'low' : sets <= 20 ? 'good' : sets <= 25 ? 'high' : 'over');

function volumeChart(weeklySets) {
  const byMuscle = new Map(weeklySets.map((row) => [row.muscle_group, row.sets]));
  for (const muscle of MAJOR_MUSCLES) if (!byMuscle.has(muscle)) byMuscle.set(muscle, 0);
  const rows = [...byMuscle].sort((a, b) => b[1] - a[1]);
  return h(
    'div',
    { class: 'pc-volume' },
    h('div', { class: 'pc-section-title' }, 'Direct sets per week', h('span', {}, '10–20 builds muscle')),
    ...rows.map(([muscle, sets]) =>
      h(
        'div',
        { class: `pc-vol-row is-${volumeZone(sets)}` },
        h('span', { class: 'pc-vol-name' }, muscleLabel(muscle)),
        h('span', { class: 'pc-vol-track' }, h('span', { class: 'pc-vol-bar', style: `width: ${Math.min(100, (sets / 25) * 100)}%` })),
        h('span', { class: 'pc-vol-num' }, String(sets)),
      ),
    ),
  );
}

function ratingBlock(rating) {
  const tone = rating.score >= 8 ? 'good' : rating.score >= 5 ? 'ok' : 'poor';
  return h(
    'div',
    { class: `pc-rating is-${tone}` },
    h(
      'div',
      { class: 'pc-score', style: `--pc-score: ${rating.score * 10}%`, role: 'img', 'aria-label': `${rating.score} out of 10` },
      h('strong', {}, String(rating.score)),
      h('span', {}, '/10'),
    ),
    h('div', { class: 'pc-verdict' }, h('small', {}, 'For your goal'), h('strong', {}, rating.verdict || 'Rated')),
  );
}

const pointList = (items, icon, className, title) =>
  items.length
    ? h(
        'div',
        { class: `pc-points ${className}` },
        h('div', { class: 'pc-section-title' }, title),
        ...items.map((item) =>
          h(
            'div',
            { class: 'pc-point' },
            renderIcon(icon, { size: 15, stroke: 2.4 }),
            // The model bolds numbers here too, as in the answer.
            h('span', {}, ...answerTokens(item).map((token) => (token.kind ? h('strong', {}, token.text) : token.text))),
          ),
        ),
      )
    : null;

/** One suggested exercise with the buttons that put it in the plan. */
function suggestionCard(suggestion, { getPlan, onAdd, onReplace }) {
  const plan = getPlan();
  const days = plan.days ?? [];
  const media = exerciseMedia(suggestion, { className: 'pc-sug-thumb', still: true });
  const actions = h('div', { class: 'pc-sug-actions' });

  const done = (message) => {
    actions.replaceChildren(h('span', { class: 'pc-sug-done' }, renderIcon('check', { size: 15, stroke: 2.6 }), message));
  };
  const dayName = (list, index) => list[index]?.day_name?.trim() || `Day ${index + 1}`;
  const canAddDay = days.length < MAX_DAYS;
  // The coach's name for a new day, or the muscle's: either way the picks
  // meant for one new day find each other by it.
  const newDayName = suggestion.new_day || muscleLabel(suggestion.muscle_group) || `Day ${days.length + 1}`;

  /** Adds to the picked day, or to a new one. A new day is made once: the
   * next exercise meant for "Legs" goes on the "Legs" just added, even though its card was drawn before that day existed. */
  function addTo(choice) {
    const current = getPlan().days;
    if (choice !== NEW_DAY) {
      if (Number(choice) >= current.length) {
        toast('That day is no longer in the plan — pick another', 'error');
        return null;
      }
      onAdd(suggestion, Number(choice));
      return dayName(current, Number(choice));
    }
    const named = current.findIndex((day) => day.day_name.trim().toLowerCase() === newDayName.toLowerCase());
    if (named !== -1) {
      onAdd(suggestion, named);
      return dayName(current, named);
    }
    if (current.length >= MAX_DAYS) {
      toast('A plan holds up to seven days — pick one of them', 'error');
      return null;
    }
    onAdd(suggestion, current.length, newDayName);
    return newDayName;
  }

  // No day picked: a new one rather than whichever day happens to be first.
  const preferNew = suggestion.day_index == null && canAddDay;
  const select = h(
    'select',
    { class: 'pc-sug-day', 'aria-label': `Day for ${suggestion.exercise_name}` },
    ...days.map((_, index) =>
      h('option', { value: String(index), selected: !preferNew && index === (suggestion.day_index ?? 0) }, dayName(days, index)),
    ),
    canAddDay ? h('option', { value: NEW_DAY, selected: preferNew }, `New day: ${newDayName}`) : null,
  );
  const add = h(
    'button',
    {
      class: `btn sm ${suggestion.replaces ? '' : 'primary'}`,
      type: 'button',
      onclick: () => {
        const added = addTo(select.value);
        if (added) done(`Added to ${added}`);
      },
    },
    renderIcon('plus', { size: 14 }),
    'Add',
  );
  if (suggestion.replaces) {
    actions.append(
      h(
        'button',
        {
          class: 'btn sm primary',
          type: 'button',
          onclick: () => {
            const index = suggestion.day_index ?? 0;
            if (onReplace(suggestion, index, suggestion.replaces)) done(`Swapped in for ${suggestion.replaces}`);
            else toast(`${suggestion.replaces} is no longer on ${dayName(getPlan().days, index)} — add it instead`, 'error');
          },
        },
        renderIcon('refresh', { size: 14 }),
        `Swap for ${suggestion.replaces}`,
      ),
    );
  }
  actions.append(h('div', { class: 'pc-sug-add' }, select, add));

  return h(
    'div',
    { class: 'pc-sug' },
    h('div', { class: 'pc-sug-media' }, media ?? renderIcon('weight', { size: 22 })),
    h(
      'div',
      { class: 'pc-sug-body' },
      h('strong', { class: 'pc-sug-name' }, suggestion.exercise_name),
      h(
        'div',
        { class: 'pc-sug-meta' },
        `${muscleLabel(suggestion.muscle_group)} · ${suggestion.target_sets} × ${suggestion.target_reps} · ${restLabel(suggestion.rest_seconds)} rest`,
      ),
      suggestion.reason ? h('p', { class: 'pc-sug-reason' }, suggestion.reason) : null,
      actions,
    ),
  );
}

/**
 * What goes under a plan answer, wherever it is shown: the score, the weekly
 * sets per muscle and the strengths and fixes behind it, then the suggested
 * exercises as cards that put themselves in the plan. `handlers` is the
 * builder's { getPlan, onAdd, onReplace } (see openPlanCoach); `rating: false`
 * leaves the score out for a caller that shows it above the answer.
 */
export function planReplyExtras(reply, handlers, { rating = true } = {}) {
  return [
    rating && reply.rating ? ratingBlock(reply.rating) : null,
    reply.rating && reply.weekly_sets ? volumeChart(reply.weekly_sets) : null,
    pointList(reply.strengths ?? [], 'checkCircle', 'is-good', 'Working well'),
    pointList(reply.improvements ?? [], 'zap', 'is-fix', 'Make it better'),
    reply.suggestions?.length
      ? h(
          'div',
          { class: 'pc-sugs' },
          h('div', { class: 'pc-section-title' }, reply.suggestions.length === 1 ? 'Suggested exercise' : 'Suggested exercises'),
          ...reply.suggestions.map((suggestion) => suggestionCard(suggestion, handlers)),
        )
      : null,
  ].filter(Boolean);
}

/**
 * Opens the coach sheet.
 *
 * @param {object} options
 * @param {() => {days: {day_name: string, exercises: object[]}[]}} options.getPlan
 *   the draft as it stands now: name, goal, level, days_per_week, days
 * @param {(payload: object) => Promise<object>} options.ask the builder's own route
 * @param {(suggestion: object, dayIndex: number, newDayName?: string) => void} options.onAdd
 *   puts it on that day; a dayIndex one past the last day means add a day named newDayName first
 * @param {(suggestion: object, dayIndex: number, replaces: string) => boolean} options.onReplace
 *   swaps it in for `replaces`; false when that exercise is no longer there
 * @param {number|null} [options.remaining] questions left today, when known
 * @param {string} [options.subtitle]
 */
export function openPlanCoach({ getPlan, ask, onAdd, onReplace, remaining = null, subtitle }) {
  const history = [];
  let busy = false;

  const thread = h('div', { class: 'pc-thread', 'aria-live': 'polite' });
  const left = h('div', { class: 'coach-remaining' });
  const paintRemaining = () => {
    left.textContent = remaining == null ? '' : remaining > 0 ? `${remaining} question${remaining === 1 ? '' : 's'} left today` : 'No coach questions left today';
  };
  paintRemaining();

  const muscles = h(
    'div',
    { class: 'gen-chips pc-muscles', hidden: true },
    ...MUSCLE_CHOICES.map(([label, words]) =>
      h(
        'button',
        {
          class: 'gen-chip',
          type: 'button',
          onclick: () => send(bestExercisesQuestion(words)),
        },
        label,
      ),
    ),
  );
  const bestFor = h(
    'button',
    {
      class: 'gen-chip pc-chip',
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        muscles.hidden = !muscles.hidden;
        bestFor.classList.toggle('on', !muscles.hidden);
        bestFor.setAttribute('aria-expanded', String(!muscles.hidden));
      },
    },
    renderIcon('target', { size: 14 }),
    'Best exercises for…',
  );
  const quick = h(
    'div',
    { class: 'pc-quick' },
    h(
      'div',
      { class: 'gen-chips' },
      h(
        'button',
        { class: 'gen-chip pc-chip', type: 'button', onclick: () => send(RATE_PLAN_QUESTION, 'rate') },
        renderIcon('trophy', { size: 14 }),
        'Rate for muscle building',
      ),
      h(
        'button',
        {
          class: 'gen-chip pc-chip',
          type: 'button',
          onclick: () => send(MISSING_QUESTION),
        },
        renderIcon('search', { size: 14 }),
        'What’s missing?',
      ),
      bestFor,
    ),
    muscles,
  );

  const input = h('textarea', {
    class: 'coach-input pc-input',
    rows: 1,
    maxlength: 500,
    placeholder: 'Ask about this plan, e.g. “Is 3 days enough for arms?”',
    'aria-label': 'Ask the coach about this plan',
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendTyped();
      }
    },
  });
  const sendBtn = h(
    'button',
    { class: 'pc-send', type: 'button', 'aria-label': 'Send', onclick: () => sendTyped() },
    renderIcon('send', { size: 18 }),
  );
  // Takes Send's place while an answer is coming.
  let stopper = null;
  const stopBtn = h(
    'button',
    { class: 'pc-send pc-stop', type: 'button', 'aria-label': 'Stop answering', title: 'Stop', hidden: true, onclick: () => stopper?.abort() },
    h('span', { class: 'coach-stop-square', 'aria-hidden': 'true' }),
  );
  function sendTyped() {
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    send(question);
  }

  const handlers = { getPlan, onAdd, onReplace };
  const replyNode = (reply) =>
    h('div', { class: 'pc-reply' }, reply.rating ? ratingBlock(reply.rating) : null, answerNode(reply.answer), ...planReplyExtras(reply, handlers, { rating: false }));

  async function send(question, mode = 'ask') {
    if (busy) return;
    if (!navigator.onLine) {
      toast('The coach needs a connection', 'error');
      return;
    }
    const plan = getPlan();
    if (mode === 'rate' && !plan.days.some((day) => day.exercises.length)) {
      toast('Add a few exercises first — there is nothing to rate yet', 'error');
      return;
    }
    busy = true;
    stopper = new AbortController();
    const { signal } = stopper;
    quick.classList.add('is-busy');
    sendBtn.hidden = true;
    stopBtn.hidden = false;
    muscles.hidden = true;
    bestFor.classList.remove('on');

    const answer = h(
      'div',
      { class: 'pc-reply is-loading' },
      h('span', { class: 'pc-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      mode === 'rate' ? 'Checking volume, balance and exercise choice…' : 'Looking at your plan…',
    );
    const turn = h('div', { class: 'pc-turn' }, h('div', { class: 'pc-question' }, question), answer);
    thread.append(turn);
    turn.scrollIntoView({ block: 'start', behavior: 'smooth' });

    try {
      const reply = await ask({ mode, question, plan, history: history.slice(-4) }, { signal });
      history.push({ question, answer: reply.answer });
      if (reply.remaining_today != null) {
        remaining = reply.remaining_today;
        paintRemaining();
      }
      answer.replaceWith(replyNode(reply));
    } catch (err) {
      answer.replaceWith(
        signal.aborted
          ? h('div', { class: 'pc-reply is-stopped' }, 'You stopped this answer')
          : h(
              'div',
              { class: 'pc-reply is-error' },
              err instanceof ApiError && err.message ? err.message : 'The coach could not answer just now — try again',
            ),
      );
    } finally {
      busy = false;
      stopper = null;
      quick.classList.remove('is-busy');
      sendBtn.hidden = false;
      stopBtn.hidden = true;
    }
  }

  openModal({
    title: 'AI Coach',
    subtitle: subtitle ?? 'Rates your plan and suggests exercises from your gym',
    icon: 'sparkle',
    className: 'coach-modal pc-modal',
    body: h('div', { class: 'pc-sheet' }, quick, thread),
    footer: [h('div', { class: 'pc-foot' }, h('div', { class: 'pc-field' }, input, sendBtn, stopBtn), left)],
    // Closed mid-answer: stop it rather than leave it running unseen.
    onClose: () => stopper?.abort(),
  });
  // openModal focuses the first field; on a phone that pops the keyboard over the chips.
  input.blur();
}
