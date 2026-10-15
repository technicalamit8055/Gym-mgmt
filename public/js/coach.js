import { ApiError, api, memberSession } from './api.js';
import { SETTLE_CHARS, answerTokens, plainLength } from './coachText.js';
import { h, openModal, closeModal, renderIcon, svg, toast } from './ui.js';

/**
 * Ask Coach: the member app's chat sheet, opened from the workout logger, the
 * next-set chip's "why?" and the Diet tab. The server (src/aiCoach.js) adds
 * everything it knows about the member; all the phone has to send is the
 * question and, mid-workout, the session that exists only on the phone.
 *
 * The sheet follows the design: what the coach can help with, the mascot and
 * its speech bubble, then the thread on a white card, with today's macro rings
 * under a diet answer and meal ideas to tap, and the quick prompts and the
 * composer docked at the bottom.
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
  workout: [
    ['barbell', 'What weight for my next set?'],
    ['sets', 'How many reps should I do?'],
    ['refresh', 'Suggest a swap for this exercise'],
    ['trendUp', 'Am I ready to go heavier?'],
  ],
  diet: [
    ['utensils', 'What should I eat next?'],
    ['barChart', 'How much protein do I have left?'],
    ['fileText', 'Suggest a meal plan'],
    ['target', 'Is today on track for my goal?'],
  ],
};
const FEATURES = [
  ['barbell', 'Personalised', 'advice', 'blue'],
  ['apple', 'Nutrition', 'guidance', 'green'],
  ['target', 'Workout', 'suggestions', 'blue'],
];
/** The diet sheet's "Recommended for you": each card asks the coach for that
 * kind of meal, fitted to what the member has left today. */
const MEAL_IDEAS = [
  {
    title: 'High Protein Meal',
    sub: 'Chicken + Rice + Veggies',
    art: 'food-protein-meal',
    emoji: '🍗',
    tone: 'peach',
    ask: 'Give me a high-protein meal, like chicken with rice and veggies, that fits what I have left today.',
  },
  {
    title: 'Quick & Healthy Snack',
    sub: 'Greek Yogurt + Fruits',
    art: 'food-yogurt-snack',
    emoji: '🥣',
    tone: 'blue',
    ask: 'Suggest a quick healthy snack, like Greek yogurt with fruit, that fits my macros.',
  },
  {
    title: 'Healthy Fats Option',
    sub: 'Avocado + Nuts',
    art: 'food-healthy-fats',
    emoji: '🥑',
    tone: 'green',
    ask: 'Suggest a healthy-fats option, like avocado or nuts, that fits what I have left today.',
  },
];
const MORE_IDEAS = 'Give me a few more meal ideas that fit what I have left today.';
const RINGS = [
  ['calories', 'Calories', 'flame', ' kcal'],
  ['protein_g', 'Protein', 'leaf', 'g'],
  ['carbs_g', 'Carbs', 'wheat', 'g'],
  ['fats_g', 'Fats', 'droplet', 'g'],
];
const asset = (name) => `/images/coach/${name}.webp`;
/** An illustration that is simply left out until its file exists. */
const art = (name, attrs = {}) => h('img', { src: asset(name), alt: '', decoding: 'async', onerror: (e) => e.currentTarget.remove(), ...attrs });

const UNAVAILABLE = 'The coach could not answer just now — try again in a moment';
/** The longest question, typed or spoken (MAX_QUESTION_LENGTH on the server). */
const MAX_QUESTION = 500;

/* ── Voice questions ── */

/** A spoken question stops itself here; the server takes up to about this much. */
const VOICE_MAX_MS = 60_000;
/** What to record in, best first: Opus where the browser has it, AAC on Safari. */
const VOICE_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** Whether this browser can record from the mic at all (not on plain http). */
const voiceSupported = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.isSecureContext);

/** The browser's own speech recognition (Google's service in Chrome and
 * Edge, Apple's in Safari): free to the gym, used for English questions. */
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition || null;
/** The voice switch: English on the free recogniser, everything else on Gemini. */
const VOICE_LANGS = [
  ['en', 'English'],
  ['any', 'Hinglish / any'],
];
const VOICE_LANG_KEY = 'gymbook.coach.voiceLang';
/** The member's last pick on this phone; Hinglish / any until they choose. */
function readVoiceLang() {
  try {
    return localStorage.getItem(VOICE_LANG_KEY) === 'en' ? 'en' : 'any';
  } catch {
    return 'any';
  }
}
function saveVoiceLang(value) {
  try {
    localStorage.setItem(VOICE_LANG_KEY, value);
  } catch {}
}
/** Recogniser errors that mean this browser has the API but no service
 * behind it (an iPhone home-screen app, Brave): Gemini takes over. */
const SPEECH_UNAVAILABLE = new Set(['service-not-allowed', 'language-not-supported', 'network']);

/**
 * Listens with the browser's recogniser; the same handle shape as
 * recordVoice, with `kind: 'speech'`. `onText` gets the words so far as they
 * are recognised. `stop()` resolves to the text ('' if nothing was said) or
 * throws an Error whose `code` is the recogniser's error; `cancel()` resolves
 * to null. `onEnd` is called if the recogniser stops by itself.
 */
function recogniseSpeech({ lang, onText }) {
  const recogniser = new SpeechRecognitionApi();
  recogniser.lang = lang;
  recogniser.interimResults = true;
  recogniser.maxAlternatives = 1;
  // Android Chrome's continuous mode repeats earlier words in every result,
  // so there it takes one phrase and ends at the pause (onEnd finishes it).
  recogniser.continuous = !/Android/i.test(navigator.userAgent);

  let heard = '';
  let error = null;
  recogniser.onresult = (event) => {
    let text = '';
    for (const result of event.results) text += `${result[0].transcript} `;
    heard = text.replace(/\s+/g, ' ').trim();
    onText(heard);
  };
  recogniser.onerror = (event) => {
    error = event.error;
  };

  const handle = { kind: 'speech', onTick: null, onEnd: null };
  let stopping = false;
  const ended = new Promise((resolve) => {
    recogniser.onend = () => {
      resolve();
      if (!stopping) handle.onEnd?.();
    };
  });
  const started = Date.now();
  const ticker = setInterval(() => handle.onTick?.(Date.now() - started), 250);
  try {
    recogniser.start();
  } catch (err) {
    clearInterval(ticker);
    throw err;
  }

  let done = null;
  const end = (keep) =>
    (done ??= (async () => {
      stopping = true;
      clearInterval(ticker);
      if (keep) recogniser.stop();
      else recogniser.abort();
      await ended;
      if (!keep) return null;
      // "no-speech" is only silence, and "aborted" our own abort.
      if (error && error !== 'no-speech' && error !== 'aborted') {
        if (error === 'network' && !navigator.onLine) error = 'offline';
        throw Object.assign(new Error(error), { code: error });
      }
      return heard.slice(0, MAX_QUESTION);
    })());
  handle.stop = () => end(true);
  handle.cancel = () => end(false).catch(() => null);
  return handle;
}

/** A blob as bare base64, for a JSON body. */
const blobBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Starts recording one voice question; throws if the mic is refused. Returns
 * a handle: `stop()` resolves to the clip (a Blob, null if nothing came out)
 * and `cancel()` throws it away — either way the mic is released. The
 * handle's `onTick(ms)` is called a few times a second with the time so far,
 * and `onLevel(0..1)` every frame with the loudness, for the meter.
 */
async function recordVoice({ onLevel }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const type = VOICE_TYPES.find((t) => window.MediaRecorder.isTypeSupported?.(t));
  let recorder;
  try {
    // Speech needs little: 32 kbps keeps a minute around 250 KB.
    recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : {});
  } catch {
    recorder = new MediaRecorder(stream);
  }
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  const handle = { onTick: null, heardNothing: false };

  // The level meter: the dot that swells with the voice, and the loudest
  // moment, so a muted or wrong mic is caught on the phone instead of coming
  // back from Gemini as "nothing said". A nicety: recording works without it.
  let audioCtx = null;
  let frame = 0;
  let peak = 0;
  try {
    audioCtx = new AudioContext();
    // Safari starts it suspended, and a suspended meter reads silence.
    audioCtx.resume?.().catch(() => {});
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
      peak = Math.max(peak, level);
      onLevel(level);
      frame = requestAnimationFrame(measure);
    };
    measure();
  } catch {}

  const started = Date.now();
  const ticker = setInterval(() => handle.onTick?.(Date.now() - started), 250);
  recorder.start();

  let ended = null;
  const end = (keep) => {
    ended ??= (async () => {
      clearInterval(ticker);
      cancelAnimationFrame(frame);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      // Judged only on a meter that really ran: speech peaks well above
      // 0.2, a quiet room sits under 0.03, a muted mic is a flat 0.
      handle.heardNothing = audioCtx?.state === 'running' && peak < 0.03;
      audioCtx?.close().catch(() => {});
      for (const track of stream.getTracks()) track.stop();
      // Under half a second is a mis-tap, not a question.
      if (!keep || !chunks.length || Date.now() - started < 500) return null;
      return new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
    })();
    return ended;
  };
  handle.stop = () => end(true);
  handle.cancel = () => end(false);
  return handle;
}
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

/** The coach's face: the mascot once its picture loads, the sparkle until then. */
const coachAvatar = () =>
  h('span', { class: 'coach-avatar' }, renderIcon('sparkle', { size: 18, stroke: 2 }), art('coach-avatar', { width: 48, height: 48 }));

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

/** One token of the answer (see coachText.js): a word, a bold run or a
 * coloured number chip. `animate` gives it the fade-in. */
function tokenNode(token, animate) {
  const fade = animate ? ' coach-word' : '';
  if (token.kind === 'kcal' || token.kind === 'protein') return h('span', { class: `coach-num is-${token.kind}${fade}` }, token.text);
  if (token.kind === 'bold') return h('strong', { class: fade.trim() || null }, token.text);
  return animate ? h('span', { class: 'coach-word' }, token.text) : document.createTextNode(token.text);
}

/**
 * Types the answer into `node` a token at a time, each fading in, behind a
 * blinking caret. `push` adds streamed text; the last few characters wait
 * until they cannot turn into a chip or a bold run any more, so nothing on
 * screen changes shape. `end` marks the text complete and resolves once it is
 * all on screen.
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

  const ready = () => {
    const tokens = answerTokens(target);
    if (final) return tokens;
    const settled = plainLength(target) - SETTLE_CHARS;
    let n = 0;
    while (n < tokens.length && tokens[n].end <= settled) n++;
    return tokens.slice(0, n);
  };
  const tick = (now) => {
    raf = 0;
    const tokens = ready();
    const backlog = tokens.length - shown;
    if (backlog > 0 && now - last >= WORD_MS) {
      const n = reducedMotion() ? backlog : Math.min(backlog, backlog > 24 ? 4 : backlog > 10 ? 2 : 1);
      for (const token of tokens.slice(shown, shown + n)) caret.before(tokenNode(token, true));
      shown += n;
      last = now;
      grow();
    }
    if (shown < tokens.length) raf = requestAnimationFrame(tick);
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

/** Today's four macros as rings, eaten against target, under a diet answer. */
function macroRings(diet) {
  const R = 27;
  const C = 2 * Math.PI * R;
  const cards = RINGS.filter(([key]) => Number(diet?.targets?.[key]) > 0).map(([key, label, icon, unit]) => {
    const eaten = Math.round(Number(diet.eaten?.[key]) || 0);
    const target = Math.round(diet.targets[key]);
    const left = C * (1 - Math.min(1, eaten / target));
    return h(
      'div',
      { class: `coach-ring is-${key.replace('_g', '')}` },
      h(
        'div',
        { class: 'coach-ring-dial' },
        svg(
          'svg',
          { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
          svg('circle', { cx: 32, cy: 32, r: R, class: 'coach-ring-track' }),
          svg('circle', { cx: 32, cy: 32, r: R, class: 'coach-ring-bar', 'stroke-dasharray': C, 'stroke-dashoffset': left, style: `--full: ${C}` }),
        ),
        h(
          'div',
          { class: 'coach-ring-mid' },
          renderIcon(icon, { size: 15, stroke: 2 }),
          h('strong', {}, unit === 'g' ? `${eaten}g` : eaten.toLocaleString()),
        ),
      ),
      h('span', { class: 'coach-ring-label' }, label),
      // The target sits under the label, not inside the dial: "/ 3,280 kcal" is
      // wider than the ring's inner chord and ran over the stroke.
      h('small', { class: 'coach-ring-goal' }, `of ${unit === 'g' ? `${target}g` : `${target.toLocaleString()} kcal`}`),
    );
  });
  return cards.length ? h('div', { class: 'coach-rings', role: 'img', 'aria-label': 'Today’s macros against your targets' }, ...cards) : null;
}

/* ── Meal plans ───────────────────────────────────────────────────────── */

const MEAL_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
  pre_workout: 'Pre-workout',
  post_workout: 'Post-workout',
};
const mealLabel = (meal) => MEAL_LABELS[meal.meal_type] ?? 'Meal';
const mealKcal = (meal) => meal.items.reduce((sum, item) => sum + item.calories, 0);
const grams = (n) => `${Math.round(n)}g`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The plan as plain text, for pasting into notes or a chat with a trainer. */
export function mealPlanText(plan) {
  const t = plan.totals;
  const lines = [plan.name, `${t.calories} kcal · ${grams(t.protein_g)} protein · ${grams(t.carbs_g)} carbs · ${grams(t.fats_g)} fats`];
  for (const meal of plan.meals) {
    lines.push('', `${mealLabel(meal)}${meal.name ? ` — ${meal.name}` : ''} (${mealKcal(meal)} kcal)`);
    for (const item of meal.items) {
      lines.push(`• ${item.food_name}, ${item.portion} — ${item.calories} kcal, ${grams(item.protein_g)} protein`);
    }
  }
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No async clipboard (plain http on a LAN, older WebViews): the old way.
    const area = h('textarea', { class: 'mplan-copy-area', 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    area.remove();
    return ok;
  }
}

/**
 * A meal plan as a card under a coach reply: totals and each meal with its
 * foods, then what to do with it — save it, track it, or copy it as text.
 *
 * There is no "log it all" here on purpose: the coach's figures are
 * estimates, so a plan is tracked food by food from Quick track's My plans
 * tab, where each food is looked up in the food library or online and logged
 * at the amount actually eaten. "Track foods" saves the plan (once) and opens
 * it there.
 *
 * @param {object} plan {name, meals, totals} as the server sends it
 * @param {object} [opts]
 * @param {(saved: object) => void} [opts.onTrackPlan] opens the saved plan in Quick track; no button without it
 */
export function mealPlanCard(plan, { onTrackPlan } = {}) {
  /** The saved copy, so Save and Track foods never save it twice. */
  let saved = null;
  let saving = null;
  const save = () => {
    saving ??= api.portal.saveMealPlan({ name: plan.name, meals: plan.meals }).then(
      (row) => {
        saved = row;
        saveBtn.disabled = true;
        saveBtn.replaceChildren(renderIcon('check', { size: 15, stroke: 2.4 }), h('span', {}, 'Saved'));
        return row;
      },
      (err) => {
        saving = null;
        throw err;
      },
    );
    return saving;
  };

  const saveBtn = h(
    'button',
    {
      class: `mplan-btn${onTrackPlan ? '' : ' is-primary'}`,
      type: 'button',
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          await save();
          toast('Saved — find it in Track food → My plans');
        } catch (err) {
          saveBtn.disabled = false;
          toast(err.message || 'Could not save that plan', 'error');
        }
      },
    },
    renderIcon('save', { size: 15, stroke: 2.2 }),
    h('span', {}, 'Save'),
  );

  const trackBtn = onTrackPlan
    ? h(
        'button',
        {
          class: 'mplan-btn is-primary',
          type: 'button',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              onTrackPlan(saved ?? (await save()));
            } catch (err) {
              toast(err.message || 'Could not save that plan', 'error');
            } finally {
              button.disabled = false;
            }
          },
        },
        renderIcon('search', { size: 15, stroke: 2.4 }),
        h('span', {}, 'Track foods'),
      )
    : null;

  const copyBtn = h(
    'button',
    {
      class: 'mplan-btn is-icon',
      type: 'button',
      'aria-label': 'Copy plan as text',
      title: 'Copy plan as text',
      onclick: async () => toast(...((await copyText(mealPlanText(plan))) ? ['Meal plan copied'] : ['Could not copy on this device', 'error'])),
    },
    renderIcon('copy', { size: 16, stroke: 2.2 }),
  );

  const t = plan.totals;
  return h(
    'section',
    { class: 'mplan', 'aria-label': plan.name },
    h(
      'div',
      { class: 'mplan-head' },
      h('span', { class: 'mplan-ico' }, renderIcon('utensils', { size: 18, stroke: 2.2 })),
      h(
        'div',
        { class: 'mplan-title' },
        h('strong', {}, plan.name),
        h('small', {}, `${plural(plan.meals.length, 'meal')} · track each food from the food library`),
      ),
    ),
    h(
      'div',
      { class: 'mplan-macros' },
      h('span', { class: 'is-kcal' }, h('strong', {}, t.calories.toLocaleString()), ' kcal'),
      h('span', { class: 'is-protein' }, h('strong', {}, grams(t.protein_g)), ' protein'),
      h('span', { class: 'is-carbs' }, h('strong', {}, grams(t.carbs_g)), ' carbs'),
      h('span', { class: 'is-fats' }, h('strong', {}, grams(t.fats_g)), ' fats'),
    ),
    ...plan.meals.map((meal) =>
      h(
        'div',
        { class: 'mplan-meal' },
        h(
          'div',
          { class: 'mplan-meal-head' },
          h('div', { class: 'mplan-meal-name' }, h('strong', {}, mealLabel(meal)), meal.name ? h('small', {}, meal.name) : null),
          h('span', { class: 'mplan-meal-kcal' }, `${mealKcal(meal)} kcal`),
        ),
        h(
          'ul',
          { class: 'mplan-items' },
          ...meal.items.map((item) =>
            h(
              'li',
              {},
              h('span', { class: 'mplan-food' }, h('span', {}, item.food_name), h('small', {}, item.portion)),
              h('span', { class: 'mplan-food-num' }, `${item.calories} kcal`, h('small', {}, `${grams(item.protein_g)} protein`)),
            ),
          ),
        ),
      ),
    ),
    h('div', { class: 'mplan-actions' }, trackBtn, saveBtn, copyBtn),
  );
}

/**
 * One coach reply, live from the moment the question is sent. Its methods
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
  const extras = h('div', { class: 'coach-extras' });
  const row = h(
    'div',
    { class: 'coach-msg is-coach is-live', 'aria-busy': 'true' },
    coachAvatar(),
    h('div', { class: 'coach-msg-body' }, think, bubble),
  );
  const node = h('div', { class: 'coach-turn' }, row, extras);
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
  const settle = () => {
    if (!turn.steps.length && !turn.thoughts) think.remove();
    row.classList.remove('is-live');
    row.removeAttribute('aria-busy');
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
      Object.assign(turn, {
        live: false,
        text: reply.answer,
        suggestion: reply.suggestion ?? null,
        swap: reply.swap ?? null,
        mealPlan: reply.meal_plan ?? null,
      });
      settle();
      answer.replaceChildren(...answerTokens(reply.answer).map((token) => tokenNode(token, false)));
      // A meal plan is the answer itself, so it takes the rings' place: the
      // reply already says how it sits against what is left.
      if (reply.meal_plan) {
        extras.append(
          mealPlanCard(reply.meal_plan, {
            // Through whichever sheet is open when tapped: this one may have
            // been closed and opened again since.
            onTrackPlan: activeSheet?.onTrackPlan ? (saved) => activeSheet?.onTrackPlan?.(saved) : undefined,
          }),
        );
      } else {
        const rings = reply.diet ? macroRings(reply.diet) : null;
        if (rings) extras.append(rings);
      }
      activeSheet?.paintActions(turn);
      grow();
    },

    fail(message) {
      stopThinking();
      Object.assign(turn, { live: false, error: true, text: message });
      if (turn.steps.length || turn.thoughts) label.textContent = 'Stopped';
      settle();
      answer.replaceChildren(message);
      bubble.classList.remove('is-empty');
      row.classList.add('is-error');
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
 * @param {(swap: {from: string, to: string, muscle_group: string|null}) => Promise<string|false>} [opts.onSwap]
 *   replaces `from` with `to` in the workout; resolves to the toast to show, or
 *   false when `from` is no longer in the session
 * @param {string} [opts.initialQuestion] sent as soon as the sheet opens
 * @param {'kg'|'lb'} [opts.unit]
 * @param {(kg: number) => string} [opts.weightLabel] how the member reads a weight
 * @param {(saved: object) => void} [opts.onTrackPlan] opens a saved meal plan in Quick track
 * @param {() => Promise<Array<{label: string, items: Array<{name: string, muscle_group?: string}>}>>} [opts.getExercises]
 *   what typing "@" lists: this workout's exercises and the rest of the plan's
 */
export function openCoachSheet({
  screen,
  getSession,
  onApply,
  onSwap,
  initialQuestion,
  unit = 'kg',
  weightLabel = (kg) => `${kg} kg`,
  onTrackPlan,
  getExercises,
}) {
  const thread = threads[screen];
  // Follow the reply down as it grows, unless the member scrolled up to reread.
  let stick = true;

  const list = h('div', { class: 'coach-thread', 'aria-live': 'polite' });
  const remainingNode = h('span', { class: 'coach-remaining' });
  const placeholder =
    screen === 'diet' ? 'Ask about food, macros, your goal…' : getExercises ? 'Ask, or @ an exercise…' : 'Ask about this workout…';
  const input = h('textarea', {
    class: 'coach-input',
    rows: 1,
    maxlength: MAX_QUESTION,
    placeholder,
    'aria-label': 'Ask the coach',
  });
  const sendBtn = h(
    'button',
    { class: 'coach-send', type: 'button', 'aria-label': 'Send', title: 'Send' },
    renderIcon('send', { size: 22, stroke: 2.2 }),
  );
  const mentions = getExercises
    ? createMentionPicker({
        input,
        load: getExercises,
        onPick: () => {
          growInput();
          paintCompose();
        },
      })
    : null;
  const mentionBtn = mentions
    ? h(
        'button',
        {
          class: 'coach-at',
          type: 'button',
          'aria-label': 'Pick an exercise',
          title: 'Pick an exercise',
          // Keeps the focus (and the phone's keyboard) in the box.
          onpointerdown: (event) => event.preventDefault(),
          onclick: () => mentions.start(),
        },
        '@',
      )
    : null;
  const field = h(
    'label',
    { class: 'coach-field' },
    h('span', { class: 'coach-field-ico' }, renderIcon('sparkle', { size: 18, stroke: 2 })),
    input,
    mentionBtn,
  );
  // Voice: WhatsApp's pattern — the mic sits where Send is while the box is
  // empty. Tapping it listens (the field becomes a recording bar), ✓ stops
  // and the words land in the box to check before sending, since a misheard
  // question would still use one of the day's questions.
  //
  // Two engines, picked by the language switch under the composer. English
  // goes to the browser's own speech recognition — free, and the words appear
  // as they are spoken. Hinglish and every other language are recorded and
  // written down by Gemini (POST /coach/transcribe), which is billed but is
  // the one that writes Hinglish in Roman letters and detects the language.
  const canRecord = voiceSupported();
  const canRecognise = Boolean(SpeechRecognitionApi) && window.isSecureContext;
  const voiceOn = canRecord || canRecognise;
  let voiceLang = canRecord && canRecognise ? readVoiceLang() : canRecognise ? 'en' : 'any';
  let voiceState = 'idle'; // 'recording' | 'writing'
  let recording = null;
  const micBtn = h(
    'button',
    { class: 'coach-mic', type: 'button', 'aria-label': 'Ask by voice', title: 'Ask by voice' },
    renderIcon('mic', { size: 22, stroke: 2.2 }),
  );
  const recClock = h('span', { class: 'coach-rec-time' }, '0:00');
  const recHint = h('span', { class: 'coach-rec-hint' });
  const recBar = h(
    'div',
    { class: 'coach-rec', hidden: true },
    h(
      'button',
      { class: 'coach-rec-cancel', type: 'button', 'aria-label': 'Cancel recording', title: 'Cancel', onclick: () => endVoice(false) },
      renderIcon('trash', { size: 18 }),
    ),
    h('span', { class: 'coach-rec-dot' }),
    recClock,
    recHint,
  );

  // The switch only shows when both engines are there to choose between.
  const langButtons = VOICE_LANGS.map(([value, label]) =>
    h('button', { class: 'coach-lang-opt', type: 'button', 'data-lang': value, onclick: () => setVoiceLang(value) }, label),
  );
  const langSwitch =
    canRecord && canRecognise
      ? h('div', { class: 'coach-lang', role: 'group', 'aria-label': 'Voice language' }, renderIcon('mic', { size: 13, stroke: 2.2 }), ...langButtons)
      : null;
  function setVoiceLang(value) {
    voiceLang = value;
    saveVoiceLang(value);
    for (const button of langButtons) button.setAttribute('aria-pressed', String(button.dataset.lang === value));
  }
  setVoiceLang(voiceLang);

  /** Which of the composer's controls show for the box and the mic's state. */
  function paintCompose() {
    const recordingNow = voiceState === 'recording';
    field.hidden = recordingNow;
    recBar.hidden = !recordingNow;
    input.disabled = voiceState === 'writing';
    input.placeholder = voiceState === 'writing' ? 'Writing down what you said…' : placeholder;
    if (mentionBtn) mentionBtn.disabled = voiceState !== 'idle';
    if (langSwitch) for (const button of langButtons) button.disabled = voiceState !== 'idle';
    if (!voiceOn) return;
    const typed = input.value.trim() !== '';
    sendBtn.hidden = voiceState !== 'idle' || !typed;
    micBtn.hidden = voiceState === 'idle' && typed;
    micBtn.classList.toggle('is-recording', recordingNow);
    micBtn.classList.toggle('is-writing', voiceState === 'writing');
    micBtn.disabled = voiceState === 'writing';
    micBtn.setAttribute('aria-label', recordingNow ? 'Done — write it down' : 'Ask by voice');
    micBtn.title = micBtn.getAttribute('aria-label');
    micBtn.replaceChildren(renderIcon(recordingNow ? 'check' : 'mic', { size: 22, stroke: recordingNow ? 2.6 : 2.2 }));
  }

  /** Spoken words into the box, after anything already typed, so a question
   * can be part typed, part spoken. */
  function insertSpoken(text) {
    const typed = input.value.trim();
    input.value = (typed ? `${typed} ${text}` : text).slice(0, MAX_QUESTION);
    growInput();
  }

  async function startVoice() {
    if (!navigator.onLine) {
      toast('Voice questions need a connection', 'error');
      return;
    }
    if (status && status.remaining_today <= 0) {
      toast(`That's your ${status.daily_limit} coach questions for today`, 'error');
      return;
    }
    const free = voiceLang === 'en' && canRecognise;
    try {
      recording = free
        ? recogniseSpeech({
            lang: 'en-IN',
            // The latest words, which is what the member is checking as they talk.
            onText: (text) => (recHint.textContent = !text ? 'Listening — English' : text.length > 24 ? `…${text.slice(-24)}` : text),
          })
        : await recordVoice({ onLevel: (level) => recBar.style.setProperty('--level', level.toFixed(2)) });
    } catch (err) {
      toast(
        err?.name === 'NotAllowedError' ? 'Allow the microphone for this app to ask by voice' : 'Could not start the microphone',
        'error',
      );
      return;
    }
    voiceState = 'recording';
    recClock.textContent = '0:00';
    recHint.textContent = free ? 'Listening — English' : 'Listening — any language';
    recBar.classList.toggle('is-live', free);
    recording.onTick = (ms) => {
      const seconds = Math.floor(ms / 1000);
      recClock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      if (ms >= VOICE_MAX_MS) endVoice(true);
    };
    // The browser can stop listening by itself (a long pause, a lost
    // connection, a refused mic): take what it heard as if ✓ was tapped.
    recording.onEnd = () => endVoice(true);
    paintCompose();
  }

  /** Stops listening: kept, the words go into the box; not, they are thrown away. */
  async function endVoice(keep) {
    if (voiceState !== 'recording') return;
    // Straight to the next state: the engine takes a moment to hand over.
    voiceState = keep ? 'writing' : 'idle';
    paintCompose();
    const handle = recording;
    recording = null;
    if (handle.kind === 'speech') return endSpeech(handle, keep);

    const clip = await (keep ? handle.stop() : handle.cancel());
    if (!clip || clip.size === 0 || handle.heardNothing) {
      voiceState = 'idle';
      paintCompose();
      if (keep && handle.heardNothing) {
        toast("Your microphone didn't pick up any sound — check it isn't muted, or that the right mic is selected", 'error');
      } else if (keep) {
        toast('Nothing was recorded — tap the mic and speak', 'error');
      }
      return;
    }
    voiceState = 'writing';
    paintCompose();
    try {
      const { text } = await api.portal.coachTranscribe({ audio: await blobBase64(clip), mime_type: clip.type, screen });
      if (text) insertSpoken(text);
      else toast("Didn't catch that — try again a little closer to the phone", 'error');
    } catch (err) {
      toast(err instanceof ApiError && err.message ? err.message : 'Could not make out that recording — try again', 'error');
    } finally {
      voiceState = 'idle';
      paintCompose();
    }
  }

  /** The browser's recogniser finishing: its words, or why there are none.
   * Where the browser has the API but no working service behind it, the
   * member is moved over to the Gemini engine for next time. */
  async function endSpeech(handle, keep) {
    try {
      const text = await (keep ? handle.stop() : handle.cancel());
      if (text) insertSpoken(text);
      // Some browsers' recognisers hear nothing without saying why; the
      // other engine is the way round that.
      else if (keep) toast("Didn't catch that — try again, or switch voice to Hinglish / any", 'error');
    } catch (err) {
      if (err.code === 'not-allowed') {
        toast('Allow the microphone for this app to ask by voice', 'error');
      } else if (err.code === 'offline') {
        toast('Voice questions need a connection', 'error');
      } else if (SPEECH_UNAVAILABLE.has(err.code) && canRecord) {
        setVoiceLang('any');
        toast("English voice isn't available in this browser — switched to Hinglish / any. Tap the mic again", 'error');
      } else {
        toast('Could not hear that — try again or type it', 'error');
      }
    } finally {
      voiceState = 'idle';
      paintCompose();
    }
  }

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

  /** The coach's swap as one tap: the exercise is replaced in the workout
   * (and the plan, where the member's own) by the logger's onSwap. */
  const swapButton = (turn) =>
    turn.swap && onSwap && !turn.swapped && !turn.live
      ? h(
          'button',
          {
            class: 'coach-apply is-swap',
            type: 'button',
            title: `Swap ${turn.swap.from} for ${turn.swap.to}`,
            onclick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              const done = await onSwap(turn.swap);
              if (done) {
                turn.swapped = true;
                closeModal();
                toast(done);
              } else {
                button.disabled = false;
                toast(`${turn.swap.from} isn't in this workout any more`, 'error');
              }
            },
          },
          renderIcon('refresh', { size: 15, stroke: 2.4 }),
          h('span', {}, `Swap to ${turn.swap.to}`),
        )
      : null;

  const actionButtons = (turn) => [swapButton(turn), applyButton(turn)];

  const turnNode = (turn) => {
    if (turn.role === 'user') {
      return h(
        'div',
        { class: 'coach-msg is-user' },
        h('div', { class: 'coach-msg-text' }, mentionText(turn.text, turn.mentions)),
        h('span', { class: 'coach-user-avatar' }, renderIcon('user', { size: 18, stroke: 2 })),
      );
    }
    turn.view.setActions(...actionButtons(turn));
    return turn.view.node;
  };

  const chipButtons = QUICK_PROMPTS[screen].map(([icon, prompt]) =>
    h('button', { class: 'coach-chip', type: 'button', onclick: () => send(prompt) }, renderIcon(icon, { size: 16, stroke: 2.2 }), h('span', {}, prompt)),
  );
  /** The chip for the question last asked stays lit, as in the design. */
  const markChips = () => {
    const asked = thread.findLast((turn) => turn.role === 'user')?.text;
    chipButtons.forEach((chip, i) => chip.classList.toggle('is-on', QUICK_PROMPTS[screen][i][1] === asked));
  };

  const hint = h('p', { class: 'coach-empty' }, 'The coach sees your plan, your history and this session — no need to explain.');

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

  const ideas =
    screen === 'diet'
      ? h(
          'section',
          { class: 'coach-ideas' },
          h(
            'div',
            { class: 'coach-ideas-head' },
            h('h3', {}, 'Recommended for you'),
            h('button', { class: 'coach-ideas-more', type: 'button', onclick: () => send(MORE_IDEAS) }, 'See more', renderIcon('arrowRight', { size: 16, stroke: 2.2 })),
          ),
          h(
            'div',
            { class: 'coach-ideas-row' },
            ...MEAL_IDEAS.map((idea, i) =>
              h(
                'button',
                { class: `coach-idea tone-${idea.tone}`, type: 'button', onclick: () => send(idea.ask) },
                h('span', { class: 'coach-idea-art', 'data-emoji': idea.emoji }, art(idea.art, { width: 64, height: 64, loading: 'lazy' })),
                h('span', { class: 'coach-idea-text' }, h('strong', {}, idea.title), h('small', {}, idea.sub)),
                h('span', { class: `coach-idea-go${i === 0 ? ' is-primary' : ''}` }, renderIcon('chevronRight', { size: 15, stroke: 2.4 })),
              ),
            ),
          ),
        )
      : null;

  const scroller = h(
    'div',
    { class: 'coach-scroll' },
    h(
      'div',
      { class: 'coach-pills' },
      ...FEATURES.map(([icon, first, second, tone]) =>
        h(
          'div',
          { class: `coach-pill tone-${tone}` },
          h('span', { class: 'coach-pill-ico' }, renderIcon(icon, { size: 15, stroke: 2.2 })),
          h('span', {}, first, h('br'), second),
        ),
      ),
    ),
    h(
      'div',
      { class: 'coach-hero' },
      h('p', { class: 'coach-hero-bubble' }, 'Got a question about food, workouts or your goals? I’m here to help! 💪'),
      art('coach-hero', { class: 'coach-hero-art', width: 180, height: 200 }),
    ),
    h('div', { class: 'coach-card' }, notice, hint, list, ideas),
  );
  scroller.addEventListener('scroll', () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  });

  const scrollDown = () => {
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  };

  const paintThread = () => {
    hint.hidden = thread.length > 0;
    list.replaceChildren(...thread.map(turnNode));
    markChips();
    stick = true;
    // Opened fresh: start at the top, with the hero. Opened mid-chat: the latest reply.
    if (thread.length) scrollDown();
  };

  const sheet = {
    onGrow: scrollDown,
    onTrackPlan,
    paintActions: (turn) => turn.view.setActions(...actionButtons(turn)),
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
    const picked = mentions?.mentionsIn(text) ?? [];
    input.value = '';
    input.style.height = '';
    mentions?.close();
    paintCompose();
    const turn = { role: 'coach', live: true, steps: [], thoughts: '', text: '' };
    turn.view = createCoachView(turn);
    thread.push({ role: 'user', text, mentions: picked }, turn);
    // Appended rather than repainted, so earlier bubbles don't replay their entrance.
    hint.hidden = true;
    list.append(turnNode(thread.at(-2)), turnNode(turn));
    markChips();
    stick = true;
    scrollDown();

    let done = null;
    let failure = null;
    try {
      const payload = {
        question: text,
        screen,
        unit,
        session: getSession?.() ?? undefined,
        mentions: picked.length ? picked : undefined,
      };
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
    if (mentions?.handleKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input.value);
    }
  });
  // Grow with the question, up to a few lines.
  function growInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }
  input.addEventListener('input', () => {
    growInput();
    paintCompose();
  });
  micBtn.addEventListener('click', () => (voiceState === 'recording' ? endVoice(true) : startVoice()));

  openModal({
    title: 'Ask Coach',
    subtitle: 'Your AI fitness assistant',
    icon: 'sparkle',
    className: 'coach-chat-modal',
    body: h(
      'div',
      { class: 'coach-sheet' },
      scroller,
      h(
        'div',
        { class: 'coach-dock' },
        mentions?.node,
        h('div', { class: 'coach-chips' }, ...chipButtons),
        h(
          'div',
          { class: 'coach-compose' },
          field,
          recBar,
          voiceOn ? micBtn : null,
          sendBtn,
        ),
        h('div', { class: 'coach-dock-foot' }, langSwitch, remainingNode),
      ),
    ),
    onClose: () => {
      if (activeSheet === sheet) activeSheet = null;
      // Never leave the mic on behind a closed sheet.
      recording?.cancel();
    },
  });
  // openModal focuses the first field, which on a phone would pop the
  // keyboard over the sheet before the member has seen it.
  input.blur();

  paintThread();
  paintCompose();
  sheet.setBusy(inFlight[screen]);
  coachStatus().then(paintRemaining);
  if (initialQuestion) send(initialQuestion);
}

/* ── @ exercise picker ── */

/** The @mention the caret is in: the text after an "@" that starts a word,
 * up to the caret, or null. */
function mentionAt(input) {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const match = /(^|\s)@([^@\n]{0,40})$/.exec(before);
  return match ? { start: before.length - match[2].length - 1, query: match[2] } : null;
}

/** Every word typed after the @ appears in the exercise's name or muscle group. */
const mentionMatches = (item, query) => {
  const haystack = `${item.name} ${item.muscle_group ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
};

/**
 * Typing "@" in the composer lists the exercises in this workout and the rest
 * of the plan; picking one writes "@Name " into the question, so a long plan
 * doesn't have to be spelled out from memory. ↑/↓ and Enter pick from the
 * keyboard, Esc closes. `load()` resolves to [{ label, items: [{ name,
 * muscle_group }] }], asked for once, the first time the list opens.
 */
function createMentionPicker({ input, load, onPick }) {
  let groups = null;
  let loading = null;
  let open = null; // { start, query } while the list shows
  let options = [];
  let active = 0;

  const box = h('div', { class: 'coach-mentions', id: 'coach-mentions', role: 'listbox', 'aria-label': 'Exercises', hidden: true });
  // Taps on the list keep the focus (and the phone's keyboard) in the box.
  box.addEventListener('pointerdown', (event) => event.preventDefault());
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', box.id);
  input.setAttribute('aria-expanded', 'false');

  const names = () => (groups ?? []).flatMap((group) => group.items.map((item) => item.name));

  function close() {
    open = null;
    box.hidden = true;
    box.scrollTop = 0;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function paintActive() {
    options.forEach((option, i) => option.node.setAttribute('aria-selected', String(i === active)));
    const current = options[active]?.node;
    if (current) {
      input.setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({ block: 'nearest' });
    }
  }

  function paint() {
    if (!open) return;
    if (!groups) {
      options = [];
      box.replaceChildren(h('div', { class: 'coach-mentions-note' }, 'Loading your plan…'));
    } else {
      // A finished mention ("@Leg Press ") is just part of the question now.
      const query = open.query;
      const done = names().some((name) => query.toLowerCase().startsWith(`${name.toLowerCase()} `));
      options = [];
      const sections = done
        ? []
        : groups
            .map((group) => {
              const items = group.items.filter((item) => mentionMatches(item, query));
              if (!items.length) return null;
              return h(
                'div',
                { class: 'coach-mentions-group', role: 'group', 'aria-label': group.label },
                h('div', { class: 'coach-mentions-label' }, group.label),
                ...items.map((item) => {
                  const index = options.length;
                  const node = h(
                    'div',
                    { class: 'coach-mention', id: `coach-mention-${index}`, role: 'option', onclick: () => pick(index) },
                    h('span', { class: 'coach-mention-at' }, '@'),
                    h('span', { class: 'coach-mention-name' }, item.name),
                    item.muscle_group ? h('span', { class: 'coach-mention-muscle' }, item.muscle_group) : null,
                  );
                  options.push({ item, node });
                  return node;
                }),
              );
            })
            .filter(Boolean);
      if (!options.length) {
        // Typing on past every match is just typing: get out of the way.
        if (query.trim()) return close();
        box.replaceChildren(h('div', { class: 'coach-mentions-note' }, 'No exercises in this workout or plan yet'));
      } else {
        box.replaceChildren(...sections);
        active = Math.min(active, options.length - 1);
      }
    }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    // Once shown: a hidden list can't scroll its active row into view.
    if (options.length) paintActive();
  }

  /** Re-reads the caret's mention after every keystroke or tap in the box. */
  function update() {
    const found = mentionAt(input);
    if (!found) return close();
    if (!open || open.query !== found.query) active = 0;
    open = found;
    if (!groups && !loading) {
      loading = Promise.resolve()
        .then(load)
        .catch(() => [])
        .then((loaded) => {
          groups = (loaded ?? []).filter((group) => group.items?.length);
          paint();
        });
    }
    paint();
  }

  function pick(index) {
    const option = options[index];
    if (!open || !option) return;
    const caret = input.selectionStart ?? input.value.length;
    const text = `@${option.item.name} `;
    input.value = (input.value.slice(0, open.start) + text + input.value.slice(caret)).slice(0, MAX_QUESTION);
    const at = Math.min(open.start + text.length, input.value.length);
    input.setSelectionRange(at, at);
    input.focus();
    close();
    onPick();
  }

  /** The list's keys, ahead of the composer's own. True when it used the key. */
  function handleKey(event) {
    if (!open || box.hidden || !options.length) {
      if (open && event.key === 'Escape') {
        close();
        return true;
      }
      return false;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      paintActive();
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      pick(active);
    } else if (event.key === 'Escape') {
      close();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  /** Starts a mention from the @ button, for keyboards that hide the @. */
  function start() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const text = before && !/\s$/.test(before) ? ' @' : '@';
    input.value = (before + text + input.value.slice(caret)).slice(0, MAX_QUESTION);
    const at = Math.min(caret + text.length, input.value.length);
    input.focus();
    input.setSelectionRange(at, at);
    onPick();
    update();
  }

  /** The exercises a question names with @, longest names first so
   * "@Incline Bench Press" isn't read as "@Bench Press". */
  function mentionsIn(text) {
    const lower = text.toLowerCase();
    return [...new Set(names())]
      .sort((a, b) => b.length - a.length)
      .filter((name) => lower.includes(`@${name.toLowerCase()}`));
  }

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', close);

  return { node: box, handleKey, start, close, mentionsIn };
}

/** A question with its @exercises picked out, for the member's bubble. */
function mentionText(text, mentions) {
  if (!mentions?.length) return text;
  const escaped = mentions.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(@(?:${escaped.join('|')}))`, 'gi');
  return text.split(pattern).map((part, i) => (i % 2 ? h('span', { class: 'coach-msg-mention' }, part) : part));
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
