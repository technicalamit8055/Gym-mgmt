import { ApiError, api, memberSession, pathPrefix } from '../api.js';
import {
  addDays,
  append,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  currencyInfo,
  date,
  dateField,
  exerciseMedia,
  h,
  initials,
  money,
  openModal,
  renderIcon,
  statusBadge,
  svg,
  time,
  toast,
  today,
  verifiedTick,
} from '../ui.js';
import { cameraProblem, startBarcodeScan } from '../barcodeScanner.js';
import { cropAndResizeImage } from '../photo.js';
import { canInstall, isIos, onInstallChange, promptInstall } from '../pwa.js';
import * as push from '../push.js';
import * as sound from '../sound.js';
import { getAppMode, isLibrary, t, toggleAppMode } from '../vertical.js';

/**
 * The member/student self-service app: a phone-first mini-app a member signs
 * into directly (see api.portal.* and requireMemberAuth on the server), not
 * the staff console. Tab switching is plain in-memory state, not the hash
 * router — a bottom tab bar behaves like a native app's, not like five more
 * routes — so the whole shell is one view that manages its own repaints.
 */

/** Set right after a bootstrap-PIN login, consumed once by the Profile tab to
 * nudge the member into setting a real PIN. Module-level because the login
 * view and the app shell are two separate calls into this module with no
 * other channel between them. */
let pendingPinPrompt = false;

const gymDisplayName = (ctx) => ctx.context?.tenant?.gym_name || (isLibrary() ? 'SeatBook' : 'GymBook');

/** Detaches the previous portal instance's push listener. A tapped
 * notification re-renders the portal via a hash change (#/portal/diet), and
 * the old instance's listener would otherwise keep repainting a detached bell. */
let detachPushListener = null;

/** The server's view of the active workout is best-effort: a dropped request
 * only costs the member a keep-alive nudge, never their session. */
const reportWorkoutStarted = (state) =>
  api.portal.notifications
    .workoutStarted({ workout_name: state.workout_name, started_at: state.started_at })
    .catch(() => {});
const reportWorkoutEnded = () => api.portal.notifications.workoutEnded().catch(() => {});

/** Category → how a notification looks in the notification center. */
const NOTIFICATION_STYLE = {
  water: { icon: 'droplet', tone: 'blue' },
  nutrition: { icon: 'utensils', tone: 'green' },
  workout: { icon: 'timer', tone: 'orange' },
  announcement: { icon: 'bell', tone: 'purple' },
  membership: { icon: 'crown', tone: 'orange' },
  test: { icon: 'checkCircle', tone: 'green' },
};

/** "5 min ago" for the notification center; a date once it is older than a day. */
function relativeTime(utc) {
  const then = Date.parse(`${String(utc).replace(' ', 'T')}Z`);
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return date(new Date(then).toISOString().slice(0, 10));
}

function dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return { weekday: d.toLocaleDateString(undefined, { weekday: 'short' }), day: d.getDate() };
}

function progressRing(pct, { size = 76, stroke = 7 } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  return h(
    'div',
    { class: 'portal-hero-ring-wrap' },
    svg(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
      svg('circle', { class: 'portal-ring-track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, fill: 'none' }),
      svg('circle', {
        class: 'portal-ring-fill',
        cx: size / 2,
        cy: size / 2,
        r,
        'stroke-width': stroke,
        fill: 'none',
        'stroke-dasharray': c.toFixed(2),
        'stroke-dashoffset': (c * (1 - clamped)).toFixed(2),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
  );
}

/** The coloured illustration icons in /images/portal — flame, bicep, leaf,
 * water, crown. Decorative only, so alt is empty. */
const portalIcon = (name, className = 'portal-art-icon') =>
  h('img', { class: className, src: `/images/portal/icon-${name}.svg`, alt: '', width: 24, height: 24 });

/** `tone` (orange | purple | green | blue) tints the icon tile. */
function quickAction(icon, label, onclick, tone = 'orange') {
  return h(
    'button',
    { class: 'portal-quick-btn', type: 'button', onclick },
    h('div', { class: `portal-quick-icon tone-${tone}` }, renderIcon(icon, { size: 22 })),
    h('span', {}, label),
  );
}

/** `tone` also switches on the little rising-bars flourish behind the number —
 * the Workout tab's stats call this without one and stay plain. */
function miniStat(icon, value, label, tone) {
  return h(
    'div',
    { class: `portal-mini-stat${tone ? ` tone-${tone}` : ''}` },
    h('div', { class: 'portal-mini-stat-icon' }, renderIcon(icon, { size: tone ? 18 : 16 })),
    h('div', { class: 'portal-mini-stat-value' }, String(value ?? 0)),
    h('div', { class: 'portal-mini-stat-label' }, label),
    tone ? h('div', { class: 'portal-mini-stat-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')) : null,
  );
}

/** A section title with its "View all →" link on the right. `className` lets a
 * tab restyle the title (the Workout tab uses the small muted `is-label`);
 * leave `linkLabel` out for a title with no link. */
function sectionHead(title, linkLabel, onLink, className = '') {
  return h(
    'div',
    { class: `portal-section-head${className ? ` ${className}` : ''}` },
    h('h3', {}, title),
    linkLabel
      ? h('button', { class: 'portal-section-link', type: 'button', onclick: onLink }, linkLabel, renderIcon('arrowRight', { size: 14 }))
      : null,
  );
}

/* ------------------------------------------------- Workout tab artwork --- */

/** Exercises that have a thumbnail in /images/workout, keyed by lower-cased
 * name. Anything else gets a dumbbell tile rather than a broken image. */
const EXERCISE_THUMBS = {
  deadlift: 'deadlift',
  'pull-up': 'pullup',
  'seated cable row': 'cable-row',
  'face pull': 'face-pull',
  'barbell curl': 'barbell-curl',
  'hammer curl': 'hammer-curl',
};

const EXERCISE_BLURBS = {
  deadlift: 'Build overall back strength',
  'pull-up': 'Great for lats and upper back',
  'seated cable row': 'Focus on controlled movement',
  'face pull': 'Build rear delts & posture',
  'barbell curl': 'Focus on full range of motion',
  'hammer curl': 'Build thicker biceps',
};

const MUSCLE_BLURBS = {
  abdominals: 'Build a strong, stable core',
  abductors: 'Strengthen the outer hips',
  adductors: 'Strengthen the inner thighs',
  biceps: 'Build bigger biceps',
  calves: 'Build stronger calves',
  cardio: 'Boost conditioning and endurance',
  chest: 'Build chest size and strength',
  forearms: 'Build grip and forearm strength',
  full_body: 'Train your whole body',
  glutes: 'Build stronger glutes',
  hamstrings: 'Build the back of your legs',
  lats: 'Build a wider back',
  lower_back: 'Strengthen your lower back',
  neck: 'Strengthen your neck',
  quadriceps: 'Build leg strength and size',
  shoulders: 'Build strong, rounded shoulders',
  traps: 'Build bigger traps',
  triceps: 'Build bigger triceps',
  upper_back: 'Build a thicker upper back',
};

/** What a routine day is about, for the "Or train another day" tiles. Days
 * whose name carries no muscle list get one from this table, then from the
 * muscle groups their exercises actually hit. */
const DAY_BLURBS = {
  'push (volume)': 'Higher volume workout',
  'pull (volume)': 'Back & Biceps (Volume)',
  'legs & core': 'Quads, Hamstrings & Core',
  'legs & conditioning': 'Strength & Cardio Mix',
};

const muscleLabel = (group) => String(group ?? '').replace('_', ' ');
const joinList = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} & ${items.at(-1)}` : (items[0] ?? ''));
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function dayCardMeta(day) {
  const stripped = day.day_name.replace(/^Day \d+:\s*/, '');
  const parens = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(stripped);
  const listy = parens && (parens[2].length > 12 || /[,&]/.test(parens[2]));
  const title = listy ? parens[1] : stripped;
  const groups = [...new Set(day.exercises.map((e) => muscleLabel(e.muscle_group)))].map(capitalise);
  const sub = listy ? parens[2] : (DAY_BLURBS[title.toLowerCase()] ?? joinList(groups));

  const key = stripped.toLowerCase();
  let icon = { name: 'weight', tone: 'orange' };
  if (/conditioning|cardio/.test(key)) icon = { image: '/images/workout/icon-runner.svg', tone: 'green' };
  else if (/volume/.test(key) && /push|upper|chest/.test(key)) icon = { name: 'barChart', tone: 'orange' };
  else if (/pull|back/.test(key)) icon = { name: 'pullBar', tone: 'purple' };
  else if (/leg|lower/.test(key)) icon = { name: 'weight', tone: 'blue' };
  else if (/push|upper|chest/.test(key)) icon = { image: '/images/workout/icon-push.svg', tone: 'orange' };
  return { title, sub, icon };
}

/** One tile of the "Or train another day" grid. */
function dayCard(day, onStart, span) {
  const { title, sub, icon } = dayCardMeta(day);
  return h(
    'button',
    { class: `portal-day-card tone-${icon.tone}`, type: 'button', style: `--span:${span}`, onclick: () => onStart(day) },
    h(
      'span',
      { class: 'portal-day-icon' },
      icon.image ? h('img', { src: icon.image, alt: '', width: 22, height: 22 }) : renderIcon(icon.name, { size: 20 }),
    ),
    h('span', { class: 'portal-day-text' }, h('span', { class: 'portal-day-title' }, title), h('span', { class: 'portal-day-sub' }, sub)),
  );
}

/** Rows of three, each row stretched to fill the grid: five other days lay out
 * as 3 + 2, four as 3 + 1, so there is never a gap at the end of a row. */
function dayCardGrid(days, onStart) {
  const spans = [];
  for (let i = 0; i < days.length; i += 3) {
    const rowLength = Math.min(3, days.length - i);
    for (let j = 0; j < rowLength; j++) spans.push(6 / rowLength);
  }
  return h('div', { class: 'portal-day-grid' }, ...days.map((day, i) => dayCard(day, onStart, spans[i])));
}

/** The demo fields a session carries for an exercise, so the logger can show
 * them without another round trip (and still can offline). */
const demoFields = (exercise) => ({
  media_url: exercise.media_url ?? null,
  media_type: exercise.media_type ?? null,
  instructions: exercise.instructions ?? null,
  secondary_muscles: exercise.secondary_muscles ?? [],
  equipment: exercise.equipment ?? null,
});

/** The sheet a member opens from a routine row or the logger: the demo, what
 * it works, and how to do it. */
function openExerciseDemo(exercise) {
  openModal({ title: exercise.exercise_name ?? exercise.name, body: exerciseDemoBody(exercise) });
}

/** An exercise's demo at any size: the operator's upload, then the bundled
 * picture, or null when it has neither. */
function demoMedia(exercise, className) {
  const thumb = EXERCISE_THUMBS[String(exercise.exercise_name ?? exercise.name).trim().toLowerCase()];
  return (
    exerciseMedia(exercise, { className }) ??
    (thumb ? h('img', { class: className, src: `/images/workout/ex-${thumb}.png`, alt: '' }) : null)
  );
}

/** Hevy's big demo: tap it to watch full screen, and a clip gets a pause
 * button in the corner. Null when the exercise has no demo at all. */
function demoStage(exercise) {
  const media = demoMedia(exercise, 'portal-demo-media');
  if (!media) return null;
  const name = exercise.exercise_name ?? exercise.name;
  const isClip = media.tagName === 'VIDEO';

  const pause = isClip
    ? h('button', {
        class: 'portal-demo-pause',
        type: 'button',
        'aria-label': 'Pause demo',
        onclick: (event) => {
          event.stopPropagation();
          if (media.paused) media.play().catch(() => {});
          else media.pause();
        },
      })
    : null;
  const paintPause = () => {
    if (!pause) return;
    clear(pause).append(renderIcon(media.paused ? 'play' : 'pause', { size: 16 }));
    pause.setAttribute('aria-label', media.paused ? 'Play demo' : 'Pause demo');
  };
  if (isClip) {
    media.addEventListener('play', paintPause);
    media.addEventListener('pause', paintPause);
    paintPause();
  }

  return h(
    'div',
    {
      class: 'portal-demo-stage',
      role: 'button',
      tabindex: '0',
      'aria-label': `Watch ${name} full screen`,
      onclick: () => openDemoFullscreen(exercise),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDemoFullscreen(exercise);
        }
      },
    },
    media,
    h('span', { class: 'portal-demo-expand', 'aria-hidden': 'true' }, renderIcon('maximize', { size: 15 })),
    pause,
  );
}

/** The demo on a black screen of its own, sized to fit, over everything —
 * the sheet underneath stays open for when it closes. */
function openDemoFullscreen(exercise) {
  const media = demoMedia(exercise, 'portal-demo-full-media');
  if (!media) return;
  const name = exercise.exercise_name ?? exercise.name;
  const muscles = [exercise.muscle_group, ...(exercise.secondary_muscles ?? [])].filter(Boolean).map((m) => capitalise(muscleLabel(m)));

  let overlay;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('portal-demo-open');
  };
  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }
  overlay = h(
    'div',
    {
      class: 'portal-demo-full',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${name} demo`,
      onclick: (event) => {
        if (event.target === overlay) close();
      },
    },
    h('button', { class: 'portal-demo-full-close', type: 'button', onclick: close, 'aria-label': 'Close' }, renderIcon('close', { size: 22 })),
    media,
    h(
      'div',
      { class: 'portal-demo-full-caption' },
      h('strong', {}, name),
      muscles.length ? h('span', {}, `Primary: ${muscles[0]}${muscles.length > 1 ? ` · Secondary: ${muscles.slice(1).join(', ')}` : ''}`) : null,
    ),
  );
  document.body.append(overlay);
  document.body.classList.add('portal-demo-open');
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('.portal-demo-full-close').focus();
}

/** The demo, what it works and how to do it — the demo sheet's body, and the
 * "How to" tab of the progress sheet. */
function exerciseDemoBody(exercise) {
  const name = exercise.exercise_name ?? exercise.name;
  const blurb = exercise.instructions || EXERCISE_BLURBS[String(name).trim().toLowerCase()] || MUSCLE_BLURBS[exercise.muscle_group] || '';

  return h(
    'div',
    { class: 'portal-demo' },
    demoStage(exercise),
    h(
      'div',
      { class: 'portal-demo-badges' },
      h('span', { class: 'portal-muscle-badge', 'data-m': exercise.muscle_group }, muscleLabel(exercise.muscle_group)),
      ...(exercise.secondary_muscles ?? []).map((m) => h('span', { class: 'portal-muscle-badge is-secondary' }, muscleLabel(m))),
      exercise.equipment ? h('span', { class: 'muted' }, muscleLabel(exercise.equipment)) : null,
    ),
    exercise.target_sets ? h('div', { class: 'portal-demo-target' }, `Target ${exercise.target_sets} × ${exercise.target_reps || '—'}`) : null,
    blurb ? h('p', { class: 'portal-demo-text' }, blurb) : null,
  );
}

/** The small demo on a logger card; opens the full sheet. The operator's
 * upload wins, then the bundled picture; with neither, a dumbbell tile keeps
 * every card's header the same shape. */
function exerciseThumbButton(exercise) {
  const bundled = EXERCISE_THUMBS[exercise.exercise_name.trim().toLowerCase()];
  const media =
    exerciseMedia(exercise, { className: 'portal-ex-thumb-media' }) ??
    (bundled ? h('img', { class: 'portal-ex-thumb-media', src: `/images/workout/ex-${bundled}.png`, alt: '' }) : null);
  return h(
    'button',
    {
      class: `portal-ex-thumb${media ? '' : ' is-empty'}`,
      type: 'button',
      'aria-label': `${exercise.exercise_name} progress and how-to`,
      onclick: () => openExerciseDetail(exercise),
    },
    media ?? renderIcon('weight', { size: 22 }),
  );
}

/** "lower_back" → "Lower Back": how the picker names a muscle or a piece of kit. */
const titleCase = (value) =>
  String(value ?? '')
    .split('_')
    .map((word) => capitalise(word))
    .join(' ');

/** Hevy's muscle groups, for when the server's list (with the operator's
 * pictures) has not arrived — the server's MUSCLE_GROUPS, src/muscles.js. */
const MUSCLE_KEYS = [
  'abdominals', 'abductors', 'adductors', 'biceps', 'calves', 'cardio', 'chest', 'forearms', 'full_body', 'glutes',
  'hamstrings', 'lats', 'lower_back', 'neck', 'quadriceps', 'shoulders', 'traps', 'triceps', 'upper_back', 'other',
];
const EQUIPMENT_KEYS = ['barbell', 'dumbbell', 'cable', 'machine', 'smith_machine', 'kettlebell', 'band', 'bodyweight', 'cardio', 'other'];

/** The drawn icon a muscle group falls back on until the operator uploads its picture. */
const MUSCLE_ICONS = {
  abdominals: 'muscleCore',
  abductors: 'muscleLeg',
  adductors: 'muscleLeg',
  biceps: 'bicep',
  calves: 'muscleLeg',
  cardio: 'heartPulse',
  chest: 'weight',
  forearms: 'muscleArm',
  full_body: 'activity',
  glutes: 'muscleLeg',
  hamstrings: 'muscleLeg',
  lats: 'muscleBack',
  lower_back: 'muscleBack',
  neck: 'muscleShoulders',
  quadriceps: 'muscleLeg',
  shoulders: 'muscleShoulders',
  traps: 'muscleBack',
  triceps: 'muscleArm',
  upper_back: 'muscleBack',
  other: 'more',
};

const EQUIPMENT_ICONS = {
  barbell: 'barbell',
  dumbbell: 'weight',
  cable: 'pullBar',
  machine: 'equipment',
  smith_machine: 'barbell',
  kettlebell: 'weight',
  band: 'activity',
  bodyweight: 'yoga',
  cardio: 'heartPulse',
  other: 'more',
};

/** Exercises the member made with the picker's Create button. Kept on this
 * device, like the recents: a member's own variation is theirs, not a row in
 * the gym's library that every trainer then sees. */
const CUSTOM_EXERCISES_KEY = 'gymbook.portal.customExercises';
const customExercises = {
  read() {
    try {
      const list = JSON.parse(localStorage.getItem(CUSTOM_EXERCISES_KEY) || '[]');
      return Array.isArray(list)
        ? list.filter((e) => e && typeof e.name === 'string' && typeof e.muscle_group === 'string')
        : [];
    } catch {
      return [];
    }
  },
  add(exercise) {
    const next = [exercise, ...this.read().filter((e) => e.name.toLowerCase() !== exercise.name.toLowerCase())].slice(0, 100);
    try {
      localStorage.setItem(CUSTOM_EXERCISES_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the exercise is still added to this workout.
    }
  },
};

/** The exercises this member last added from the picker, newest first, kept
 * on the device like the weight unit. */
const RECENT_EXERCISES_KEY = 'gymbook.portal.recentExercises';
const recentExercises = {
  read() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_EXERCISES_KEY) || '[]');
      return Array.isArray(list) ? list.filter((name) => typeof name === 'string') : [];
    } catch {
      return [];
    }
  },
  add(name) {
    const next = [name, ...this.read().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 10);
    try {
      localStorage.setItem(RECENT_EXERCISES_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the picker simply shows no recents.
    }
  },
};

/** A picker row's picture: the operator's demo, then the bundled one, then a
 * dumbbell tile so the list stays aligned. */
function pickerThumb(item) {
  const bundled = EXERCISE_THUMBS[item.name.trim().toLowerCase()];
  return (
    exerciseMedia(item, { className: 'portal-pick-thumb' }) ??
    (bundled
      ? h('img', { class: 'portal-pick-thumb', src: `/images/workout/ex-${bundled}.png`, alt: '', loading: 'lazy' })
      : h('span', { class: 'portal-pick-thumb is-empty' }, renderIcon('weight', { size: 22 })))
  );
}

/** A Hevy-style action sheet: a column of full-width rows, each closing the
 * sheet before it runs so a follow-up dialog opens on a clean stack. */
function actionSheet(title, actions) {
  openModal({
    title,
    className: 'portal-action-modal',
    body: h(
      'div',
      { class: 'portal-action-sheet' },
      ...actions.filter(Boolean).map((action) =>
        h(
          'button',
          {
            class: `portal-action-row${action.danger ? ' danger' : ''}`,
            type: 'button',
            disabled: action.disabled,
            onclick: () => {
              closeModal();
              action.onClick();
            },
          },
          renderIcon(action.icon, { size: 18 }),
          h('span', {}, action.label),
        ),
      ),
    ),
  });
}

/** One exercise of today's routine: thumbnail, muscle badge, name and what to
 * aim for, the sets × reps pill and a chevron. */
function routineExerciseRow(exercise) {
  const name = exercise.exercise_name;
  const thumb = EXERCISE_THUMBS[name.trim().toLowerCase()];
  const blurb = exercise.notes || EXERCISE_BLURBS[name.trim().toLowerCase()] || MUSCLE_BLURBS[exercise.muscle_group] || '';
  return h(
    'button',
    { class: 'portal-routine-row', type: 'button', onclick: () => openExerciseDemo(exercise) },
    // The operator's demo wins; the bundled picture covers an exercise that has none yet.
    exerciseMedia(exercise, { className: 'portal-routine-thumb' }) ??
      (thumb
        ? h('img', { class: 'portal-routine-thumb', src: `/images/workout/ex-${thumb}.png`, alt: '', width: 88, height: 44, loading: 'lazy' })
        : h('span', { class: 'portal-routine-thumb is-empty' }, renderIcon('weight', { size: 20 }))),
    h(
      'div',
      { class: 'portal-routine-body' },
      h('span', { class: 'portal-muscle-badge', 'data-m': exercise.muscle_group }, muscleLabel(exercise.muscle_group)),
      h('div', { class: 'portal-routine-main' }, h('div', { class: 'portal-routine-ex-name' }, name), blurb ? h('div', { class: 'portal-routine-ex-sub' }, blurb) : null),
      h('span', { class: 'portal-routine-pill' }, `${exercise.target_sets} × ${exercise.target_reps}`),
      h('span', { class: 'portal-routine-go' }, renderIcon('chevronRight', { size: 15 })),
    ),
  );
}

/**
 * Hevy's sheet header: a text button either side of a centred title. Used by
 * the Add Exercise screen and the Create Exercise form, which hide the
 * modal's own head.
 */
function pickerBar(title, { left, right }) {
  return h(
    'div',
    { class: 'portal-pick-bar' },
    h('button', { class: 'portal-pick-bar-btn', type: 'button', onclick: left.onClick }, left.label),
    h('h2', { class: 'portal-pick-bar-title' }, title),
    right
      ? h('button', { class: 'portal-pick-bar-btn strong', type: 'button', onclick: right.onClick }, right.label)
      : h('span', { class: 'portal-pick-bar-btn' }),
  );
}

/** A filter option's round picture: the operator's upload, else a drawn icon. */
function optionArt(option) {
  return h(
    'span',
    { class: `portal-filter-art${option.media_url ? '' : ' is-icon'}` },
    option.media_url ? h('img', { src: option.media_url, alt: '', loading: 'lazy', decoding: 'async' }) : renderIcon(option.icon, { size: 22 }),
  );
}

/**
 * The "Muscle Group" / "Equipment" sheet over the picker: an "All" row, then
 * one row per option with its round picture, and a tick on the current one.
 * Picking closes only this sheet.
 */
function openFilterSheet({ title, allLabel, options, current, onPick }) {
  const row = (option) =>
    h(
      'button',
      {
        class: `portal-filter-row${option.key === current ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': String(option.key === current),
        onclick: () => {
          closeModal();
          onPick(option.key);
        },
      },
      optionArt(option),
      h('span', { class: 'portal-filter-label' }, option.label),
      option.key === current ? h('span', { class: 'portal-filter-tick' }, renderIcon('check', { size: 20, stroke: 2.4 })) : null,
    );

  openModal({
    title,
    className: 'portal-filter-modal',
    body: h(
      'div',
      { class: 'portal-filter-list' },
      row({ key: '', label: allLabel, icon: 'layoutGrid' }),
      ...options.map(row),
    ),
  });
}

/**
 * Hevy's Create Exercise form: a name, the equipment and the primary muscle,
 * each of the last two picked from the same sheets the filters use.
 */
function openCreateExercise({ name = '', muscles, equipment, onCreate }) {
  const state = { equipment: 'other', muscle: '' };
  const nameInput = h('input', {
    class: 'portal-create-name',
    type: 'text',
    maxlength: 120,
    value: name,
    placeholder: 'Exercise name',
    'aria-label': 'Exercise name',
  });
  const muscleValue = h('span', { class: 'portal-create-value' });
  const equipmentValue = h('span', { class: 'portal-create-value' });

  const paint = () => {
    muscleValue.textContent = state.muscle ? titleCase(state.muscle) : 'Select';
    muscleValue.classList.toggle('is-placeholder', !state.muscle);
    equipmentValue.textContent = titleCase(state.equipment);
  };

  const field = (label, value, onClick) =>
    h(
      'button',
      { class: 'portal-create-field', type: 'button', onclick: onClick },
      h('span', { class: 'portal-create-label' }, label),
      value,
      renderIcon('chevronRight', { size: 18 }),
    );

  function save() {
    const exerciseName = nameInput.value.trim().replace(/\s+/g, ' ');
    if (exerciseName.length < 2) return toast('Give the exercise a name', 'error');
    if (!state.muscle) return toast('Choose the primary muscle group', 'error');
    closeModal();
    onCreate({ name: exerciseName, muscle_group: state.muscle, equipment: state.equipment });
  }

  openModal({
    title: 'Create Exercise',
    className: 'portal-pick-modal portal-hevy-modal portal-create-modal',
    body: h(
      'div',
      { class: 'portal-create-sheet' },
      pickerBar('Create Exercise', { left: { label: 'Cancel', onClick: closeModal }, right: { label: 'Save', onClick: save } }),
      nameInput,
      h(
        'div',
        { class: 'portal-create-fields' },
        field('Equipment', equipmentValue, () =>
          openFilterSheet({
            title: 'Equipment',
            allLabel: 'None',
            options: equipment,
            current: state.equipment === 'other' ? '' : state.equipment,
            onPick: (key) => {
              state.equipment = key || 'other';
              paint();
            },
          }),
        ),
        field('Primary Muscle Group', muscleValue, () =>
          openFilterSheet({
            title: 'Muscle Group',
            allLabel: 'Select',
            options: muscles,
            current: state.muscle,
            onPick: (key) => {
              state.muscle = key;
              paint();
            },
          }),
        ),
      ),
      h('p', { class: 'portal-create-note' }, 'Saved on this phone, so it shows up in your exercise list next time too.'),
    ),
  });
  paint();
}

/**
 * The Add Exercise screen, laid out like Hevy's: Cancel · title · Create, a
 * search box, "All Equipment" and "All Muscles" filters that open picture
 * sheets, then Recent Exercises above the full list. Rows toggle in and out
 * of a multi-select; `onAdd` gets the picked library rows in the order they
 * were tapped — the live logger turns them into set tables, the plan builder
 * into targets.
 */
function openExercisePicker(onAdd, { title = 'Add Exercise' } = {}) {
  let library = null;
  let query = '';
  const filter = { muscle: '', equipment: '' };
  let muscles = MUSCLE_KEYS.map((key) => ({ key, label: titleCase(key), media_url: null }));
  let equipment = EQUIPMENT_KEYS;
  // Hevy-style multi-select: rows toggle in and out, and they are added in
  // the order they were picked. A Map keeps that order and dedupes by name.
  const selected = new Map();
  const list = h('div', { class: 'portal-pick-list' }, h('div', { class: 'portal-loading' }, 'Loading…'));
  const addButton = h('button', { class: 'portal-pick-submit', type: 'button', onclick: addSelected });
  const footer = h('div', { class: 'portal-pick-footer hidden' }, addButton);

  const muscleOptions = () => muscles.map((m) => ({ ...m, icon: MUSCLE_ICONS[m.key] ?? 'weight' }));
  const equipmentOptions = () => equipment.map((key) => ({ key, label: titleCase(key), icon: EQUIPMENT_ICONS[key] ?? 'weight' }));
  const muscleName = (key) => muscles.find((m) => m.key === key)?.label ?? titleCase(key);

  function addSelected() {
    const picked = [...selected.values()];
    // Newest first in the recents, so add in reverse to keep the first pick on top.
    for (const item of [...picked].reverse()) recentExercises.add(item.name);
    closeModal();
    onAdd(picked);
  }

  function paintFooter() {
    const count = selected.size;
    footer.classList.toggle('hidden', count === 0);
    addButton.textContent = `Add ${count} exercise${count === 1 ? '' : 's'}`;
  }

  const keyOf = (item) => item.name.toLowerCase();
  function toggle(item) {
    if (selected.has(keyOf(item))) selected.delete(keyOf(item));
    else selected.set(keyOf(item), item);
    paintList();
    paintFooter();
  }

  function pickRow(item) {
    const isOn = selected.has(keyOf(item));
    return h(
      'div',
      { class: `portal-pick-row${isOn ? ' selected' : ''}` },
      h(
        'button',
        {
          class: 'portal-pick-thumb-btn',
          type: 'button',
          'aria-label': `${item.name} progress and how-to`,
          onclick: () => openExerciseDetail(item),
        },
        pickerThumb(item),
      ),
      h(
        'button',
        { class: 'portal-pick-main', type: 'button', 'aria-pressed': String(isOn), onclick: () => toggle(item) },
        h(
          'span',
          { class: 'portal-pick-text' },
          h('span', { class: 'portal-pick-name' }, item.name),
          h('span', { class: 'portal-pick-sub' }, muscleName(item.muscle_group)),
        ),
      ),
      h(
        'button',
        {
          class: 'portal-pick-stats',
          type: 'button',
          title: 'See progress',
          'aria-label': `${item.name} progress`,
          onclick: () => openExerciseDetail(item),
        },
        renderIcon('trendUp', { size: 18, stroke: 2.2 }),
      ),
    );
  }

  const matchesFilters = (e) =>
    (!filter.muscle || e.muscle_group === filter.muscle) && (!filter.equipment || e.equipment === filter.equipment);

  function paintList() {
    if (!library) return;
    const needle = query.trim().toLowerCase();
    const matches = library
      .filter(matchesFilters)
      .filter((e) => !needle || `${e.name} ${muscleName(e.muscle_group)} ${titleCase(e.equipment ?? '')}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));

    clear(list);
    // Recents sit above the full list only while browsing: once the member
    // is typing, the one list of matches is the answer.
    const byName = new Map(library.map((e) => [e.name.toLowerCase(), e]));
    const recents = needle
      ? []
      : recentExercises
          .read()
          .map((name) => byName.get(name.toLowerCase()))
          .filter((e) => e && matchesFilters(e));
    if (recents.length) {
      list.append(
        h('h3', { class: 'portal-pick-caption' }, 'Recent Exercises'),
        h('div', { class: 'portal-pick-group' }, ...recents.map((item) => pickRow(item))),
      );
    }

    const heading = needle ? 'Results' : filter.muscle ? `${muscleName(filter.muscle)} Exercises` : 'All Exercises';
    list.append(h('h3', { class: 'portal-pick-caption' }, heading));
    if (!matches.length) {
      list.append(
        h(
          'div',
          { class: 'portal-pick-none' },
          h('p', {}, 'No exercise matches that.'),
          h('button', { class: 'portal-pick-none-btn', type: 'button', onclick: openCreate }, renderIcon('plus', { size: 16, stroke: 2.4 }), `Create "${query.trim() || 'a custom exercise'}"`),
        ),
      );
      return;
    }
    list.append(h('div', { class: 'portal-pick-group' }, ...matches.slice(0, 150).map((item) => pickRow(item))));
  }

  /* The two filter buttons, which read their current choice like Hevy's do. */
  const muscleButton = h('button', { class: 'portal-pick-filter', type: 'button', onclick: () => pickFilter('muscle') });
  const equipmentButton = h('button', { class: 'portal-pick-filter', type: 'button', onclick: () => pickFilter('equipment') });
  function paintFilters() {
    equipmentButton.textContent = filter.equipment ? titleCase(filter.equipment) : 'All Equipment';
    equipmentButton.classList.toggle('active', Boolean(filter.equipment));
    muscleButton.textContent = filter.muscle ? muscleName(filter.muscle) : 'All Muscles';
    muscleButton.classList.toggle('active', Boolean(filter.muscle));
  }
  function pickFilter(kind) {
    const isMuscle = kind === 'muscle';
    openFilterSheet({
      title: isMuscle ? 'Muscle Group' : 'Equipment',
      allLabel: isMuscle ? 'All Muscles' : 'All Equipment',
      options: isMuscle ? muscleOptions() : equipmentOptions(),
      current: filter[kind],
      onPick: (key) => {
        filter[kind] = key;
        paintFilters();
        paintList();
      },
    });
  }
  paintFilters();

  function openCreate() {
    openCreateExercise({
      name: query.trim(),
      muscles: muscleOptions(),
      equipment: equipmentOptions(),
      onCreate: (made) => {
        // A name the library already has is that exercise, not a copy of it.
        const existing = library?.find((e) => e.name.toLowerCase() === made.name.toLowerCase());
        const item = existing ?? { ...made, source: 'member', previous: null, media_url: null, media_type: null };
        if (!existing) {
          customExercises.add(made);
          library = [...(library ?? []), item];
        }
        if (!selected.has(keyOf(item))) selected.set(keyOf(item), item);
        paintList();
        paintFooter();
        toast(existing ? `${item.name} is already in the list — selected it` : `${item.name} created`);
      },
    });
  }

  const search = h(
    'label',
    { class: 'portal-pick-search' },
    renderIcon('search', { size: 20 }),
    h('input', {
      type: 'search',
      placeholder: 'Search exercise',
      'aria-label': 'Search exercise',
      oninput: (event) => {
        query = event.target.value;
        paintList();
      },
    }),
  );

  openModal({
    title,
    className: 'portal-pick-modal portal-hevy-modal portal-pick-screen',
    body: h(
      'div',
      { class: 'portal-pick-sheet' },
      h(
        'div',
        { class: 'portal-pick-top' },
        pickerBar(title, { left: { label: 'Cancel', onClick: closeModal }, right: { label: 'Create', onClick: openCreate } }),
        search,
        h('div', { class: 'portal-pick-filters' }, equipmentButton, muscleButton),
      ),
      list,
      footer,
    ),
  });
  // openModal focuses the first input; browsing is the common case, so the
  // keyboard stays down until the member taps the search box.
  search.querySelector('input').blur();
  api.portal
    .exercises()
    .then((res) => {
      if (res.muscle_groups?.length) muscles = res.muscle_groups;
      if (res.equipment?.length) equipment = res.equipment;
      // The member's own creations, minus any the library has since gained.
      const names = new Set(res.items.map((e) => e.name.toLowerCase()));
      const mine = customExercises
        .read()
        .filter((e) => !names.has(e.name.toLowerCase()))
        .map((e) => ({ ...e, source: 'member', previous: null, media_url: null, media_type: null }));
      library = [...res.items, ...mine];
      paintFilters();
      paintList();
    })
    .catch((err) => clear(list).append(h('div', { class: 'portal-empty' }, err.message || 'Could not load exercises')));
}


/**
 * One row of a Profile card: a tinted icon tile, a title over a muted line,
 * then whatever sits on the right — a value, a switch, a segmented control.
 * `onclick` turns the whole row into a button with a chevron; `tone` is one of
 * the .tone-* classes (orange | purple | blue | green | rose).
 */
function profileRow({ icon, tone, title, sub, value, control, onclick, className = '' }) {
  const parts = [
    h('span', { class: 'portal-prof-ico' }, renderIcon(icon, { size: 22 })),
    h('span', { class: 'portal-prof-text' }, h('strong', {}, title), sub ? h('small', {}, sub) : null),
    value != null ? h('span', { class: 'portal-prof-value' }, value) : null,
    control || null,
    onclick ? h('span', { class: 'portal-prof-chev' }, renderIcon('chevronRight', { size: 18 })) : null,
  ];
  const cls = `portal-prof-row tone-${tone}${className ? ` ${className}` : ''}`;
  return onclick ? h('button', { class: cls, type: 'button', onclick }, ...parts) : h('div', { class: cls }, ...parts);
}

function settingsSwitch(checked, label, onToggle) {
  return h(
    'button',
    {
      class: `portal-switch${checked ? ' on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': String(checked),
      'aria-label': label,
      onclick: onToggle,
    },
    h('span', { class: 'portal-switch-thumb' }),
  );
}

function volumeSegmented(current, onPick) {
  return h(
    'div',
    { class: 'portal-segmented' },
    ...Object.entries(sound.VOLUME_PRESETS).map(([key, value]) =>
      h(
        'button',
        {
          class: `portal-segment${Math.abs(current - value) < 0.001 ? ' active' : ''}`,
          type: 'button',
          onclick: () => onPick(value),
        },
        key[0].toUpperCase() + key.slice(1),
      ),
    ),
  );
}

function seatCard(s) {
  return h(
    'div',
    { class: 'portal-seat-card' },
    h('div', { class: 'portal-seat-code' }, s.seat_code),
    h(
      'div',
      { class: 'portal-seat-meta' },
      h('div', {}, [s.zone_name, s.row_label ? `Row ${s.row_label}` : null].filter(Boolean).join(' · ') || 'Unzoned'),
      h('div', { class: 'muted' }, `${s.session_name} · ${time(s.start_time)} – ${time(s.end_time)}`),
    ),
    h('div', { class: 'portal-seat-until' }, `Until ${date(s.end_date)}`),
  );
}

function classCard(c, { onBook, onCancel } = {}) {
  const full = c.seats_left <= 0 && !c.my_booking_id;
  return h(
    'div',
    { class: 'portal-class-card' },
    h('div', { class: 'portal-class-time' }, time(c.start_time)),
    h(
      'div',
      { class: 'portal-class-meta' },
      h('div', { class: 'portal-class-name' }, c.name),
      h('div', { class: 'muted' }, [c.trainer_name, c.room].filter(Boolean).join(' · ') || `${c.duration_min} min`),
      h('div', { class: `portal-class-capacity${full ? ' full' : ''}` }, full ? 'Full' : `${c.seats_left} spots left`),
    ),
    onBook
      ? c.my_booking_id
        ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => onCancel(c) }, 'Cancel')
        : h('button', { class: 'btn sm primary', type: 'button', disabled: full, onclick: () => onBook(c) }, 'Book')
      : c.my_booking_id
        ? h('span', { class: 'badge green' }, 'Booked')
        : null,
  );
}

/** A class's look on the Schedule tab, picked from its name — the first
 * matching keyword wins. Anything unmatched cycles the tones by position so a
 * day of unknown classes still reads as a coloured list, not five of the same. */
const CLASS_KINDS = [
  { match: /yoga|stretch|meditat|mobility/i, icon: 'yoga', tone: 'orange' },
  { match: /strength|weight|lift|power|muscle|pump/i, icon: 'barbell', tone: 'blue' },
  { match: /hiit|blast|boot ?camp|circuit|tabata|crossfit|cardio|spin|cycl/i, icon: 'zap', tone: 'red' },
  { match: /zumba|dance|aerobic|bhangra/i, icon: 'music', tone: 'purple' },
  { match: /abs|core|pilates|posture/i, icon: 'bicep', tone: 'green' },
];
const FALLBACK_KINDS = [
  { icon: 'weight', tone: 'orange' },
  { icon: 'barbell', tone: 'blue' },
  { icon: 'zap', tone: 'red' },
  { icon: 'music', tone: 'purple' },
  { icon: 'bicep', tone: 'green' },
];
const classKind = (name, index) => CLASS_KINDS.find((k) => k.match.test(name || '')) || FALLBACK_KINDS[index % FALLBACK_KINDS.length];

/** A seat count is "running low" at five or under, or a quarter of the room. */
const spotsLow = (c) => c.seats_left <= Math.max(5, Math.floor(c.capacity / 4));

/** The Schedule tab's card: a tinted time block on the left, then the class
 * and its trainer, with the spots pill and the Book button down the right. */
function scheduleCard(c, index, { onBook, onCancel }) {
  const kind = classKind(c.name, index);
  const [hh = '0', mm = '00'] = String(c.start_time || '').split(':');
  const hour = Number(hh);
  const clock = `${String(hour % 12 || 12).padStart(2, '0')}:${mm.padStart(2, '0')}`;
  const booked = Boolean(c.my_booking_id);
  const full = c.seats_left <= 0 && !booked;
  const ended = c.class_date < today();
  const trainer = String(c.trainer_name || '').trim() || 'Gym staff';

  let action;
  if (booked) {
    action = h(
      'button',
      { class: 'portal-sched-btn is-booked', type: 'button', disabled: ended, onclick: () => onCancel(c) },
      renderIcon('check', { size: 15, stroke: 2.6 }),
      'Booked',
    );
  } else if (ended || full) {
    action = h('button', { class: 'portal-sched-btn', type: 'button', disabled: true }, ended ? 'Ended' : 'Full');
  } else {
    action = h(
      'button',
      { class: 'portal-sched-btn', type: 'button', onclick: () => onBook(c) },
      'Book',
      renderIcon('arrowRight', { size: 16, stroke: 2.4 }),
    );
  }

  return h(
    'article',
    { class: `portal-sched-card tone-${kind.tone}` },
    h(
      'div',
      { class: 'portal-sched-time' },
      h('strong', {}, clock),
      h('strong', {}, hour < 12 ? 'AM' : 'PM'),
      h('span', {}, `${c.duration_min} min`),
    ),
    h(
      'div',
      { class: 'portal-sched-body' },
      h('div', { class: 'portal-sched-icon' }, renderIcon(kind.icon, { size: 22 })),
      h(
        'div',
        { class: 'portal-sched-info' },
        h('div', { class: 'portal-sched-name' }, c.name),
        c.description ? h('div', { class: 'portal-sched-desc' }, c.description) : null,
      ),
      h(
        'div',
        { class: `portal-sched-spots${full || spotsLow(c) ? ' is-low' : ''}` },
        renderIcon('users', { size: 14 }),
        full ? 'Full' : `${Math.max(0, c.seats_left)} spot${c.seats_left === 1 ? '' : 's'} left`,
      ),
      h('div', { class: 'portal-sched-avatar' }, initials(...trainer.split(/\s+/))),
      h(
        'div',
        { class: 'portal-sched-trainer' },
        h('div', {}, trainer),
        h('span', {}, c.room || 'Trainer'),
      ),
      action,
    ),
  );
}

/**
 * The illustrations on the Invoices & Payments tab, from /images/billing.
 * Decorative and optional: a missing file removes its own <img>, so the
 * layout never shows a broken-image box while the artwork is not in yet.
 */
const payArt = (name, className) =>
  h('img', {
    class: className,
    src: `/images/billing/${name}.png`,
    alt: '',
    decoding: 'async',
    onerror: (event) => event.currentTarget.remove(),
  });

/** Renewal tiles take these in turn — orange, blue, green — like the mockup. */
const RENEWAL_LOOKS = [
  { tone: 'orange', icon: 'barbell', art: 'plan-monthly' },
  { tone: 'blue', icon: 'calendar', art: 'plan-quarterly' },
  { tone: 'green', icon: 'crown', art: 'plan-annual' },
];

/**
 * Three short selling points for a renewal tile. The gym's own description
 * wins, split into phrases; otherwise a line about the length, and — when the
 * plan is cheaper per day than the shortest one — how much it saves, so the
 * tile never claims a saving the prices do not back up.
 */
function planPerks(p, savePct, base) {
  const fromDescription = String(p.description || '')
    .split(/\r?\n|•|;|\.\s+|,\s+/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s && s.length <= 40);
  const months = Math.round(p.duration_days / 30);
  const length =
    p.duration_days >= 360 ? 'Full year access' : months > 1 ? `${months} months access` : p.duration_days >= 28 ? 'Full month access' : `${p.duration_days} days access`;
  const perks = fromDescription.length ? fromDescription.slice(0, 3) : [length, isLibrary() ? 'All reading halls' : 'All fitness equipment'];
  if (perks.length < 3) {
    if (savePct >= 5) perks.push(`Save ${savePct}% vs ${base.name}`);
    else if (p.id === base.id) perks.push(p.duration_days <= 31 ? 'Renew every month' : 'Shortest commitment');
    else perks.push(isLibrary() ? 'Your seat, held for you' : 'Full gym access');
  }
  return perks.slice(0, 3);
}

function openFullscreenPass(pass, member) {
  let overlay;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  overlay = h(
    'div',
    { class: 'portal-pass-fullscreen', onclick: (event) => { if (event.target === overlay) close(); } },
    h('button', { class: 'portal-pass-fullscreen-close', type: 'button', onclick: close, 'aria-label': 'Close' }, renderIcon('close', { size: 22 })),
    h('div', { class: 'portal-pass-fullscreen-qr', html: pass.svg }),
    h('div', { class: 'portal-pass-fullscreen-name' }, `${member.first_name} ${member.last_name || ''}`.trim()),
    h('div', { class: 'portal-pass-fullscreen-code' }, member.code),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
}

function openSupportModal() {
  openModal({
    title: 'Need help?',
    body: h(
      'div',
      { class: 'portal-support-body' },
      h(
        'p',
        {},
        `For membership questions, payments or anything else, reach out to the ${isLibrary() ? 'hall' : 'gym'} front desk directly — they can see your account and sort it out on the spot.`,
      ),
      h('p', { class: 'muted' }, 'You can also change your PIN from the Profile tab.'),
    ),
  });
}

/* ------------------------------------------------------------------ login */

function renderPortalLogin(ctx) {
  const gymName = gymDisplayName(ctx);
  const logoUrl = ctx.context?.tenant?.logo_url;
  const memberWord = isLibrary() ? 'student' : 'member';

  let step = 'identifier';
  let identifier = '';
  let pin = '';
  let busy = false;
  let error = '';

  const card = h('div', { class: 'portal-login-card' });

  function paintIdentifier() {
    clear(card);
    const input = h('input', {
      class: 'portal-input',
      type: 'text',
      autocapitalize: 'none',
      autocorrect: 'off',
      placeholder: isLibrary() ? 'Student ID or phone number' : 'Member ID or phone number',
      value: identifier,
    });
    input.addEventListener('input', (event) => { identifier = event.target.value; });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        goPin();
      }
    });

    append(card, [
      h('h1', { class: 'portal-login-title' }, 'Welcome back'),
      h('p', { class: 'portal-login-sub' }, `Sign in with your ${memberWord} ID or phone number.`),
      h('label', { class: 'portal-field' }, input),
      error ? h('p', { class: 'portal-login-error' }, error) : null,
      h('button', { class: 'btn primary block', type: 'button', onclick: goPin }, 'Continue'),
      h('p', { class: 'portal-login-foot' }, h('a', { href: '#/' }, renderIcon('arrowLeft', { size: 16 }), 'Back to the site')),
    ]);
    input.focus();
  }

  function goPin() {
    error = '';
    if (!identifier.trim()) {
      error = `Enter your ${memberWord} ID or phone number`;
      paintIdentifier();
      return;
    }
    step = 'pin';
    pin = '';
    paintPin();
  }

  function paintPin() {
    clear(card);
    const dots = h(
      'div',
      { class: 'portal-pin-dots' },
      ...Array.from({ length: 6 }, (_, i) => h('span', { class: `portal-pin-dot${i < pin.length ? ' filled' : ''}` })),
    );
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];
    const keypad = h(
      'div',
      { class: 'portal-keypad' },
      ...keys.map((k) => {
        if (k === '') return h('span', { class: 'portal-key portal-key-empty' });
        if (k === 'back') {
          return h(
            'button',
            {
              class: 'portal-key portal-key-action',
              type: 'button',
              'aria-label': 'Delete digit',
              onclick: () => { pin = pin.slice(0, -1); paintPin(); },
            },
            renderIcon('close', { size: 18 }),
          );
        }
        return h(
          'button',
          {
            class: 'portal-key',
            type: 'button',
            onclick: () => {
              if (pin.length < 6) pin += k;
              paintPin();
            },
          },
          k,
        );
      }),
    );

    append(card, [
      h('button', { class: 'portal-back-link', type: 'button', onclick: () => { step = 'identifier'; error = ''; paintIdentifier(); } }, '‹ Back'),
      h('h1', { class: 'portal-login-title' }, 'Enter your PIN'),
      h('p', { class: 'portal-login-sub' }, 'First time here? Use the last 4 digits of your phone number.'),
      dots,
      error ? h('p', { class: 'portal-login-error' }, error) : null,
      keypad,
      h(
        'button',
        { class: 'btn primary block', type: 'button', disabled: pin.length < 4 || busy, onclick: submit },
        busy ? 'Signing in…' : 'Sign in',
      ),
    ]);
  }

  async function submit() {
    if (pin.length < 4 || busy) return;
    busy = true;
    error = '';
    paintPin();
    try {
      const res = await api.portal.login(identifier.trim(), pin);
      memberSession.save(res.token, res.member);
      pendingPinPrompt = Boolean(res.must_set_pin);
      toast(`Welcome, ${res.member.first_name}`);
      await ctx.rerender();
    } catch (err) {
      busy = false;
      error = err.message || 'Could not sign in';
      pin = '';
      paintPin();
    }
  }

  paintIdentifier();

  return h(
    'div',
    { class: 'portal-login' },
    h(
      'div',
      { class: 'portal-login-brand' },
      logoUrl
        ? h('img', { class: 'portal-login-logo-img', src: logoUrl, alt: gymName })
        : h('div', { class: 'portal-login-logo' }, renderIcon(isLibrary() ? 'book' : 'dumbbell', { size: 26 })),
      h('div', { class: 'portal-login-gymname' }, gymName),
    ),
    card,
  );
}

/* ══════════════════════════════════════════════ Diet & workout tracking ══ */

/**
 * The member-facing half of the paid Fitness add-on: a Heavy-style set logger
 * and a Lifesum-style macro tracker, both living in this file's tab shell.
 *
 * Both tabs check entitlement before painting anything (api.portal.fitnessStatus
 * is the one fitness call that answers for an unentitled member) and fall back
 * to the upgrade sheet, which is the same screen the server's 402 describes.
 */

const MEAL_SLOTS = [
  { key: 'breakfast', label: 'Breakfast', icon: 'sun' },
  { key: 'lunch', label: 'Lunch', icon: 'utensils' },
  { key: 'dinner', label: 'Dinner', icon: 'moon' },
  { key: 'snack', label: 'Snacks', icon: 'flame' },
  { key: 'pre_workout', label: 'Pre-workout', icon: 'weight' },
  { key: 'post_workout', label: 'Post-workout', icon: 'weight' },
];

const SET_TYPES = [
  { key: 'warmup', short: 'W', label: 'Warmup' },
  { key: 'normal', short: '—', label: 'Normal' },
  { key: 'drop', short: 'D', label: 'Drop set' },
  { key: 'failure', short: 'F', label: 'To failure' },
];

const REST_PRESETS = [30, 60, 90, 120, 180];

/** Kilograms are what the server stores; pounds are this member's own display
 * preference, kept on the device so it survives a reload but never touches
 * their logged history. */
const UNIT_KEY = 'gymbook.portal.weightUnit';
const LB_PER_KG = 2.20462;

const weightUnit = {
  get() {
    try {
      return localStorage.getItem(UNIT_KEY) === 'lb' ? 'lb' : 'kg';
    } catch {
      return 'kg';
    }
  },
  set(unit) {
    try {
      localStorage.setItem(UNIT_KEY, unit === 'lb' ? 'lb' : 'kg');
    } catch {
      // A private window with storage blocked simply stays in kilograms.
    }
  },
};

/** Height is stored in centimetres; feet and inches are a display choice,
 * remembered on the device like the weight unit. Until one is picked it
 * follows the weight unit — someone weighing in pounds usually measures in feet. */
const HEIGHT_UNIT_KEY = 'gymbook.portal.heightUnit';
const heightUnit = {
  get() {
    try {
      const saved = localStorage.getItem(HEIGHT_UNIT_KEY);
      if (saved === 'cm' || saved === 'ft') return saved;
    } catch {
      // Storage blocked: fall through to the weight unit's lead.
    }
    return weightUnit.get() === 'lb' ? 'ft' : 'cm';
  },
  set(unit) {
    try {
      localStorage.setItem(HEIGHT_UNIT_KEY, unit === 'ft' ? 'ft' : 'cm');
    } catch {
      // A private window simply forgets the choice.
    }
  },
};

/** Centimetres → whole feet and inches, carrying a rounded-up 12 inches. */
function cmToFeetInches(cm) {
  const total = Math.round(cm / 2.54);
  return { ft: Math.floor(total / 12), inch: total % 12 };
}

const toDisplayWeight = (kg) => (weightUnit.get() === 'lb' ? Math.round(kg * LB_PER_KG * 10) / 10 : kg);
const toKg = (value) => (weightUnit.get() === 'lb' ? Math.round((value / LB_PER_KG) * 100) / 100 : Number(value) || 0);
const weightLabel = (kg) => `${toDisplayWeight(kg)} ${weightUnit.get()}`;

const clockFrom = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const minutesLabel = (seconds) => `${Math.max(1, Math.round(seconds / 60))} min`;

/** Epley, mirroring estimate1rm() in src/fitness.js — shown live as the member
 * types, which is why it cannot wait for a round trip. */
const estimate1rm = (kg, reps) => (kg > 0 && reps > 0 ? Math.round(kg * (1 + reps / 30) * 10) / 10 : 0);

/* ── The paywall ───────────────────────────────────────────────────────── */

function upgradeSheet(status, { onRefresh } = {}) {
  const price = money(status.settings.monthly_price);
  return h(
    'div',
    { class: 'portal-tab-body' },
    h(
      'div',
      { class: 'portal-paywall' },
      h('div', { class: 'portal-paywall-glow' }),
      h('div', { class: 'portal-paywall-badge' }, renderIcon('sparkle', { size: 14 }), ' Premium'),
      h('h2', { class: 'portal-paywall-title' }, 'Diet & Workout Tracking'),
      h('p', { class: 'portal-paywall-sub' }, status.settings.description),
      h(
        'div',
        { class: 'portal-paywall-features' },
        ...[
          ['weight', 'Log every set', 'Weights, reps and rest timers, with your last session next to each set.'],
          ['trophy', 'Chase your records', 'Automatic 1RM estimates and a personal-record wall that fills up as you lift.'],
          ['flame', 'Hit your macros', 'Calorie and protein rings, meal by meal, plus a water tracker.'],
          ['member', 'Coached, not guessed', 'Your gym’s trainers assign the plan and can see how you are getting on.'],
        ].map(([icon, title, body]) =>
          h(
            'div',
            { class: 'portal-paywall-feature' },
            h('div', { class: 'portal-paywall-feature-icon' }, renderIcon(icon, { size: 17 })),
            h('div', {}, h('strong', {}, title), h('p', {}, body)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'portal-paywall-price' },
        h('strong', {}, price),
        h('span', {}, '/ month'),
      ),
      h(
        'p',
        { class: 'portal-paywall-cta-note' },
        'Ask the front desk to switch it on — they can activate it while you wait.',
      ),
      h(
        'button',
        { class: 'btn primary block', type: 'button', onclick: onRefresh },
        renderIcon('refresh', { size: 15 }),
        ' I have paid — check again',
      ),
    ),
  );
}

/* ── Exercise progress ─────────────────────────────────────────────────── */

/** What the progress chart can plot, each read off one session of
 * api.portal.exerciseHistory. Weights stay in kilograms until they are drawn. */
const PROGRESS_METRICS = [
  { key: 'heaviest', label: 'Heaviest Weight', weight: true, read: (s) => s.heaviest_weight_kg },
  { key: '1rm', label: 'One Rep Max', weight: true, read: (s) => s.best_1rm_kg },
  { key: 'set_volume', label: 'Best Set Volume', weight: true, read: (s) => s.best_set_volume_kg },
  { key: 'volume', label: 'Session Volume', weight: true, read: (s) => s.volume_kg },
  { key: 'reps', label: 'Total Reps', weight: false, read: (s) => s.total_reps },
];

const PROGRESS_RANGES = [
  { key: '3m', label: '3 months', days: 92 },
  { key: '1y', label: 'Year', days: 366 },
  { key: 'all', label: 'All time', days: null },
];

const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const longDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * A line chart for one metric over time, drawn for a thumb: the axis zooms to
 * the data (a bench going 80 → 85 kg must look like progress, not a flat line
 * on a 0-based axis) and dragging anywhere picks the nearest session.
 */
function progressChart(points, { format, onSelect }) {
  const W = 340;
  const H = 172;
  const left = 40;
  const right = 12;
  const top = 12;
  const bottom = H - 24;
  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo) * 0.15 || Math.max(1, hi * 0.1);
  lo = Math.max(0, lo - pad);
  hi += pad;

  const x = (i) => (points.length === 1 ? (left + W - right) / 2 : left + (i * (W - left - right)) / (points.length - 1));
  const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const coords = points.map((p, i) => [x(i), y(p.value)]);

  const ticks = [hi, (hi + lo) / 2, lo];
  const marker = svg('circle', { class: 'portal-prog-marker', r: 5.5 });
  const guide = svg('line', { class: 'portal-prog-guide', y1: top, y2: bottom });

  const select = (index) => {
    const [cx, cy] = coords[index];
    marker.setAttribute('cx', cx);
    marker.setAttribute('cy', cy);
    guide.setAttribute('x1', cx);
    guide.setAttribute('x2', cx);
    onSelect(index);
  };

  const labelIdx = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const chart = svg(
    'svg',
    { class: 'portal-prog-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Progress chart' },
    ...ticks.map((v) =>
      svg(
        'g',
        {},
        svg('line', { class: 'portal-prog-grid', x1: left, x2: W - right, y1: y(v), y2: y(v) }),
        svg('text', { class: 'portal-prog-axis', x: left - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, format(v, true)),
      ),
    ),
    points.length > 1
      ? svg('path', {
          class: 'portal-prog-area',
          d: `M${coords.map(([cx, cy]) => `${cx.toFixed(1)},${cy.toFixed(1)}`).join(' L')} L${coords.at(-1)[0]},${bottom} L${coords[0][0]},${bottom} Z`,
        })
      : null,
    points.length > 1 ? svg('path', { class: 'portal-prog-line', d: `M${coords.map(([cx, cy]) => `${cx.toFixed(1)},${cy.toFixed(1)}`).join(' L')}` }) : null,
    ...coords.map(([cx, cy]) => svg('circle', { class: 'portal-prog-dot', cx, cy, r: 3 })),
    ...labelIdx.map((i) =>
      svg(
        'text',
        { class: 'portal-prog-axis', x: x(i), y: H - 6, 'text-anchor': points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' },
        shortDate(points[i].date),
      ),
    ),
    guide,
    marker,
  );

  // Pointer events cover mouse, pen and touch alike; the chart is the only
  // thing on the sheet that wants a horizontal drag.
  const pick = (event) => {
    const rect = chart.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < coords.length; i++) if (Math.abs(coords[i][0] - px) < Math.abs(coords[best][0] - px)) best = i;
    select(best);
  };
  chart.addEventListener('pointerdown', (event) => {
    chart.setPointerCapture?.(event.pointerId);
    pick(event);
  });
  chart.addEventListener('pointermove', (event) => {
    if (event.buttons || event.pointerType === 'mouse') pick(event);
  });

  select(points.length - 1);
  return chart;
}

/**
 * Hevy's exercise screen: Summary (a chart of any metric, the records and the
 * lifetime totals), History (every session's sets) and How to (the demo).
 * Opens from the logger card, the Add Exercise sheet and the records wall.
 */
function openExerciseDetail(exercise, { tab = 'summary' } = {}) {
  const name = exercise.exercise_name ?? exercise.name;
  const item = { ...exercise, name, exercise_name: name };
  let active = tab;
  let history = null;
  let failed = null;
  let metric = PROGRESS_METRICS[0].key;
  let range = 'all';

  const body = h('div', { class: 'portal-exd' });
  const panel = h('div', { class: 'portal-exd-panel' });
  const tabs = h('div', { class: 'portal-exd-tabs', role: 'tablist' });

  const weightOf = (kg, axis) => (axis ? `${Math.round(toDisplayWeight(kg))}` : weightLabel(Math.round(kg * 10) / 10));
  const setText = (set) => `${weightLabel(set.weight_kg)} × ${set.reps}`;

  function paintTabs() {
    clear(tabs).append(
      ...[
        ['summary', 'Summary'],
        ['history', 'History'],
        ['howto', 'How to'],
      ].map(([key, label]) =>
        h(
          'button',
          {
            class: `portal-exd-tab${active === key ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            'aria-selected': String(active === key),
            onclick: () => {
              active = key;
              paint();
            },
          },
          label,
        ),
      ),
    );
  }

  function emptyHistory() {
    return h(
      'div',
      { class: 'portal-exd-empty' },
      h('span', { class: 'portal-exd-empty-icon' }, renderIcon('trendUp', { size: 24 })),
      h('strong', {}, 'No history yet'),
      h('span', {}, `Log ${name} in a workout and your progress shows up here.`),
    );
  }

  function summaryPanel() {
    const records = history.records;
    const def = PROGRESS_METRICS.find((m) => m.key === metric);
    const cutoff = PROGRESS_RANGES.find((r) => r.key === range).days;
    const since = cutoff ? addDays(today(), -cutoff) : null;
    const points = [...history.sessions]
      .reverse()
      .filter((s) => !since || s.log_date >= since)
      .map((s) => ({ date: s.log_date, value: def.read(s) }))
      .filter((p) => p.value > 0);

    const format = (v, axis) => (def.weight ? weightOf(v, axis) : String(Math.round(v)));
    const valueNode = h('div', { class: 'portal-exd-value' });
    const dateNode = h('div', { class: 'portal-exd-date' });
    const changeNode = h('div', { class: 'portal-exd-change' });

    const chartCard = h(
      'div',
      { class: 'portal-exd-card' },
      h('div', { class: 'portal-exd-readout' }, h('div', {}, valueNode, dateNode), changeNode),
    );
    if (points.length) {
      const first = points[0].value;
      chartCard.append(
        progressChart(points, {
          format,
          onSelect: (index) => {
            const point = points[index];
            valueNode.textContent = format(point.value);
            dateNode.textContent = longDate(point.date);
            const delta = point.value - first;
            clear(changeNode);
            if (index > 0 && Math.abs(delta) >= 0.05) {
              changeNode.className = `portal-exd-change ${delta > 0 ? 'up' : 'down'}`;
              changeNode.append(
                renderIcon(delta > 0 ? 'trendUp' : 'trendDown', { size: 14 }),
                `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`,
              );
            }
          },
        }),
      );
    } else {
      valueNode.textContent = '—';
      dateNode.textContent = 'Nothing logged in this period';
    }
    chartCard.append(
      h(
        'div',
        { class: 'portal-exd-ranges' },
        ...PROGRESS_RANGES.map((r) =>
          h(
            'button',
            {
              class: `portal-exd-range${r.key === range ? ' active' : ''}`,
              type: 'button',
              onclick: () => {
                range = r.key;
                paint();
              },
            },
            r.label,
          ),
        ),
      ),
    );

    const metricChips = h(
      'div',
      { class: 'portal-exd-metrics' },
      ...PROGRESS_METRICS.map((m) =>
        h(
          'button',
          {
            class: `portal-pick-chip${m.key === metric ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              metric = m.key;
              paint();
            },
          },
          m.label,
        ),
      ),
    );

    const recordRow = (icon, label, value, sub) =>
      h(
        'div',
        { class: 'portal-exd-record' },
        h('span', { class: 'portal-exd-record-icon' }, renderIcon(icon, { size: 17 })),
        h('span', { class: 'portal-exd-record-label' }, label),
        h('span', { class: 'portal-exd-record-value' }, value, sub ? h('small', {}, sub) : null),
      );

    return h(
      'div',
      { class: 'portal-exd-summary' },
      metricChips,
      chartCard,
      h('h3', { class: 'portal-exd-heading' }, renderIcon('trophy', { size: 17 }), 'Personal Records'),
      h(
        'div',
        { class: 'portal-exd-card is-list' },
        recordRow('weight', 'Heaviest Weight', weightLabel(records.heaviest_weight_kg)),
        recordRow('target', 'Best 1RM (est.)', weightLabel(records.best_1rm_kg)),
        records.best_set
          ? recordRow('crown', 'Best Set', setText(records.best_set), `${weightLabel(records.best_set.volume_kg)} · ${shortDate(records.best_set.log_date)}`)
          : null,
        recordRow('barChart', 'Best Session Volume', weightLabel(records.best_session_volume_kg)),
        recordRow('refresh', 'Most Reps', String(records.most_reps)),
      ),
      h('h3', { class: 'portal-exd-heading' }, renderIcon('activity', { size: 17 }), 'Lifetime'),
      h(
        'div',
        { class: 'portal-exd-totals' },
        ...[
          [String(records.total_sessions), records.total_sessions === 1 ? 'Workout' : 'Workouts'],
          [String(records.total_sets), 'Sets'],
          [String(records.total_reps), 'Reps'],
          [weightLabel(records.total_volume_kg), 'Volume'],
        ].map(([value, label]) => h('div', {}, h('strong', {}, value), h('span', {}, label))),
      ),
      records.first_logged_on
        ? h('p', { class: 'portal-exd-foot' }, `First logged ${longDate(records.first_logged_on)} · last ${longDate(records.last_logged_on)}`)
        : null,
    );
  }

  function historyPanel() {
    return h(
      'div',
      { class: 'portal-exd-history' },
      ...history.sessions.map((session) => {
        let working = 0;
        return h(
          'div',
          { class: 'portal-exd-card portal-exd-session' },
          h(
            'div',
            { class: 'portal-exd-session-head' },
            h('div', {}, h('strong', {}, session.workout_name), h('span', {}, longDate(session.log_date))),
            session.has_pr ? h('span', { class: 'portal-exd-pr' }, renderIcon('trophy', { size: 13 }), 'PR') : null,
          ),
          h('div', { class: 'portal-exd-set is-head' }, h('span', {}, 'Set'), h('span', {}, 'Weight & reps'), h('span', {}, '1RM')),
          ...session.sets.map((set) => {
            if (set.set_type !== 'warmup') working += 1;
            const type = SET_TYPES.find((t) => t.key === set.set_type);
            return h(
              'div',
              { class: `portal-exd-set${set.is_pr ? ' is-pr' : ''}` },
              h('span', { class: `portal-set-type t-${set.set_type}` }, set.set_type === 'normal' ? String(working) : (type?.short ?? '')),
              h('span', {}, setText(set), set.is_pr ? renderIcon('trophy', { size: 13 }) : null),
              h('span', { class: 'muted' }, set.set_type === 'warmup' ? '—' : weightLabel(set.est_1rm_kg)),
            );
          }),
          h('div', { class: 'portal-exd-session-foot' }, `Volume ${weightLabel(session.volume_kg)} · ${session.total_reps} reps`),
        );
      }),
    );
  }

  function paint() {
    paintTabs();
    clear(panel);
    if (active === 'summary' && summaryDemo) panel.append(summaryDemo);
    if (active === 'howto') {
      panel.append(exerciseDemoBody(item));
      return;
    }
    if (failed) {
      panel.append(h('div', { class: 'portal-empty' }, failed));
      return;
    }
    if (!history) {
      panel.append(h('div', { class: 'portal-loading' }, 'Loading…'));
      return;
    }
    if (!history.sessions.length) {
      panel.append(emptyHistory());
      return;
    }
    panel.append(active === 'summary' ? summaryPanel() : historyPanel());
  }

  // Built once and moved between paints, so tapping a metric or a range
  // doesn't restart the clip.
  const summaryDemo = demoStage(item);

  const subtitle = [item.muscle_group, item.equipment].filter(Boolean).map(titleCase).join(' · ');
  body.append(
    h(
      'div',
      { class: 'portal-exd-hero' },
      summaryDemo ? null : pickerThumb(item),
      h('div', { class: 'portal-pick-text' }, h('span', { class: 'portal-pick-sub' }, subtitle), h('span', { class: 'portal-exd-hint' }, 'Tap the chart to see any session')),
    ),
    tabs,
    panel,
  );
  paint();
  openModal({ title: name, className: 'portal-pick-modal portal-exd-modal', body });

  api.portal
    .exerciseHistory(name)
    .then((res) => {
      history = res;
      paint();
    })
    .catch((err) => {
      failed = err.message || 'Could not load this exercise’s history';
      paint();
    });
}

/* ── Rest timer ────────────────────────────────────────────────────────── */

/**
 * The floating countdown between sets.
 *
 * One instance per active session rather than one per set: only one rest can be
 * running at a time, and a per-set timer would leave stray intervals behind
 * every time the set table repainted. stop() is called from the session's own
 * teardown so leaving the tab mid-rest cannot leave an interval running.
 */
function restTimer() {
  const label = h('div', { class: 'portal-rest-time' }, '0:00');
  const bar = h('i');
  const node = h(
    'div',
    { class: 'portal-rest-timer hidden' },
    h('div', { class: 'portal-rest-icon' }, renderIcon('timer', { size: 16 })),
    h(
      'div',
      { class: 'portal-rest-body' },
      h('div', { class: 'portal-rest-label' }, 'Rest'),
      label,
      h('div', { class: 'portal-rest-bar' }, bar),
    ),
    h(
      'div',
      { class: 'portal-rest-actions' },
      h('button', { class: 'portal-rest-btn', type: 'button', title: 'Add 30 seconds', onclick: () => extend(30) }, '+30'),
      h('button', { class: 'portal-rest-btn', type: 'button', title: 'Skip rest', onclick: () => stop() }, renderIcon('close', { size: 14 })),
    ),
  );

  let interval = null;
  let endsAt = 0;
  let total = 0;
  // Runs every 250ms, so a plain "remaining === 3" check would fire the tick
  // sound up to four times for the same second — this remembers the last
  // second it already sounded for.
  let lastTickSecond = null;

  function tick() {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    label.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    bar.style.width = `${total ? (remaining / total) * 100 : 0}%`;
    node.classList.toggle('urgent', remaining <= 10 && remaining > 0);

    if (remaining !== lastTickSecond) {
      lastTickSecond = remaining;
      if (remaining === 3 || remaining === 2 || remaining === 1) {
        sound.playRestTick();
        node.classList.add('tick');
        setTimeout(() => node.classList.remove('tick'), 220);
      }
    }

    if (remaining <= 0) {
      clearInterval(interval);
      interval = null;
      node.classList.add('done');
      sound.playRestEnd();
      setTimeout(() => stop(), 2500);
    }
  }

  function start(seconds) {
    if (!seconds) return;
    clearInterval(interval);
    total = seconds;
    endsAt = Date.now() + seconds * 1000;
    lastTickSecond = null;
    node.classList.remove('hidden', 'done');
    sound.playRestStart();
    tick();
    // Wall-clock driven, not a decrementing counter: a phone that sleeps
    // mid-rest must come back showing the real remaining time.
    interval = setInterval(tick, 250);
  }

  function extend(seconds) {
    if (!interval) return start(seconds);
    endsAt += seconds * 1000;
    total += seconds;
    return tick();
  }

  function stop() {
    clearInterval(interval);
    interval = null;
    node.classList.add('hidden');
    node.classList.remove('done', 'urgent');
  }

  return { node, start, stop };
}

/* ── Active workout session ────────────────────────────────────────────── */

const SESSION_KEY = 'gymbook.portal.activeWorkout';

/** A session in progress, kept on the device.
 *
 * The server only ever sees a finished workout (see the POST in
 * routes/portal.js), so a closed tab or a dropped connection mid-session would
 * otherwise lose an hour of logging. Restoring it is what makes leaving the tab
 * to check a plan safe. */
const activeSession = {
  read() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(state) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch {
      // Storage blocked: the session lives in memory for as long as the tab does.
    }
  },
  clear() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to clear.
    }
  },
};


/* ── Macro rings ───────────────────────────────────────────────────────── */

/** The hero calorie ring: eaten against target, with what is left in the
 * middle — the one number a member opens the Diet tab to read. */
function calorieRing(eaten, target, { size = 168, stroke = 13, compact = false, icon = null } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = target > 0 ? Math.min(eaten / target, 1) : 0;
  const remaining = Math.max(0, Math.round(target - eaten));
  const over = eaten > target;

  return h(
    'div',
    { class: `portal-cal-ring${compact ? ' sm' : ''}` },
    svg(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
      svg('circle', { class: 'portal-cal-track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, fill: 'none' }),
      svg('circle', {
        class: `portal-cal-fill${over ? ' over' : ''}`,
        cx: size / 2,
        cy: size / 2,
        r,
        'stroke-width': stroke,
        fill: 'none',
        'stroke-linecap': 'round',
        'stroke-dasharray': c.toFixed(2),
        'stroke-dashoffset': (c * (1 - pct)).toFixed(2),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
    h(
      'div',
      { class: 'portal-cal-center' },
      icon ? portalIcon(icon, 'portal-cal-icon') : null,
      h('strong', {}, String(over ? Math.round(eaten - target) : remaining)),
      h('span', {}, over ? 'kcal over' : 'kcal left'),
      h('small', {}, `${Math.round(eaten)} of ${target}`),
    ),
  );
}

function macroBar(label, eaten, target, tone, icon = null) {
  const pct = target > 0 ? Math.min((eaten / target) * 100, 100) : 0;
  const body = h(
    'div',
    { class: 'portal-macro-body' },
    h(
      'div',
      { class: 'portal-macro-top' },
      h('span', { class: 'portal-macro-label' }, label),
      h('span', { class: 'portal-macro-value' }, `${Math.round(eaten)} / ${target}g`),
    ),
    h('div', { class: `portal-macro-bar ${tone}` }, h('i', { style: `width:${pct}%` })),
  );
  return h('div', { class: `portal-macro${icon ? ' has-icon' : ''}` }, icon ? portalIcon(icon, 'portal-macro-icon') : null, body);
}

/* ── Quick track sheet ─────────────────────────────────────────────────── */

/** "150 g" for 1.5 × a per-100 g food — how scanned packs are logged — and
 * "2 × 1 egg (50g)" for anything counted in servings. */
function portionLabel(entry) {
  const per100 = /^100\s?(g|ml)$/i.exec(entry.serving_unit || '');
  if (per100) return `${Math.round(entry.quantity * 100)} ${per100[1].toLowerCase()}`;
  return `${entry.quantity === 1 ? '' : `${entry.quantity} × `}${entry.serving_unit}`;
}

/** The meal a new entry most likely belongs to, by the clock — what Quick
 * track opens on. One tap on the meal row changes it. */
function mealForNow(now = new Date()) {
  const hour = now.getHours();
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 18) return 'snack';
  return 'dinner';
}

const round1 = (n) => Math.round(n * 10) / 10;

/** A library food's figures for `q` × its serving_unit — the same arithmetic
 * the entries POST does, for the live preview. */
const scaleFood = (food, q) => ({
  calories: Math.round(food.calories * q),
  protein_g: round1(food.protein_g * q),
  carbs_g: round1(food.carbs_g * q),
  fats_g: round1(food.fats_g * q),
  fiber_g: round1((food.fiber_g || 0) * q),
  sugar_g: round1((food.sugar_g || 0) * q),
});

const macrosOf = (row) => ({
  calories: row.calories || 0,
  protein_g: row.protein_g || 0,
  carbs_g: row.carbs_g || 0,
  fats_g: row.fats_g || 0,
  fiber_g: row.fiber_g || 0,
  sugar_g: row.sugar_g || 0,
});

/**
 * How an amount can be entered for `food`, each turned into a multiple of its
 * serving_unit (what the server scales by). A per-100 g food — every scanned
 * pack, and much of the library — is entered in grams, or in the pack's own
 * servings when the label gives one; anything else in servings.
 */
function unitsFor(food) {
  const per100 = /^100\s?(g|ml)$/i.exec(food.serving_unit || '');
  if (!per100) {
    return [{ key: 'serving', label: 'Servings', hint: `× ${food.serving_unit}`, start: 1, step: 0.25, nudge: 0.5, toQty: (n) => n }];
  }
  const measure = per100[1].toLowerCase();
  const units = [];
  if (food.serving_size_g) {
    units.push({
      key: 'pack',
      label: 'Servings',
      hint: `× ${food.serving_label || `${food.serving_size_g} ${measure}`}`,
      start: 1,
      step: 0.5,
      nudge: 0.5,
      toQty: (n) => (n * food.serving_size_g) / 100,
    });
  }
  units.push({
    key: 'amount',
    label: measure === 'ml' ? 'Millilitres' : 'Grams',
    hint: measure,
    start: 100,
    step: 5,
    nudge: 10,
    toQty: (n) => n / 100,
  });
  return units;
}

const QUICK_TRACK_TABS = [
  { key: 'recent', label: 'Recent' },
  { key: 'favorites', label: 'Favourites' },
  { key: 'all', label: 'All foods' },
];

/**
 * Quick track: the one sheet every food goes in through — recents and
 * favourites for one-tap logging, the library, a barcode, or numbers typed
 * off a packet. Opened from the Diet tab's floating button, on the meal the
 * clock suggests.
 *
 * The sheet stays open after each add, so a whole plate goes in one visit;
 * the Diet tab repaints once, when it closes. Serving arithmetic is previewed
 * live but recomputed on the server (see the entries POST) — the preview is a
 * courtesy, not the source of truth.
 */
function openFoodSearch({ logDate, onAdded, mealType = mealForNow(), startOn = 'list' }) {
  let foods = [];
  let recent = [];
  let favorites = [];
  let loaded = false;
  let meal = MEAL_SLOTS.find((slot) => slot.key === mealType) ?? MEAL_SLOTS[0];
  let tab = 'recent';
  let query = '';
  /** Where the detail view's back arrow goes: the list or the scanner. */
  let detailFrom = 'list';
  /** Repaints the open detail view's button when the meal changes. */
  let onMealChange = null;
  /** What this visit logged, newest last, so it can be reviewed and taken
   * back out before Done. `changed` stays set once anything was logged, so
   * the Diet tab repaints even if every item was removed again. */
  const tracked = { items: [], changed: false, open: false };
  const trackedTotal = (key) => Math.round(tracked.items.reduce((sum, item) => sum + item[key], 0) * 10) / 10;

  /* ── Favourites ── */

  const keyOf = (food) => (food.id ? `lib:${food.id}` : `name:${food.name.toLowerCase()}`);
  const favoriteFor = (food) =>
    food.id
      ? favorites.find((f) => f.food_id === food.id)
      : favorites.find((f) => !f.food_id && f.food_name.toLowerCase() === food.name.toLowerCase());
  const favButtons = new Map();

  /** Every heart on screen for `food` follows its state, list and detail alike. */
  function paintHearts() {
    for (const [button, food] of favButtons) {
      if (!button.isConnected) {
        favButtons.delete(button);
        continue;
      }
      const on = Boolean(favoriteFor(food));
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', on ? `Remove ${food.name} from favourites` : `Add ${food.name} to favourites`);
    }
  }

  function heartButton(food, className = 'qt-fav') {
    const button = h(
      'button',
      { class: className, type: 'button', onclick: () => toggleFavorite(food) },
      renderIcon('heart', { size: 19, stroke: 2 }),
    );
    favButtons.set(button, food);
    const on = Boolean(favoriteFor(food));
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? `Remove ${food.name} from favourites` : `Add ${food.name} to favourites`);
    return button;
  }

  async function toggleFavorite(food) {
    const existing = favoriteFor(food);
    if (existing) {
      favorites = favorites.filter((f) => f !== existing);
      paintHearts();
      if (tab === 'favorites') paintList();
      try {
        await api.portal.removeFavoriteFood(existing.favorite_id);
      } catch (err) {
        favorites = [existing, ...favorites];
        paintHearts();
        if (tab === 'favorites') paintList();
        toast(err.message || 'Could not update your favourites', 'error');
      }
      return;
    }
    try {
      const saved = await api.portal.addFavoriteFood(
        food.id
          ? { food_id: food.id }
          : { food_name: food.name, serving_unit: food.serving_unit, ...macrosOf(food) },
      );
      favorites = [saved, ...favorites.filter((f) => f.favorite_id !== saved.favorite_id)];
      paintHearts();
      if (tab === 'favorites') paintList();
      toast(`${food.name} saved to favourites`);
    } catch (err) {
      toast(err.message || 'Could not update your favourites', 'error');
    }
  }

  /* ── Rows: every list item is a food to open, plus a one-tap add ── */

  const snapshotFood = (row) => ({
    id: null,
    name: row.food_name,
    serving_unit: portionLabel({ quantity: row.quantity ?? 1, serving_unit: row.serving_unit }),
    ...macrosOf(row),
  });
  const libraryByName = (name) => foods.find((f) => f.name.toLowerCase() === name.toLowerCase());

  /** A library food at its first unit's starting amount — what opening it
   * and pressing Add would log. */
  function libraryItem(food) {
    const [unit] = unitsFor(food);
    const q = unit.toQty(unit.start);
    const scaled = scaleFood(food, q);
    return {
      food,
      name: food.name,
      // "1 dosa (180g)" reads better than "180 g" when the food names its portion.
      meta: [food.brand, unit.key === 'pack' && food.serving_label ? food.serving_label : portionLabel({ quantity: q, serving_unit: food.serving_unit })]
        .filter(Boolean)
        .join(' · '),
      kcal: scaled.calories,
      payload: { food_id: food.id, quantity: Math.round(q * 1000) / 1000 },
      scaled,
    };
  }

  /** A recent entry, re-logged exactly as it was last time. Hand-typed ones
   * (and entries from before food_id was stored) re-send their own figures. */
  function recentItem(row) {
    if (row.food) {
      const scaled = scaleFood(row.food, row.quantity);
      return {
        food: row.food,
        name: row.food.name,
        meta: portionLabel({ quantity: row.quantity, serving_unit: row.food.serving_unit }),
        kcal: scaled.calories,
        payload: { food_id: row.food.id, quantity: row.quantity },
        scaled,
      };
    }
    const scaled = macrosOf(row);
    return {
      food: libraryByName(row.food_name) ?? snapshotFood(row),
      name: row.food_name,
      meta: portionLabel(row),
      kcal: scaled.calories,
      payload: { food_name: row.food_name, serving_unit: row.serving_unit, quantity: row.quantity, ...scaled },
      scaled,
    };
  }

  function favoriteItem(fav) {
    if (fav.food) return libraryItem(fav.food);
    const scaled = macrosOf(fav);
    return {
      food: snapshotFood({ ...fav, quantity: 1 }),
      name: fav.food_name,
      meta: portionLabel({ quantity: 1, serving_unit: fav.serving_unit }),
      kcal: scaled.calories,
      payload: { food_name: fav.food_name, serving_unit: fav.serving_unit, quantity: 1, ...scaled },
      scaled,
    };
  }

  /** Logs one entry to the chosen meal and keeps the sheet open. */
  async function track(food, payload, scaled) {
    const entry = await api.portal.addFoodEntry({ meal_type: meal.key, log_date: logDate, ...payload });
    sound.playFoodLogged();
    tracked.changed = true;
    tracked.items.push({
      id: entry.id,
      name: food.name,
      meal: meal.label,
      portion: portionLabel(entry),
      calories: scaled.calories,
      protein_g: scaled.protein_g,
    });
    // Newest first in Recent, without a refetch.
    const row = payload.food_id
      ? { food_id: food.id, food_name: food.name, quantity: payload.quantity, serving_unit: food.serving_unit, ...scaled, food }
      : { food_id: null, food_name: payload.food_name, quantity: payload.quantity, serving_unit: payload.serving_unit, ...scaled, food: null };
    recent = [row, ...recent.filter((r) => r.food_name.toLowerCase() !== row.food_name.toLowerCase())];
    paintTrackedBar();
  }

  async function quickAdd(item, button) {
    button.disabled = true;
    try {
      await track(item.food, item.payload, item.scaled);
      // A tick in place of the plus, rather than a repaint that would
      // reorder the list under the member's thumb.
      button.classList.add('done');
      clear(button).append(renderIcon('check', { size: 18, stroke: 2.6 }));
      setTimeout(() => {
        if (!button.isConnected) return;
        button.classList.remove('done');
        clear(button).append(renderIcon('plus', { size: 18, stroke: 2.4 }));
        button.disabled = false;
      }, 1400);
    } catch (err) {
      toast(err.message || 'Could not log that', 'error');
      button.disabled = false;
    }
  }

  function row(item) {
    return h(
      'div',
      { class: 'qt-row' },
      h(
        'button',
        { class: 'qt-row-main', type: 'button', onclick: () => openDetail(item.food, 'list') },
        h(
          'span',
          { class: 'qt-row-text' },
          h('span', { class: 'qt-row-name' }, h('span', {}, item.name), item.food.verified ? verifiedTick({ size: 15 }) : null),
          h('span', { class: 'qt-row-meta' }, item.meta),
        ),
        h('span', { class: 'qt-row-kcal' }, String(item.kcal), h('small', {}, 'kcal')),
      ),
      heartButton(item.food),
      h(
        'button',
        {
          class: 'qt-add',
          type: 'button',
          'aria-label': `Add ${item.name}`,
          onclick: (event) => quickAdd(item, event.currentTarget),
        },
        renderIcon('plus', { size: 18, stroke: 2.4 }),
      ),
    );
  }

  /* ── Header: meal picker ── */

  const mealRow = h('div', { class: 'qt-meals', role: 'radiogroup', 'aria-label': 'Meal' });
  function paintMeals() {
    clear(mealRow).append(
      ...MEAL_SLOTS.map((slot) =>
        h(
          'button',
          {
            class: `qt-meal${slot.key === meal.key ? ' active' : ''}`,
            type: 'button',
            role: 'radio',
            'aria-checked': String(slot.key === meal.key),
            onclick: () => {
              meal = slot;
              paintMeals();
              onMealChange?.();
            },
          },
          renderIcon(slot.icon, { size: 15, stroke: 2 }),
          slot.label,
        ),
      ),
    );
  }
  paintMeals();

  /* ── List view ── */

  const searchInput = h('input', {
    class: 'qt-search-input',
    type: 'search',
    placeholder: 'Search foods',
    autocomplete: 'off',
    enterkeyhint: 'search',
    'aria-label': 'Search foods',
  });
  const clearSearch = h(
    'button',
    { class: 'qt-search-clear hidden', type: 'button', 'aria-label': 'Clear search' },
    renderIcon('close', { size: 14, stroke: 2.4 }),
  );
  const searchBox = h(
    'div',
    { class: 'qt-search' },
    renderIcon('search', { size: 18 }),
    searchInput,
    clearSearch,
    h(
      'button',
      { class: 'qt-search-scan', type: 'button', 'aria-label': 'Scan a barcode', title: 'Scan a barcode', onclick: () => show('scan') },
      renderIcon('scan', { size: 19 }),
    ),
  );

  const tabRow = h('div', { class: 'qt-tabs', role: 'tablist' });
  function paintTabs() {
    clear(tabRow).append(
      ...QUICK_TRACK_TABS.map((t) =>
        h(
          'button',
          {
            class: `qt-tab${t.key === tab ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            'aria-selected': String(t.key === tab),
            onclick: () => {
              tab = t.key;
              paintList();
              listBody.scrollTop = 0;
            },
          },
          t.label,
          t.key === 'favorites' && favorites.length ? h('span', { class: 'qt-tab-count' }, String(favorites.length)) : null,
        ),
      ),
    );
  }

  const listBody = h('div', { class: 'qt-list' });
  const section = (label) => h('div', { class: 'qt-section' }, label);
  const emptyState = (icon, title, text) =>
    h(
      'div',
      { class: 'qt-empty' },
      h('span', { class: 'qt-empty-ico' }, renderIcon(icon, { size: 24, stroke: 1.8 })),
      h('strong', {}, title),
      h('p', {}, text),
    );
  const listFooter = () =>
    h(
      'div',
      { class: 'qt-list-foot' },
      h('span', {}, query.trim() ? `Can't find “${query.trim()}”?` : 'Not in the list?'),
      h(
        'div',
        { class: 'qt-list-foot-actions' },
        h('button', { class: 'qt-chip-btn', type: 'button', onclick: () => show('custom') }, renderIcon('edit', { size: 15 }), 'Custom food'),
        h('button', { class: 'qt-chip-btn', type: 'button', onclick: () => show('scan') }, renderIcon('scan', { size: 15 }), 'Scan barcode'),
      ),
    );
  const prettyCategory = (c) => (c || 'Other').replace(/[_-]+/g, ' ').replace(/^./, (ch) => ch.toUpperCase());

  function paintList() {
    const needle = query.trim().toLowerCase();
    tabRow.classList.toggle('hidden', Boolean(needle));
    paintTabs();
    clear(listBody);

    if (!loaded) {
      listBody.append(...Array.from({ length: 6 }, () => h('div', { class: 'qt-skel' }, h('i'), h('i'))));
      return;
    }

    if (needle) {
      // Their own foods first — a search for "shake" should find the cafe
      // shake they log daily before the library's generic one.
      const seen = new Set();
      const mine = [...favorites.map(favoriteItem), ...recent.map(recentItem)].filter((item) => {
        const key = keyOf(item.food);
        if (seen.has(key) || !item.name.toLowerCase().includes(needle)) return false;
        seen.add(key);
        return true;
      });
      const library = foods
        .filter((f) => f.name.toLowerCase().includes(needle) && !seen.has(keyOf(f)))
        .slice(0, 80)
        .map(libraryItem);
      if (mine.length) listBody.append(section('Your foods'), ...mine.map(row));
      if (library.length) listBody.append(section('Food library'), ...library.map(row));
      if (!mine.length && !library.length) {
        listBody.append(emptyState('search', 'No matches', 'Check the spelling, scan the pack, or add it as a custom food.'));
      }
    } else if (tab === 'recent') {
      if (recent.length) listBody.append(section('Recently tracked'), ...recent.map(recentItem).map(row));
      else listBody.append(emptyState('history', 'Nothing tracked yet', 'Foods you log show up here, ready to add again in one tap.'));
    } else if (tab === 'favorites') {
      if (favorites.length) listBody.append(...favorites.map(favoriteItem).map(row));
      else listBody.append(emptyState('heart', 'No favourites yet', 'Tap the heart on any food to keep it here for quick tracking.'));
    } else {
      let category = null;
      for (const food of foods.slice(0, 200)) {
        if (food.category !== category) {
          category = food.category;
          listBody.append(section(prettyCategory(category)));
        }
        listBody.append(row(libraryItem(food)));
      }
      if (!foods.length) listBody.append(emptyState('apple', 'The food library is empty', 'Add what you ate as a custom food instead.'));
    }
    listBody.append(listFooter());
  }

  // The first 300 library foods come with the sheet; a search also asks the
  // server, so a gym whose library has grown past that still finds the rest.
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    clearSearch.classList.toggle('hidden', !query);
    paintList();
    listBody.scrollTop = 0;
    clearTimeout(searchTimer);
    const asked = query.trim();
    if (asked.length < 2) return;
    searchTimer = setTimeout(async () => {
      try {
        const res = await api.portal.foods({ q: asked });
        const known = new Set(foods.map((f) => f.id));
        const fresh = res.items.filter((f) => !known.has(f.id));
        if (!fresh.length) return;
        foods = [...foods, ...fresh];
        if (query.trim() === asked) paintList();
      } catch {
        // The local results already on screen stand.
      }
    }, 280);
  });
  clearSearch.addEventListener('click', () => {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });

  const listPane = h('div', { class: 'qt-pane qt-pane-list' }, searchBox, tabRow, listBody);

  /* ── Detail view ── */

  const detailPane = h('div', { class: 'qt-pane hidden' });

  function openDetail(food, from) {
    detailFrom = from;
    const units = unitsFor(food);
    let unit = units[0];
    let amount = unit.start;
    const qty = () => unit.toQty(amount);

    const kcalValue = h('strong', {});
    const macroCells = {
      protein_g: h('strong', {}),
      carbs_g: h('strong', {}),
      fats_g: h('strong', {}),
    };
    const splitBar = h('div', { class: 'qt-split', 'aria-hidden': 'true' });
    const extra = h('div', { class: 'qt-extra' });

    // Only the numbers repaint as the member types: rebuilding the input on
    // every keystroke would drop its focus between "1" and "1.5".
    const paintNumbers = () => {
      const scaled = scaleFood(food, qty() || 0);
      kcalValue.textContent = String(scaled.calories);
      macroCells.protein_g.textContent = `${scaled.protein_g} g`;
      macroCells.carbs_g.textContent = `${scaled.carbs_g} g`;
      macroCells.fats_g.textContent = `${scaled.fats_g} g`;
      extra.textContent = `Fibre ${scaled.fiber_g} g · Sugar ${scaled.sugar_g} g`;
      // Where the energy comes from, as a share of the calories in the macros.
      const energy = [scaled.protein_g * 4, scaled.carbs_g * 4, scaled.fats_g * 9];
      const total = energy.reduce((a, b) => a + b, 0) || 1;
      clear(splitBar).append(
        ...['protein', 'carbs', 'fats'].map((tone, i) => h('i', { class: tone, style: `flex-grow:${energy[i] / total}` })),
      );
    };

    const qtyInput = h('input', {
      class: 'qt-qty-input',
      type: 'number',
      inputmode: 'decimal',
      'aria-label': 'Amount',
      oninput: (event) => {
        amount = Number(event.target.value) || 0;
        paintNumbers();
      },
    });
    const qtyHint = h('span', { class: 'qt-qty-hint' });
    const nudge = (dir) => {
      const next = Math.round((amount + dir * unit.nudge) * 100) / 100;
      amount = Math.max(unit.step, next);
      qtyInput.value = String(amount);
      paintNumbers();
    };
    const unitRow = h('div', { class: 'qt-units' });
    const setUnit = (u) => {
      unit = u;
      amount = u.start;
      qtyInput.min = String(u.step);
      qtyInput.step = String(u.step);
      qtyInput.value = String(amount);
      qtyHint.textContent = u.hint;
      clear(unitRow).append(
        ...units.map((other) =>
          h(
            'button',
            { class: `qt-unit${other.key === u.key ? ' active' : ''}`, type: 'button', onclick: () => setUnit(other) },
            other.label,
          ),
        ),
      );
      paintNumbers();
    };

    const cta = h('button', { class: 'btn primary block qt-cta', type: 'button' });
    onMealChange = () => {
      clear(cta).append(renderIcon('plus', { size: 17, stroke: 2.4 }), `Add to ${meal.label}`);
    };
    onMealChange();
    cta.addEventListener('click', async () => {
      const q = qty();
      if (!(q >= 0.05)) {
        toast(unit.key === 'amount' ? `Enter at least 5 ${unit.hint}` : 'Enter how much you had', 'error');
        return;
      }
      const quantity = Math.round(q * 1000) / 1000;
      const scaled = scaleFood(food, quantity);
      const payload = food.id
        ? { food_id: food.id, quantity }
        : { food_name: food.name, serving_unit: food.serving_unit, quantity, ...scaled };
      cta.disabled = true;
      try {
        await track(food, payload, scaled);
        show('list');
      } catch (err) {
        toast(err.message || 'Could not log that', 'error');
        cta.disabled = false;
      }
    });

    const sourceNote = food.source === 'openfoodfacts'
      ? 'From Open Food Facts'
      : food.source === 'member'
        ? 'Added by a member from the label'
        : null;
    const sub = [food.brand, sourceNote].filter(Boolean).join(' · ');

    clear(detailPane).append(
      h(
        'div',
        { class: 'qt-subhead' },
        h(
          'button',
          { class: 'qt-back', type: 'button', 'aria-label': 'Back', onclick: () => show(detailFrom) },
          renderIcon('arrowLeft', { size: 19 }),
        ),
        h('span', { class: 'qt-subhead-title' }, 'Food details'),
        heartButton(food, 'qt-fav qt-fav-lg'),
      ),
      h(
        'div',
        { class: 'qt-detail-head' },
        h('h3', {}, food.name, food.verified ? verifiedTick({ size: 20 }) : null),
        food.verified ? h('p', { class: 'qt-verified-note' }, 'Verified nutrition info') : null,
        sub ? h('p', {}, food.source ? renderIcon('scan', { size: 12 }) : null, sub) : null,
      ),
      h(
        'div',
        { class: 'qt-hero' },
        h('div', { class: 'qt-kcal' }, kcalValue, h('span', {}, 'kcal')),
        splitBar,
        h(
          'div',
          { class: 'qt-macros' },
          ...[
            ['protein', 'Protein', macroCells.protein_g],
            ['carbs', 'Carbs', macroCells.carbs_g],
            ['fats', 'Fat', macroCells.fats_g],
          ].map(([tone, label, value]) => h('div', { class: `qt-macro ${tone}` }, h('span', {}, h('i'), label), value)),
        ),
        extra,
      ),
      h(
        'div',
        { class: 'qt-amount' },
        h('div', { class: 'qt-amount-label' }, 'Amount'),
        units.length > 1 ? unitRow : null,
        h(
          'div',
          { class: 'qt-stepper' },
          h('button', { class: 'qt-step', type: 'button', 'aria-label': 'Less', onclick: () => nudge(-1) }, renderIcon('minus', { size: 18, stroke: 2.4 })),
          h('div', { class: 'qt-qty' }, qtyInput, qtyHint),
          h('button', { class: 'qt-step', type: 'button', 'aria-label': 'More', onclick: () => nudge(1) }, renderIcon('plus', { size: 18, stroke: 2.4 })),
        ),
      ),
      cta,
    );
    setUnit(unit);
    show('detail');
  }

  /* ── Custom view ── */

  const customBody = h('div', {});
  const customPane = h(
    'div',
    { class: 'qt-pane hidden' },
    h(
      'div',
      { class: 'qt-subhead' },
      h('button', { class: 'qt-back', type: 'button', 'aria-label': 'Back', onclick: () => show('list') }, renderIcon('arrowLeft', { size: 19 })),
      h('span', { class: 'qt-subhead-title' }, 'Custom food'),
    ),
    h('p', { class: 'qt-pane-note' }, 'Type the numbers for what you actually ate — the whole portion, not per 100 g.'),
    customBody,
  );
  function paintCustom() {
    clear(customBody).append(
      buildForm(
        [
          { name: 'food_name', label: 'What did you eat?', required: true, full: true, placeholder: 'e.g. Cafe protein shake', value: query.trim() },
          { name: 'calories', label: 'Calories', type: 'number', required: true, min: 0 },
          { name: 'protein_g', label: 'Protein (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'carbs_g', label: 'Carbs (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'fats_g', label: 'Fats (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'fiber_g', label: 'Fibre (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'sugar_g', label: 'Sugar (g)', type: 'number', min: 0, step: '0.1' },
        ],
        {
          submitLabel: 'Track food',
          onSubmit: async (values) => {
            const scaled = {
              calories: Number(values.calories || 0),
              protein_g: Number(values.protein_g || 0),
              carbs_g: Number(values.carbs_g || 0),
              fats_g: Number(values.fats_g || 0),
              fiber_g: Number(values.fiber_g || 0),
              sugar_g: Number(values.sugar_g || 0),
            };
            const payload = { food_name: values.food_name, serving_unit: 'serving', quantity: 1, ...scaled };
            await track({ id: null, name: values.food_name }, payload, scaled);
            show('list');
          },
        },
      ),
    );
  }

  /* ── Scan view: camera or typed digits → the library food, or "add it" ── */

  const cameraIssue = cameraProblem();
  const scanVideo = h('video', { class: 'portal-scan-video', playsinline: '', muted: '', 'aria-label': 'Camera view' });
  const scanStage = h(
    'div',
    { class: 'portal-scan-stage' },
    scanVideo,
    h('div', { class: 'portal-scan-guide', 'aria-hidden': 'true' }, h('i')),
  );
  const scanStatus = h('div', { class: 'portal-scan-status', role: 'status' });
  const scanResult = h('div', {});
  const scanAgain = h('button', { class: 'btn block hidden', type: 'button' }, renderIcon('scan', { size: 16 }), 'Scan again');
  let stopCamera = null;
  let scanPane;

  function stopScan() {
    stopCamera?.();
    stopCamera = null;
    scanStage.classList.remove('live');
  }

  async function startScan() {
    if (cameraIssue || stopCamera) return;
    clear(scanResult);
    scanAgain.classList.add('hidden');
    scanStatus.textContent = 'Starting camera…';
    try {
      stopCamera = await startBarcodeScan(scanVideo, {
        onCode: (code) => {
          stopCamera = null;
          scanStage.classList.remove('live');
          lookupBarcode(code);
        },
      });
    } catch (err) {
      stopCamera = null;
      scanAgain.classList.remove('hidden');
      scanStatus.textContent = err?.name === 'NotAllowedError'
        ? 'Camera access was blocked — allow it in your browser settings, or type the digits below.'
        : err?.message || 'Could not start the camera — type the digits below instead.';
      return;
    }
    // The member may have left the scanner or closed the sheet while the
    // camera was starting; it must not keep running behind their back.
    if (scanPane.classList.contains('hidden') || !scanVideo.isConnected) {
      stopScan();
      return;
    }
    scanStage.classList.add('live');
    scanStatus.textContent = 'Hold the barcode level inside the frame';
  }
  scanAgain.addEventListener('click', startScan);

  /** A found food, opened ready to log. */
  function showFood(food) {
    if (!foods.some((f) => f.id === food.id)) foods = [food, ...foods];
    openDetail(food, 'scan');
  }

  async function lookupBarcode(code) {
    clear(scanResult);
    scanAgain.classList.add('hidden');
    scanStatus.textContent = `Looking up ${code}…`;
    try {
      const res = await api.portal.barcodeFood(code);
      scanStatus.textContent = '';
      if (res.found) {
        showFood(res.food);
        return;
      }
      scanResult.append(addProductForm(res));
      scanAgain.classList.toggle('hidden', Boolean(cameraIssue));
    } catch (err) {
      scanStatus.textContent = err.message || 'Could not look that up';
      scanAgain.classList.toggle('hidden', Boolean(cameraIssue));
    }
  }

  /** The label, typed in: saved to the gym's library so the next member with
   * the same pack finds it, then shown ready to log like any other food. */
  function addProductForm({ barcode, product }) {
    return h(
      'div',
      { class: 'portal-scan-missing' },
      h('strong', {}, product?.name ? `${product.name} has no nutrition info yet` : 'Not in the food database yet'),
      h(
        'p',
        { class: 'muted' },
        `Barcode ${barcode}. Copy the nutrition panel from the pack (the per 100 g / 100 ml column) and it is saved for everyone at your gym.`,
      ),
      buildForm(
        [
          { name: 'name', label: 'Product name', required: true, full: true, value: product?.name || '' },
          { name: 'brand', label: 'Brand', value: product?.brand || '' },
          {
            name: 'basis',
            label: 'Values per',
            type: 'select',
            options: [
              { value: '100g', label: '100 g' },
              { value: '100ml', label: '100 ml' },
            ],
          },
          { name: 'calories', label: 'Calories (kcal)', type: 'number', required: true, min: 0 },
          { name: 'protein_g', label: 'Protein (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'carbs_g', label: 'Carbs (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'fats_g', label: 'Fat (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'fiber_g', label: 'Fibre (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'sugar_g', label: 'Sugar (g)', type: 'number', min: 0, step: '0.1' },
          { name: 'serving_size_g', label: 'One serving (g or ml)', type: 'number', min: 0, hint: 'Optional — if the pack states one' },
        ],
        {
          submitLabel: 'Save product',
          onSubmit: async (values) => {
            const number = (key) => (values[key] === '' ? undefined : Number(values[key]));
            const food = await api.portal.addBarcodeFood({
              barcode,
              name: values.name,
              brand: values.brand || undefined,
              basis: values.basis,
              calories: number('calories'),
              protein_g: number('protein_g'),
              carbs_g: number('carbs_g'),
              fats_g: number('fats_g'),
              fiber_g: number('fiber_g'),
              sugar_g: number('sugar_g'),
              serving_size_g: number('serving_size_g') || undefined,
            });
            toast('Saved — thanks for adding it');
            showFood(food);
          },
        },
      ),
    );
  }

  const digits = h('input', {
    class: 'portal-input',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: 'Or type the barcode digits',
    maxlength: 18,
  });
  const lookupTyped = () => {
    const code = digits.value.replace(/\D/g, '');
    if (code.length < 8) {
      toast('A barcode has 8 to 14 digits', 'error');
      return;
    }
    stopScan();
    lookupBarcode(code);
  };
  digits.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') lookupTyped();
  });

  scanPane = h(
    'div',
    { class: 'qt-pane portal-scan-pane hidden' },
    h(
      'div',
      { class: 'qt-subhead' },
      h('button', { class: 'qt-back', type: 'button', 'aria-label': 'Back', onclick: () => show('list') }, renderIcon('arrowLeft', { size: 19 })),
      h('span', { class: 'qt-subhead-title' }, 'Scan barcode'),
    ),
    cameraIssue ? h('div', { class: 'portal-scan-status' }, cameraIssue) : scanStage,
    cameraIssue ? null : scanStatus,
    scanAgain,
    h(
      'div',
      { class: 'portal-scan-manual' },
      digits,
      h('button', { class: 'btn', type: 'button', onclick: lookupTyped }, 'Look up'),
    ),
    cameraIssue ? scanStatus : null,
    scanResult,
  );

  /* ── Views, and the running tally ── */

  const panes = { list: listPane, detail: detailPane, scan: scanPane, custom: customPane };
  let currentView = 'list';
  function show(view) {
    currentView = view;
    for (const [key, pane] of Object.entries(panes)) pane.classList.toggle('hidden', key !== view);
    paintTrackedBar();
    if (view !== 'detail') onMealChange = null;
    if (view === 'list') paintList();
    if (view === 'custom') paintCustom();
    if (view === 'scan') {
      clear(scanResult);
      digits.value = '';
      startScan();
    } else {
      stopScan();
    }
    sheet.closest('.modal-backdrop')?.scrollTo?.({ top: 0 });
  }

  const trackedBar = h('div', { class: 'qt-tracked hidden', role: 'status' });
  /** Takes one of this visit's entries back out of the log. */
  async function untrack(item, button) {
    button.disabled = true;
    try {
      await api.portal.deleteFoodEntry(item.id);
      tracked.items = tracked.items.filter((other) => other !== item);
      sound.playFoodRemoved();
      if (!tracked.items.length) tracked.open = false;
      paintTrackedBar();
    } catch (err) {
      toast(err.message || 'Could not remove that', 'error');
      button.disabled = false;
    }
  }

  /** The tally and its Done button, on the list only — the other views have
   * their own button in the same spot. Tapping the tally opens what this
   * visit added, each with a remove button. */
  function paintTrackedBar() {
    const { items } = tracked;
    trackedBar.classList.toggle('hidden', !items.length || currentView !== 'list');
    trackedBar.classList.toggle('open', tracked.open);
    if (!items.length) return;
    const last = items[items.length - 1];
    const count = `${items.length} ${items.length === 1 ? 'item' : 'items'} · ${trackedTotal('calories')} kcal`;

    clear(trackedBar).append(
      ...(tracked.open
        ? [
            h(
              'div',
              { class: 'qt-tracked-list' },
              h('div', { class: 'qt-tracked-head' }, 'Added this visit'),
              ...[...items].reverse().map((item) => {
                const remove = h(
                  'button',
                  {
                    class: 'qt-tracked-remove',
                    type: 'button',
                    'aria-label': `Remove ${item.name} from ${item.meal}`,
                    title: 'Remove',
                    onclick: (event) => untrack(item, event.currentTarget),
                  },
                  renderIcon('trash', { size: 16 }),
                );
                return h(
                  'div',
                  { class: 'qt-tracked-row' },
                  h(
                    'span',
                    { class: 'qt-tracked-row-text' },
                    h('strong', {}, item.name),
                    h('small', {}, `${item.meal} · ${item.portion} · ${item.calories} kcal`),
                  ),
                  remove,
                );
              }),
            ),
          ]
        : []),
      h(
        'div',
        { class: 'qt-tracked-main' },
        h(
          'button',
          {
            class: 'qt-tracked-toggle',
            type: 'button',
            'aria-expanded': String(tracked.open),
            onclick: () => {
              tracked.open = !tracked.open;
              paintTrackedBar();
            },
          },
          h('span', { class: 'qt-tracked-ico' }, renderIcon('check', { size: 15, stroke: 2.8 })),
          h(
            'span',
            { class: 'qt-tracked-text' },
            h('strong', {}, tracked.open ? 'Review or remove' : `${last.name} added to ${last.meal}`),
            h('small', {}, count),
          ),
          renderIcon(tracked.open ? 'chevronDown' : 'chevronUp', { size: 18 }),
        ),
        h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'Done'),
      ),
    );
  }

  const sheet = h('div', { class: 'qt-sheet' }, mealRow, listPane, detailPane, scanPane, customPane, trackedBar);

  openModal({
    title: 'Track food',
    subtitle: logDate === today() ? 'Today' : longDate(logDate),
    className: 'qt-modal',
    body: sheet,
    onClose: () => {
      stopScan();
      clearTimeout(searchTimer);
      if (tracked.changed) onAdded({ calories: trackedTotal('calories'), protein_g: trackedTotal('protein_g') });
    },
  });
  // openModal focuses the first input; on a phone that is the keyboard
  // sliding up over the recents the sheet opened to show.
  if (window.matchMedia?.('(pointer: coarse)').matches) searchInput.blur();
  // An evening snack or a post-workout meal sits past the phone's edge;
  // centre whichever the clock chose so the member sees where it will go.
  requestAnimationFrame(() => {
    const chip = mealRow.querySelector('.qt-meal.active');
    if (!chip) return;
    const row = mealRow.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    mealRow.scrollLeft += box.left - row.left - (row.width - box.width) / 2;
  });

  if (startOn === 'scan') show('scan');
  else paintList();

  api.portal
    .foods()
    .then((res) => {
      foods = res.items;
      recent = res.recent ?? [];
      favorites = res.favorites ?? [];
      loaded = true;
      // Nothing tracked yet: open on the library instead of an empty tab.
      if (!recent.length) tab = favorites.length ? 'favorites' : 'all';
      paintList();
    })
    .catch((err) => {
      clear(listBody).append(h('div', { class: 'portal-empty' }, err.message || 'Could not load the food library'));
    });
}

/* ── Diet settings ─────────────────────────────────────────────────────── */

const ACTIVITY_LEVEL_OPTIONS = [
  { value: 'sedentary', label: 'Sedentary (desk job)' },
  { value: 'light', label: 'Lightly active' },
  { value: 'moderate', label: 'Active (on your feet a lot)' },
  { value: 'very_active', label: 'Very active (physical job)' },
];
const INTENSITY_OPTIONS = [
  ['light', 'Light'],
  ['moderate', 'Moderate'],
  ['hard', 'Hard'],
];
const GOAL_OPTIONS = [
  ['lose', 'Lose'],
  ['maintain', 'Maintain'],
  ['gain', 'Gain'],
];
const ADDBACK_OPTIONS = [
  [100, 'All'],
  [50, 'Half'],
  [0, 'None'],
];
const ADDBACK_HINT = {
  100: 'Every calorie you burn is added to what you can eat that day.',
  50: 'Half of what you burn is added — burn estimates run high, so this is the cautious choice.',
  0: 'Your budget stays fixed. The calculator builds your usual training into it instead.',
};
const KCAL_PER_GRAM = { protein: 4, carbs: 4, fats: 9 };

/** A segmented control that repaints itself; `onPick` gets the option's value. */
function segmentedPicker(options, current, onPick) {
  const wrap = h('div', { class: 'portal-segmented portal-seg-full' });
  const paint = (value) => {
    clear(wrap).append(
      ...options.map(([optionValue, label]) =>
        h(
          'button',
          {
            class: `portal-segment${optionValue === value ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              paint(optionValue);
              onPick(optionValue);
            },
          },
          label,
        ),
      ),
    );
  };
  paint(current);
  return wrap;
}

/** A label only around a real input: a <label> wrapped round a segmented
 * control would press its first button whenever the caption is tapped. */
const nutriField = (label, control, hint) =>
  h(
    ['INPUT', 'SELECT'].includes(control.tagName) ? 'label' : 'div',
    { class: 'portal-nutri-field' },
    h('span', {}, label),
    control,
    hint ? h('small', {}, hint) : null,
  );

const numberInput = (value, { step = 1, min = 0, placeholder = '', oninput } = {}) =>
  h('input', {
    class: 'portal-input',
    type: 'number',
    inputmode: 'decimal',
    step,
    min,
    placeholder,
    value: value ?? '',
    oninput,
  });

/**
 * openModal for a long sheet: no autofocus — on a phone that opens the
 * keyboard over the first section, and focusing mid slide-up scrolls the
 * backdrop to the bottom — so it starts at the top instead.
 */
function openTallSheet(options) {
  const backdrop = openModal(options);
  backdrop.querySelector(':focus')?.blur();
  backdrop.scrollTop = 0;
  return backdrop;
}

/**
 * The member's own targets, MyFitnessPal/Lifesum-style: whose numbers to
 * follow, the numbers themselves (grams or a percentage split), how much
 * exercise to eat back, and the body stats the calculator suggests from.
 *
 * One Save at the bottom: a suggestion only fills the target fields, so the
 * member sees the numbers before they become the ones they are held to.
 */
async function openNutritionSettings({ onSaved } = {}) {
  const data = await api.portal.nutrition();
  const { profile, trainer_plan: trainerPlan, effective, latest_weight: latestWeight } = data;
  const lb = weightUnit.get() === 'lb';

  // Blank own targets start from whatever the member follows today, so
  // switching to "my own" is a tweak rather than a blank form.
  const seed = profile.target_calories ? profile : effective.targets;
  const state = {
    source: effective.source === 'own' || !trainerPlan ? 'own' : 'trainer',
    mode: 'g',
    calories: seed.target_calories,
    grams: { protein: seed.target_protein_g ?? 0, carbs: seed.target_carbs_g ?? 0, fats: seed.target_fats_g ?? 0 },
    pct: {},
    fiber: profile.target_fiber_g,
    sugar: profile.target_sugar_g,
    water: seed.target_water_ml ?? 3000,
    addback: profile.exercise_addback_pct,
    goal: profile.goal,
    rate: profile.goal_rate_kg,
    intensity: profile.training_intensity,
  };
  const syncPct = () => {
    for (const [key, perGram] of Object.entries(KCAL_PER_GRAM)) {
      state.pct[key] = state.calories ? Math.round(((state.grams[key] * perGram) / state.calories) * 100) : 0;
    }
  };

  /* Whose targets */
  const sourceHint = h('p', { class: 'portal-nutri-hint' });
  const paintSourceHint = () => {
    sourceHint.textContent = !trainerPlan
      ? 'No trainer plan is assigned, so these are the targets your Diet tab uses.'
      : state.source === 'own'
        ? `Your own numbers replace your trainer's plan, ${trainerPlan.name}. Its meals stay visible as suggestions, and you can switch back any time.`
        : `Following your trainer's plan, ${trainerPlan.name}. Switch to My own to set your numbers.`;
    targetsCard.classList.toggle('is-muted', state.source === 'trainer');
  };

  /* Daily targets */
  const targetsCard = h('div', { class: 'portal-nutri-card' });
  const macroHint = h('div', { class: 'portal-nutri-total' });
  const macroInputs = {};
  const macroGrams = {};

  const paintMacroHint = () => {
    if (state.mode === 'pct') {
      const total = state.pct.protein + state.pct.carbs + state.pct.fats;
      macroHint.textContent = `Split adds up to ${total}%`;
      macroHint.classList.toggle('warn', total !== 100);
      for (const key of Object.keys(KCAL_PER_GRAM)) macroGrams[key].textContent = `${state.grams[key]} g`;
    } else {
      const kcal = Object.entries(KCAL_PER_GRAM).reduce((sum, [key, perGram]) => sum + state.grams[key] * perGram, 0);
      macroHint.textContent = `Macros add up to ${kcal} kcal`;
      macroHint.classList.toggle('warn', Boolean(state.calories) && Math.abs(kcal - state.calories) > state.calories * 0.05);
      for (const key of Object.keys(KCAL_PER_GRAM)) {
        macroGrams[key].textContent = state.calories ? `${Math.round(((state.grams[key] * KCAL_PER_GRAM[key]) / state.calories) * 100)}%` : '';
      }
    }
  };

  const gramsFromPct = (key) => Math.round((state.calories * (state.pct[key] || 0)) / 100 / KCAL_PER_GRAM[key]);

  function paintTargets() {
    syncPct();
    const macroRow = (key, label) => {
      const pctMode = state.mode === 'pct';
      macroInputs[key] = numberInput(pctMode ? state.pct[key] : state.grams[key], {
        oninput: (event) => {
          const value = Number(event.target.value) || 0;
          if (pctMode) {
            state.pct[key] = value;
            state.grams[key] = gramsFromPct(key);
          } else {
            state.grams[key] = value;
          }
          paintMacroHint();
        },
      });
      macroGrams[key] = h('em', {});
      return h(
        'label',
        { class: `portal-nutri-macro ${key}` },
        h('i', {}),
        h('span', {}, label),
        h('div', { class: 'portal-nutri-macro-in' }, macroInputs[key], h('b', {}, pctMode ? '%' : 'g')),
        macroGrams[key],
      );
    };

    clear(targetsCard).append(
      h(
        'div',
        { class: 'portal-nutri-kcal' },
        renderIcon('flame', { size: 22 }),
        numberInput(state.calories, {
          step: 10,
          placeholder: 'e.g. 2200',
          oninput: (event) => {
            state.calories = Number(event.target.value) || 0;
            if (state.mode === 'pct') {
              for (const key of Object.keys(KCAL_PER_GRAM)) state.grams[key] = gramsFromPct(key);
            }
            paintMacroHint();
          },
        }),
        h('span', {}, 'kcal a day'),
      ),
      h(
        'div',
        { class: 'portal-nutri-row' },
        h('strong', {}, 'Macros'),
        segmentedPicker(
          [
            ['g', 'Grams'],
            ['pct', '% split'],
          ],
          state.mode,
          (mode) => {
            state.mode = mode;
            paintTargets();
          },
        ),
      ),
      macroRow('protein', 'Protein'),
      macroRow('carbs', 'Carbs'),
      macroRow('fats', 'Fat'),
      macroHint,
      h(
        'div',
        { class: 'portal-nutri-grid' },
        nutriField(
          'Fibre (g)',
          numberInput(state.fiber, { placeholder: 'Auto', oninput: (e) => (state.fiber = e.target.value === '' ? null : Number(e.target.value)) }),
        ),
        nutriField(
          'Sugar limit (g)',
          numberInput(state.sugar, { placeholder: 'Auto', oninput: (e) => (state.sugar = e.target.value === '' ? null : Number(e.target.value)) }),
        ),
        nutriField(
          'Water (ml)',
          numberInput(state.water, { step: 250, oninput: (e) => (state.water = Number(e.target.value) || 0) }),
        ),
      ),
      h('small', { class: 'portal-nutri-hint' }, 'Leave fibre and sugar blank to follow your calories (14 g fibre per 1000 kcal, sugar under 10%).'),
    );
    paintMacroHint();
  }

  /* About you */
  const weightIn = numberInput(latestWeight ? toDisplayWeight(latestWeight.weight_kg) : '', { step: 0.1, placeholder: lb ? 'lb' : 'kg' });
  const goalWeightIn = numberInput(profile.goal_weight_kg ? toDisplayWeight(profile.goal_weight_kg) : '', {
    step: 0.1,
    placeholder: 'Optional',
  });
  // Height: centimetres or feet + inches, switchable in place. Switching
  // converts whatever is typed, so nothing has to be re-entered.
  let heightMode = heightUnit.get();
  const startFtIn = profile.height_cm ? cmToFeetInches(profile.height_cm) : null;
  const heightCm = numberInput(profile.height_cm ?? '', { step: 0.5, placeholder: 'e.g. 175' });
  const heightFt = numberInput(startFtIn?.ft ?? '', { min: 3, placeholder: 'e.g. 5' });
  const heightIn = numberInput(startFtIn?.inch ?? '', { min: 0, placeholder: 'e.g. 9' });
  heightFt.max = 8;
  heightIn.max = 11;
  const suffixed = (input, unit) => h('div', { class: 'portal-nutri-suffix' }, input, h('b', {}, unit));
  const heightInputs = h('div', {});
  // Inches are coarser than centimetres, so 182 cm shown as 6 ft 0 in would
  // come back as 183. Each side converts only when it was actually edited;
  // otherwise the other side's exact value stands.
  let feetEdited = false;
  let cmEdited = false;
  heightFt.addEventListener('input', () => (feetEdited = true));
  heightIn.addEventListener('input', () => (feetEdited = true));
  heightCm.addEventListener('input', () => (cmEdited = true));
  const feetToCm = () => ((Number(heightFt.value) || 0) * 12 + (Number(heightIn.value) || 0)) * 2.54;
  const readHeightCm = () =>
    heightMode === 'ft' && (feetEdited || !heightCm.value) ? feetToCm() : Number(heightCm.value) || 0;
  const paintHeight = () => {
    clear(heightInputs).append(
      heightMode === 'ft'
        ? h('div', { class: 'portal-nutri-pair' }, suffixed(heightFt, 'ft'), suffixed(heightIn, 'in'))
        : suffixed(heightCm, 'cm'),
    );
  };
  const heightToggle = h('div', { class: 'portal-unit-toggle', role: 'group', 'aria-label': 'Height unit' });
  const paintHeightToggle = () => {
    clear(heightToggle).append(
      ...[
        ['cm', 'cm'],
        ['ft', 'ft · in'],
      ].map(([unit, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: unit === heightMode ? 'active' : '',
            'aria-pressed': unit === heightMode ? 'true' : 'false',
            onclick: () => {
              if (unit === heightMode) return;
              if (unit === 'ft' && (cmEdited || !heightFt.value) && Number(heightCm.value)) {
                const { ft, inch } = cmToFeetInches(Number(heightCm.value));
                heightFt.value = ft;
                heightIn.value = inch;
              }
              if (unit === 'cm' && feetEdited) heightCm.value = Math.round(feetToCm());
              feetEdited = false;
              cmEdited = false;
              heightMode = unit;
              heightUnit.set(unit);
              paintHeightToggle();
              paintHeight();
            },
          },
          label,
        ),
      ),
    );
  };
  paintHeightToggle();
  paintHeight();
  const heightField = h(
    'div',
    { class: 'portal-nutri-field' },
    h('div', { class: 'portal-nutri-field-head' }, h('span', {}, 'Height'), heightToggle),
    heightInputs,
  );
  const sexSelect = h(
    'select',
    { class: 'portal-input' },
    h('option', { value: '' }, 'Choose…'),
    ...[
      ['male', 'Male'],
      ['female', 'Female'],
      ['other', 'Prefer not to say'],
    ].map(([value, label]) => h('option', { value, selected: profile.sex === value }, label)),
  );
  // Ages 13 to 100, the same bounds the server checks. An empty field's
  // calendar opens on the year grid around 25 years ago: three taps to a
  // birthday instead of scrolling back through hundreds of months.
  const yearsAgo = (n) => `${Number(today().slice(0, 4)) - n}${today().slice(4)}`;
  const birthIn = dateField({
    value: profile.birth_date ?? '',
    class: 'portal-date',
    min: yearsAgo(100),
    max: yearsAgo(13),
    startView: 'years',
    defaultDate: yearsAgo(25),
  });
  const activitySelect = h(
    'select',
    { class: 'portal-input' },
    ...ACTIVITY_LEVEL_OPTIONS.map((o) => h('option', { value: o.value, selected: profile.activity_level === o.value }, o.label)),
  );
  const daysSelect = h(
    'select',
    { class: 'portal-input' },
    ...Array.from({ length: 8 }, (_, n) =>
      h('option', { value: n, selected: profile.training_days === n }, n === 0 ? 'None' : `${n} day${n === 1 ? '' : 's'} a week`),
    ),
  );

  const rateSelect = h('select', { class: 'portal-input' });
  const paintRates = () => {
    const rates = state.goal === 'gain' ? [0.25, 0.5] : [0.25, 0.5, 0.75, 1];
    if (!rates.includes(state.rate)) state.rate = 0.5;
    clear(rateSelect).append(
      ...rates.map((r) =>
        h('option', { value: r, selected: r === state.rate }, `${lb ? Math.round(r * LB_PER_KG * 10) / 10 : r} ${lb ? 'lb' : 'kg'} a week`),
      ),
    );
    rateField.hidden = state.goal === 'maintain';
  };
  rateSelect.addEventListener('change', () => (state.rate = Number(rateSelect.value)));
  const rateField = nutriField('Pace', rateSelect);

  const bodyPayload = () => {
    const out = {
      activity_level: activitySelect.value,
      training_days: Number(daysSelect.value),
      training_intensity: state.intensity,
      goal: state.goal,
      goal_rate_kg: state.rate,
      exercise_addback_pct: state.addback,
    };
    if (weightIn.value) out.weight_kg = toKg(Number(weightIn.value));
    if (goalWeightIn.value) out.goal_weight_kg = toKg(Number(goalWeightIn.value));
    const cm = readHeightCm();
    if (cm) out.height_cm = Math.round(cm * 10) / 10;
    if (sexSelect.value) out.sex = sexSelect.value;
    if (birthIn.value) out.birth_date = birthIn.value;
    return out;
  };

  /* Calculator result */
  const resultBox = h('div', {});
  const FIELD_NAMES = { weight_kg: 'weight', height_cm: 'height', sex: 'sex', birth_date: 'date of birth' };

  async function calculate(button) {
    button.disabled = true;
    try {
      const res = await api.portal.suggestNutrition(bodyPayload());
      const t = res.targets;
      const line = (label, value) => h('div', { class: 'portal-nutri-line' }, h('span', {}, label), h('strong', {}, value));
      const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} kcal`;
      clear(resultBox).append(
        h(
          'div',
          { class: 'portal-nutri-result' },
          h('div', { class: 'portal-nutri-result-kcal' }, h('strong', {}, String(t.target_calories)), h('span', {}, 'kcal a day')),
          h(
            'div',
            { class: 'portal-food-macros' },
            h('div', {}, h('strong', {}, `${t.target_protein_g}g`), h('span', {}, 'protein')),
            h('div', {}, h('strong', {}, `${t.target_carbs_g}g`), h('span', {}, 'carbs')),
            h('div', {}, h('strong', {}, `${t.target_fats_g}g`), h('span', {}, 'fat')),
            h('div', {}, h('strong', {}, `${(t.target_water_ml / 1000).toFixed(1)}L`), h('span', {}, 'water')),
          ),
          line('Resting burn (BMR)', `${res.bmr} kcal`),
          line('With daily activity', `${res.maintenance - res.training_built_in} kcal`),
          res.training_built_in ? line('Training not added back', signed(res.training_built_in)) : null,
          res.goal_adjustment ? line(state.goal === 'lose' ? 'Deficit' : 'Surplus', signed(res.goal_adjustment)) : null,
          res.floored
            ? h('p', { class: 'portal-nutri-warn' }, renderIcon('alert', { size: 15 }), 'That pace would take you below a safe minimum, so this is held at the floor. A slower pace is kinder.')
            : null,
          res.weeks_to_goal ? h('p', { class: 'portal-nutri-hint' }, `At this pace you would reach your goal weight in about ${res.weeks_to_goal} weeks.`) : null,
          h(
            'button',
            {
              class: 'btn primary block',
              type: 'button',
              onclick: () => {
                state.calories = t.target_calories;
                state.grams = { protein: t.target_protein_g, carbs: t.target_carbs_g, fats: t.target_fats_g };
                state.water = t.target_water_ml;
                state.fiber = null;
                state.sugar = null;
                state.source = 'own';
                paintSource();
                paintTargets();
                targetsCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                toast('Targets filled in — tap Save to start using them');
              },
            },
            'Use these targets',
          ),
        ),
      );
      resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      const missing = Object.keys(err.details ?? {}).map((k) => FIELD_NAMES[k] ?? k.replace(/_/g, ' '));
      toast(missing.length ? `${err.message}: ${missing.join(', ')}` : err.message || 'Could not work that out', 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* Save */
  async function save(button) {
    button.disabled = true;
    try {
      const own = state.source === 'own';
      const payload = {
        ...bodyPayload(),
        // Without a trainer plan their own numbers apply anyway; leaving the
        // switch off means a plan assigned later still takes over.
        use_own_targets: Boolean(trainerPlan) && own,
        target_water_ml: state.water,
      };
      // Untouched targets on the trainer's side are not saved as the
      // member's own: the seed numbers came from the plan, not from them.
      if (own || profile.target_calories) {
        Object.assign(payload, {
          target_calories: state.calories || null,
          target_protein_g: state.grams.protein,
          target_carbs_g: state.grams.carbs,
          target_fats_g: state.grams.fats,
          target_fiber_g: state.fiber ?? null,
          target_sugar_g: state.sugar ?? null,
        });
      } else {
        delete payload.target_water_ml;
      }
      // Only a changed weight becomes a weigh-in.
      if (latestWeight && payload.weight_kg && Math.abs(payload.weight_kg - latestWeight.weight_kg) < 0.05) delete payload.weight_kg;
      await api.portal.saveNutrition(payload);
      closeModal();
      toast('Diet settings saved');
      await onSaved?.();
    } catch (err) {
      const fields = Object.keys(err.details ?? {}).map((k) => FIELD_NAMES[k] ?? k.replace(/^target_|_g$|_ml$/g, '').replace(/_/g, ' '));
      toast(fields.length ? `${err.message}: ${fields.join(', ')}` : err.message || 'Could not save', 'error');
      button.disabled = false;
    }
  }

  const sourceSlot = h('div', {});
  const paintSource = () => {
    clear(sourceSlot).append(
      trainerPlan
        ? segmentedPicker(
            [
              ['trainer', 'Trainer plan'],
              ['own', 'My own'],
            ],
            state.source,
            (value) => {
              state.source = value;
              paintSourceHint();
            },
          )
        : null,
      sourceHint,
    );
    paintSourceHint();
  };

  const addbackHint = h('p', { class: 'portal-nutri-hint' }, ADDBACK_HINT[state.addback]);
  const goalSlot = segmentedPicker(GOAL_OPTIONS, state.goal, (goal) => {
    state.goal = goal;
    paintRates();
  });

  paintTargets();
  paintSource();
  paintRates();

  const saveBtn = h('button', { class: 'btn primary block', type: 'button' }, 'Save');
  saveBtn.addEventListener('click', () => save(saveBtn));
  const calcBtn = h('button', { class: 'btn block portal-nutri-calc', type: 'button' }, renderIcon('sparkle', { size: 16 }), 'Suggest my targets');
  calcBtn.addEventListener('click', () => calculate(calcBtn));

  openTallSheet({
    title: 'Diet settings',
    className: 'portal-nutri-modal',
    body: h(
      'div',
      { class: 'portal-nutri' },
      h('h4', { class: 'portal-nutri-label' }, 'Targets to follow'),
      sourceSlot,
      h('h4', { class: 'portal-nutri-label' }, 'Daily targets'),
      targetsCard,
      h('h4', { class: 'portal-nutri-label' }, 'Exercise calories'),
      h(
        'div',
        { class: 'portal-nutri-card' },
        h('p', { class: 'portal-nutri-q' }, 'How much of what you burn should be added back to your food budget?'),
        segmentedPicker(ADDBACK_OPTIONS, state.addback, (value) => {
          state.addback = value;
          addbackHint.textContent = ADDBACK_HINT[value];
        }),
        addbackHint,
      ),
      h('h4', { class: 'portal-nutri-label' }, 'About you'),
      h(
        'div',
        { class: 'portal-nutri-card' },
        h('p', { class: 'portal-nutri-hint' }, 'Used to suggest targets and to estimate what your workouts burn. Only you and your trainer see it.'),
        h(
          'div',
          { class: 'portal-nutri-grid' },
          nutriField(`Weight (${lb ? 'lb' : 'kg'})`, weightIn),
          heightField,
          nutriField('Sex', sexSelect, 'For the BMR formula'),
          nutriField('Date of birth', birthIn),
        ),
        nutriField('Daily activity', activitySelect, 'Leave your workouts out — those are counted separately.'),
        nutriField('Training', daysSelect),
        nutriField('Training effort', segmentedPicker(INTENSITY_OPTIONS, state.intensity, (value) => (state.intensity = value))),
        nutriField('Goal', goalSlot),
        h('div', { class: 'portal-nutri-grid' }, rateField, nutriField(`Goal weight (${lb ? 'lb' : 'kg'})`, goalWeightIn)),
        calcBtn,
        resultBox,
      ),
      h('div', { class: 'portal-nutri-save' }, saveBtn),
    ),
  });
}

/* ── Nutrition insights ────────────────────────────────────────────────── */

const MACRO_PARTS = [
  { key: 'protein', label: 'Protein', grams: 'protein_g', target: 'target_protein_g', kcalPerGram: 4 },
  { key: 'carbs', label: 'Carbs', grams: 'carbs_g', target: 'target_carbs_g', kcalPerGram: 4 },
  { key: 'fats', label: 'Fat', grams: 'fats_g', target: 'target_fats_g', kcalPerGram: 9 },
];

const formatKcal = (n) => Math.round(n).toLocaleString();

/** A bar with a 4 px rounded top and a square foot on the baseline. */
function roundedBar(x, y, width, height, radius = 4) {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

/** One 100% bar split by each macro's share of energy, labelled where a
 * segment is wide enough to hold its number. */
function macroSplitBar(grams, caption) {
  const kcal = MACRO_PARTS.map((m) => (grams[m.key] || 0) * m.kcalPerGram);
  const total = kcal.reduce((a, b) => a + b, 0);
  const pct = kcal.map((k) => (total ? Math.round((k / total) * 100) : 0));
  return {
    pct,
    node: h(
      'div',
      { class: 'portal-ins-split-row' },
      h('span', { class: 'portal-ins-split-caption' }, caption),
      total
        ? h(
            'div',
            { class: 'portal-ins-split', role: 'img', 'aria-label': `${caption}: ${MACRO_PARTS.map((m, i) => `${m.label} ${pct[i]}%`).join(', ')}` },
            ...MACRO_PARTS.map((m, i) =>
              pct[i] > 0
                ? h(
                    'span',
                    { class: `portal-ins-seg ${m.key}`, style: `flex:${kcal[i]} 1 0`, title: `${m.label}: ${pct[i]}% of energy` },
                    pct[i] >= 12 ? `${pct[i]}%` : '',
                  )
                : null,
            ),
          )
        : h('div', { class: 'portal-ins-split empty' }, 'Nothing logged yet'),
    ),
  };
}

/**
 * The last seven days as bars, each with a tick at that day's budget (the
 * goal plus the exercise eaten back, so the target moves with the training).
 * Tapping or hovering a day reads it out under the chart.
 */
function weekChart(days, selectedDate) {
  const W = 340;
  const H = 150;
  const top = 12;
  const base = H - 22;
  const max = Math.max(1, ...days.map((d) => Math.max(d.calories, d.budget))) * 1.08;
  const slot = W / days.length;
  const barW = Math.min(26, slot * 0.55);
  const y = (v) => base - (v / max) * (base - top);
  const readout = h('div', { class: 'portal-ins-readout', role: 'status' });
  const bars = [];

  const select = (i) => {
    const d = days[i];
    bars.forEach((bar, j) => bar.classList.toggle('active', j === i));
    readout.textContent = d.entry_count
      ? `${dayLabel(d.log_date).weekday} ${shortDate(d.log_date)} · ${formatKcal(d.calories)} of ${formatKcal(d.budget)} kcal · P ${Math.round(d.protein_g)}g`
      : `${dayLabel(d.log_date).weekday} ${shortDate(d.log_date)} · nothing logged`;
  };

  const chart = svg(
    'svg',
    { class: 'portal-ins-week', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Calories eaten each day against that day’s budget' },
    svg('line', { class: 'portal-ins-axis', x1: 0, x2: W, y1: base, y2: base }),
    ...days.map((d, i) => {
      const cx = slot * i + slot / 2;
      const bar = svg('path', {
        class: `portal-ins-bar${d.log_date === selectedDate ? ' selected' : ''}`,
        d: d.calories > 0 ? roundedBar(cx - barW / 2, y(d.calories), barW, base - y(d.calories)) : '',
      });
      bars.push(bar);
      const hit = svg('rect', { class: 'portal-ins-hit', x: slot * i, y: 0, width: slot, height: H });
      hit.addEventListener('pointerenter', () => select(i));
      hit.addEventListener('click', () => select(i));
      return svg(
        'g',
        {},
        bar,
        svg('line', { class: 'portal-ins-budget', x1: cx - barW / 2 - 4, x2: cx + barW / 2 + 4, y1: y(d.budget), y2: y(d.budget) }),
        svg('text', { class: 'portal-ins-day', x: cx, y: H - 6, 'text-anchor': 'middle' }, dayLabel(d.log_date).weekday.slice(0, 2)),
        hit,
      );
    }),
  );

  select(Math.max(0, days.findIndex((d) => d.log_date === selectedDate)));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'portal-ins-legend-inline' },
      h('span', {}, h('i', { class: 'swatch bar' }), 'Eaten'),
      h('span', {}, h('i', { class: 'swatch tick' }), 'Budget'),
    ),
    chart,
    readout,
  );
}

/**
 * Lifesum-style detail for one day and the week behind it: the calorie sum,
 * how the energy splits across macros against the target split, which meals
 * and foods it came from, every tracked nutrient against its goal or limit,
 * and the last seven days. The Diet tab's card keeps only what reads at a
 * glance; everything that needs reading lives here, on a screen of its own
 * (see openScreen in renderPortalApp).
 */
async function buildNutritionInsights({ day, targets, logDate }) {
  const week = await api.portal.dietSummary({ end: logDate, days: 7 });
  const card = (title, ...children) =>
    h('section', { class: 'portal-ins-card' }, h('h4', { class: 'portal-ins-title' }, title), ...children);

  /* Calories */
  const { budget, exercise } = day;
  const cell = (value, label, tone = '') =>
    h('div', { class: `portal-budget-cell ${tone}` }, h('strong', {}, formatKcal(value)), h('span', {}, label));
  const op = (symbol) => h('span', { class: 'portal-budget-op', 'aria-hidden': 'true' }, symbol);
  const exerciseNote = !exercise.total_burned
    ? 'No exercise logged this day.'
    : exercise.addback_pct === 0
      ? `You burned ${formatKcal(exercise.total_burned)} kcal; exercise is not added to your budget.`
      : `You burned ${formatKcal(exercise.total_burned)} kcal; ${exercise.addback_pct}% of it is added to your budget.`;

  const caloriesCard = card(
    'Calories',
    h(
      'div',
      { class: 'portal-budget', role: 'img', 'aria-label': `Goal ${budget.goal} minus food ${budget.food} plus exercise ${budget.exercise} leaves ${budget.remaining} kcal` },
      cell(budget.goal, 'Goal'),
      op('−'),
      cell(budget.food, 'Food'),
      op('+'),
      cell(budget.exercise, 'Exercise', 'exercise'),
      op('='),
      cell(budget.remaining, budget.remaining < 0 ? 'Over' : 'Left', budget.remaining < 0 ? 'over' : 'left'),
    ),
    h('p', { class: 'portal-ins-note' }, exerciseNote),
  );

  /* Macro split: eaten against target */
  const eatenGrams = { protein: day.totals.protein_g, carbs: day.totals.carbs_g, fats: day.totals.fats_g };
  const targetGrams = { protein: targets.target_protein_g, carbs: targets.target_carbs_g, fats: targets.target_fats_g };
  const eaten = macroSplitBar(eatenGrams, 'Eaten');
  const planned = macroSplitBar(targetGrams, 'Target');
  const macroCard = card(
    'Macro split',
    eaten.node,
    planned.node,
    h(
      'div',
      { class: 'portal-ins-legend' },
      ...MACRO_PARTS.map((m, i) =>
        h(
          'div',
          { class: 'portal-ins-legend-row' },
          h('i', { class: `swatch ${m.key}` }),
          h('span', { class: 'portal-ins-legend-name' }, m.label),
          h('span', { class: 'portal-ins-legend-val' }, `${Math.round(eatenGrams[m.key])} / ${targetGrams[m.key]} g`),
          h('span', { class: 'portal-ins-legend-pct' }, `${eaten.pct[i]}% · target ${planned.pct[i]}%`),
        ),
      ),
    ),
  );

  /* Calories by meal */
  const mealRows = MEAL_SLOTS.map((slot) => ({
    ...slot,
    kcal: (day.meals[slot.key] ?? []).reduce((sum, e) => sum + e.calories, 0),
    count: (day.meals[slot.key] ?? []).length,
  })).filter((m) => m.count || ['breakfast', 'lunch', 'dinner', 'snack'].includes(m.key));
  const mealMax = Math.max(1, ...mealRows.map((m) => m.kcal));
  const foodTotal = day.totals.calories;
  const mealCard = card(
    'Calories by meal',
    ...mealRows.map((m) =>
      h(
        'div',
        { class: 'portal-ins-meal' },
        h('span', { class: 'portal-ins-meal-name' }, renderIcon(m.icon, { size: 15 }), m.label),
        h('div', { class: 'portal-ins-track' }, h('i', { style: `width:${(m.kcal / mealMax) * 100}%` })),
        h('span', { class: 'portal-ins-meal-val' }, `${formatKcal(m.kcal)} kcal`, h('small', {}, foodTotal ? `${Math.round((m.kcal / foodTotal) * 100)}%` : '–')),
      ),
    ),
  );

  /* Nutrients: goals to reach, and sugar as a limit to stay under */
  const nutrient = ({ label, eatenValue, target, unit, kind = 'goal', tone }) => {
    const value = Math.round(eatenValue * 10) / 10;
    const pctOf = target > 0 ? Math.min((eatenValue / target) * 100, 100) : 0;
    let status;
    if (kind === 'limit') {
      status = eatenValue > target
        ? h('span', { class: 'portal-ins-status bad' }, renderIcon('alert', { size: 13 }), `${Math.round(eatenValue - target).toLocaleString()} ${unit} over limit`)
        : h('span', { class: 'portal-ins-status' }, `${Math.round(target - eatenValue).toLocaleString()} ${unit} under limit`);
    } else {
      status = target > 0 && eatenValue >= target
        ? h('span', { class: 'portal-ins-status good' }, renderIcon('checkCircle', { size: 13 }), 'Goal reached')
        : h('span', { class: 'portal-ins-status' }, `${Math.round(target - eatenValue).toLocaleString()} ${unit} to go`);
    }
    return h(
      'div',
      { class: `portal-ins-nutrient ${tone}${kind === 'limit' && eatenValue > target ? ' over' : ''}` },
      h(
        'div',
        { class: 'portal-ins-nutrient-top' },
        h('strong', {}, label, kind === 'limit' ? h('small', {}, ' limit') : null),
        h('span', {}, `${value.toLocaleString()} / ${target.toLocaleString()} ${unit}`),
      ),
      h('div', { class: 'portal-ins-track' }, h('i', { style: `width:${pctOf}%` })),
      status,
    );
  };
  const nutrientCard = card(
    'Nutrients',
    nutrient({ label: 'Protein', eatenValue: day.totals.protein_g, target: targets.target_protein_g, unit: 'g', tone: 'protein' }),
    nutrient({ label: 'Carbs', eatenValue: day.totals.carbs_g, target: targets.target_carbs_g, unit: 'g', tone: 'carbs' }),
    nutrient({ label: 'Fat', eatenValue: day.totals.fats_g, target: targets.target_fats_g, unit: 'g', tone: 'fats' }),
    nutrient({ label: 'Fibre', eatenValue: day.totals.fiber_g, target: targets.target_fiber_g, unit: 'g', tone: 'fiber' }),
    nutrient({ label: 'Sugar', eatenValue: day.totals.sugar_g, target: targets.target_sugar_g, unit: 'g', kind: 'limit', tone: 'sugar' }),
    nutrient({ label: 'Water', eatenValue: day.water_ml, target: targets.target_water_ml, unit: 'ml', tone: 'water' }),
  );

  /* Where the calories came from */
  const topFoods = [...day.entries].sort((a, b) => b.calories - a.calories).slice(0, 5);
  const foodsCard = card(
    'Top foods',
    ...(topFoods.length
      ? topFoods.map((e) =>
          h(
            'div',
            { class: 'portal-ins-food' },
            h('div', {}, h('strong', {}, e.food_name), h('small', {}, portionLabel(e))),
            h('span', {}, `${formatKcal(e.calories)} kcal`, h('small', {}, foodTotal ? `${Math.round((e.calories / foodTotal) * 100)}%` : '')),
          ),
        )
      : [h('p', { class: 'portal-ins-note' }, 'Log a meal to see which foods your calories come from.')]),
  );

  /* The week */
  const logged = week.days.filter((d) => d.entry_count > 0);
  const avg = (key) => (logged.length ? logged.reduce((sum, d) => sum + d[key], 0) / logged.length : 0);
  // "On target" is the same ±15% band the trainer's adherence view uses.
  const onTarget = logged.filter((d) => Math.abs(d.calories - d.budget) <= d.budget * 0.15).length;
  const stat = (value, label) => h('div', { class: 'portal-ins-stat' }, h('strong', {}, value), h('span', {}, label));
  const weekCard = card(
    'Last 7 days',
    weekChart(week.days, logDate),
    logged.length
      ? h(
          'div',
          { class: 'portal-ins-stats' },
          stat(formatKcal(avg('calories')), 'avg kcal / day'),
          stat(`${onTarget} of ${logged.length}`, 'days on target'),
          stat(`${Math.round(avg('protein_g'))} g`, 'avg protein'),
        )
      : h('p', { class: 'portal-ins-note' }, 'Nothing logged this week yet.'),
  );

  return h('div', { class: 'portal-insights' }, caloriesCard, macroCard, mealCard, nutrientCard, foodsCard, weekCard);
}

/* ── Exercise & weigh-in sheets ───────────────────────────────────────── */

/**
 * Exercise outside the logger. The estimate is previewed with the same net-MET
 * arithmetic the server uses (src/nutrition.js); typing over it sends the
 * member's own number, which the server keeps as given.
 */
async function openActivitySheet({ logDate, onAdded }) {
  const { items, weight_kg: weightKg } = await api.portal.activityTypes();
  let selected = items.find((a) => a.key === 'walking') ?? items[0];
  let minutes = 30;
  let typedKcal = null;

  const estimate = () => Math.round(Math.max(0, selected.met - 1) * (weightKg || 70) * (minutes / 60));
  const kcalIn = numberInput(estimate(), {
    oninput: (event) => (typedKcal = event.target.value === '' ? null : Number(event.target.value)),
  });
  const refreshKcal = () => {
    if (typedKcal === null) kcalIn.value = estimate();
  };
  const nameIn = h('input', { class: 'portal-input', placeholder: 'What did you do?', maxlength: 80 });
  const nameField = nutriField('Name', nameIn);

  const grid = h('div', { class: 'portal-act-grid' });
  const paintGrid = () => {
    clear(grid).append(
      ...items.map((type) =>
        h(
          'button',
          {
            class: `portal-act-chip${type.key === selected.key ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              selected = type;
              nameField.hidden = type.key !== 'other';
              paintGrid();
              refreshKcal();
            },
          },
          renderIcon(type.icon, { size: 16 }),
          type.label,
        ),
      ),
    );
  };
  paintGrid();
  nameField.hidden = true;

  const minutesIn = numberInput(minutes, {
    min: 1,
    oninput: (event) => {
      minutes = Number(event.target.value) || 0;
      refreshKcal();
    },
  });
  const quick = h(
    'div',
    { class: 'portal-chip-row' },
    ...[15, 30, 45, 60, 90].map((m) =>
      h(
        'button',
        {
          class: 'portal-act-quick',
          type: 'button',
          onclick: () => {
            minutes = m;
            minutesIn.value = m;
            refreshKcal();
          },
        },
        `${m} min`,
      ),
    ),
  );

  const addBtn = h('button', { class: 'btn primary block', type: 'button' }, 'Add activity');
  addBtn.addEventListener('click', async () => {
    if (!minutes) {
      toast('How long did it take?', 'error');
      return;
    }
    addBtn.disabled = true;
    try {
      await api.portal.logActivity({
        activity: selected.key,
        name: selected.key === 'other' ? nameIn.value.trim() || undefined : undefined,
        duration_minutes: Math.round(minutes),
        calories: typedKcal ?? undefined,
        log_date: logDate,
      });
      closeModal();
      toast(`${selected.label} logged`);
      await onAdded();
    } catch (err) {
      toast(err.message || 'Could not log that', 'error');
      addBtn.disabled = false;
    }
  });

  openTallSheet({
    title: 'Log activity',
    body: h(
      'div',
      { class: 'portal-nutri' },
      grid,
      nameField,
      h('div', { class: 'portal-nutri-grid' }, nutriField('Minutes', minutesIn), nutriField('Calories burned', kcalIn)),
      quick,
      h(
        'small',
        { class: 'portal-nutri-hint' },
        weightKg
          ? 'Estimated from your weight. Got a number from a watch? Type it in instead.'
          : 'Estimated for 70 kg — log your weight on the Diet tab for a closer number.',
      ),
      addBtn,
    ),
  });
}

function openWeightSheet({ latest, onSaved }) {
  const unit = weightUnit.get();
  const input = numberInput(latest ? toDisplayWeight(latest.weight_kg) : '', { step: 0.1, placeholder: unit });
  const dateIn = dateField({ value: today(), class: 'portal-date', max: today() });
  const saveBtn = h('button', { class: 'btn primary block', type: 'button' }, 'Save weigh-in');
  saveBtn.addEventListener('click', async () => {
    const value = Number(input.value);
    if (!value) {
      toast('Enter your weight', 'error');
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.portal.logWeight({ weight_kg: toKg(value), log_date: dateIn.value || today() });
      closeModal();
      toast('Weigh-in saved');
      await onSaved();
    } catch (err) {
      toast(err.message || 'Could not save that', 'error');
      saveBtn.disabled = false;
    }
  });

  openModal({
    title: 'Log weight',
    body: h(
      'div',
      { class: 'portal-nutri' },
      h('div', { class: 'portal-nutri-grid' }, nutriField(`Weight (${unit})`, input), nutriField('Date', dateIn)),
      h('small', { class: 'portal-nutri-hint' }, 'Weigh in at the same time of day — first thing in the morning is most consistent. A second weigh-in on the same day replaces the first.'),
      saveBtn,
    ),
  });
}

/* -------------------------------------------------------------------- app */

/**
 * The bottom bar, built at render time rather than held as a module constant.
 *
 * isLibrary() is only correct after boot() has called setVertical(), and this
 * module is imported well before that runs (see the t()-at-top-level trap in
 * vertical.js) — so a constant here would freeze the gym's labels onto a study
 * hall's portal, and would decide the Workout/Diet tabs against the wrong
 * product too. Those two only exist for a gym: the fitness module is not part
 * of SeatBook, and their API 404s there.
 *
 * Capped at 5 tabs (4 for a library) on purpose. Pass and Pay stay real
 * screens — TAB_RENDERERS below still has both — but they are reached from
 * the topbar QR button and Home's quick actions / Profile hub rather than
 * from a bottom slot, so a gym with Workout and Diet on top of the base set
 * never has to squeeze seven labels into a thumb-width strip.
 *
 * A gym's Schedule is not a bottom slot either: Home already carries today's
 * classes with "View all" and a Book Class quick action, so the slot goes to
 * the Store (a coming-soon screen for now). TAB_HOME_OF maps such off-bar
 * screens to the tab that should stay lit while one is showing.
 */
function buildTabs() {
  if (isLibrary()) {
    return [
      { key: 'home', label: 'Home', icon: 'home' },
      { key: 'pass', label: 'Pass', icon: 'idCard' },
      { key: 'schedule', label: 'Shift', icon: 'seat' },
      { key: 'profile', label: 'Profile', icon: 'person' },
    ];
  }
  return [
    { key: 'home', label: 'Home', icon: 'home' },
    { key: 'workout', label: 'Workout', icon: 'dumbbell' },
    { key: 'diet', label: 'Diet', icon: 'leaf' },
    { key: 'store', label: 'Store', icon: 'bag', badge: 'Soon' },
    { key: 'profile', label: 'Profile', icon: 'person' },
  ];
}

const TAB_HOME_OF = { schedule: 'home', pass: 'home', pay: 'profile' };

/**
 * The tab bar's own icons, apart from the app-wide set in ui.js because each
 * is drawn twice: `line` is the idle outline, and the active state is a solid,
 * brand-gradient version built from `body` (filled), `stroke` (gradient
 * strokes) and `cut` (white detail on top of the fill, like the bag's smile).
 * Both layers sit in one <svg> so the tab can cross-fade between them.
 */
const NAV_ICONS = {
  home: {
    line: ['M4 10.2 12 3.6l8 6.6V19a2 2 0 0 1-2 2h-3.5v-4.5a2.5 2.5 0 0 0-5 0V21H6a2 2 0 0 1-2-2z'],
    body: ['M4 10.2 12 3.6l8 6.6V19a2 2 0 0 1-2 2h-3.5v-4.5a2.5 2.5 0 0 0-5 0V21H6a2 2 0 0 1-2-2z'],
  },
  dumbbell: {
    thick: true,
    line: ['M2.8 9.8v4.4', 'M7.2 6.2v11.6', { tag: 'path', d: 'M7.2 12h9.6', 'stroke-width': 2.2 }, 'M16.8 6.2v11.6', 'M21.2 9.8v4.4'],
    stroke: ['M2.8 9.8v4.4', 'M7.2 6.2v11.6', { tag: 'path', d: 'M7.2 12h9.6', 'stroke-width': 2.2 }, 'M16.8 6.2v11.6', 'M21.2 9.8v4.4'],
  },
  leaf: {
    line: [
      'M12.2 18.4C11.2 12 14.6 6.3 21 5.3c.4 7.1-3.5 12.3-8.8 13.1z',
      'M10.2 17.6C6.3 17.3 3.6 14.3 3.1 10.6c3.4-.2 6.3 1.9 7.4 5.2',
      'M11.4 21.4c.1-4.8 2.3-9.2 5.8-12.2',
    ],
    body: ['M12.2 18.4C11.2 12 14.6 6.3 21 5.3c.4 7.1-3.5 12.3-8.8 13.1z', 'M10.2 17.6C6.3 17.3 3.6 14.3 3.1 10.6c3.4-.2 6.3 1.9 7.4 5.2z'],
    stroke: ['M11.4 21.4c.1-2 .5-3.9 1.2-5.6'],
    cut: ['M12.9 15.4c1-2.4 2.4-4.4 4.3-6.2'],
  },
  bag: {
    line: [
      'M5.6 8h12.8a1.5 1.5 0 0 1 1.5 1.4l.8 9.9a2.5 2.5 0 0 1-2.5 2.7H5.8a2.5 2.5 0 0 1-2.5-2.7l.8-9.9A1.5 1.5 0 0 1 5.6 8z',
      'M8.5 8V6.8a3.5 3.5 0 0 1 7 0V8',
      'M9 12.5a3 3 0 0 0 6 0',
    ],
    body: ['M5.6 8h12.8a1.5 1.5 0 0 1 1.5 1.4l.8 9.9a2.5 2.5 0 0 1-2.5 2.7H5.8a2.5 2.5 0 0 1-2.5-2.7l.8-9.9A1.5 1.5 0 0 1 5.6 8z'],
    stroke: ['M8.5 8V6.8a3.5 3.5 0 0 1 7 0V8'],
    cut: ['M9 12.5a3 3 0 0 0 6 0'],
  },
  person: {
    line: [{ tag: 'circle', cx: 12, cy: 7.5, r: 4 }, 'M4.5 20.5a7.5 7.5 0 0 1 15 0'],
    body: [{ tag: 'circle', cx: 12, cy: 7.5, r: 4 }, 'M4.5 20.5a7.5 7.5 0 0 1 15 0z'],
  },
  idCard: {
    line: [
      { tag: 'rect', x: 3, y: 4.5, width: 18, height: 15, rx: 3 },
      { tag: 'circle', cx: 9, cy: 10.6, r: 2.1 },
      'M5.9 16.2a3.3 3.3 0 0 1 6.2 0',
      'M14.5 10h3.5',
      'M14.5 13.5h2.5',
    ],
    body: [{ tag: 'rect', x: 3, y: 4.5, width: 18, height: 15, rx: 3 }],
    cut: [{ tag: 'circle', cx: 9, cy: 10.6, r: 2.1 }, 'M5.9 16.2a3.3 3.3 0 0 1 6.2 0', 'M14.5 10h3.5', 'M14.5 13.5h2.5'],
  },
  seat: {
    line: [
      'M18.5 9V6a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v3',
      'M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z',
      'M5.5 18v2.5',
      'M18.5 18v2.5',
    ],
    body: [
      'M18.5 9V6a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v3z',
      'M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z',
    ],
    stroke: ['M5.5 18v2.5', 'M18.5 18v2.5'],
  },
};

function navIcon(name, key) {
  const def = NAV_ICONS[name];
  // userSpaceOnUse, not the default bounding box: a straight line (the
  // dumbbell's bar) has a zero-height box and would not paint at all.
  const gradId = `pnav-grad-${key}`;
  const paint = `url(#${gradId})`;
  const shape = (spec, attrs) =>
    typeof spec === 'string' ? svg('path', { d: spec, ...attrs }) : svg(spec.tag, { ...spec, tag: undefined, ...attrs });
  return svg(
    'svg',
    {
      class: 'pnav-svg',
      viewBox: '0 0 24 24',
      width: 28,
      height: 28,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': def.thick ? 3.2 : 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    svg(
      'defs',
      {},
      svg(
        'linearGradient',
        { id: gradId, gradientUnits: 'userSpaceOnUse', x1: 6, y1: 2, x2: 18, y2: 22 },
        svg('stop', { class: 'pnav-stop-a', offset: '0' }),
        svg('stop', { class: 'pnav-stop-b', offset: '1' }),
      ),
    ),
    svg('g', { class: 'pnav-line' }, (def.line ?? []).map((s) => shape(s))),
    svg(
      'g',
      { class: 'pnav-fill' },
      (def.body ?? []).map((s) => shape(s, { fill: paint, stroke: paint })),
      (def.stroke ?? []).map((s) => shape(s, { stroke: paint })),
      (def.cut ?? []).map((s) => shape(s, { stroke: '#fff', 'stroke-width': 1.9 })),
    ),
  );
}

function renderPortalApp(ctx, initialMe) {
  const TABS = buildTabs();
  let me = initialMe;
  let active = 'home';
  let tickInterval = null;
  let unsubscribeInstall;
  // Teardown callbacks a tab registers for anything it starts and must stop —
  // the workout stopwatch and its rest timer, alongside the pass ticker below.
  let cleanups = [];
  const registerCleanup = (fn) => cleanups.push(fn);
  /** Which day the Diet tab is showing. Held here rather than inside the tab so
   * scrolling back to yesterday and then logging a meal repaints yesterday,
   * not today. */
  let dietDate = today();

  const stopTicking = () => {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    for (const fn of cleanups) fn();
    cleanups = [];
  };
  // Tab switches never change the hash (see the module header), so the only
  // hashchange a mounted portal instance will ever see is leaving it outright
  // — exactly when a still-running pass ticker needs to stop.
  window.addEventListener('hashchange', stopTicking);

  const content = h('div', { class: 'portal-content' });
  const tabbar = h('nav', { class: 'portal-tabbar' });
  // The tracking tabs say what they are under the gym's name; the rest keep
  // the header to the name alone.
  const TOPBAR_SUBTITLES = { workout: 'Workout tracking', diet: 'Diet tracking' };
  const topbarSub = h('div', { class: 'portal-topbar-sub' });

  /**
   * Tapping a tab: a press-in squeeze, a ripple out of the pill, a haptic
   * tick, then the pill springs open and the filled icon pops in. Tapping the
   * tab already open goes back to its top (or out of a pushed screen) instead
   * of reloading it, the way native apps behave.
   */
  function onTabTap(tabDef, button) {
    sound.tapHaptic();
    const pill = button.querySelector('.portal-tab-icon');
    const ripple = h('span', { class: 'portal-tab-ripple' });
    ripple.addEventListener('animationend', () => ripple.remove());
    pill.append(ripple);
    if (tabDef.key === active && !screenOpen) {
      content.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    switchTab(tabDef.key);
  }

  // Built once and then only re-classed, so the CSS transitions between the
  // idle and active states actually play instead of being swapped for new
  // nodes mid-animation.
  const tabButtons = TABS.map((tabDef) => {
    const button = h(
      'button',
      { class: 'portal-tab', type: 'button', 'aria-label': tabDef.label },
      h(
        'span',
        { class: 'portal-tab-icon' },
        navIcon(tabDef.icon, tabDef.key),
        tabDef.badge ? h('span', { class: 'portal-tab-badge' }, tabDef.badge) : null,
      ),
      h('span', { class: 'portal-tab-label' }, tabDef.label),
    );
    button.addEventListener('click', () => onTabTap(tabDef, button));
    return button;
  });
  tabbar.append(...tabButtons);

  function paintTabbar() {
    const lit = TABS.some((tabDef) => tabDef.key === active) ? active : TAB_HOME_OF[active];
    TABS.forEach((tabDef, i) => {
      const isActive = lit === tabDef.key;
      tabButtons[i].classList.toggle('active', isActive);
      if (isActive) tabButtons[i].setAttribute('aria-current', 'page');
      else tabButtons[i].removeAttribute('aria-current');
    });
  }

  /**
   * A full screen pushed over the current tab — a page of its own with a back
   * arrow, as opposed to a bottom sheet — for detail that needs room to read.
   * The tab bar stays put, Lifesum-style.
   *
   * Opening one adds a history entry so the phone's back button or gesture
   * pops it. Tab switches never touch the URL (see the module header), so a
   * popstate while a screen is open can only mean "leave this screen".
   */
  let screenOpen = false;
  let skipNextPop = false;

  function onPopState() {
    // A portal instance replaced by a re-render (or a sign-out) must stop
    // listening, or it would repaint a detached tab on the next back press.
    if (!content.isConnected) {
      window.removeEventListener('popstate', onPopState);
      return;
    }
    if (skipNextPop) {
      skipNextPop = false;
      return;
    }
    if (screenOpen) {
      screenOpen = false;
      switchTab(active);
    }
  }
  window.addEventListener('popstate', onPopState);

  async function openScreen({ title, subtitle, render }) {
    stopTicking();
    if (!screenOpen) {
      history.pushState({ portalScreen: true }, '', window.location.href);
      screenOpen = true;
    }
    const head = h(
      'div',
      { class: 'portal-screen-head' },
      h(
        'button',
        { class: 'portal-screen-back', type: 'button', 'aria-label': 'Back', onclick: () => history.back() },
        renderIcon('arrowLeft', { size: 20 }),
      ),
      h('div', { class: 'portal-screen-title' }, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null),
    );
    content.classList.remove('is-refresh');
    clear(content).append(h('div', { class: 'portal-tab-body portal-screen' }, head, h('div', { class: 'portal-loading' }, 'Loading…')));
    content.scrollTop = 0;
    try {
      const node = await render();
      if (!screenOpen) return; // Backed out while it was loading.
      clear(content).append(h('div', { class: 'portal-tab-body portal-screen' }, head, node));
      content.scrollTop = 0;
    } catch (err) {
      if (!screenOpen) return;
      clear(content).append(
        h(
          'div',
          { class: 'portal-tab-body portal-screen' },
          head,
          h(
            'div',
            { class: 'portal-error' },
            h('p', {}, err.message || 'Could not load this page'),
            h('button', { class: 'btn', type: 'button', onclick: () => openScreen({ title, subtitle, render }) }, 'Try again'),
          ),
        ),
      );
    }
  }

  async function switchTab(key) {
    // Leaving a pushed screen through the tab bar: drop its history entry
    // too, so the next back press is not swallowed by a screen already gone.
    if (screenOpen) {
      screenOpen = false;
      skipNextPop = true;
      history.back();
    }
    stopTicking();
    active = key;
    paintTabbar();
    topbarSub.textContent = TOPBAR_SUBTITLES[key] ?? '';
    content.classList.remove('is-refresh');
    clear(content).append(h('div', { class: 'portal-loading' }, 'Loading…'));
    try {
      const node = await TAB_RENDERERS[key]();
      clear(content).append(node);
      content.scrollTop = 0;
    } catch (err) {
      clear(content).append(
        h(
          'div',
          { class: 'portal-error' },
          h('p', {}, err.message || 'Could not load this page'),
          h('button', { class: 'btn', type: 'button', onclick: () => switchTab(key) }, 'Try again'),
        ),
      );
    }
  }

  /** Re-renders the open tab in place after an edit made on it: the old view
   * stays up while the new one loads and the scroll position is kept, so a
   * water tap or a removed food doesn't flash "Loading…" and jump to the top.
   * A pushed screen shares `content`, so that case takes the full switch. */
  async function refreshTab(key) {
    if (screenOpen || active !== key) return switchTab(key);
    const scroll = content.scrollTop;
    try {
      const node = await TAB_RENDERERS[key]();
      if (screenOpen || active !== key) return; // The member moved on meanwhile.
      content.classList.add('is-refresh'); // Same page, so skip the fade-in.
      clear(content).append(node);
      content.scrollTop = scroll;
    } catch (err) {
      toast(err.message || 'Could not refresh this page', 'error');
    }
  }

  /**
   * Starts a workout session and jumps to the Workout tab, already logging.
   * Lives here — not nested inside renderWorkoutTab — so Home's "Start
   * workout" button can fire the exact same 1-tap flow the Workout tab uses
   * instead of routing the member through an extra tap into that tab first.
   */
  function startWorkoutSession({ name, day, planId, previous }) {
    const state = {
      workout_name: name,
      plan_id: planId ?? null,
      day_id: day?.id ?? null,
      started_at: Date.now(),
      exercises: (day?.exercises ?? []).map((exercise) => ({
        exercise_name: exercise.exercise_name,
        muscle_group: exercise.muscle_group,
        ...demoFields(exercise),
        target_sets: exercise.target_sets,
        target_reps: exercise.target_reps,
        rest_seconds: exercise.rest_seconds,
        previous: previous?.[exercise.exercise_name] ?? null,
        sets: Array.from({ length: exercise.target_sets }, () => ({
          set_type: 'normal',
          weight_display: '',
          weight_kg: 0,
          reps: '',
          completed: false,
        })),
      })),
    };
    activeSession.write(state);
    reportWorkoutStarted(state);
    switchTab('workout');
  }

  /* -------------------------------------------------------------- Home tab */

  /**
   * Home's "today" snippet for the fitness add-on: a 1-tap Start Workout card
   * and a compact calorie ring, so a member with the add-on sees today's plan
   * without leaving Home. Resolves to null — never a paywall — for a library,
   * a member without the add-on, or on any fetch hiccup: Home is a dashboard,
   * not the place to chase someone into an upsell.
   */
  async function renderTodaysFocus() {
    if (isLibrary()) return null;
    let status;
    try {
      status = await api.portal.fitnessStatus();
    } catch {
      return null;
    }
    if (!status.has_access) return null;

    const [current, dietPlan, dietDayRes] = await Promise.all([
      api.portal.currentWorkout().catch(() => null),
      api.portal.currentDiet().catch(() => null),
      api.portal.dietDay(today()).catch(() => null),
    ]);

    const cards = [];

    if (current?.today_day) {
      const groups = [...new Set(current.today_day.exercises.map((e) => e.muscle_group))];
      cards.push(
        h(
          'div',
          { class: 'portal-focus-card portal-focus-workout' },
          h('img', { class: 'portal-focus-art', src: '/images/portal/portal-workout-pull.png', alt: '' }),
          h('div', { class: 'portal-focus-kicker' }, renderIcon('weight', { size: 16 }), h('span', {}, current.plan.name)),
          h('div', { class: 'portal-focus-title' }, current.today_day.day_name),
          h(
            'div',
            { class: 'portal-focus-chips' },
            ...groups.slice(0, 4).map((g) => h('span', { class: 'portal-muscle-badge' }, g.replace('_', ' '))),
            h('span', { class: 'muted' }, `${current.today_day.exercises.length} exercises`),
          ),
          h(
            'button',
            {
              class: 'btn primary portal-start-btn',
              type: 'button',
              onclick: () =>
                startWorkoutSession({
                  name: current.today_day.day_name,
                  day: current.today_day,
                  planId: current.plan.id,
                  previous: current.previous,
                }),
            },
            renderIcon('play', { size: 14 }),
            ' Start workout',
          ),
        ),
      );
    }

    if (dietPlan && dietDayRes) {
      const targets = dietPlan.targets;
      const totals = dietDayRes.totals;
      cards.push(
        h(
          'button',
          { class: 'portal-focus-card portal-focus-diet', type: 'button', onclick: () => switchTab('diet') },
          calorieRing(totals.calories, targets.target_calories, { size: 104, stroke: 9, compact: true, icon: 'flame' }),
          h(
            'div',
            { class: 'portal-macro-stack' },
            macroBar('Protein', totals.protein_g, targets.target_protein_g, 'protein', 'bicep'),
            macroBar('Carbs', totals.carbs_g, targets.target_carbs_g, 'carbs', 'leaf'),
            macroBar('Fats', totals.fats_g, targets.target_fats_g, 'fats', 'water'),
          ),
        ),
      );
    }

    if (!cards.length) return null;
    return h(
      'div',
      { class: 'portal-section' },
      sectionHead("Today's focus", 'View plan', () => switchTab('workout')),
      h('div', { class: 'portal-focus-grid' }, ...cards),
    );
  }

  async function renderTodaySection() {
    if (isLibrary()) {
      const seatRes = await api.portal.seat().catch(() => ({ items: [] }));
      if (!seatRes.items.length) {
        return h(
          'div',
          { class: 'portal-section' },
          h('h3', {}, 'Your shift'),
          h('div', { class: 'portal-empty' }, 'No seat assigned yet — visit the desk to get seated.'),
        );
      }
      return h('div', { class: 'portal-section' }, h('h3', {}, 'Your shift today'), ...seatRes.items.map(seatCard));
    }

    const todayIso = today();
    const schedule = await api.portal.classes({ week_start: todayIso }).catch(() => ({ items: [] }));
    const mine = schedule.items.filter((c) => c.class_date === todayIso && c.my_booking_id);
    const head = sectionHead("Today's schedule", 'View all', () => switchTab('schedule'));
    if (!mine.length) {
      return h(
        'div',
        { class: 'portal-section' },
        head,
        h(
          'div',
          { class: 'portal-schedule-empty' },
          h('img', { class: 'portal-schedule-empty-art', src: '/images/portal/portal-schedule-empty.svg', alt: '' }),
          h('div', { class: 'portal-schedule-empty-title' }, 'No classes booked for today.'),
          h('div', { class: 'portal-schedule-empty-sub' }, 'Take the next step towards a healthier you!'),
          h(
            'button',
            { class: 'btn primary portal-browse-btn', type: 'button', onclick: () => switchTab('schedule') },
            renderIcon('classes', { size: 16 }),
            ' Browse classes',
          ),
        ),
      );
    }
    return h('div', { class: 'portal-section' }, head, ...mine.map((c) => classCard(c)));
  }

  async function renderHomeTab() {
    const sub = me.subscription;
    const daysLeft = me.days_left ?? 0;
    const pct = sub && sub.duration_days ? daysLeft / sub.duration_days : 0;

    const heroCard = h(
      'div',
      { class: 'portal-hero-card' },
      h('div', { class: 'portal-hero-glow' }),
      h(
        'div',
        { class: 'portal-hero-top' },
        h(
          'div',
          { class: 'portal-hero-info' },
          h(
            'div',
            { class: 'portal-hero-label' },
            portalIcon('crown', 'portal-hero-crown'),
            h('span', {}, sub ? t('membership') : 'No active plan'),
          ),
          h('div', { class: 'portal-hero-plan' }, sub ? sub.plan_name : `Visit the desk to ${isLibrary() ? 'buy a pass' : 'join a plan'}`),
          sub
            ? h(
                'div',
                { class: 'portal-hero-bottom' },
                h('span', {}, `Valid until ${date(sub.end_date)}`),
                me.sessions_left !== null && me.sessions_left !== undefined
                  ? h('span', { class: 'portal-hero-pill' }, `${me.sessions_left} sessions left`)
                  : null,
              )
            : h(
                'div',
                { class: 'portal-hero-bottom' },
                h('button', { class: 'btn sm ghost', type: 'button', onclick: () => switchTab('pay') }, 'See renewal plans'),
              ),
        ),
        sub
          ? h(
              'div',
              { class: 'portal-hero-ring' },
              h(
                'div',
                { style: 'position:relative' },
                progressRing(pct, { size: 88, stroke: 8 }),
                h(
                  'div',
                  { class: 'portal-hero-ring-text' },
                  h('strong', {}, String(Math.max(daysLeft, 0))),
                  h('span', {}, 'Days left'),
                ),
              ),
              h(
                'button',
                { class: 'portal-hero-go', type: 'button', 'aria-label': 'Invoices & renewal', onclick: () => switchTab('pay') },
                renderIcon('chevronRight', { size: 16, stroke: 2.5 }),
              ),
            )
          : null,
      ),
    );

    const quickActions = h(
      'div',
      { class: 'portal-quick-grid' },
      quickAction('idCard', 'Digital Pass', () => switchTab('pass'), 'orange'),
      quickAction(isLibrary() ? 'seats' : 'classes', isLibrary() ? 'My Shift' : 'Book Class', () => switchTab('schedule'), 'purple'),
      quickAction('billing', 'Invoices', () => switchTab('pay'), 'green'),
      quickAction('member', 'Support', openSupportModal, 'blue'),
    );

    const statsRow = h(
      'div',
      { class: 'portal-stat-row' },
      miniStat(isLibrary() ? 'activity' : 'flame', me.stats.streak_days, `Day${me.stats.streak_days === 1 ? '' : 's'} streak`, 'green'),
      miniStat(isLibrary() ? 'seats' : 'weight', me.stats.visits_this_month, `${isLibrary() ? 'Sittings' : 'Workouts'} this month`, 'purple'),
      miniStat('trendUp', me.stats.total_visits, 'Total visits', 'orange'),
    );

    const [todaysFocus, todaySection] = await Promise.all([renderTodaysFocus(), renderTodaySection()]);

    return h(
      'div',
      { class: 'portal-tab-body' },
      h(
        'div',
        { class: `portal-greeting${isLibrary() ? '' : ' has-art'}` },
        isLibrary()
          ? null
          : h('div', { class: 'portal-greeting-art' }, h('img', { src: '/images/portal/portal-hero-athlete.png', alt: '' })),
        h('h2', {}, `Hi, ${`${me.member.first_name} ${me.member.last_name || ''}`.trim()} 👋`),
        h('p', {}, isLibrary() ? 'Have a productive day.' : 'Ready for today’s workout?'),
      ),
      heroCard,
      pushPrimerSlot(),
      quickActions,
      todaysFocus,
      statsRow,
      todaySection,
    );
  }

  /* -------------------------------------------------------------- Pass tab */

  async function renderPassTab() {
    const pass = await api.portal.pass();
    const body = h('div', { class: 'portal-tab-body portal-pass-tab' }, h('h2', { class: 'portal-tab-title' }, 'Digital Pass'));

    const ticker = h('div', { class: 'portal-qr-ticker' });
    const walletCard = h(
      'div',
      { class: 'portal-wallet-card' },
      h(
        'div',
        { class: 'portal-wallet-top' },
        me.member.photo_url
          ? h('img', { class: 'portal-wallet-avatar', src: me.member.photo_url, alt: '' })
          : h('div', { class: 'portal-wallet-avatar portal-wallet-avatar-fallback' }, initials(me.member.first_name, me.member.last_name)),
        h(
          'div',
          { class: 'portal-wallet-meta' },
          h('div', { class: 'portal-wallet-name' }, `${me.member.first_name} ${me.member.last_name || ''}`.trim()),
          h('div', { class: 'portal-wallet-code' }, me.member.code),
        ),
        statusBadge(me.member.status),
      ),
      h('div', { class: 'portal-qr-wrap' }, h('div', { class: 'portal-qr-radar' }), h('div', { class: 'portal-qr-img', html: pass.svg })),
      ticker,
      h(
        'button',
        { class: 'btn primary block', type: 'button', onclick: () => openFullscreenPass(pass, me.member) },
        renderIcon('maximize', { size: 16 }),
        ' Full screen for scanning',
      ),
    );
    body.append(walletCard);

    const mountedAt = Date.now();
    const anchor = Date.parse(pass.server_time) || Date.now();
    const paintTick = () => {
      const now = new Date(anchor + (Date.now() - mountedAt));
      ticker.textContent = `SECURE · ${now.toISOString().slice(11, 19)} UTC`;
    };
    paintTick();
    tickInterval = setInterval(paintTick, 1000);

    return body;
  }

  /* ---------------------------------------------------------- Schedule tab */

  async function renderGymSchedule() {
    // The strip shows seven days from `weekStart`; the arrows page it a week
    // at a time, but never back past today, since a past class can't be booked.
    let weekStart = today();
    let selectedDay = weekStart;
    let weekView = false;
    let res = await api.portal.classes({ week_start: weekStart });

    const prevBtn = h('button', { class: 'portal-sched-nav', type: 'button', 'aria-label': 'Previous week' }, renderIcon('chevronLeft', { size: 20 }));
    const nextBtn = h('button', { class: 'portal-sched-nav', type: 'button', 'aria-label': 'Next week' }, renderIcon('chevronRight', { size: 20 }));
    const strip = h('div', { class: 'portal-sched-days' });
    const dayTitle = h('h3', {});
    const viewBtn = h('button', { class: 'portal-sched-view', type: 'button' });
    const listWrap = h('div', { class: 'portal-sched-list' });

    // Built from parts: ICU versions disagree on the comma after the weekday.
    const fmt = (iso, opts) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', opts);
    const dayMonth = (iso) => fmt(iso, { day: 'numeric', month: 'short' });
    const longDate = (iso) => `${fmt(iso, { weekday: 'long' })}, ${fmt(iso, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const shortDate = (iso) => `${fmt(iso, { weekday: 'short' })}, ${dayMonth(iso)}`;

    async function reload() {
      res = await api.portal.classes({ week_start: weekStart });
      paint();
    }

    async function bookClass(c) {
      try {
        await api.portal.bookClass(c.id, { class_date: c.class_date });
        toast(`Booked ${c.name}!`);
        await reload();
      } catch (err) {
        toast(err.message || 'Could not book this class', 'error');
      }
    }
    function cancelClass(c) {
      confirmDialog({
        title: 'Cancel this booking?',
        message: `Your spot in ${c.name} on ${shortDate(c.class_date)} goes back to the class.`,
        confirmLabel: 'Cancel booking',
        danger: true,
        onConfirm: async () => {
          await api.portal.cancelBooking(c.my_booking_id);
          toast('Booking cancelled');
          await reload();
        },
      });
    }
    const handlers = { onBook: bookClass, onCancel: cancelClass };

    async function goToWeek(start) {
      weekStart = start;
      selectedDay = start;
      prevBtn.disabled = nextBtn.disabled = true;
      try {
        await reload();
      } catch (err) {
        toast(err.message || 'Could not load this week', 'error');
        paint();
      }
    }
    prevBtn.addEventListener('click', () => goToWeek(addDays(weekStart, -7) < today() ? today() : addDays(weekStart, -7)));
    nextBtn.addEventListener('click', () => goToWeek(addDays(weekStart, 7)));
    viewBtn.addEventListener('click', () => {
      weekView = !weekView;
      paint();
    });

    function emptyDay(message) {
      return h(
        'div',
        { class: 'portal-schedule-empty' },
        h('img', { class: 'portal-schedule-empty-art', src: '/images/portal/portal-schedule-empty.svg', alt: '' }),
        h('div', { class: 'portal-schedule-empty-title' }, message),
        h('div', { class: 'portal-schedule-empty-sub' }, 'Pick another day, or check the next week.'),
      );
    }

    function paint() {
      const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
      prevBtn.disabled = weekStart <= today();
      nextBtn.disabled = false;

      clear(strip).append(
        ...days.map((iso) => {
          const lbl = dayLabel(iso);
          const hasBooking = res.items.some((c) => c.class_date === iso && c.my_booking_id);
          return h(
            'button',
            {
              class: `portal-sched-day${iso === selectedDay && !weekView ? ' active' : ''}${hasBooking ? ' has-booking' : ''}`,
              type: 'button',
              'aria-pressed': iso === selectedDay && !weekView ? 'true' : 'false',
              onclick: () => {
                selectedDay = iso;
                weekView = false;
                paint();
              },
            },
            h('span', {}, lbl.weekday),
            h('strong', {}, String(lbl.day)),
            h('i', { 'aria-hidden': 'true' }),
          );
        }),
      );

      clear(viewBtn).append(renderIcon(weekView ? 'list' : 'calendar', { size: 18 }), weekView ? 'View day' : 'View week');
      clear(listWrap);

      if (weekView) {
        dayTitle.textContent = `${dayMonth(days[0])} – ${fmt(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`;
        const groups = days
          .map((iso) => ({ iso, items: res.items.filter((c) => c.class_date === iso) }))
          .filter((g) => g.items.length);
        if (!groups.length) {
          listWrap.append(emptyDay('No classes this week.'));
          return;
        }
        for (const g of groups) {
          listWrap.append(
            h('div', { class: 'portal-sched-group' }, `${fmt(g.iso, { weekday: 'long' })}, ${dayMonth(g.iso)}`),
            ...g.items.map((c, i) => scheduleCard(c, i, handlers)),
          );
        }
        return;
      }

      dayTitle.textContent = longDate(selectedDay);
      const items = res.items.filter((c) => c.class_date === selectedDay);
      append(listWrap, items.length ? items.map((c, i) => scheduleCard(c, i, handlers)) : [emptyDay('No classes on this day.')]);
    }
    paint();

    return h(
      'div',
      { class: 'portal-tab-body portal-sched' },
      h(
        'div',
        { class: 'portal-page-head' },
        h('h2', {}, 'Schedule'),
        h('p', {}, 'Book your favorite classes and manage your fitness routine.'),
      ),
      h('div', { class: 'portal-sched-week' }, prevBtn, strip, nextBtn),
      h('div', { class: 'portal-sched-dayhead' }, dayTitle, viewBtn),
      listWrap,
    );
  }

  /* ------------------------------------------------------------- Store tab */

  /** Holds the Store's slot until the shop itself ships: what is coming, and
   * nothing that can be tapped into a dead end. */
  function renderStoreTab() {
    const teaser = (icon, tone, title, sub) =>
      h(
        'div',
        { class: `portal-store-item tone-${tone}` },
        h('span', { class: 'portal-store-item-icon' }, renderIcon(icon, { size: 20 })),
        h('div', {}, h('strong', {}, title), h('span', {}, sub)),
      );
    return h(
      'div',
      { class: 'portal-tab-body portal-store' },
      h(
        'div',
        { class: 'portal-store-hero' },
        h('span', { class: 'portal-store-hero-icon' }, renderIcon('store', { size: 34 })),
        h('span', { class: 'portal-store-chip' }, 'Coming soon'),
        h('h2', {}, 'The gym store is on its way'),
        h('p', {}, 'Soon you can shop supplements, gear and merchandise from your gym — right here in the app.'),
      ),
      h(
        'div',
        { class: 'portal-store-list' },
        teaser('zap', 'orange', 'Supplements', 'Protein, pre-workout and more'),
        teaser('bag', 'purple', 'Gear & apparel', 'Gym wear, shakers and accessories'),
        teaser('cart', 'green', 'Pick up at the desk', 'Order in the app, collect at your gym'),
      ),
    );
  }

  async function renderLibrarySchedule() {
    const seatRes = await api.portal.seat();
    const body = h('div', { class: 'portal-tab-body' }, h('h2', { class: 'portal-tab-title' }, 'My shifts'));
    body.append(
      seatRes.items.length
        ? h('div', { class: 'portal-section' }, ...seatRes.items.map(seatCard))
        : h('div', { class: 'portal-empty' }, 'No seat assigned yet — visit the desk to get seated.'),
    );
    if (me.locker) {
      body.append(
        h('h3', { class: 'portal-section-title' }, 'Locker'),
        h(
          'div',
          { class: 'portal-locker-card' },
          h('div', { class: 'portal-locker-icon' }, renderIcon('lockers', { size: 22 })),
          h(
            'div',
            {},
            h('div', { class: 'portal-locker-code' }, me.locker.code),
            h('div', { class: 'muted' }, `Held until ${date(me.locker.held_until)} · ${me.locker.key_issued ? 'Key issued' : 'No key yet'}`),
          ),
        ),
      );
    }
    return body;
  }

  /* --------------------------------------------------------------- Pay tab */

  async function renderPayTab() {
    const [paymentsRes, plansRes] = await Promise.all([api.portal.payments(), api.portal.plans()]);
    const sub = me.subscription;
    const payments = paymentsRes.items;
    const body = h(
      'div',
      { class: 'portal-tab-body portal-pay' },
      h(
        'div',
        { class: 'portal-page-head portal-pay-head' },
        payArt('header-athlete', 'portal-pay-head-art'),
        h('h2', {}, isLibrary() ? 'Passes & Payments' : 'Invoices & Payments'),
        h('p', {}, `View your ${t('plan').toLowerCase()} details, invoices and payment history.`),
      ),
    );

    /* Current plan */
    const { symbol } = currencyInfo();
    body.append(
      h(
        'section',
        { class: `portal-pay-plan${sub ? '' : ' is-empty'}` },
        h(
          'div',
          { class: 'portal-pay-plan-top' },
          payArt('plan-hero', 'portal-pay-plan-art'),
          h('span', { class: 'portal-pay-plan-ico' }, renderIcon('crown', { size: 34, stroke: 2 })),
          h(
            'div',
            { class: 'portal-pay-plan-who' },
            h('strong', {}, sub ? sub.plan_name : `No active ${t('plan').toLowerCase()}`),
            h('small', {}, sub ? `Current ${isLibrary() ? 'pass' : 'membership plan'}` : 'Pick one below and renew at the front desk'),
            sub ? h('span', { class: 'portal-prof-status tone-green' }, h('i'), 'Active') : null,
          ),
        ),
        sub
          ? h(
              'div',
              { class: 'portal-pay-plan-facts' },
              h(
                'div',
                { class: 'portal-pay-fact' },
                h('span', { class: 'portal-pay-fact-ico portal-pay-currency' }, symbol),
                h(
                  'div',
                  {},
                  h('small', {}, 'Price'),
                  h('strong', {}, money(sub.price - (sub.discount || 0))),
                  sub.discount ? h('em', {}, `${money(sub.discount)} off ${money(sub.price)}`) : null,
                ),
              ),
              h(
                'div',
                { class: 'portal-pay-fact' },
                h('span', { class: 'portal-pay-fact-ico' }, renderIcon('calendar', { size: 22 })),
                h('div', {}, h('small', {}, 'Valid till'), h('strong', {}, `${date(sub.start_date)} – ${date(sub.end_date)}`)),
              ),
            )
          : null,
      ),
    );
    if (sub && sub.due > 0) {
      body.append(
        h('div', { class: 'portal-due-banner' }, renderIcon('outgoing', { size: 16 }), ` ${money(sub.due)} due — pay at the front desk`),
      );
    }

    /* Payment history: the latest three, "See all" opens the rest in place */
    const PREVIEW = 3;
    const historyList = h('div', { class: 'portal-pay-list' });
    let showAll = false;
    const seeAll = h('button', { class: 'portal-pay-seeall', type: 'button' });
    const paintHistory = () => {
      const rows = showAll ? payments : payments.slice(0, PREVIEW);
      clear(historyList).append(
        ...(rows.length ? rows.map(paymentRow) : [h('div', { class: 'portal-pay-empty' }, 'No payments yet — they show up here once the desk records one.')]),
      );
      clear(seeAll).append(showAll ? 'Show less' : 'See all', renderIcon(showAll ? 'chevronUp' : 'chevronRight', { size: 16 }));
      seeAll.hidden = payments.length <= PREVIEW;
    };
    seeAll.addEventListener('click', () => {
      showAll = !showAll;
      paintHistory();
    });
    paintHistory();
    body.append(
      h(
        'div',
        { class: 'portal-pay-section-head' },
        h('h3', { class: 'portal-prof-label' }, 'Payment history'),
        h('span', { class: 'portal-pay-count' }, `${payments.length} payment${payments.length === 1 ? '' : 's'}`),
        seeAll,
      ),
      historyList,
    );

    /* Renewal plans */
    const plans = plansRes.items;
    if (plans.length) {
      const perDay = (p) => p.price / Math.max(1, p.duration_days);
      const base = plans.reduce((a, b) => (b.duration_days < a.duration_days ? b : a));
      body.append(
        h(
          'div',
          { class: 'portal-pay-section-head is-stacked' },
          h('h3', { class: 'portal-prof-label' }, 'Renewal plans'),
          h('p', {}, `Choose a ${t('plan').toLowerCase()} that fits your ${isLibrary() ? 'study routine' : 'fitness journey'}.`),
        ),
        h(
          'div',
          { class: `portal-pay-plans${plans.length % 2 ? ' is-odd' : ''}` },
          ...plans.map((p, i) => {
            const look = RENEWAL_LOOKS[i % RENEWAL_LOOKS.length];
            const savePct = p.id !== base.id ? Math.round((1 - perDay(p) / perDay(base)) * 100) : 0;
            return renewalTile(p, look, {
              perks: planPerks(p, savePct, base),
              current: sub && sub.plan_id === p.id,
            });
          }),
        ),
      );
    }

    body.append(
      h(
        'div',
        { class: 'portal-pay-note' },
        h('span', { class: 'portal-pay-note-ico' }, renderIcon('info', { size: 18, stroke: 2.4 })),
        h('span', {}, `Ask the front desk to renew or switch your ${t('plan').toLowerCase()}.`),
        h('span', { class: 'portal-pay-note-mark', 'aria-hidden': 'true' }, renderIcon('barbell', { size: 64, stroke: 1.6 })),
      ),
    );

    return body;
  }

  function paymentRow(p) {
    const cash = String(p.method).toLowerCase() === 'cash';
    return h(
      'div',
      { class: 'portal-pay-row' },
      h('span', { class: 'portal-pay-row-ico' }, renderIcon(cash ? 'revenue' : 'fileText', { size: 24 })),
      h(
        'div',
        { class: 'portal-pay-row-meta' },
        h('strong', {}, p.plan_name ? `${p.plan_name} ${isLibrary() ? 'Pass' : 'Membership'}` : 'Payment'),
        h('small', {}, `${date(p.paid_on)} · ${String(p.method || '').toUpperCase()}`),
      ),
      h('div', { class: 'portal-pay-row-amount' }, money(p.amount)),
      h(
        'button',
        {
          class: 'portal-pay-row-dl',
          type: 'button',
          title: 'Download PDF receipt',
          'aria-label': 'Download PDF receipt',
          onclick: async (event) => {
            const btn = event.currentTarget;
            btn.disabled = true;
            try {
              await api.portal.downloadReceipt(p.id);
            } catch (err) {
              toast(err.message || 'Could not download receipt', 'error');
            } finally {
              btn.disabled = false;
            }
          },
        },
        renderIcon('download', { size: 20 }),
      ),
    );
  }

  function renewalTile(p, look, { perks, current }) {
    const open = () =>
      openModal({
        title: p.name,
        subtitle: `${money(p.price)} · ${p.duration_days} days`,
        icon: look.icon,
        body: h(
          'div',
          { class: 'portal-pay-plan-modal' },
          p.description ? h('p', {}, p.description) : null,
          h('ul', { class: 'portal-pay-perks' }, ...perks.map((perk) => h('li', {}, renderIcon('check', { size: 12, stroke: 3 }), perk))),
          h(
            'p',
            { class: 'muted' },
            current
              ? `This is your current ${t('plan').toLowerCase()}. Renew it at the front desk before it runs out.`
              : `Renewals and switches are done at the front desk — show them this screen and they'll set it up.`,
          ),
        ),
      });
    return h(
      'button',
      { class: `portal-pay-tile tone-${look.tone}`, type: 'button', onclick: open },
      payArt(look.art, 'portal-pay-tile-art'),
      h(
        'div',
        { class: 'portal-pay-tile-top' },
        h('span', { class: 'portal-pay-tile-ico' }, renderIcon(look.icon, { size: 26, stroke: 2 })),
        h(
          'div',
          { class: 'portal-pay-tile-price' },
          h('strong', {}, p.name),
          h('b', {}, money(p.price)),
          h('small', {}, `${p.duration_days} days${p.sessions ? ` · ${p.sessions} sessions` : ''}`),
          current ? h('span', { class: 'portal-pay-tile-current' }, 'Your plan') : null,
        ),
      ),
      h('ul', { class: 'portal-pay-perks' }, ...perks.map((perk) => h('li', {}, renderIcon('check', { size: 11, stroke: 3.2 }), perk))),
      h('span', { class: 'portal-pay-tile-go' }, renderIcon('arrowRight', { size: 20, stroke: 2.4 })),
    );
  }

  /* ----------------------------------------------------------- Workout tab */

  /**
   * The active-session logger.
   *
   * Everything here is local state until Finish: the set table is a scratchpad,
   * and a round trip per checkbox would put a spinner between the member and
   * their next set. It is mirrored into localStorage on every change so a
   * locked phone or a closed tab does not lose the session — see activeSession.
   */
  function renderActiveWorkout(state, { onFinish, onDiscard }) {
    const rest = restTimer();
    const body = h('div', { class: 'portal-tab-body portal-session' });
    const clockNode = h('div', { class: 'portal-session-clock' }, '00:00:00');
    let clockInterval = null;

    const persist = () => activeSession.write(state);

    const teardown = () => {
      rest.stop();
      if (clockInterval) clearInterval(clockInterval);
      clockInterval = null;
    };
    // The tab shell stops the pass ticker on hashchange the same way; a running
    // rest timer and a stopwatch need exactly the same treatment.
    registerCleanup(teardown);

    const totals = () =>
      state.exercises
        .flatMap((ex) => ex.sets)
        .reduce(
          (acc, set) =>
            set.completed
              ? {
                  sets: acc.sets + 1,
                  reps: acc.reps + (Number(set.reps) || 0),
                  volume: acc.volume + (Number(set.weight_kg) || 0) * (Number(set.reps) || 0),
                }
              : acc,
          { sets: 0, reps: 0, volume: 0 },
        );

    // The set ticked by the last tap, so only its check pops — not every done
    // check on each repaint.
    let justTicked = null;

    function setRow(exercise, set, index) {
      const previous = exercise.previous;
      // Like Hevy, the badge is the set number and doubles as the set-type
      // switch: warmups don't count towards the numbering and show a W, drop
      // and failure sets their own letter.
      const workingNumber = exercise.sets.slice(0, index + 1).filter((s) => s.set_type !== 'warmup').length;
      const typeInfo = SET_TYPES.find((t) => t.key === set.set_type);
      const typeButton = h(
        'button',
        {
          class: `portal-set-type t-${set.set_type}`,
          type: 'button',
          title: `${typeInfo?.label ?? 'Normal'} set — tap to change type`,
          'aria-label': `Set ${index + 1}, ${typeInfo?.label ?? 'Normal'}. Change set type`,
          onclick: () => {
            const order = ['normal', 'warmup', 'drop', 'failure'];
            set.set_type = order[(order.indexOf(set.set_type) + 1) % order.length];
            persist();
            paint();
          },
        },
        set.set_type === 'normal' ? String(workingNumber) : (typeInfo?.short ?? String(workingNumber)),
      );

      const oneRm = estimate1rm(Number(set.weight_kg) || 0, Number(set.reps) || 0);
      const beatsPrevious = previous && oneRm > estimate1rm(previous.weight_kg, previous.reps);

      // The greyed-out placeholders are last session's numbers; a blank box
      // means "same as last time", so this copies them in for real.
      const fillFromPrevious = () => {
        if (!previous) return;
        if (set.weight_display === '' || set.weight_display == null) {
          set.weight_display = String(toDisplayWeight(previous.weight_kg));
          set.weight_kg = previous.weight_kg;
        }
        if (set.reps === '' || set.reps == null || Number(set.reps) === 0) set.reps = previous.reps;
      };

      const check = h(
        'button',
        {
          class: `portal-set-check${set.completed ? ' done' : ''}${set.completed && justTicked === set ? ' pop' : ''}`,
          type: 'button',
          'aria-label': set.completed ? 'Mark set as not done' : 'Mark set as done',
          onclick: () => {
            set.completed = !set.completed;
            justTicked = set.completed ? set : null;
            if (set.completed) fillFromPrevious();
            persist();
            if (set.completed) {
              sound.playSetComplete();
              // Ticking a set is what starts the rest clock — that is the
              // moment the member actually stops lifting.
              rest.start(exercise.rest_seconds || 90);
            } else {
              sound.playSetUncheck();
            }
            paint();
            justTicked = null;
          },
        },
        renderIcon('check', { size: 18, stroke: 2.4 }),
      );

      return h(
        'div',
        { class: `portal-set-row${set.completed ? ' completed' : ''}` },
        typeButton,
        previous
          ? h(
              'button',
              {
                class: 'portal-set-prev',
                type: 'button',
                title: 'Use last session’s numbers',
                onclick: () => {
                  fillFromPrevious();
                  persist();
                  paint();
                },
              },
              `${weightLabel(previous.weight_kg)} × ${previous.reps}`,
            )
          : h('div', { class: 'portal-set-prev is-empty' }, '—'),
        h('input', {
          class: 'portal-set-input',
          type: 'number',
          inputmode: 'decimal',
          min: 0,
          step: 0.5,
          placeholder: previous ? String(toDisplayWeight(previous.weight_kg)) : '0',
          value: set.weight_display ?? '',
          oninput: (event) => {
            set.weight_display = event.target.value;
            set.weight_kg = toKg(event.target.value);
            persist();
            paintMeta();
          },
        }),
        h('input', {
          class: 'portal-set-input',
          type: 'number',
          inputmode: 'numeric',
          min: 0,
          step: 1,
          placeholder: previous ? String(previous.reps) : '0',
          value: set.reps ?? '',
          oninput: (event) => {
            set.reps = Number(event.target.value);
            persist();
            paintMeta();
          },
        }),
        check,
        oneRm > 0
          ? h(
              'div',
              {
                class: `portal-set-1rm${beatsPrevious ? ' beats' : ''}`,
                title: beatsPrevious ? 'Estimated one-rep max — beats last session' : 'Estimated one-rep max',
              },
              beatsPrevious ? renderIcon('trophy', { size: 11, stroke: 2.2 }) : null,
              h('span', { class: 'portal-set-1rm-label' }, 'Est. 1RM'),
              h('strong', {}, weightLabel(oneRm)),
            )
          : null,
      );
    }

    function moveExercise(from, to) {
      if (to < 0 || to >= state.exercises.length) return;
      const [moved] = state.exercises.splice(from, 1);
      state.exercises.splice(to, 0, moved);
      persist();
      paint();
    }

    function openExerciseMenu(exercise, exIndex) {
      actionSheet(exercise.exercise_name, [
        { icon: 'trendUp', label: 'Exercise progress', onClick: () => openExerciseDetail(exercise) },
        { icon: 'info', label: 'How to do it', onClick: () => openExerciseDetail(exercise, { tab: 'howto' }) },
        exIndex > 0 ? { icon: 'arrowUp', label: 'Move up', onClick: () => moveExercise(exIndex, exIndex - 1) } : null,
        exIndex < state.exercises.length - 1
          ? { icon: 'arrowDown', label: 'Move down', onClick: () => moveExercise(exIndex, exIndex + 1) }
          : null,
        {
          icon: 'trash',
          label: 'Remove exercise',
          danger: true,
          onClick: () => {
            state.exercises.splice(exIndex, 1);
            persist();
            paint();
          },
        },
      ]);
    }

    function exerciseCard(exercise, exIndex) {
      return h(
        'div',
        { class: 'portal-ex-card' },
        h(
          'div',
          { class: 'portal-ex-head' },
          exerciseThumbButton(exercise),
          h(
            'div',
            { class: 'portal-ex-title' },
            h('div', { class: 'portal-ex-name' }, exercise.exercise_name),
            h(
              'div',
              { class: 'portal-ex-meta' },
              h('span', { class: 'portal-muscle-badge' }, capitalise(muscleLabel(exercise.muscle_group))),
              exercise.target_reps ? h('span', { class: 'portal-ex-target' }, `Target ${exercise.target_sets} × ${exercise.target_reps}`) : null,
            ),
          ),
          h(
            'div',
            { class: 'portal-ex-actions' },
            h(
              'button',
              {
                class: 'portal-rest-chip',
                type: 'button',
                title: 'Rest between sets — tap to change',
                onclick: () => {
                  const next = REST_PRESETS[(REST_PRESETS.indexOf(exercise.rest_seconds) + 1) % REST_PRESETS.length];
                  exercise.rest_seconds = next;
                  persist();
                  paint();
                },
              },
              renderIcon('timer', { size: 16 }),
              h('span', {}, `${exercise.rest_seconds}s`),
            ),
            h(
              'button',
              {
                class: 'portal-ex-menu',
                type: 'button',
                title: 'Exercise options',
                'aria-label': `${exercise.exercise_name} options`,
                onclick: () => openExerciseMenu(exercise, exIndex),
              },
              renderIcon('more', { size: 20, stroke: 2.5 }),
            ),
          ),
        ),
        h(
          'div',
          { class: 'portal-set-row portal-set-header' },
          h('span', {}, 'Set'),
          h('span', {}, 'Previous'),
          h('span', {}, weightUnit.get()),
          h('span', {}, 'Reps'),
          h('span', {}, ''),
        ),
        ...exercise.sets.map((set, index) => setRow(exercise, set, index)),
        h(
          'div',
          { class: 'portal-ex-foot' },
          h(
            'button',
            {
              class: 'portal-ex-btn is-add',
              type: 'button',
              onclick: () => {
                const last = exercise.sets[exercise.sets.length - 1];
                // A new set inherits the previous one's load: on a straight-sets
                // day that is what it will be, and it is one fewer thing to type.
                exercise.sets.push({
                  set_type: 'normal',
                  weight_display: last?.weight_display ?? '',
                  weight_kg: last?.weight_kg ?? 0,
                  reps: last?.reps ?? '',
                  completed: false,
                });
                persist();
                paint();
              },
            },
            renderIcon('plus', { size: 18, stroke: 2.2 }),
            h('span', {}, 'Add set'),
          ),
          h(
            'button',
            {
              class: 'portal-ex-btn is-remove',
              type: 'button',
              // The last set stays: an exercise with no rows is removed from
              // its menu, not by emptying it.
              disabled: exercise.sets.length <= 1,
              onclick: () => {
                exercise.sets.pop();
                persist();
                paint();
              },
            },
            renderIcon('trash', { size: 17 }),
            h('span', {}, 'Remove set'),
          ),
        ),
      );
    }

    const openAddExercise = () =>
      openExercisePicker((items) => {
        for (const item of items) {
          state.exercises.push({
            exercise_name: item.name,
            muscle_group: item.muscle_group,
            ...demoFields(item),
            target_sets: 3,
            target_reps: '',
            rest_seconds: 90,
            previous: item.previous ?? null,
            sets: [{ set_type: 'normal', weight_display: '', weight_kg: 0, reps: '', completed: false }],
          });
        }
        persist();
        paint();
      });

    async function finish() {
      const sets = state.exercises.flatMap((exercise) =>
        exercise.sets
          // Untouched rows are dropped: a member who added three sets and did two
          // should not have a 0 kg × 0 set in their history.
          .filter((set) => set.completed || Number(set.reps) > 0)
          .map((set, index) => ({
            exercise_name: exercise.exercise_name,
            muscle_group: exercise.muscle_group,
            set_number: index + 1,
            set_type: set.set_type,
            weight_kg: Number(set.weight_kg) || 0,
            reps: Number(set.reps) || 0,
            completed: Boolean(set.completed),
          })),
      );

      if (!sets.length) {
        toast('Tick at least one set before finishing', 'error');
        return;
      }

      const res = await api.portal.saveWorkoutLog({
        workout_name: state.workout_name,
        plan_id: state.plan_id ?? undefined,
        day_id: state.day_id ?? undefined,
        duration_seconds: Math.round((Date.now() - state.started_at) / 1000),
        sets,
      });

      teardown();
      activeSession.clear();
      reportWorkoutEnded();
      sound.playWorkoutComplete(res.prs && res.prs.length > 0);
      openSummary(res);
      await onFinish();
    }

    function openSummary(res) {
      openModal({
        title: 'Workout complete',
        body: h(
          'div',
          { class: 'portal-summary' },
          h('div', { class: 'portal-summary-burst' }, res.prs.length ? '🏆' : '💪'),
          h('h3', {}, res.prs.length ? `${res.prs.length} new personal record${res.prs.length === 1 ? '' : 's'}!` : 'Session logged'),
          h(
            'div',
            { class: 'portal-summary-grid' },
            h('div', {}, h('strong', {}, weightLabel(res.log.total_volume_kg)), h('span', {}, 'volume')),
            h('div', {}, h('strong', {}, String(res.log.total_sets)), h('span', {}, 'sets')),
            h('div', {}, h('strong', {}, String(res.log.total_reps)), h('span', {}, 'reps')),
            h('div', {}, h('strong', {}, minutesLabel(res.log.duration_seconds)), h('span', {}, 'duration')),
          ),
          res.log.calories_burned
            ? h(
                'div',
                { class: 'portal-summary-kcal' },
                renderIcon('flame', { size: 16, stroke: 2.2 }),
                h('strong', {}, `~${res.log.calories_burned} kcal burned`),
                h('span', {}, 'counted on your Diet tab'),
              )
            : null,
          res.prs.length
            ? h(
                'div',
                { class: 'portal-summary-prs' },
                ...res.prs.map((pr) =>
                  h(
                    'div',
                    { class: 'portal-pr-line' },
                    renderIcon('trophy', { size: 14 }),
                    h('strong', {}, pr.exercise_name),
                    h('span', {}, `${weightLabel(pr.weight_kg)} × ${pr.reps}`),
                    h(
                      'span',
                      { class: 'portal-pr-delta' },
                      pr.previous_est_1rm_kg
                        ? `+${Math.round((pr.est_1rm_kg - pr.previous_est_1rm_kg) * 10) / 10} kg 1RM`
                        : 'first record',
                    ),
                  ),
                ),
              )
            : null,
          h('button', { class: 'btn primary block', type: 'button', onclick: closeModal }, 'Done'),
        ),
      });
    }

    const metaNode = h('div', { class: 'portal-session-totals' });
    function paintMeta() {
      const t = totals();
      const stat = (icon, value, label) =>
        h(
          'div',
          { class: 'portal-session-stat' },
          h('div', { class: 'portal-session-stat-value' }, renderIcon(icon, { size: 20, stroke: 2.2 }), h('strong', {}, value)),
          h('span', {}, label),
        );
      clear(metaNode).append(
        stat('weight', weightLabel(Math.round(t.volume * 10) / 10), 'Volume'),
        stat('sets', String(t.sets), 'Sets'),
        stat('refresh', String(t.reps), 'Reps'),
      );
    }

    const finishBtn = h('button', { class: 'portal-session-btn is-finish', type: 'button' }, 'Finish');
    finishBtn.addEventListener('click', async () => {
      finishBtn.disabled = true;
      try {
        await finish();
      } catch (err) {
        toast(err.message || 'Could not save this workout', 'error');
        finishBtn.disabled = false;
      }
    });

    const confirmDiscard = () =>
      confirmDialog({
        title: 'Discard this workout?',
        message: 'Everything logged in this session is thrown away. This cannot be undone.',
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: async () => {
          teardown();
          activeSession.clear();
          reportWorkoutEnded();
          await onDiscard();
        },
      });

    function openRename() {
      const input = h('input', { class: 'portal-input', type: 'text', maxlength: 80, value: state.workout_name });
      const save = () => {
        const name = input.value.trim();
        if (!name) {
          toast('Give the workout a name', 'error');
          return;
        }
        state.workout_name = name;
        persist();
        closeModal();
        paint();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save();
      });
      openModal({
        title: 'Rename workout',
        body: input,
        footer: [
          h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
          h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save'),
        ],
      });
      input.select();
    }

    function openSessionMenu() {
      const other = weightUnit.get() === 'kg' ? 'lb' : 'kg';
      actionSheet('Workout options', [
        { icon: 'edit', label: 'Rename workout', onClick: openRename },
        {
          icon: 'weight',
          label: `Show weights in ${other}`,
          onClick: () => {
            weightUnit.set(other);
            // The typed boxes hold display units, so they are re-derived from
            // the kilograms underneath rather than relabelled.
            for (const set of state.exercises.flatMap((ex) => ex.sets)) {
              if (set.weight_display !== '' && set.weight_display != null) {
                set.weight_display = String(toDisplayWeight(Number(set.weight_kg) || 0));
              }
            }
            persist();
            paint();
          },
        },
        { icon: 'trash', label: 'Discard workout', danger: true, onClick: confirmDiscard },
      ]);
    }

    function paint() {
      const soundOn = sound.getSoundEnabled();
      clear(body).append(
        h(
          'div',
          { class: 'portal-session-bar' },
          h(
            'div',
            { class: 'portal-session-top' },
            h(
              'button',
              { class: 'portal-session-name', type: 'button', title: 'Rename workout', onclick: openRename },
              h('span', {}, state.workout_name),
              renderIcon('edit', { size: 17 }),
            ),
            h(
              'button',
              { class: 'portal-session-more', type: 'button', title: 'Workout options', 'aria-label': 'Workout options', onclick: openSessionMenu },
              renderIcon('more', { size: 22, stroke: 2.6 }),
            ),
          ),
          h(
            'div',
            { class: 'portal-session-row' },
            h('div', { class: 'portal-session-time' }, renderIcon('timer', { size: 20, stroke: 2 }), clockNode),
            h(
              'div',
              { class: 'portal-session-actions' },
              h(
                'button',
                {
                  class: 'portal-sound-toggle',
                  type: 'button',
                  'aria-label': soundOn ? 'Mute sounds' : 'Unmute sounds',
                  title: soundOn ? 'Mute sounds' : 'Unmute sounds',
                  onclick: () => {
                    sound.setSoundEnabled(!soundOn);
                    paint();
                  },
                },
                renderIcon(soundOn ? 'volume' : 'volumeX', { size: 17 }),
              ),
              h('button', { class: 'portal-session-btn is-discard', type: 'button', onclick: confirmDiscard }, 'Discard'),
              finishBtn,
            ),
          ),
        ),
        metaNode,
        ...state.exercises.map(exerciseCard),
        h(
          'button',
          { class: 'portal-add-ex', type: 'button', onclick: openAddExercise },
          renderIcon('plus', { size: 20, stroke: 2.2 }),
          h('span', {}, 'Add exercise'),
        ),
        rest.node,
      );
      paintMeta();
    }

    const paintClock = () => {
      clockNode.textContent = clockFrom((Date.now() - state.started_at) / 1000);
    };
    paintClock();
    clockInterval = setInterval(paintClock, 1000);

    paint();
    return body;
  }

  /* ---------------------------------------------------- Member-built plans */

  const REST_CHOICES = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300];
  const restLabel = (seconds) =>
    seconds === 0 ? 'Off' : seconds < 60 ? `${seconds}s` : seconds % 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds / 60} min`;
  const daysLabel = (count) => `${count} day${count === 1 ? '' : 's'}`;

  /** An exercise as the plan editor holds it: the fields the server stores,
   * plus the demo fields so the thumbnails still show. Takes a plan row
   * (exercise_name) or a picker row (name). */
  const editableExercise = (exercise) => ({
    exercise_name: exercise.exercise_name ?? exercise.name,
    muscle_group: exercise.muscle_group,
    target_sets: exercise.target_sets ?? 3,
    target_reps: exercise.target_reps ?? '8-12',
    rest_seconds: exercise.rest_seconds ?? 90,
    notes: exercise.notes ?? null,
    ...demoFields(exercise),
  });

  /**
   * Hevy's "Create routine", stretched to a week: a named plan of up to seven
   * days, each a list of exercises with target sets, reps and rest. Takes over
   * the tab body the way the live logger does — a builder this size is a
   * screen, not a sheet — and hands back to the Workout tab on save or cancel.
   * `plan` is a full tree to edit, or null for a new one.
   */
  function openPlanEditor(plan = null) {
    stopTicking();
    const isNew = !plan?.id;
    const draft = {
      name: plan?.name ?? '',
      description: plan?.description ?? '',
      days: plan?.days?.length
        ? plan.days.map((day) => ({ day_name: day.day_name, notes: day.notes ?? null, exercises: day.exercises.map(editableExercise) }))
        : [{ day_name: 'Day 1', notes: null, exercises: [] }],
      activate: true,
    };
    const pristine = JSON.stringify(draft);
    const body = h('div', { class: 'portal-tab-body portal-pe' });
    const leave = () => switchTab('workout');

    const cancel = () => {
      if (JSON.stringify(draft) === pristine) return leave();
      return confirmDialog({
        title: 'Discard changes?',
        message: isNew ? 'This plan has not been saved.' : 'Your edits to this plan will be lost.',
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: leave,
      });
    };

    /** The client-side half of the server's checks, so the common slips get a
     * message that names the day instead of a generic 400. */
    function problemWithDraft() {
      if (draft.name.trim().length < 2) return 'Give your plan a name';
      for (const [index, day] of draft.days.entries()) {
        if (!day.day_name.trim()) return `Give day ${index + 1} a name`;
        if (!day.exercises.length) return `Add at least one exercise to ${day.day_name.trim()}`;
      }
      return null;
    }

    const saveBtn = h('button', { class: 'portal-session-btn is-finish', type: 'button' }, 'Save');
    saveBtn.addEventListener('click', async () => {
      const problem = problemWithDraft();
      if (problem) {
        toast(problem, 'error');
        return;
      }
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        days: draft.days.map((day) => ({
          day_name: day.day_name.trim(),
          notes: day.notes,
          exercises: day.exercises.map((e) => ({
            exercise_name: e.exercise_name,
            muscle_group: e.muscle_group,
            target_sets: e.target_sets,
            target_reps: String(e.target_reps).trim() || '8-12',
            rest_seconds: e.rest_seconds,
            notes: e.notes,
          })),
        })),
      };
      saveBtn.disabled = true;
      try {
        if (isNew) {
          const saved = await api.portal.createRoutine({ ...payload, activate: draft.activate });
          toast(saved.active ? `Saved — you're now training with ${saved.name}` : 'Plan saved');
        } else {
          await api.portal.updateRoutine(plan.id, payload);
          toast('Plan updated');
        }
        await leave();
      } catch (err) {
        toast(err.message || 'Could not save this plan', 'error');
        saveBtn.disabled = false;
      }
    });

    const move = (list, from, to) => {
      if (to < 0 || to >= list.length) return;
      list.splice(to, 0, list.splice(from, 1)[0]);
      paint();
    };

    function openDayMenu(dayIndex) {
      const day = draft.days[dayIndex];
      const removeDay = () => {
        draft.days.splice(dayIndex, 1);
        paint();
      };
      actionSheet(day.day_name.trim() || `Day ${dayIndex + 1}`, [
        { icon: 'arrowUp', label: 'Move day up', disabled: dayIndex === 0, onClick: () => move(draft.days, dayIndex, dayIndex - 1) },
        { icon: 'arrowDown', label: 'Move day down', disabled: dayIndex === draft.days.length - 1, onClick: () => move(draft.days, dayIndex, dayIndex + 1) },
        {
          icon: 'copy',
          label: 'Duplicate day',
          disabled: draft.days.length >= 7,
          onClick: () => {
            draft.days.splice(dayIndex + 1, 0, {
              ...day,
              day_name: `${day.day_name.trim()} (copy)`.slice(0, 120),
              exercises: day.exercises.map((e) => ({ ...e })),
            });
            paint();
          },
        },
        {
          icon: 'trash',
          label: 'Delete day',
          danger: true,
          disabled: draft.days.length === 1,
          onClick: () =>
            day.exercises.length
              ? confirmDialog({
                  title: 'Delete this day?',
                  message: `${day.day_name.trim() || 'This day'} and its ${day.exercises.length} exercise${day.exercises.length === 1 ? '' : 's'} are removed from the plan.`,
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: removeDay,
                })
              : removeDay(),
        },
      ]);
    }

    function openExerciseMenu(day, exIndex) {
      actionSheet(day.exercises[exIndex].exercise_name, [
        { icon: 'arrowUp', label: 'Move up', disabled: exIndex === 0, onClick: () => move(day.exercises, exIndex, exIndex - 1) },
        { icon: 'arrowDown', label: 'Move down', disabled: exIndex === day.exercises.length - 1, onClick: () => move(day.exercises, exIndex, exIndex + 1) },
        {
          icon: 'trash',
          label: 'Remove exercise',
          danger: true,
          onClick: () => {
            day.exercises.splice(exIndex, 1);
            paint();
          },
        },
      ]);
    }

    /** Sets, reps and rest under one exercise. Edited in place — the draft
     * changes but nothing repaints, so typing never loses focus. */
    function targetFields(exercise) {
      const setsValue = h('strong', { class: 'portal-pe-sets-value' }, String(exercise.target_sets));
      const step = (delta) => {
        exercise.target_sets = Math.min(20, Math.max(1, exercise.target_sets + delta));
        setsValue.textContent = String(exercise.target_sets);
      };
      const rests = REST_CHOICES.includes(exercise.rest_seconds) ? REST_CHOICES : [...REST_CHOICES, exercise.rest_seconds].sort((a, b) => a - b);
      const field = (label, control) => h('label', { class: 'portal-pe-field' }, h('span', {}, label), control);

      return h(
        'div',
        { class: 'portal-pe-targets' },
        field(
          'Sets',
          h(
            'div',
            { class: 'portal-pe-stepper' },
            h('button', { type: 'button', 'aria-label': 'One set fewer', onclick: () => step(-1) }, '−'),
            setsValue,
            h('button', { type: 'button', 'aria-label': 'One set more', onclick: () => step(1) }, '+'),
          ),
        ),
        field(
          'Reps',
          h('input', {
            class: 'portal-pe-input',
            type: 'text',
            inputmode: 'text',
            maxlength: 30,
            placeholder: '8-12',
            value: exercise.target_reps,
            oninput: (event) => {
              exercise.target_reps = event.target.value;
            },
          }),
        ),
        field(
          'Rest',
          h(
            'select',
            {
              class: 'portal-pe-input',
              onchange: (event) => {
                exercise.rest_seconds = Number(event.target.value);
              },
            },
            ...rests.map((seconds) =>
              h('option', { value: String(seconds), selected: seconds === exercise.rest_seconds }, restLabel(seconds)),
            ),
          ),
        ),
      );
    }

    function exerciseRow(day, exercise, exIndex) {
      return h(
        'div',
        { class: 'portal-pe-ex' },
        h(
          'div',
          { class: 'portal-pe-ex-head' },
          exerciseThumbButton(exercise),
          h(
            'div',
            { class: 'portal-pe-ex-title' },
            h('div', { class: 'portal-ex-name' }, exercise.exercise_name),
            h('span', { class: 'portal-muscle-badge', 'data-m': exercise.muscle_group }, muscleLabel(exercise.muscle_group)),
          ),
          h(
            'button',
            { class: 'portal-ex-menu', type: 'button', 'aria-label': `${exercise.exercise_name} options`, onclick: () => openExerciseMenu(day, exIndex) },
            renderIcon('more', { size: 20 }),
          ),
        ),
        targetFields(exercise),
      );
    }

    function dayCard(day, dayIndex) {
      return h(
        'section',
        { class: 'portal-pe-day' },
        h(
          'div',
          { class: 'portal-pe-day-head' },
          h('span', { class: 'portal-pe-day-num' }, String(dayIndex + 1)),
          h('input', {
            class: 'portal-pe-day-name',
            type: 'text',
            maxlength: 120,
            placeholder: 'Day name, e.g. Push',
            'aria-label': `Day ${dayIndex + 1} name`,
            value: day.day_name,
            oninput: (event) => {
              day.day_name = event.target.value;
            },
          }),
          h(
            'button',
            { class: 'portal-ex-menu', type: 'button', 'aria-label': 'Day options', onclick: () => openDayMenu(dayIndex) },
            renderIcon('more', { size: 20 }),
          ),
        ),
        ...(day.exercises.length
          ? day.exercises.map((exercise, exIndex) => exerciseRow(day, exercise, exIndex))
          : [h('p', { class: 'portal-pe-empty' }, 'No exercises yet — add the ones you want to train on this day.')]),
        h(
          'button',
          {
            class: 'portal-add-ex',
            type: 'button',
            onclick: () =>
              openExercisePicker(
                (items) => {
                  day.exercises.push(...items.map(editableExercise));
                  paint();
                },
                { title: `Add to ${day.day_name.trim() || `day ${dayIndex + 1}`}` },
              ),
          },
          renderIcon('plus', { size: 20, stroke: 2.2 }),
          h('span', {}, 'Add exercises'),
        ),
      );
    }

    function paint() {
      append(clear(body), [
        h(
          'div',
          { class: 'portal-session-bar' },
          h(
            'div',
            { class: 'portal-session-row' },
            h('button', { class: 'portal-session-btn is-discard', type: 'button', onclick: cancel }, 'Cancel'),
            h('strong', { class: 'portal-pe-title' }, isNew ? 'New plan' : 'Edit plan'),
            saveBtn,
          ),
        ),
        h(
          'div',
          { class: 'portal-pe-head' },
          h('input', {
            class: 'portal-input portal-pe-name',
            type: 'text',
            maxlength: 100,
            placeholder: 'Plan name, e.g. My Push Pull Legs',
            'aria-label': 'Plan name',
            value: draft.name,
            oninput: (event) => {
              draft.name = event.target.value;
            },
          }),
          h(
            'textarea',
            {
              class: 'portal-input portal-pe-notes',
              rows: 2,
              maxlength: 1000,
              placeholder: 'Notes (optional)',
              'aria-label': 'Plan notes',
              oninput: (event) => {
                draft.description = event.target.value;
              },
            },
            draft.description,
          ),
        ),
        ...draft.days.map(dayCard),
        draft.days.length < 7
          ? h(
              'button',
              {
                class: 'btn ghost block portal-pe-add-day',
                type: 'button',
                onclick: () => {
                  draft.days.push({ day_name: `Day ${draft.days.length + 1}`, notes: null, exercises: [] });
                  paint();
                  body.querySelectorAll('.portal-pe-day-name')[draft.days.length - 1]?.select();
                },
              },
              renderIcon('plus', { size: 16 }),
              ' Add day',
            )
          : h('p', { class: 'portal-pe-empty' }, 'A plan holds up to seven days.'),
        isNew
          ? h(
              'div',
              { class: 'portal-pe-toggle' },
              h(
                'div',
                {},
                h('strong', {}, 'Train with this plan now'),
                h('small', {}, "Your trainer's plan stays — you can switch back any time."),
              ),
              settingsSwitch(draft.activate, 'Train with this plan now', () => {
                draft.activate = !draft.activate;
                paint();
              }),
            )
          : null,
        isNew
          ? null
          : h(
              'button',
              {
                class: 'btn danger block',
                type: 'button',
                onclick: () =>
                  confirmDialog({
                    title: 'Delete this plan?',
                    message: 'The plan is removed. Workouts you logged with it stay in your history.',
                    confirmLabel: 'Delete',
                    danger: true,
                    onConfirm: async () => {
                      await api.portal.deleteRoutine(plan.id);
                      toast('Plan deleted');
                      await leave();
                    },
                  }),
              },
              'Delete plan',
            ),
      ]);
    }

    paint();
    clear(content).append(body);
    content.scrollTop = 0;
  }

  /** Points the Workout tab at a plan: one of the member's own, or null for
   * the trainer's. */
  async function useWorkoutPlan(planId, name) {
    try {
      await api.portal.setActivePlan(planId);
      toast(`Now training with ${name}`);
      await switchTab('workout');
    } catch (err) {
      toast(err.message || 'Could not switch plans', 'error');
    }
  }

  /** Copies a plan (the trainer's, or one of the member's own) into a new plan
   * of theirs and opens it in the editor — the trainer's copy is untouched. */
  async function copyPlanToEdit(planId) {
    try {
      const copy = await api.portal.copyRoutine({ plan_id: planId });
      toast('Copied to your plans — make it yours');
      openPlanEditor(copy);
    } catch (err) {
      toast(err.message || 'Could not copy that plan', 'error');
    }
  }

  async function editOwnPlan(planId) {
    try {
      openPlanEditor(await api.portal.routine(planId));
    } catch (err) {
      toast(err.message || 'Could not open that plan', 'error');
    }
  }

  const isActivePlan = (routines, source, planId) =>
    routines.active.source === source && (source === 'trainer' || routines.active.plan_id === planId);

  /** The "Switch" sheet on the routine card: every plan the member can follow,
   * a tick on the live one, and a way to start a new one. */
  function openPlanSwitcher(routines) {
    const { trainer, items } = routines;
    actionSheet('Switch plan', [
      trainer && {
        icon: isActivePlan(routines, 'trainer') ? 'check' : 'crown',
        label: `${trainer.plan_name} · trainer`,
        disabled: isActivePlan(routines, 'trainer'),
        onClick: () => useWorkoutPlan(null, trainer.plan_name),
      },
      ...items.map((plan) => ({
        icon: isActivePlan(routines, 'own', plan.id) ? 'check' : 'weight',
        label: plan.name,
        disabled: isActivePlan(routines, 'own', plan.id),
        onClick: () => useWorkoutPlan(plan.id, plan.name),
      })),
      { icon: 'plus', label: 'Create a new plan', onClick: () => openPlanEditor() },
    ]);
  }

  /** The member's plans on the Workout tab: the trainer's on top, their own
   * below, the live one marked and every other one a tap away. */
  function myPlansSection(routines) {
    const { trainer, items } = routines;

    const planRow = ({ icon, tone, title, sub, active, onUse, actions }) =>
      h(
        'div',
        { class: `portal-myplan tone-${tone}${active ? ' is-active' : ''}` },
        h('span', { class: 'portal-myplan-ico' }, renderIcon(icon, { size: 20 })),
        h('div', { class: 'portal-myplan-text' }, h('strong', {}, title), h('small', {}, sub)),
        active
          ? h('span', { class: 'portal-myplan-active' }, renderIcon('check', { size: 13, stroke: 2.8 }), 'Active')
          : h('button', { class: 'portal-myplan-use', type: 'button', onclick: onUse }, 'Use'),
        h(
          'button',
          { class: 'portal-ex-menu', type: 'button', 'aria-label': `${title} options`, onclick: () => actionSheet(title, actions) },
          renderIcon('more', { size: 20 }),
        ),
      );

    const rows = [];
    if (trainer) {
      const active = isActivePlan(routines, 'trainer');
      rows.push(
        planRow({
          icon: 'crown',
          tone: 'purple',
          title: trainer.plan_name,
          sub: [trainer.assigned_by_name ? `From ${trainer.assigned_by_name}` : 'From your trainer', daysLabel(trainer.day_count)].join(' · '),
          active,
          onUse: () => useWorkoutPlan(null, trainer.plan_name),
          actions: [
            !active && { icon: 'check', label: 'Train with this plan', onClick: () => useWorkoutPlan(null, trainer.plan_name) },
            { icon: 'copy', label: 'Copy to my plans & edit', onClick: () => copyPlanToEdit(trainer.plan_id) },
          ],
        }),
      );
    }
    for (const plan of items) {
      const active = isActivePlan(routines, 'own', plan.id);
      rows.push(
        planRow({
          icon: 'weight',
          tone: 'orange',
          title: plan.name,
          sub: `Your plan · ${daysLabel(plan.day_count)} · ${plan.exercise_count} exercise${plan.exercise_count === 1 ? '' : 's'}`,
          active,
          onUse: () => useWorkoutPlan(plan.id, plan.name),
          actions: [
            !active && { icon: 'check', label: 'Train with this plan', onClick: () => useWorkoutPlan(plan.id, plan.name) },
            { icon: 'edit', label: 'Edit plan', onClick: () => editOwnPlan(plan.id) },
            { icon: 'copy', label: 'Duplicate', onClick: () => copyPlanToEdit(plan.id) },
            {
              icon: 'trash',
              label: 'Delete plan',
              danger: true,
              onClick: () =>
                confirmDialog({
                  title: `Delete ${plan.name}?`,
                  message: active
                    ? `Workouts you logged with it stay in your history.${trainer ? " You'll go back to your trainer's plan." : ''}`
                    : 'Workouts you logged with it stay in your history.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: async () => {
                    await api.portal.deleteRoutine(plan.id);
                    toast('Plan deleted');
                    await switchTab('workout');
                  },
                }),
            },
          ],
        }),
      );
    }

    return h(
      'div',
      { class: 'portal-section portal-myplans' },
      sectionHead('My plans', 'New plan', () => openPlanEditor(), 'is-label'),
      rows.length ? h('div', { class: 'portal-myplan-list' }, ...rows) : null,
      items.length
        ? null
        : h(
            'button',
            { class: 'portal-myplan-create', type: 'button', onclick: () => openPlanEditor() },
            h('span', { class: 'portal-myplan-ico' }, renderIcon('plus', { size: 22, stroke: 2.4 })),
            h(
              'span',
              { class: 'portal-myplan-text' },
              h('strong', {}, 'Build your own plan'),
              h(
                'small',
                {},
                trainer
                  ? "Pick your exercises and set your own sets, reps and rest. Switch between it and your trainer's plan any time."
                  : 'Pick your exercises and set your own sets, reps and rest for each day.',
              ),
            ),
          ),
    );
  }

  async function renderWorkoutTab() {
    const status = await api.portal.fitnessStatus();
    if (!status.has_access) return upgradeSheet(status, { onRefresh: () => switchTab('workout') });

    // A session interrupted by a locked phone or a closed tab resumes exactly
    // where it was, which is the whole reason it is mirrored to localStorage.
    const resumed = activeSession.read();
    if (resumed) {
      // Re-reported on resume: the start may never have reached the server
      // (offline gym floor), and the same started_at does not re-arm a nudge.
      reportWorkoutStarted(resumed);
      return renderActiveWorkout(resumed, {
        onFinish: () => switchTab('workout'),
        onDiscard: () => switchTab('workout'),
      });
    }

    const [current, history, prs, routines] = await Promise.all([
      api.portal.currentWorkout(),
      api.portal.workoutLogs({ limit: 20 }),
      api.portal.personalRecords(),
      api.portal.routines(),
    ]);

    const body = h('div', { class: 'portal-tab-body' });

    const startSession = (name, day) =>
      startWorkoutSession({ name, day, planId: current.plan?.id, previous: current.previous });

    const startButton = (label, onclick) =>
      h(
        'button',
        { class: 'btn primary block portal-start-btn portal-routine-start', type: 'button', onclick },
        renderIcon('play', { size: 18 }),
        h('span', {}, label),
        renderIcon('arrowRight', { size: 18 }),
      );

    /* Today's routine */
    if (current.today_day) {
      const day = current.today_day;
      const groups = [...new Set(day.exercises.map((e) => e.muscle_group))];
      const otherDays = current.plan.days.filter((d) => d.id !== day.id);

      body.append(
        h(
          'div',
          { class: 'portal-routine-card' },
          h(
            'div',
            { class: 'portal-routine-hero has-switch' },
            h('img', { class: 'portal-routine-art', src: '/images/workout/hero-pull-down.png', alt: '' }),
            h(
              'button',
              { class: 'portal-routine-switch', type: 'button', onclick: () => openPlanSwitcher(routines) },
              renderIcon('refresh', { size: 14, stroke: 2.4 }),
              h('span', {}, 'Switch'),
            ),
            h(
              'div',
              { class: 'portal-routine-kicker' },
              renderIcon(current.source === 'own' ? 'member' : 'weight', { size: 20 }),
              h('span', {}, current.plan.name),
            ),
            h('div', { class: 'portal-routine-source' }, current.source === 'own' ? 'Your own plan' : "Your trainer's plan"),
            h('h2', { class: 'portal-routine-day' }, day.day_name),
            day.notes ? h('p', { class: 'portal-routine-note' }, day.notes) : null,
            h(
              'div',
              { class: 'portal-routine-chips' },
              ...groups.map((group) => h('span', { class: 'portal-muscle-badge', 'data-m': group }, muscleLabel(group))),
              h('span', { class: 'portal-routine-count' }, `${day.exercises.length} exercise${day.exercises.length === 1 ? '' : 's'}`),
            ),
          ),
          h(
            'div',
            { class: 'portal-routine-sheet' },
            h('div', { class: 'portal-routine-exercises' }, ...day.exercises.map(routineExerciseRow)),
            startButton('Start workout', () => startSession(day.day_name, day)),
          ),
        ),
      );

      if (otherDays.length) {
        const openAllDays = () => {
          const modal = openModal({
            title: current.plan.name,
            body: dayCardGrid(current.plan.days, (d) => {
              closeModal();
              startSession(d.day_name, d);
            }),
          });
          modal.classList.add('portal-days-modal');
        };
        body.append(
          sectionHead('Or train another day', 'View all days', openAllDays, 'is-label'),
          dayCardGrid(otherDays, (d) => startSession(d.day_name, d)),
        );
      }
    } else {
      body.append(
        h(
          'div',
          { class: 'portal-routine-card' },
          h(
            'div',
            { class: 'portal-routine-hero is-plain' },
            h('h2', { class: 'portal-routine-day' }, 'No routine yet'),
            h(
              'p',
              { class: 'portal-routine-note' },
              'Build your own plan, ask a trainer to put you on one — or start a freestyle session and log whatever you do today.',
            ),
          ),
          h(
            'div',
            { class: 'portal-routine-sheet' },
            startButton('Start a freestyle workout', () => startSession('Freestyle workout', null)),
            h(
              'button',
              { class: 'btn ghost block portal-pe-add-day', type: 'button', onclick: () => openPlanEditor() },
              renderIcon('plus', { size: 16 }),
              ' Create your own plan',
            ),
          ),
        ),
      );
    }

    body.append(myPlansSection(routines));

    /* Lifetime stats */
    body.append(
      sectionHead("Today's stats", null, null, 'is-label'),
      h(
        'div',
        { class: 'portal-stat-row' },
        miniStat('weight', history.stats.total_workouts, 'Workouts', 'orange'),
        miniStat('trendUp', Math.round(history.stats.lifetime_volume_kg / 1000), 'Tonnes lifted', 'green'),
        miniStat('trophy', prs.items.length, 'Records', 'orange'),
      ),
    );

    /* PR wall: the best lift, with the rest behind "View all" */
    if (prs.items.length) {
      const best = prs.items[0];
      const openAllRecords = () =>
        openModal({
          title: 'Personal records',
          body: h(
            'div',
            { class: 'portal-pr-wall' },
            ...prs.items.map((pr) =>
              h(
                'button',
                { class: 'portal-pr-card', type: 'button', title: 'See progress', onclick: () => openExerciseDetail(pr) },
                h('div', { class: 'portal-pr-trophy' }, renderIcon('trophy', { size: 15 })),
                h('div', { class: 'portal-pr-name' }, pr.exercise_name),
                h('div', { class: 'portal-pr-value' }, `${weightLabel(pr.max_weight_kg)} × ${pr.max_reps}`),
                h('div', { class: 'portal-pr-1rm' }, `~${weightLabel(pr.est_1rm_kg)} 1RM`),
              ),
            ),
          ),
        });

      body.append(
        sectionHead('Personal records', 'View all', openAllRecords, 'is-label'),
        h(
          'button',
          { class: 'portal-pr-feature', type: 'button', title: 'See progress', onclick: () => openExerciseDetail(best) },
          h(
            'div',
            { class: 'portal-pr-feature-art', 'aria-hidden': 'true' },
            h('img', { src: '/images/workout/pr-barbell.png', alt: '', width: 205, height: 74 }),
            h('span', { class: 'portal-pr-feature-badge' }, renderIcon('crown', { size: 15 }), 'PR'),
          ),
          h('div', { class: 'portal-pr-feature-icon' }, renderIcon('trophy', { size: 24 })),
          h(
            'div',
            { class: 'portal-pr-feature-info' },
            h('div', { class: 'portal-pr-feature-name' }, best.exercise_name),
            h('div', { class: 'portal-pr-feature-value' }, `${weightLabel(best.max_weight_kg)} × ${best.max_reps}`),
            h('div', { class: 'portal-pr-feature-1rm' }, `~${weightLabel(best.est_1rm_kg)} 1RM`),
          ),
        ),
      );
    }

    /* History */
    body.append(h('h3', { class: 'portal-section-title' }, 'Recent workouts'));
    body.append(
      history.items.length
        ? h(
            'div',
            { class: 'portal-section' },
            ...history.items.map((log) =>
              h(
                'button',
                {
                  class: 'portal-log-row',
                  type: 'button',
                  onclick: async () => {
                    try {
                      const full = await api.portal.workoutLog(log.id);
                      openWorkoutLogDetail(full, () => switchTab('workout'));
                    } catch (err) {
                      toast(err.message || 'Could not open that workout', 'error');
                    }
                  },
                },
                h('div', { class: 'portal-log-icon' }, renderIcon('weight', { size: 15 })),
                h(
                  'div',
                  { class: 'portal-log-meta' },
                  h('div', { class: 'portal-log-name' }, log.workout_name),
                  h('div', { class: 'muted' }, `${date(log.log_date)} · ${minutesLabel(log.duration_seconds)} · ${log.total_sets} sets`),
                ),
                h(
                  'div',
                  { class: 'portal-log-right' },
                  h('div', { class: 'portal-log-volume' }, weightLabel(log.total_volume_kg)),
                  log.pr_count ? h('span', { class: 'badge amber' }, `${log.pr_count} PR`) : null,
                ),
              ),
            ),
          )
        : h('div', { class: 'portal-empty' }, 'No workouts logged yet — your first session will show up here.'),
    );

    /* Units */
    body.append(
      h(
        'button',
        {
          class: 'btn ghost block portal-settings-btn',
          type: 'button',
          onclick: () => {
            weightUnit.set(weightUnit.get() === 'kg' ? 'lb' : 'kg');
            switchTab('workout');
          },
        },
        renderIcon('weight', { size: 15 }),
        ` Show weights in ${weightUnit.get() === 'kg' ? 'pounds' : 'kilograms'}`,
      ),
    );

    return body;
  }

  function openWorkoutLogDetail(log, onDeleted) {
    const byExercise = new Map();
    for (const set of log.sets) {
      if (!byExercise.has(set.exercise_name)) byExercise.set(set.exercise_name, []);
      byExercise.get(set.exercise_name).push(set);
    }

    openModal({
      title: log.workout_name,
      body: h(
        'div',
        { class: 'portal-log-detail' },
        h(
          'div',
          { class: 'portal-summary-grid' },
          h('div', {}, h('strong', {}, weightLabel(log.total_volume_kg)), h('span', {}, 'volume')),
          h('div', {}, h('strong', {}, String(log.total_sets)), h('span', {}, 'sets')),
          h('div', {}, h('strong', {}, String(log.total_reps)), h('span', {}, 'reps')),
          h('div', {}, h('strong', {}, minutesLabel(log.duration_seconds)), h('span', {}, 'duration')),
        ),
        ...[...byExercise].map(([name, sets]) =>
          h(
            'div',
            { class: 'portal-log-ex' },
            h('h4', {}, name),
            ...sets.map((set) =>
              h(
                'div',
                { class: 'portal-log-set' },
                h('span', { class: `portal-set-type t-${set.set_type}` }, SET_TYPES.find((t) => t.key === set.set_type)?.short ?? '—'),
                h('span', {}, `${weightLabel(set.weight_kg)} × ${set.reps}`),
                set.is_pr ? h('span', { class: 'badge amber' }, 'PR') : null,
                h('span', { class: 'muted' }, set.est_1rm_kg ? `~${weightLabel(set.est_1rm_kg)} 1RM` : ''),
              ),
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'btn danger block',
            type: 'button',
            onclick: () =>
              confirmDialog({
                title: 'Delete this workout?',
                message: 'The session is removed from your history. Records you set stay on your wall.',
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: async () => {
                  await api.portal.deleteWorkoutLog(log.id);
                  toast('Workout deleted');
                  closeModal();
                  await onDeleted();
                },
              }),
          },
          'Delete this workout',
        ),
      ),
    });
  }

  /* -------------------------------------------------------------- Diet tab */

  /** The trainer's full plan in a sheet — the "View plan" link and the plan row
   * both open it. Read-only: the member logs against it from the meal cards. */
  function openPlanSheet(plan, targets) {
    const total = (meal) => meal.items.reduce((sum, item) => sum + (Number(item.calories) || 0), 0);
    openModal({
      title: plan.name,
      body: h(
        'div',
        { class: 'portal-plan-sheet' },
        h(
          'div',
          { class: 'portal-plan-targets' },
          ...[
            [targets.target_calories, 'kcal'],
            [`${targets.target_protein_g}g`, 'Protein'],
            [`${targets.target_carbs_g}g`, 'Carbs'],
            [`${targets.target_fats_g}g`, 'Fats'],
          ].map(([value, label]) => h('div', {}, h('strong', {}, String(value)), h('span', {}, label))),
        ),
        ...(plan.meals.length
          ? plan.meals.map((meal) =>
              h(
                'div',
                { class: 'portal-trainer-box' },
                h(
                  'div',
                  { class: 'portal-trainer-label' },
                  h('span', {}, meal.meal_name),
                  h('span', {}, `${total(meal)} kcal`),
                ),
                ...meal.items.map((item) =>
                  h(
                    'div',
                    { class: 'portal-planned-row' },
                    h('span', {}, item.food_name),
                    h('span', { class: 'muted' }, `${item.portion_size} · ${item.calories} kcal`),
                  ),
                ),
              ),
            )
          : [h('div', { class: 'portal-empty' }, 'Your trainer has not added meals to this plan yet.')]),
      ),
    });
  }

  /** One meal's art. Both themes are in the DOM and CSS picks one, because the
   * light/dark switch is a body attribute rather than a media query, and the
   * member can flip it without leaving the tab. Snacks art stands in for the
   * pre/post-workout slots, which have none of their own. */
  const mealArt = (slotKey) => {
    const base = ['breakfast', 'lunch', 'dinner'].includes(slotKey) ? slotKey : 'snacks';
    const img = (cls, suffix) =>
      h('img', { class: cls, src: `/images/diet/meal-${base}${suffix}.png`, alt: '', width: 400, height: 315, loading: 'lazy' });
    return h('div', { class: 'portal-meal-art', 'aria-hidden': 'true' }, img('art-light', ''), img('art-dark', '-dark'));
  };

  /** A macro row: coloured badge, label, "eaten / target g", progress bar. */
  const dietMacro = (label, eaten, target, tone, glyph) => {
    const pct = target > 0 ? Math.min((eaten / target) * 100, 100) : 0;
    return h(
      'div',
      { class: `portal-dmacro ${tone}` },
      h('div', { class: 'portal-dmacro-badge' }, glyph ?? h('i')),
      h(
        'div',
        { class: 'portal-dmacro-body' },
        h(
          'div',
          { class: 'portal-dmacro-top' },
          h('span', { class: 'portal-dmacro-label' }, label),
          h('span', { class: 'portal-dmacro-value' }, `${Math.round(eaten)} / ${target}g`),
        ),
        h('div', { class: 'portal-dmacro-bar' }, h('i', { style: `width:${pct}%` })),
      ),
    );
  };

  async function renderDietTab() {
    const status = await api.portal.fitnessStatus();
    if (!status.has_access) return upgradeSheet(status, { onRefresh: () => switchTab('diet') });

    let logDate = dietDate;
    const [plan, day, weights] = await Promise.all([
      api.portal.currentDiet(),
      api.portal.dietDay(logDate),
      api.portal.weightLog({ days: 90 }).catch(() => null),
    ]);
    const targets = plan.targets;
    // The ring is measured against the day's whole budget: the goal plus the
    // share of exercise the member chose to eat back.
    const budgetTotal = day.budget.goal + day.budget.exercise;
    const openSettings = () =>
      openNutritionSettings({ onSaved: reload }).catch((err) => toast(err.message || 'Could not open diet settings', 'error'));

    // `added` is the macros of a food entry that just went in — undefined for a
    // deletion or a water bump, which can only move totals away from target.
    // Comparing the pre-add snapshot still held in `day` against the delta
    // catches the exact moment a target is crossed without a second fetch.
    const reload = async (added) => {
      if (added) {
        const crossedCalories = day.totals.calories < budgetTotal
          && day.totals.calories + (added.calories || 0) >= budgetTotal;
        const crossedProtein = day.totals.protein_g < targets.target_protein_g
          && day.totals.protein_g + (added.protein_g || 0) >= targets.target_protein_g;
        if (crossedCalories || crossedProtein) sound.playTargetReached();
      }
      dietDate = logDate;
      await refreshTab('diet');
    };

    const body = h('div', { class: 'portal-tab-body portal-diet' });

    /* Date carousel: the last week, oldest first, ending today */
    const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 6));
    let activePill;
    const strip = h(
      'div',
      { class: 'portal-day-strip' },
      ...days.map((iso) => {
        const lbl = dayLabel(iso);
        const pill = h(
          'button',
          {
            class: `portal-day-pill${iso === logDate ? ' active' : ''}${iso === today() ? ' is-today' : ''}`,
            type: 'button',
            'aria-pressed': iso === logDate ? 'true' : 'false',
            onclick: () => {
              logDate = iso;
              reload();
            },
          },
          h('span', {}, iso === today() ? 'Today' : lbl.weekday),
          h('strong', {}, String(lbl.day)),
        );
        if (iso === logDate) activePill = pill;
        return pill;
      }),
    );
    body.append(strip);
    // The week fits a normal phone, but a narrow one overflows and would open
    // on the oldest day. Deferred a frame: no scrollWidth until it is mounted.
    if (activePill) {
      requestAnimationFrame(() => {
        strip.scrollLeft = Math.max(0, activePill.offsetLeft + activePill.offsetWidth - strip.clientWidth);
      });
    }

    /* Hero: calorie ring + macro bars. The budget sum, fibre, sugar and the
       rest live on the insights screen — this card stays one glance. */
    body.append(
      h(
        'section',
        { class: 'portal-diet-hero' },
        calorieRing(day.totals.calories, budgetTotal, { size: 168, stroke: 12, icon: 'flame' }),
        h(
          'div',
          { class: 'portal-dmacro-stack' },
          dietMacro('Protein', day.totals.protein_g, targets.target_protein_g, 'protein', renderIcon('droplet', { size: 13, stroke: 2.4 })),
          dietMacro('Carbs', day.totals.carbs_g, targets.target_carbs_g, 'carbs'),
          dietMacro('Fats', day.totals.fats_g, targets.target_fats_g, 'fats', renderIcon('droplet', { size: 13, stroke: 2.4 })),
        ),
        h(
          'button',
          {
            class: 'portal-insights-link',
            type: 'button',
            onclick: () =>
              openScreen({
                title: 'Nutrition insights',
                subtitle: logDate === today() ? 'Today' : longDate(logDate),
                render: () => buildNutritionInsights({ day, targets, logDate }),
              }),
          },
          renderIcon('barChart', { size: 17 }),
          h('span', {}, 'Nutrition insights'),
          renderIcon('chevronRight', { size: 16 }),
        ),
      ),
    );

    // Where today's numbers come from, and the way into Diet settings.
    const planRow = (() => {
      if (plan.target_source === 'trainer' && plan.plan) {
        return h(
          'button',
          { class: 'portal-plan-row', type: 'button', onclick: () => openPlanSheet(plan.plan, targets) },
          h('span', { class: 'portal-plan-ico' }, renderIcon('target', { size: 22 })),
          h('span', { class: 'portal-plan-text' }, `Plan: ${plan.plan.name}`),
          renderIcon('chevronRight', { size: 18 }),
        );
      }
      const text = plan.target_source === 'own'
        ? `My targets · ${targets.target_calories} kcal`
        : `Default targets — ${targets.target_calories} kcal. Tap to set your own.`;
      return h(
        'button',
        { class: `portal-plan-row${plan.target_source === 'default' ? ' static' : ''}`, type: 'button', onclick: openSettings },
        h('span', { class: 'portal-plan-ico' }, renderIcon(plan.target_source === 'own' ? 'user' : 'target', { size: 22 })),
        h('span', { class: 'portal-plan-text' }, text),
        renderIcon('chevronRight', { size: 18 }),
      );
    })();
    body.append(
      h(
        'div',
        { class: 'portal-plan-wrap' },
        planRow,
        h(
          'button',
          { class: 'portal-plan-gear', type: 'button', 'aria-label': 'Diet settings', title: 'Diet settings', onclick: openSettings },
          renderIcon('settings', { size: 20 }),
        ),
      ),
    );

    /* Exercise & weight: one compact row of tiles with the detail in sheets,
       so the meals sit close under the summary — logging food is what this
       tab is opened for most. */
    const ex = day.exercise;

    /** Leaves the sheet before the tab repaints underneath it, so nothing
     * stale is left on screen. */
    const fromSheet = (fn) => () => {
      closeModal();
      fn();
    };

    function openExerciseSheet() {
      const exRow = ({ icon, name, meta, kcal, onRemove }) =>
        h(
          'div',
          { class: 'portal-ex-row' },
          h('span', { class: 'portal-ex-ico' }, renderIcon(icon, { size: 17 })),
          h('div', { class: 'portal-ex-text' }, h('strong', {}, name), h('small', {}, meta)),
          h('span', { class: 'portal-ex-kcal' }, `${kcal} kcal`),
          onRemove
            ? h(
                'button',
                {
                  class: 'icon-btn',
                  type: 'button',
                  'aria-label': `Remove ${name}`,
                  onclick: async (event) => {
                    event.currentTarget.disabled = true;
                    try {
                      await onRemove();
                      closeModal();
                      toast(`${name} removed`);
                      await reload();
                    } catch (err) {
                      toast(err.message || 'Could not remove that', 'error');
                      event.currentTarget.disabled = false;
                    }
                  },
                },
                renderIcon('close', { size: 14 }),
              )
            : null,
        );
      const addbackNote = ex.addback_pct === 0
        ? 'Not added to your food budget — change this in Diet settings.'
        : ex.addback_pct === 50
          ? `Half added to your food budget: +${ex.credited} kcal.`
          : `Added to your food budget: +${ex.credited} kcal.`;

      openModal({
        title: 'Exercise',
        subtitle: `${ex.total_burned} kcal burned`,
        body: h(
          'div',
          { class: 'portal-ex-sheet' },
          ...ex.workouts.map((w) =>
            exRow({ icon: 'weight', name: w.workout_name, meta: `Workout · ${minutesLabel(w.duration_seconds)}`, kcal: w.calories }),
          ),
          ...ex.activities.map((a) =>
            exRow({ icon: 'activity', name: a.name, meta: `${a.duration_minutes} min`, kcal: a.calories, onRemove: () => api.portal.deleteActivity(a.id) }),
          ),
          ex.workouts.length || ex.activities.length
            ? h('small', { class: 'portal-ex-note' }, addbackNote)
            : h('div', { class: 'portal-ex-empty' }, 'Nothing yet. Workouts you finish in the app appear here on their own.'),
          h(
            'button',
            {
              class: 'portal-add-food',
              type: 'button',
              onclick: fromSheet(() =>
                openActivitySheet({ logDate, onAdded: reload }).catch((err) => toast(err.message || 'Could not open that', 'error')),
              ),
            },
            h('span', { class: 'portal-add-ico' }, renderIcon('plus', { size: 13, stroke: 2.4 })),
            'Log activity',
          ),
        ),
      });
    }

    const latestWeight = weights?.latest ?? null;
    const unit = weightUnit.get();
    const firstWeight = weights?.items[0];
    const weightChange = latestWeight && firstWeight && firstWeight.log_date !== latestWeight.log_date
      ? Math.round((toDisplayWeight(latestWeight.weight_kg) - toDisplayWeight(firstWeight.weight_kg)) * 10) / 10
      : null;
    const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)} ${unit}`;

    function openWeightTrend() {
      const points = weights.items.map((w) => ({ date: w.log_date, value: toDisplayWeight(w.weight_kg) }));
      const readout = h('div', { class: 'portal-weight-readout' });
      const sub = [
        weightChange !== null ? `${signed(weightChange)} since ${shortDate(firstWeight.log_date)}` : null,
        weights.goal_weight_kg ? `goal ${weightLabel(weights.goal_weight_kg)}` : null,
      ].filter(Boolean).join(' · ');

      openModal({
        title: 'Weight',
        subtitle: sub || weightLabel(latestWeight.weight_kg),
        body: h(
          'div',
          { class: 'portal-ex-sheet' },
          points.length >= 2
            ? h(
                'div',
                { class: 'portal-weight-chart' },
                progressChart(points, {
                  format: (v) => String(Math.round(v * 10) / 10),
                  onSelect: (i) => {
                    readout.textContent = `${points[i].value} ${unit} · ${shortDate(points[i].date)}`;
                  },
                }),
                readout,
              )
            : h('div', { class: 'portal-ex-empty' }, 'Log another weigh-in to start your trend line.'),
          h(
            'button',
            { class: 'portal-add-food', type: 'button', onclick: fromSheet(() => openWeightSheet({ latest: latestWeight, onSaved: reload })) },
            h('span', { class: 'portal-add-ico' }, renderIcon('plus', { size: 13, stroke: 2.4 })),
            'Log weight',
          ),
        ),
      });
    }

    const miniTile = ({ tone, icon, label, value, note, onclick }) =>
      h(
        'button',
        { class: `portal-mini-tile ${tone}`, type: 'button', onclick },
        h('span', { class: 'portal-mini-ico' }, renderIcon(icon, { size: 18, stroke: 2 })),
        h('span', { class: 'portal-mini-text' }, h('small', {}, label), h('strong', {}, value), note ? h('em', {}, note) : null),
        renderIcon('chevronRight', { size: 16 }),
      );

    body.append(
      h(
        'div',
        { class: 'portal-mini-row' },
        miniTile({
          tone: 'exercise',
          icon: 'flame',
          label: 'Exercise',
          value: ex.total_burned ? `${ex.total_burned} kcal` : 'None yet',
          note: ex.workouts.length + ex.activities.length ? `${ex.workouts.length + ex.activities.length} logged` : 'Tap to log',
          onclick: openExerciseSheet,
        }),
        weights
          ? miniTile({
              tone: 'weight',
              icon: 'weight',
              label: 'Weight',
              value: latestWeight ? weightLabel(latestWeight.weight_kg) : 'Not logged',
              note: weightChange !== null ? signed(weightChange) : latestWeight ? shortDate(latestWeight.log_date) : 'Tap to log',
              // Nothing to chart yet: straight to the weigh-in.
              onclick: latestWeight ? openWeightTrend : () => openWeightSheet({ latest: null, onSaved: reload }),
            })
          : null,
      ),
    );

    /* Water */
    // One row of up to twelve cells, each an equal slice of the day's target:
    // exactly one 250 ml glass for targets up to 3 L, proportional beyond that.
    const glassTarget = Math.min(Math.max(1, Math.round(targets.target_water_ml / 250)), 12);
    const glassesDone = Math.min(
      glassTarget,
      Math.round((day.water_ml / Math.max(1, targets.target_water_ml)) * glassTarget),
    );
    const bump = async (ml) => {
      try {
        await api.portal.logWater({ add_ml: ml, log_date: logDate });
        if (ml > 0) sound.playWaterLogged();
        await reload();
      } catch (err) {
        toast(err.message || 'Could not update your water', 'error');
      }
    };

    body.append(
      h(
        'section',
        { class: 'portal-water-card' },
        h(
          'div',
          { class: 'portal-water-head' },
          h('div', {}, renderIcon('droplet', { size: 20, stroke: 2 }), h('strong', {}, 'Water')),
          h('span', {}, `${day.water_ml} / ${targets.target_water_ml} ml`),
        ),
        h(
          'div',
          {
            class: 'portal-water-glasses',
            style: `--cells:${glassTarget}`,
            role: 'img',
            'aria-label': `${glassesDone} of ${glassTarget} glasses`,
          },
          ...Array.from({ length: glassTarget }, (_, i) =>
            h('span', { class: `portal-glass${i < glassesDone ? ' filled' : ''}` }, renderIcon('droplet', { size: 13, stroke: 2.2 })),
          ),
        ),
        h(
          'div',
          { class: 'portal-water-actions' },
          h('button', { class: 'portal-water-btn primary', type: 'button', onclick: () => bump(250) }, renderIcon('bottle', { size: 18 }), '+ 250 ml'),
          h('button', { class: 'portal-water-btn blue', type: 'button', onclick: () => bump(500) }, renderIcon('plus', { size: 17 }), '500 ml'),
          h(
            'button',
            { class: 'portal-water-btn', type: 'button', disabled: day.water_ml <= 0, onclick: () => bump(-250) },
            '− 250 ml',
          ),
        ),
      ),
    );

    /* Meal cards */
    const plannedByMeal = new Map();
    for (const meal of plan.plan?.meals ?? []) {
      // The trainer's meal names are free text ("Pre-Workout", "Snack"); match
      // them to the four fixed log slots by the closest sensible key so the
      // recommendation shows up next to where the member actually logs it.
      const key = MEAL_SLOTS.find((slot) => meal.meal_name.toLowerCase().replace(/[^a-z]/g, '').includes(slot.key.replace('_', '')))?.key
        ?? 'snack';
      if (!plannedByMeal.has(key)) plannedByMeal.set(key, []);
      plannedByMeal.get(key).push(meal);
    }

    const visibleSlots = MEAL_SLOTS.filter(
      (slot) => ['breakfast', 'lunch', 'dinner', 'snack'].includes(slot.key)
        || day.meals[slot.key]?.length
        || plannedByMeal.has(slot.key),
    );

    body.append(
      h(
        'div',
        { class: 'portal-meals-head' },
        h('h3', { class: 'portal-section-title' }, 'Meals'),
        plan.plan
          ? h(
              'button',
              { class: 'portal-link-btn', type: 'button', onclick: () => openPlanSheet(plan.plan, targets) },
              'View plan',
              renderIcon('arrowRight', { size: 15, stroke: 2.2 }),
            )
          : null,
      ),
    );

    for (const slot of visibleSlots) {
      const entries = day.meals[slot.key] ?? [];
      const eaten = entries.reduce((sum, e) => sum + e.calories, 0);
      const planned = plannedByMeal.get(slot.key) ?? [];

      // Beside the art when there is nothing else in the column; full width
      // underneath when the trainer's suggestions already fill it.
      const loggedBox = entries.length
        ? h(
            'div',
            { class: 'portal-trainer-box logged' },
            h('div', { class: 'portal-trainer-label' }, 'Logged'),
            ...entries.map((entry) =>
              h(
                'div',
                { class: 'portal-entry-row' },
                h(
                  'div',
                  {},
                  h('div', { class: 'portal-entry-name' }, entry.food_name),
                  h(
                    'div',
                    { class: 'muted' },
                    `${portionLabel(entry)} · P ${entry.protein_g}g · C ${entry.carbs_g}g · F ${entry.fats_g}g`,
                  ),
                ),
                h('div', { class: 'portal-entry-kcal' }, String(entry.calories)),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    'aria-label': `Remove ${entry.food_name}`,
                    onclick: async (event) => {
                      event.currentTarget.disabled = true;
                      try {
                        await api.portal.deleteFoodEntry(entry.id);
                        sound.playFoodRemoved();
                        await reload();
                      } catch (err) {
                        toast(err.message || 'Could not remove that', 'error');
                        event.currentTarget.disabled = false;
                      }
                    },
                  },
                  renderIcon('close', { size: 14 }),
                ),
              ),
            ),
          )
        : null;

      body.append(
        h(
          'article',
          { class: 'portal-meal-card' },
          h(
            'div',
            { class: 'portal-meal-head' },
            h('div', { class: 'portal-meal-icon' }, renderIcon(slot.icon, { size: 20, stroke: 2 })),
            h('div', { class: 'portal-meal-title' }, slot.label),
            h('div', { class: 'portal-meal-kcal' }, `${Math.round(eaten)} kcal`),
          ),
          h(
            'div',
            { class: 'portal-meal-body' },
            mealArt(slot.key),
            h(
              'div',
              { class: 'portal-meal-side' },
              planned.length
                ? h(
                    'div',
                    { class: 'portal-trainer-box' },
                    h('div', { class: 'portal-trainer-label' }, 'Your trainer suggests'),
                    ...planned.flatMap((meal) =>
                      meal.items.map((item) =>
                        h(
                          'div',
                          { class: 'portal-planned-row' },
                          h('span', {}, item.food_name),
                          h('span', { class: 'muted' }, `${item.portion_size} · ${item.calories} kcal`),
                        ),
                      ),
                    ),
                  )
                : null,
              !planned.length ? loggedBox : null,
              !planned.length && !entries.length
                ? h('div', { class: 'portal-trainer-box empty' }, 'Nothing logged yet.', h('br'), 'Tap + to track food.')
                : null,
            ),
          ),
          planned.length ? loggedBox : null,
        ),
      );
    }

    // A sibling of the tab body rather than inside it: the body's entry
    // animation transforms it, and a transformed ancestor would pin the
    // fixed-position button to the body instead of the screen.
    return h('div', { class: 'portal-diet-wrap' }, body, dietFab({ logDate, onAdded: reload }));
  }

  /**
   * The Diet tab's floating + : every way food goes in starts here, on the
   * meal the clock suggests. Quick track is the slot a typed or spoken "what
   * did you eat" will live in once that exists.
   */
  function dietFab({ logDate, onAdded }) {
    const fab = h(
      'button',
      { class: 'diet-fab', type: 'button', 'aria-label': 'Track food', 'aria-expanded': 'false', 'aria-haspopup': 'menu' },
      renderIcon('plus', { size: 26, stroke: 2.4 }),
    );
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const item = (icon, title, note, onclick) =>
      h(
        'button',
        {
          class: 'diet-fab-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            setOpen(false);
            onclick();
          },
        },
        h('span', { class: 'diet-fab-ico' }, renderIcon(icon, { size: 20, stroke: 2 })),
        h('span', { class: 'diet-fab-text' }, h('strong', {}, title), h('small', {}, note)),
      );
    const menu = h(
      'div',
      { class: 'diet-fab-menu', role: 'menu', 'aria-label': 'Track food' },
      item('search', 'Quick track', 'Search, recents & favourites', () => openFoodSearch({ logDate, onAdded })),
      item('scan', 'Scan barcode', 'Packaged food from its label', () => openFoodSearch({ logDate, onAdded, startOn: 'scan' })),
    );
    const layer = h('div', { class: 'diet-fab-layer', onclick: (event) => event.target === layer && setOpen(false) }, menu);

    function setOpen(open) {
      layer.classList.toggle('open', open);
      fab.classList.toggle('open', open);
      fab.setAttribute('aria-expanded', String(open));
      if (open) document.addEventListener('keydown', onKey);
      else document.removeEventListener('keydown', onKey);
    }
    fab.addEventListener('click', () => setOpen(!fab.classList.contains('open')));

    return h('div', {}, layer, fab);
  }

  /* --------------------------------------------------------- Notifications */

  /** /api/portal/notifications/config, once per portal instance (refreshed by
   * the Profile tab). Null until it lands — enabling needs its public key. */
  let pushConfig = null;
  let unread = 0;
  const bellBadge = h('span', { class: 'portal-bell-badge', hidden: true });

  function setUnread(count) {
    unread = Math.max(0, Number(count) || 0);
    bellBadge.hidden = unread === 0;
    bellBadge.textContent = unread > 9 ? '9+' : String(unread);
    push.setAppBadge(unread);
  }

  async function loadPushConfig({ refresh = false } = {}) {
    if (pushConfig && !refresh) return pushConfig;
    pushConfig = await api.portal.notifications.config();
    setUnread(pushConfig.unread);
    return pushConfig;
  }

  // The bell's count, and this device's subscription re-sent so the server
  // keeps up with anything the browser rotated while the app was closed.
  loadPushConfig()
    .then((config) => push.syncPushSubscription(config.public_key))
    .catch(() => {});

  // Coming back to the app (from the lock screen, another app) is when the
  // bell is most likely stale — announcements reach the notification center
  // whether or not this device gets pushes.
  const refreshUnread = () => {
    if (document.visibilityState !== 'visible' || !memberSession.token) return;
    api.portal.notifications
      .list({ limit: 1 })
      .then((res) => setUnread(res.unread))
      .catch(() => {});
  };
  document.addEventListener('visibilitychange', refreshUnread);

  detachPushListener?.();
  detachPushListener = push.onPushMessage((notification, foreground) => {
    setUnread(Number.isFinite(notification.unread) ? notification.unread : unread + 1);
    if (!foreground) return;
    // sw.js left the system notification silent because the app is on
    // screen; this is the sound and buzz in its place.
    sound.playNotification({ urgent: Boolean(notification.urgent) });
    toast(notification.title || 'New notification', notification.urgent ? 'error' : 'info');
  });
  const detachMessages = detachPushListener;
  detachPushListener = () => {
    detachMessages();
    document.removeEventListener('visibilitychange', refreshUnread);
  };

  /**
   * Asks for permission and registers this device. Must be called straight
   * from a tap — see enablePush() in push.js for why.
   * @returns {Promise<boolean>} whether notifications ended up on.
   */
  async function turnOnPush() {
    if (!pushConfig) {
      loadPushConfig().catch(() => {});
      toast('Still loading — try again in a moment', 'info');
      return false;
    }
    try {
      await push.enablePush(pushConfig.public_key);
      await loadPushConfig({ refresh: true });
      toast('Notifications are on for this device');
      return true;
    } catch (err) {
      toast(err.message || 'Could not turn on notifications', err.code === 'dismissed' ? 'info' : 'error');
      return false;
    }
  }

  /** Every notification the member has had, newest first. Opening it counts
   * as having seen them — the badge clears, the unread dots stay for this look. */
  async function openNotificationCenter() {
    const list = h('div', { class: 'portal-notif-list' }, h('div', { class: 'portal-loading' }, 'Loading…'));
    openModal({ title: 'Notifications', icon: 'bell', className: 'portal-notif-modal', body: list });

    let items;
    try {
      ({ items } = await api.portal.notifications.list({ limit: 50 }));
    } catch (err) {
      clear(list).append(h('p', { class: 'muted' }, err.message || 'Could not load notifications'));
      return;
    }
    if (items.some((item) => !item.read_at)) {
      api.portal.notifications
        .markRead()
        .then((res) => setUnread(res.unread))
        .catch(() => {});
    }

    if (!items.length) {
      clear(list).append(
        h(
          'div',
          { class: 'portal-notif-empty' },
          renderIcon('bell', { size: 34 }),
          h('strong', {}, 'You’re all caught up'),
          h('p', {}, isLibrary() ? 'Renewal reminders and announcements will appear here.' : 'Reminders and gym announcements will appear here.'),
        ),
      );
      return;
    }

    const reachable = new Set([...TABS.map((tab) => tab.key), 'pass', 'pay', 'schedule']);
    clear(list).append(
      ...items.map((item) => {
        const style = NOTIFICATION_STYLE[item.category] ?? NOTIFICATION_STYLE.announcement;
        const target = reachable.has(item.screen) ? item.screen : null;
        const parts = [
          h('span', { class: 'portal-notif-ico' }, renderIcon(style.icon, { size: 20 })),
          h(
            'span',
            { class: 'portal-notif-text' },
            h('strong', {}, item.title),
            h('span', {}, item.body),
            item.image_url
              ? h('img', { class: 'portal-notif-img', src: `${pathPrefix}${item.image_url}`, alt: '', loading: 'lazy' })
              : null,
            h('small', {}, relativeTime(item.created_at)),
          ),
          item.read_at ? null : h('i', { class: 'portal-notif-dot', 'aria-label': 'New' }),
        ];
        const cls = `portal-notif tone-${style.tone}${item.read_at ? '' : ' unread'}${item.urgent ? ' urgent' : ''}`;
        return target
          ? h(
              'button',
              {
                class: cls,
                type: 'button',
                onclick: () => {
                  closeModal();
                  switchTab(target);
                },
              },
              ...parts,
            )
          : h('div', { class: cls }, ...parts);
      }),
    );
  }

  /**
   * Home's "turn on reminders" card, for whichever way this member is missing
   * out: never asked, switched off from Profile, blocked in the browser, or on
   * an iPhone that needs the app installed first.
   *
   * A card rather than asking on load: a cold permission prompt is mostly
   * denied, and a denial is final. "Not now" snoozes it for longer each time
   * (push.snoozePrimer), so it comes back without nagging.
   *
   * Returns its slot straight away and fills it once the service worker has
   * said whether this device is subscribed, so Home never waits on that.
   */
  function pushPrimerSlot() {
    const slot = h('div', { class: 'portal-push-slot' });
    if (push.primerDue()) {
      pushPrimerCard()
        .then((card) => card && slot.append(card))
        .catch(() => {});
    }
    return slot;
  }

  async function pushPrimerCard() {
    const capability = push.pushCapability();
    let mode;
    if (capability === 'ios-install') mode = 'install';
    else if (capability === 'denied') mode = 'blocked';
    else if (capability === 'ready') {
      const granted = push.permissionState() === 'granted';
      if (granted && (await push.currentSubscription().catch(() => null))) return null;
      mode = granted ? 'off' : 'ask';
    } else return null;

    const what = isLibrary()
      ? 'renewal reminders and announcements from the front desk, like closures and holiday hours'
      : 'water, meal and workout nudges, plus gym announcements like closures and holiday hours';
    const COPY = {
      ask: { title: 'Get reminders on this phone', text: `${what[0].toUpperCase()}${what.slice(1)}.`, action: 'Turn on' },
      off: {
        title: 'Notifications are off',
        text: `You turned them off on this phone, so you are missing ${what}.`,
        action: 'Turn back on',
      },
      blocked: {
        title: 'Notifications are blocked',
        text: `You are missing ${what}. ${PUSH_UNAVAILABLE.denied.sub}`,
        action: null,
      },
      install: {
        title: 'Get reminders on this phone',
        text: 'On iPhone, notifications work once the app is on your Home Screen. Add it, open it from there, then turn them on.',
        action: 'Add to Home Screen',
      },
    };
    const copy = COPY[mode];

    const card = h(
      'div',
      { class: `portal-push-primer is-${mode}` },
      h('span', { class: 'portal-push-primer-ico' }, renderIcon(mode === 'blocked' ? 'alert' : 'bell', { size: 22 })),
      h('div', { class: 'portal-push-primer-text' }, h('strong', {}, copy.title), h('span', {}, copy.text)),
      h(
        'div',
        { class: 'portal-push-primer-actions' },
        copy.action
          ? h(
              'button',
              {
                class: 'btn sm primary',
                type: 'button',
                onclick: async () => {
                  if (mode === 'install') {
                    promptInstall();
                    return;
                  }
                  if (await turnOnPush()) card.remove();
                },
              },
              copy.action,
            )
          : null,
        h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              push.snoozePrimer();
              card.remove();
            },
          },
          copy.action ? 'Not now' : 'Got it',
        ),
      ),
    );
    return card;
  }

  const PUSH_UNAVAILABLE = {
    denied: {
      title: 'Notifications are blocked',
      sub: isIos()
        ? 'Turn them on in Settings → Notifications → this app, then come back.'
        : 'Allow notifications for this site in your browser’s site settings, then come back.',
    },
    'ios-version': { title: 'Update your iPhone', sub: 'Notifications need iOS 16.4 or later.' },
    insecure: { title: 'Notifications unavailable', sub: 'They need the secure (https) address of this app.' },
    unsupported: { title: 'Notifications unavailable', sub: 'This browser cannot receive notifications. Try Chrome, Edge or Safari.' },
  };

  /** Profile's Notifications card: this device's on/off state, then what to
   * hear about. The category switches are the member's, not the device's —
   * they apply to every phone the member has turned notifications on for. */
  async function notificationSection() {
    let config;
    try {
      config = await loadPushConfig({ refresh: true });
    } catch {
      return null;
    }
    const capability = push.pushCapability();
    const subscription = capability === 'ready' ? await push.currentSubscription().catch(() => null) : null;
    const onHere = Boolean(subscription) && push.permissionState() === 'granted';
    const prefs = config.preferences;

    const toggle = (key) => async () => {
      try {
        config.preferences = await api.portal.notifications.savePreferences({ [key]: !prefs[key] });
      } catch (err) {
        toast(err.message || 'Could not save', 'error');
      }
      switchTab('profile');
    };

    let deviceRow;
    if (capability === 'ready') {
      const devices = config.devices;
      deviceRow = profileRow({
        icon: 'bell',
        tone: 'orange',
        title: 'Push notifications',
        sub: onHere
          ? `On for this device${devices > 1 ? ` · ${devices} devices in total` : ''}`
          : 'Off on this device — turn on to get reminders',
        control: settingsSwitch(onHere, 'Push notifications', async () => {
          if (onHere) {
            await push.disablePush();
            // Home will ask again, but not for a couple of days.
            push.snoozePrimer();
            toast('Notifications turned off for this device', 'info');
          } else {
            await turnOnPush();
          }
          switchTab('profile');
        }),
      });
      // In a plain browser tab Android files every notification under
      // "Chrome · <domain>" with an Unsubscribe button; installed, they come
      // from the gym's own app. Only an install can change that.
      if (onHere && canInstall()) {
        deviceRow = [
          deviceRow,
          profileRow({
            icon: 'download',
            tone: 'blue',
            title: 'Install the app',
            sub: `So notifications come from ${gymDisplayName(ctx)}, not your browser`,
            onclick: () => promptInstall(),
          }),
        ];
      }
    } else if (capability === 'ios-install') {
      deviceRow = profileRow({
        icon: 'download',
        tone: 'orange',
        title: 'Add to Home Screen first',
        sub: 'iPhone and iPad deliver notifications only to Home Screen apps (iOS 16.4+)',
        onclick: () => promptInstall(),
      });
    } else {
      const copy = PUSH_UNAVAILABLE[capability] ?? PUSH_UNAVAILABLE.unsupported;
      deviceRow = profileRow({ icon: 'alert', tone: 'rose', title: copy.title, sub: copy.sub });
    }

    const CATEGORY_ROWS = {
      water: { icon: 'droplet', tone: 'blue', title: 'Water reminders', sub: 'At set times, if you are behind your daily goal' },
      nutrition: { icon: 'utensils', tone: 'green', title: 'Meal tracking', sub: 'Around lunch and dinner, to log calories & macros' },
      workout: { icon: 'timer', tone: 'orange', title: 'Workout nudges', sub: 'When a session is left running without being finished' },
      announcements: {
        icon: 'bell',
        tone: 'purple',
        title: `${isLibrary() ? 'Library' : 'Gym'} announcements`,
        sub: 'Events and holiday hours — urgent closures always come through',
      },
      membership: { icon: 'crown', tone: 'orange', title: 'Renewal reminders', sub: 'Before your plan runs out' },
    };

    const testButton = h(
      'button',
      {
        class: 'portal-prof-test',
        type: 'button',
        disabled: !onHere,
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const res = await api.portal.notifications.test();
            if (res.delivered > 0) toast(`Test sent to ${res.delivered} device${res.delivered === 1 ? '' : 's'}`);
            else toast('The test could not be delivered — try turning notifications off and on again', 'error');
          } catch (err) {
            toast(err.message || 'Could not send a test', 'error');
          } finally {
            button.disabled = false;
          }
        },
      },
      h('span', { class: 'portal-prof-ico' }, renderIcon('bell', { size: 20 })),
      h(
        'span',
        { class: 'portal-prof-text' },
        h('strong', {}, 'Send a test notification'),
        h('small', {}, onHere ? 'See how reminders look on this device' : 'Turn on notifications to try it'),
      ),
      h('span', { class: 'portal-prof-play' }, renderIcon('play', { size: 14 })),
    );

    return [
      h('h3', { class: 'portal-prof-label' }, 'Notifications'),
      h(
        'div',
        { class: 'portal-prof-card' },
        ...[deviceRow].flat(),
        ...config.categories.map((key) => {
          const row = CATEGORY_ROWS[key];
          return row
            ? profileRow({ ...row, control: settingsSwitch(Boolean(prefs[key]), row.title, toggle(key)) })
            : null;
        }),
        profileRow({
          icon: 'volume', tone: 'purple', title: 'Notification sound', sub: 'Play a sound when one arrives',
          control: settingsSwitch(Boolean(prefs.sound), 'Notification sound', toggle('sound')),
        }),
        profileRow({
          icon: 'smartphone', tone: 'green', title: 'Notification vibration', sub: 'Buzz when one arrives (Android)',
          control: settingsSwitch(Boolean(prefs.vibrate), 'Notification vibration', toggle('vibrate')),
        }),
        testButton,
      ),
    ];
  }

  /* ----------------------------------------------------------- Profile tab */

  function openChangePinModal() {
    openModal({
      title: 'Change your PIN',
      body: buildForm(
        [
          { name: 'current_pin', label: 'Current PIN', type: 'password', required: true, full: true },
          { name: 'new_pin', label: 'New PIN (4-6 digits)', type: 'password', required: true, full: true },
        ],
        {
          submitLabel: 'Update PIN',
          onSubmit: async (values) => {
            await api.portal.setPin(values);
            toast('PIN updated');
            closeModal();
          },
        },
      ),
    });
  }

  function openEditProfileModal() {
    const m = me.member;
    openModal({
      title: 'Edit profile',
      body: h(
        'div',
        { class: 'portal-edit-profile' },
        h(
          'p',
          { class: 'muted' },
          `Your name and phone number are kept by the front desk — ask them if either needs changing. You sign in with ${m.phone ? 'that phone number' : 'your member ID'}.`,
        ),
        buildForm(
          [
            { name: 'email', label: 'Email', type: 'email', value: m.email || '', full: true },
            { name: 'emergency_contact', label: t('emergencyContact'), value: m.emergency_contact || '' },
            { name: 'emergency_phone', label: `${t('emergencyContact')} phone`, type: 'tel', value: m.emergency_phone || '' },
          ],
          {
            submitLabel: 'Save changes',
            onSubmit: async (values) => {
              me.member = await api.portal.updateMe(values);
              toast('Profile updated');
              closeModal();
              switchTab('profile');
            },
          },
        ),
      ),
    });
  }

  async function uploadProfilePhoto(file) {
    try {
      const dataUrl = await cropAndResizeImage(file, 320, 0.8);
      me.member = await api.portal.setPhoto(dataUrl);
      toast('Photo updated');
      switchTab('profile');
    } catch (err) {
      toast(err.message || 'Could not update your photo', 'error');
    }
  }

  /** Diet settings from Profile. Without the tracker the Diet tab's upgrade
   * screen is the honest answer, so that is where a locked member lands. */
  async function openDietSettings() {
    try {
      const status = await api.portal.fitnessStatus();
      if (!status.has_access) {
        await switchTab('diet');
        return;
      }
      await openNutritionSettings({ onSaved: () => (active === 'diet' ? switchTab('diet') : null) });
    } catch (err) {
      toast(err.message || 'Could not open diet settings', 'error');
    }
  }

  async function renderProfileTab() {
    const m = me.member;
    const sub = me.subscription;
    const fullName = `${m.first_name} ${m.last_name || ''}`.trim();
    const body = h(
      'div',
      { class: 'portal-tab-body portal-prof' },
      h('div', { class: 'portal-page-head' }, h('h2', {}, 'Profile'), h('p', {}, 'Manage your account and preferences.')),
    );

    if (pendingPinPrompt) {
      pendingPinPrompt = false;
      body.append(
        h(
          'div',
          { class: 'portal-pin-banner' },
          h('div', {}, renderIcon('key', { size: 16 }), ' Using a temporary PIN — set your own for next time.'),
          h('button', { class: 'btn sm primary', type: 'button', onclick: openChangePinModal }, 'Set PIN'),
        ),
      );
    }

    /* Hero: photo (tap the camera to replace it), name, code, status */
    const photoInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
    photoInput.addEventListener('change', () => {
      const [file] = photoInput.files;
      if (file) uploadProfilePhoto(file);
    });
    const status = (() => {
      if (m.status === 'frozen') return { tone: 'blue', label: 'Membership frozen' };
      if (m.status !== 'active') return { tone: 'grey', label: `Inactive ${t('member').toLowerCase()}` };
      if (!sub) return { tone: 'amber', label: 'No active plan' };
      return { tone: 'green', label: `Active ${t('member')}` };
    })();

    body.append(
      h(
        'section',
        { class: 'portal-prof-hero' },
        h('img', { class: 'portal-prof-hero-art', src: '/images/member/flex-silhouette.svg', alt: '' }),
        h(
          'div',
          { class: 'portal-prof-photo' },
          m.photo_url
            ? h('img', { src: m.photo_url, alt: '' })
            : h('span', { class: 'portal-prof-initials' }, initials(m.first_name, m.last_name)),
          h(
            'button',
            { class: 'portal-prof-camera', type: 'button', 'aria-label': 'Change photo', onclick: () => photoInput.click() },
            renderIcon('camera', { size: 16, stroke: 2.2 }),
          ),
          photoInput,
        ),
        h(
          'div',
          { class: 'portal-prof-who' },
          h('div', { class: 'portal-prof-name' }, fullName),
          h('div', { class: 'portal-prof-code' }, m.code),
          h('span', { class: `portal-prof-status tone-${status.tone}` }, h('i'), status.label),
        ),
        h(
          'button',
          { class: 'portal-prof-edit', type: 'button', onclick: openEditProfileModal },
          renderIcon('edit', { size: 17, stroke: 2.2 }),
          h('span', {}, 'Edit'),
          h('span', { class: 'portal-prof-edit-more' }, ' Profile'),
        ),
      ),
    );

    /* Contact details */
    const emergency = m.emergency_contact
      ? `${m.emergency_contact}${m.emergency_phone ? ` · ${m.emergency_phone}` : ''}`
      : null;
    body.append(
      h(
        'div',
        { class: 'portal-prof-card' },
        profileRow({
          icon: 'phone', tone: 'orange', title: 'Phone', sub: 'Your registered phone number',
          value: m.phone || 'Not set', onclick: openEditProfileModal,
        }),
        profileRow({
          icon: 'mail', tone: 'purple', title: 'Email', sub: 'Your email address',
          value: m.email || 'Add email', onclick: openEditProfileModal, className: m.email ? '' : 'is-empty',
        }),
        emergency
          ? profileRow({
              icon: 'heartPulse', tone: 'rose', title: t('emergencyContact'), sub: 'Who we call if needed',
              value: emergency, onclick: openEditProfileModal,
            })
          : null,
        m.joined_on
          ? profileRow({
              icon: 'calendar', tone: 'blue', title: 'Joined', sub: `${t('member')} since`,
              value: date(m.joined_on), onclick: () => switchTab('pay'),
            })
          : null,
      ),
    );

    // Pass and Pay are not bottom tabs (see buildTabs) — this is where they
    // live for a member who came straight to Profile instead of tapping the
    // topbar QR button or a Home quick action. A library keeps its own Pass
    // tab, so only Pay folds in here for it; a gym folds in both.
    if (sub && sub.due > 0) {
      body.append(
        h('div', { class: 'portal-due-banner' }, renderIcon('outgoing', { size: 16 }), ` ${money(sub.due)} due — pay at the front desk`),
      );
    }
    const memberTile = (tone, icon, title, sub, onclick) =>
      h(
        'button',
        { class: `portal-prof-tile tone-${tone}`, type: 'button', onclick },
        h('span', { class: 'portal-prof-tile-mark', 'aria-hidden': 'true' }, renderIcon(icon, { size: 56, stroke: 1.6 })),
        h('span', { class: 'portal-prof-tile-ico' }, renderIcon(icon, { size: 28, stroke: 2 })),
        h('span', { class: 'portal-prof-tile-text' }, h('strong', {}, title), h('small', {}, sub)),
        h('span', { class: 'portal-prof-tile-go' }, renderIcon('arrowRight', { size: 16, stroke: 2.4 })),
      );
    body.append(
      h('h3', { class: 'portal-prof-label' }, 'Membership'),
      h(
        'div',
        { class: `portal-prof-tiles${isLibrary() ? ' is-single' : ''}` },
        isLibrary()
          ? null
          : memberTile('orange', 'qrCode', 'View & scan digital pass', 'Show your QR code at the gym', () => switchTab('pass')),
        memberTile('blue', 'billing', 'Invoices & payment history', 'View all your invoices and payments', () => switchTab('pay')),
      ),
    );

    /* Audio & feedback */
    const soundOn = sound.getSoundEnabled();
    let previewIndex = 0;
    body.append(
      h('h3', { class: 'portal-prof-label' }, 'Audio & Feedback'),
      h(
        'div',
        { class: 'portal-prof-card' },
        profileRow({
          icon: 'volume', tone: 'orange', title: 'Sound effects', sub: 'Play sounds for actions and notifications',
          control: settingsSwitch(soundOn, 'Sound effects', () => {
            sound.setSoundEnabled(!soundOn);
            switchTab('profile');
          }),
        }),
        profileRow({
          icon: 'barChart', tone: 'purple', title: 'Volume', sub: 'Adjust app sound volume', className: 'has-segmented',
          control: volumeSegmented(sound.getSoundVolume(), (value) => {
            sound.setSoundVolume(value);
            switchTab('profile');
          }),
        }),
        profileRow({
          icon: 'smartphone', tone: 'green', title: 'Vibration', sub: 'Vibrate for important actions',
          control: settingsSwitch(sound.getHapticsEnabled(), 'Vibration', () => {
            sound.setHapticsEnabled(!sound.getHapticsEnabled());
            switchTab('profile');
          }),
        }),
        h(
          'button',
          {
            class: 'portal-prof-test',
            type: 'button',
            disabled: !soundOn,
            onclick: () => {
              const key = sound.SOUND_PREVIEW_ORDER[previewIndex % sound.SOUND_PREVIEW_ORDER.length];
              previewIndex += 1;
              const label = sound.previewSound(key);
              if (label) toast(`🔊 ${label}`);
            },
          },
          h('span', { class: 'portal-prof-ico' }, renderIcon('bell', { size: 20 })),
          h(
            'span',
            { class: 'portal-prof-text' },
            h('strong', {}, 'Test sound'),
            h('small', {}, soundOn ? 'Play a sample notification sound' : 'Turn sound effects on to preview'),
          ),
          h('span', { class: 'portal-prof-play' }, renderIcon('play', { size: 14 })),
        ),
      ),
    );

    const notifications = await notificationSection();
    if (notifications) body.append(...notifications);

    /* Settings */
    const installRow = profileRow({
      icon: 'download', tone: 'blue', title: 'Add to Home Screen', sub: 'Install the app on this phone',
      onclick: () => promptInstall(), className: 'install-hidden',
    });
    unsubscribeInstall?.();
    unsubscribeInstall = onInstallChange((available) => installRow.classList.toggle('install-hidden', !available));

    const dark = getAppMode() !== 'light';
    body.append(
      h('h3', { class: 'portal-prof-label' }, 'Settings'),
      h(
        'div',
        { class: 'portal-prof-card' },
        TABS.some((tabDef) => tabDef.key === 'diet')
          ? profileRow({
              icon: 'nutrition', tone: 'green', title: 'Diet & nutrition', sub: 'Calorie and macro goals, body stats, exercise calories',
              onclick: openDietSettings,
            })
          : null,
        profileRow({ icon: 'key', tone: 'rose', title: 'Change PIN', sub: 'Update your app PIN for security', onclick: openChangePinModal }),
        profileRow({
          icon: 'moon', tone: 'purple', title: dark ? 'Dark Mode' : 'Switch to Dark Mode', sub: 'Change app appearance',
          control: settingsSwitch(dark, 'Dark mode', () => {
            toggleAppMode();
            switchTab('profile');
          }),
        }),
        installRow,
      ),
      h(
        'button',
        {
          class: 'portal-prof-signout',
          type: 'button',
          onclick: async () => {
            // Before the token goes: the next person to sign in on this phone
            // must not receive this member's reminders.
            await push.disablePush().catch(() => {});
            detachPushListener?.();
            detachPushListener = null;
            memberSession.clear();
            ctx.navigate('/portal/login');
          },
        },
        renderIcon('logout', { size: 20 }),
        'Sign out',
      ),
    );

    return body;
  }

  const TAB_RENDERERS = {
    home: renderHomeTab,
    pass: renderPassTab,
    schedule: () => (isLibrary() ? renderLibrarySchedule() : renderGymSchedule()),
    workout: renderWorkoutTab,
    diet: renderDietTab,
    pay: renderPayTab,
    store: renderStoreTab,
    profile: renderProfileTab,
  };

  paintTabbar();
  const topbar = h(
    'header',
    { class: 'portal-topbar' },
    ctx.context?.tenant?.logo_url
      ? h('img', { class: 'portal-topbar-logo-img', src: ctx.context.tenant.logo_url, alt: gymDisplayName(ctx) })
      : isLibrary()
        ? h('div', { class: 'portal-topbar-logo' }, renderIcon('book', { size: 16 }))
        : h('img', { class: 'portal-topbar-logo-img', src: '/icons/gym-logo.svg', alt: gymDisplayName(ctx) }),
    h('div', { class: 'portal-topbar-name' }, h('div', {}, gymDisplayName(ctx)), topbarSub),
    h(
      'div',
      { class: 'portal-topbar-actions' },
      // Pass is not always a bottom tab (see buildTabs) so this is the one
      // spot on every screen that gets a member to their scannable code in a
      // single tap, matching the quick action on Home.
      h(
        'button',
        { class: 'portal-qr-btn', type: 'button', title: 'Show digital pass', 'aria-label': 'Show digital pass', onclick: () => switchTab('pass') },
        renderIcon('qrCode', { size: 20 }),
      ),
      h(
        'button',
        {
          class: 'portal-qr-btn portal-bell-btn',
          type: 'button',
          title: 'Notifications',
          'aria-label': 'Notifications',
          onclick: openNotificationCenter,
        },
        renderIcon('bell', { size: 20 }),
        bellBadge,
      ),
    ),
  );

  // A tapped notification lands on #/portal/<screen> (see sw.js). The hash is
  // put back to plain #/portal straight away — tabs never touch the hash, so a
  // reload would otherwise reopen the notification's screen forever after.
  const requested = window.location.hash.replace(/^#\/portal\/?/, '').split(/[/?]/)[0];
  if (requested) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/portal`);
  const reachable = new Set([...TABS.map((tab) => tab.key), 'pass', 'pay', 'schedule']);
  switchTab(reachable.has(requested) ? requested : 'home');
  if (requested === 'notifications') openNotificationCenter();

  return h('div', { class: 'portal-frame' }, h('div', { class: 'portal-app' }, topbar, content, tabbar));
}

/* --------------------------------------------------------------- entry --- */

export async function renderPortal(ctx) {
  if (memberSession.token) {
    try {
      const me = await api.portal.me();
      return renderPortalApp(ctx, me);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // A 401 already cleared memberSession (see request() in api.js) — fall
      // through to the sign-in screen below.
    }
  }
  return renderPortalLogin(ctx);
}
