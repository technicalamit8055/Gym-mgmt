import { ApiError, api, memberSession } from './api.js';
import { h, openModal, closeModal, renderIcon, toast } from './ui.js';

/**
 * Ask Coach: the member app's chat sheet, opened from the workout logger, the
 * next-set chip's "why?" and the Diet tab. The server (src/aiCoach.js) adds
 * everything it knows about the member; all the phone has to send is the
 * question and, mid-workout, the session that exists only on the phone.
 *
 * Replies are streamed, and the bubble shows the coach at work the way the big
 * assistants do: what it is reading ticks off line by line, Gemini's thinking
 * headlines shimmer in the header, then the answer is typed out word by word
 * and the thinking folds away under "Thought for 3s".
 *
 * The thread is kept per screen for as long as the app is open, so closing
 * the sheet to log a set and opening it again picks up where it left off —
 * even mid-answer: each bubble is one node that lives with its turn.
 */

const QUICK_PROMPTS = {
  workout: ['What weight for my next set?', 'How many reps should I do?', 'Suggest a swap for this exercise', 'Am I ready to go heavier?'],
  diet: ['What should I eat next?', 'How much protein do I have left?', 'Is today on track for my goal?'],
};
const UNAVAILABLE = 'The coach could not answer just now — try again in a moment';
/** Gap between the "reading" lines, so they read as work being done. */
const STEP_MS = 260;
/** Gap between typed words; a backlog is typed faster so a long reply never lags. */
const WORD_MS = 38;

const threads = { workout: [], diet: [] };
const inFlight = { workout: false, diet: false };
/** The open sheet's hooks, for a reply that finishes after its sheet was
 * closed and opened again. */
let activeSheet = null;
let statusPromise = null;
let status = null;

/** Whether this gym has the coach, cached for the app's lifetime (refreshed
 * after every question, which also moves the remaining count). Never throws:
 * a member without the add-on or offline just doesn't see the button. */
export function coachStatus({ refresh = false } = {}) {
  if (!statusPromise || refresh) {
    statusPromise = api.portal
      .coachStatus()
      .then((s) => (status = s))
      .catch(() => (status = { enabled: false, remaining_today: 0, daily_limit: 0 }));
  }
  return statusPromise;
}

const noticeKey = () => `gymbook.coach.notice.${memberSession.member?.id ?? 'anon'}`;
const noticeSeen = () => {
  try {
    return localStorage.getItem(noticeKey()) === '1';
  } catch {
    return false;
  }
};
const markNoticeSeen = () => {
  try {
    localStorage.setItem(noticeKey(), '1');
  } catch {
    // Storage blocked: the notice just shows again next time.
  }
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const grow = () => activeSheet?.onGrow();

/**
 * Gemini's thought summaries are short markdown sections, each opening with a
 * bold headline ("**Checking the last set**"). Read from the whole text so far
 * every time, since a chunk can end mid-line.
 */
function thoughtSections(raw) {
  const sections = [];
  for (const line of raw.split('\n')) {
    const head = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (head) {
      sections.push({ title: head[1].trim(), body: '' });
      continue;
    }
    const text = line.replace(/\*\*/g, '').trim();
    if (!text) continue;
    if (!sections.length) sections.push({ title: '', body: '' });
    const last = sections.at(-1);
    last.body += (last.body ? ' ' : '') + text;
  }
  return sections;
}

/**
 * Types text into `node` a word at a time, each word fading in, behind a
 * blinking caret. `push` adds streamed text (a half-arrived word waits for the
 * rest); `end` marks the text complete and resolves once it is all on screen.
 */
function createTyper(node) {
  const caret = h('span', { class: 'coach-caret', 'aria-hidden': 'true' });
  node.append(caret);
  let target = '';
  let final = false;
  let shown = 0;
  let last = 0;
  let raf = 0;
  let resolveDone;
  const finished = new Promise((resolve) => (resolveDone = resolve));

  const words = () => {
    const list = target.match(/\S+\s*/g) ?? [];
    if (!final && list.length && !/\s$/.test(list.at(-1))) list.pop();
    return list;
  };
  const tick = (now) => {
    raf = 0;
    const list = words();
    const backlog = list.length - shown;
    if (backlog > 0 && now - last >= WORD_MS) {
      const n = reducedMotion() ? backlog : Math.min(backlog, backlog > 24 ? 4 : backlog > 10 ? 2 : 1);
      for (const word of list.slice(shown, shown + n)) caret.before(h('span', { class: 'coach-word' }, word));
      shown += n;
      last = now;
      grow();
    }
    if (shown < list.length) raf = requestAnimationFrame(tick);
    else if (final) resolveDone();
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  return {
    get started() {
      return target.trim().length > 0;
    },
    push(chunk) {
      target += chunk;
      kick();
    },
    end(full) {
      if (full != null) target = full;
      final = true;
      kick();
      return finished;
    },
  };
}

/**
 * One coach bubble, live from the moment the question is sent. Its methods
 * are fed the stream's events; the turn object keeps what it ends up saying.
 */
function createCoachView(turn) {
  const startedAt = performance.now();
  let thoughtFor = 0;
  let userToggled = false;
  let thoughtRaw = '';
  let stepQueue = [];
  let stepTimer = 0;

  const label = h('span', { class: 'coach-think-label' }, 'Reading your data');
  const head = h(
    'button',
    { type: 'button', class: 'coach-think-head', 'aria-expanded': 'true' },
    label,
    renderIcon('chevronDown', { size: 14, stroke: 2.2 }),
  );
  const steps = h('ol', { class: 'coach-steps' });
  const thoughts = h('div', { class: 'coach-thoughts' });
  const think = h(
    'div',
    { class: 'coach-think is-open is-live' },
    head,
    h('div', { class: 'coach-think-body' }, h('div', { class: 'coach-think-inner' }, steps, thoughts)),
  );
  const answer = h('div', { class: 'coach-answer' });
  const actions = h('div', { class: 'coach-actions' });
  const bubble = h('div', { class: 'coach-msg-text is-empty' }, answer, actions);
  const node = h(
    'div',
    { class: 'coach-msg is-coach is-live', 'aria-busy': 'true' },
    h('span', { class: 'coach-msg-icon' }, renderIcon('sparkle', { size: 14, stroke: 2 })),
    h('div', { class: 'coach-msg-body' }, think, bubble),
  );
  const typer = createTyper(answer);

  const setOpen = (open) => {
    think.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.addEventListener('click', () => {
    userToggled = true;
    setOpen(!think.classList.contains('is-open'));
    grow();
  });

  const addStep = (text) => {
    steps.lastElementChild?.classList.replace('is-active', 'is-done');
    steps.append(
      h(
        'li',
        { class: 'coach-step is-active' },
        h('span', { class: 'coach-step-dot' }, renderIcon('check', { size: 10, stroke: 3.2 })),
        h('span', {}, text),
      ),
    );
    grow();
  };
  const revealStep = () => {
    stepTimer = 0;
    if (stepQueue.length) addStep(stepQueue.shift());
    if (stepQueue.length) stepTimer = setTimeout(revealStep, STEP_MS);
  };
  /** Everything read: put the rest of the lines up at once and tick them all. */
  const finishSteps = () => {
    clearTimeout(stepTimer);
    stepTimer = 0;
    for (const text of stepQueue) addStep(text);
    stepQueue = [];
    for (const li of steps.children) li.classList.replace('is-active', 'is-done');
  };

  /** The thinking is over: say for how long and fold it away. */
  const stopThinking = () => {
    if (thoughtFor) return;
    finishSteps();
    thoughtFor = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
    turn.seconds = thoughtFor;
    think.classList.remove('is-live');
    label.textContent = `Thought for ${thoughtFor}s`;
    if (!userToggled) setOpen(false);
  };

  return {
    node,

    step(text) {
      turn.steps.push(text);
      stepQueue.push(text);
      if (!stepTimer) stepTimer = setTimeout(revealStep, steps.children.length ? STEP_MS : 0);
    },

    thought(text) {
      finishSteps();
      thoughtRaw += text;
      turn.thoughts = thoughtRaw;
      const sections = thoughtSections(thoughtRaw);
      sections.forEach((section, i) => {
        let el = thoughts.children[i];
        if (!el) {
          el = h('div', { class: 'coach-thought' }, h('strong', {}), h('p', {}));
          thoughts.append(el);
        }
        el.firstChild.textContent = section.title;
        el.lastChild.textContent = section.body;
      });
      if (!thoughtFor) label.textContent = sections.findLast((section) => section.title)?.title || 'Thinking';
      grow();
    },

    answer(text) {
      if (!typer.started && text.trim()) {
        stopThinking();
        bubble.classList.remove('is-empty');
      }
      typer.push(text);
    },

    /** The reply is in: type whatever is left, then settle into the final text. */
    async finish(reply) {
      stopThinking();
      bubble.classList.remove('is-empty');
      await typer.end(reply.answer);
      Object.assign(turn, { live: false, text: reply.answer, suggestion: reply.suggestion ?? null });
      answer.replaceChildren(reply.answer);
      if (!turn.steps.length && !turn.thoughts) think.remove();
      node.classList.remove('is-live');
      node.removeAttribute('aria-busy');
      activeSheet?.paintActions(turn);
      grow();
    },

    fail(message) {
      stopThinking();
      Object.assign(turn, { live: false, error: true, text: message });
      if (!turn.steps.length && !turn.thoughts) think.remove();
      else label.textContent = 'Stopped';
      answer.replaceChildren(message);
      bubble.classList.remove('is-empty');
      node.classList.remove('is-live');
      node.classList.add('is-error');
      node.removeAttribute('aria-busy');
      grow();
    },

    setActions(...children) {
      actions.replaceChildren(...children.filter(Boolean));
    },
  };
}

/**
 * @param {object} opts
 * @param {'workout'|'diet'} opts.screen
 * @param {() => object|null} [opts.getSession] the live workout, read at send time
 * @param {(suggestion: {exercise: string, weight_kg: number, reps: number}) => boolean} [opts.onApply]
 *   fills the next set; returns false when no exercise in the session matches
 * @param {string} [opts.initialQuestion] sent as soon as the sheet opens
 * @param {'kg'|'lb'} [opts.unit]
 * @param {(kg: number) => string} [opts.weightLabel] how the member reads a weight
 */
export function openCoachSheet({ screen, getSession, onApply, initialQuestion, unit = 'kg', weightLabel = (kg) => `${kg} kg` }) {
  const thread = threads[screen];
  // Follow the reply down as it grows, unless the member scrolled up to reread.
  let stick = true;

  const list = h('div', { class: 'coach-thread', 'aria-live': 'polite' });
  list.addEventListener('scroll', () => {
    stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  });
  const remainingNode = h('span', { class: 'coach-remaining' });
  const input = h('textarea', {
    class: 'coach-input',
    rows: 1,
    maxlength: 500,
    placeholder: screen === 'diet' ? 'Ask about food, macros, your goal…' : 'Ask about this workout…',
    'aria-label': 'Ask the coach',
  });
  const sendBtn = h(
    'button',
    { class: 'coach-send', type: 'button', 'aria-label': 'Send', title: 'Send' },
    renderIcon('arrowUp', { size: 18, stroke: 2.4 }),
  );

  const paintRemaining = () => {
    if (!status?.enabled) return;
    const left = status.remaining_today;
    remainingNode.textContent = left > 0 ? `${left} question${left === 1 ? '' : 's'} left today` : 'No questions left today';
  };

  const applyButton = (turn) =>
    turn.suggestion && onApply && !turn.applied && !turn.live
      ? h(
          'button',
          {
            class: 'coach-apply',
            type: 'button',
            onclick: () => {
              if (onApply(turn.suggestion)) {
                turn.applied = true;
                closeModal();
                toast(`Next set: ${weightLabel(turn.suggestion.weight_kg)} × ${turn.suggestion.reps}`);
              } else {
                toast(`${turn.suggestion.exercise} isn't in this workout`, 'error');
              }
            },
          },
          renderIcon('check', { size: 15, stroke: 2.4 }),
          h('span', {}, `Use ${weightLabel(turn.suggestion.weight_kg)} × ${turn.suggestion.reps} for the next set`),
        )
      : null;

  const scrollDown = () => {
    if (stick) list.scrollTop = list.scrollHeight;
  };

  const turnNode = (turn) => {
    if (turn.role === 'user') return h('div', { class: 'coach-msg is-user' }, turn.text);
    turn.view.setActions(applyButton(turn));
    return turn.view.node;
  };

  const paintThread = () => {
    list.replaceChildren(
      ...(thread.length
        ? thread.map(turnNode)
        : [
            h(
              'div',
              { class: 'coach-empty' },
              h('strong', {}, screen === 'diet' ? 'Your food, your targets, one question away.' : 'Ask about the set in front of you.'),
              h('span', {}, 'The coach sees your plan, your history and this session — no need to explain.'),
            ),
          ]),
    );
    stick = true;
    scrollDown();
  };

  const sheet = {
    onGrow: scrollDown,
    paintActions: (turn) => turn.view.setActions(applyButton(turn)),
    setBusy: (busy) => {
      sendBtn.disabled = busy;
    },
    paintRemaining,
  };
  activeSheet = sheet;

  async function send(question) {
    const text = String(question ?? '').trim();
    if (!text || inFlight[screen]) return;
    if (!navigator.onLine) {
      toast('The coach needs a connection — your workout is still saved on this phone', 'error');
      return;
    }
    if (status && status.remaining_today <= 0) {
      toast(`That's your ${status.daily_limit} coach questions for today`, 'error');
      return;
    }
    inFlight[screen] = true;
    sheet.setBusy(true);
    input.value = '';
    input.style.height = '';
    const turn = { role: 'coach', live: true, steps: [], thoughts: '', text: '' };
    turn.view = createCoachView(turn);
    thread.push({ role: 'user', text }, turn);
    // Appended rather than repainted, so earlier bubbles don't replay their entrance.
    list.querySelector('.coach-empty')?.remove();
    list.append(turnNode(thread.at(-2)), turnNode(turn));
    stick = true;
    scrollDown();

    let done = null;
    let failure = null;
    try {
      const payload = { question: text, screen, unit, session: getSession?.() ?? undefined };
      const plain = await api.portal.coachAskStream(payload, (event, data) => {
        if (event === 'step') turn.view.step(data.text);
        else if (event === 'thought') turn.view.thought(data.text);
        else if (event === 'answer') turn.view.answer(data.text);
        else if (event === 'done') done = data;
        else if (event === 'error') failure = new ApiError(502, data.error, { code: data.code });
      });
      if (failure) throw failure;
      // A server that answered with plain JSON hands back the whole reply at once.
      const reply = done ?? plain;
      if (!reply?.answer) throw new ApiError(502, UNAVAILABLE);
      if (status) status.remaining_today = reply.remaining_today;
      await turn.view.finish(reply);
    } catch (err) {
      turn.view.fail(err instanceof ApiError && err.message ? err.message : UNAVAILABLE);
      if (err instanceof ApiError && err.details?.code === 'coach_limit_reached' && status) status.remaining_today = 0;
    } finally {
      inFlight[screen] = false;
      // Whichever sheet is open now, which may not be the one that asked.
      (activeSheet ?? sheet).setBusy(false);
      (activeSheet ?? sheet).paintRemaining();
    }
  }

  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input.value);
    }
  });
  // Grow with the question, up to a few lines.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  const notice = noticeSeen()
    ? null
    : h(
        'div',
        { class: 'coach-notice' },
        renderIcon('info', { size: 16 }),
        h('span', {}, 'The coach uses your profile and your workout and diet logs to answer. Questions are processed by Google Gemini.'),
        h(
          'button',
          {
            class: 'coach-notice-ok',
            type: 'button',
            onclick: (event) => {
              markNoticeSeen();
              event.currentTarget.closest('.coach-notice')?.remove();
            },
          },
          'Got it',
        ),
      );

  const chips = h(
    'div',
    { class: 'coach-chips' },
    ...QUICK_PROMPTS[screen].map((prompt) => h('button', { class: 'coach-chip', type: 'button', onclick: () => send(prompt) }, prompt)),
  );

  openModal({
    title: 'Ask Coach',
    icon: 'sparkle',
    className: 'coach-modal',
    body: h(
      'div',
      { class: 'coach-sheet' },
      notice,
      list,
      chips,
      h('div', { class: 'coach-compose' }, input, sendBtn),
      remainingNode,
    ),
    onClose: () => {
      if (activeSheet === sheet) activeSheet = null;
    },
  });

  paintThread();
  sheet.setBusy(inFlight[screen]);
  coachStatus().then(paintRemaining);
  if (initialQuestion) send(initialQuestion);
}

/* ── AI workout generator ─────────────────────────────────────────────── */

const PLAN_CHOICES = {
  goal: [
    ['muscle_gain', 'Build muscle'],
    ['fat_loss', 'Lose fat'],
    ['strength', 'Get stronger'],
    ['endurance', 'Endurance'],
    ['general_fitness', 'General fitness'],
  ],
  level: [
    ['beginner', 'Beginner'],
    ['intermediate', 'Intermediate'],
    ['advanced', 'Advanced'],
  ],
  days_per_week: [2, 3, 4, 5, 6].map((n) => [n, String(n)]),
  minutes: [30, 45, 60, 90].map((n) => [n, `${n} min`]),
  equipment: [
    ['full_gym', 'Full gym'],
    ['machines', 'Machines & cables'],
    ['dumbbells', 'Dumbbells'],
    ['bodyweight', 'Bodyweight'],
  ],
  focus: [
    ['balanced', 'Balanced'],
    ['upper_body', 'Upper body'],
    ['lower_body', 'Lower body'],
    ['chest_back', 'Chest & back'],
    ['arms_shoulders', 'Arms & shoulders'],
    ['glutes_legs', 'Glutes & legs'],
    ['core', 'Core'],
  ],
};

/**
 * The "Create with AI" sheet: a handful of taps (goal, experience, days,
 * time, kit, focus) and an optional note about injuries. The server builds a
 * week from the gym's own exercise library and `onPlan(plan)` gets the draft —
 * the Workout tab opens it in the plan builder, so nothing is saved until the
 * member has looked it over and tapped Save.
 */
export function openPlanGenerator({ onPlan }) {
  const defaults = status?.plan_defaults ?? {};
  const choice = {
    goal: defaults.goal ?? 'muscle_gain',
    level: 'beginner',
    days_per_week: defaults.days_per_week ?? 3,
    minutes: 60,
    equipment: 'full_gym',
    focus: 'balanced',
  };

  const group = (key, label) => {
    const row = h('div', { class: 'gen-chips', role: 'radiogroup', 'aria-label': label });
    const paint = () =>
      row.replaceChildren(
        ...PLAN_CHOICES[key].map(([value, text]) =>
          h(
            'button',
            {
              class: `gen-chip${choice[key] === value ? ' on' : ''}`,
              type: 'button',
              role: 'radio',
              'aria-checked': choice[key] === value ? 'true' : 'false',
              onclick: () => {
                choice[key] = value;
                paint();
              },
            },
            text,
          ),
        ),
      );
    paint();
    return h('div', { class: 'gen-field' }, h('div', { class: 'gen-label' }, label), row);
  };

  const notes = h('textarea', {
    class: 'coach-input gen-notes',
    rows: 2,
    maxlength: 300,
    placeholder: 'Optional: injuries, exercises to avoid, anything else (e.g. “bad left knee, no deadlifts”)',
    'aria-label': 'Anything the coach should know',
  });
  const left = status?.plans_remaining_today;
  const remaining = h(
    'div',
    { class: 'coach-remaining' },
    left == null ? '' : left > 0 ? `${left} AI plan${left === 1 ? '' : 's'} left today` : 'No AI plans left today',
  );

  const go = h(
    'button',
    { class: 'btn primary gen-go', type: 'button' },
    renderIcon('sparkle', { size: 16 }),
    h('span', {}, 'Create my plan'),
  );
  go.addEventListener('click', async () => {
    if (!navigator.onLine) {
      toast('Creating a plan needs a connection', 'error');
      return;
    }
    go.disabled = true;
    go.classList.add('is-busy');
    go.querySelector('span').textContent = 'Building your plan…';
    try {
      const res = await api.portal.coachPlan({ ...choice, notes: notes.value.trim() || undefined });
      if (status) status.plans_remaining_today = res.plans_remaining_today;
      closeModal();
      onPlan(res.plan, res);
    } catch (err) {
      toast(err instanceof ApiError && err.message ? err.message : 'Could not build a plan just now — try again', 'error');
      go.disabled = false;
      go.classList.remove('is-busy');
      go.querySelector('span').textContent = 'Create my plan';
    }
  });

  openModal({
    title: 'Create a plan with AI',
    subtitle: 'Built from your gym’s exercises, around you',
    icon: 'sparkle',
    className: 'coach-modal gen-modal',
    body: h(
      'div',
      { class: 'gen-sheet' },
      group('goal', 'Goal'),
      group('level', 'Experience'),
      group('days_per_week', 'Days a week'),
      group('minutes', 'Time per workout'),
      group('equipment', 'Equipment'),
      group('focus', 'Focus'),
      h('div', { class: 'gen-field' }, h('div', { class: 'gen-label' }, 'Anything else?'), notes),
    ),
    footer: [h('div', { class: 'gen-foot' }, go, remaining)],
  });
  // openModal focuses the first field — the notes box here, which would pop
  // the keyboard over the choices on a phone.
  notes.blur();
}
