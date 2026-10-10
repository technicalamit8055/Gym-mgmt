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
} from '../ui.js';
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
  chest: 'Build chest size and strength',
  back: 'Build a stronger back',
  legs: 'Build leg strength and size',
  shoulders: 'Build strong, rounded shoulders',
  arms: 'Build bigger arms',
  core: 'Build a strong, stable core',
  cardio: 'Boost conditioning and endurance',
  full_body: 'Train your whole body',
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

/** The demo, what it works and how to do it — the demo sheet's body, and the
 * "How to" tab of the progress sheet. */
function exerciseDemoBody(exercise) {
  const name = exercise.exercise_name ?? exercise.name;
  const thumb = EXERCISE_THUMBS[String(name).trim().toLowerCase()];
  const demo =
    exerciseMedia(exercise, { className: 'portal-demo-media' }) ??
    (thumb ? h('img', { class: 'portal-demo-media', src: `/images/workout/ex-${thumb}.png`, alt: '' }) : null);
  const blurb = exercise.instructions || EXERCISE_BLURBS[String(name).trim().toLowerCase()] || MUSCLE_BLURBS[exercise.muscle_group] || '';

  return h(
    'div',
    { class: 'portal-demo' },
    demo,
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

/** The Add Exercise filter chips. Olympic is not a muscle group: it is the
 * operator's "olympic" tag, plus anything filed as full body. */
const PICKER_GROUPS = [
  { key: '', label: 'All' },
  ...[
    ['chest', 'Chest', 'weight'],
    ['back', 'Back', 'muscleBack'],
    ['legs', 'Legs', 'muscleLeg'],
    ['shoulders', 'Shoulders', 'muscleShoulders'],
    ['arms', 'Arms', 'muscleArm'],
    ['core', 'Core', 'muscleCore'],
    ['cardio', 'Cardio', 'heartPulse'],
  ].map(([key, label, icon]) => ({ key, label, icon, match: (e) => e.muscle_group === key })),
  {
    key: 'olympic',
    label: 'Olympic',
    icon: 'barbell',
    match: (e) => e.muscle_group === 'full_body' || (e.tags ?? []).some((tag) => String(tag).toLowerCase() === 'olympic'),
  },
];

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
    const next = [name, ...this.read().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 5);
    try {
      localStorage.setItem(RECENT_EXERCISES_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the picker simply shows no recents.
    }
  },
  clear() {
    try {
      localStorage.removeItem(RECENT_EXERCISES_KEY);
    } catch {
      // Nothing stored to clear.
    }
  },
};

/** "Arms · Barbell" — muscle and equipment, the way the picker labels a row. */
const exerciseSubtitle = (item) =>
  [item.muscle_group, item.equipment].filter(Boolean).map((part) => capitalise(muscleLabel(part))).join(' · ');

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
 * The Add Exercise sheet: search, muscle chips, recents and a Hevy-style
 * multi-select. `onAdd` gets the picked library rows in the order they were
 * tapped — the live logger turns them into set tables, the plan builder into
 * targets.
 */
function openExercisePicker(onAdd, { title = 'Add Exercise' } = {}) {
  let library = null;
  let query = '';
  let group = '';
  // Hevy-style multi-select: rows toggle in and out, and they are added in
  // the order they were picked. A Map keeps that order and dedupes by name.
  const selected = new Map();
  const list = h('div', { class: 'portal-pick-list' }, h('div', { class: 'portal-loading' }, 'Loading…'));
  const addButton = h('button', { class: 'portal-pick-submit', type: 'button', onclick: addSelected });
  const footer = h('div', { class: 'portal-pick-footer hidden' }, addButton);

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

  function pickRow(item, { recent = false } = {}) {
    const isOn = selected.has(keyOf(item));
    const order = isOn ? [...selected.keys()].indexOf(keyOf(item)) + 1 : 0;
    return h(
      'div',
      { class: `portal-pick-row${recent ? ' is-recent' : ''}${isOn ? ' selected' : ''}` },
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
          h('span', { class: 'portal-pick-sub' }, exerciseSubtitle(item)),
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
        renderIcon('trendUp', { size: 18 }),
      ),
      h(
        'button',
        {
          class: 'portal-pick-add',
          type: 'button',
          'aria-label': isOn ? `Unselect ${item.name}` : `Select ${item.name}`,
          onclick: () => toggle(item),
        },
        isOn
          ? selected.size > 1
            ? h('span', { class: 'portal-pick-order' }, String(order))
            : renderIcon('check', { size: 18, stroke: 2.6 })
          : renderIcon('plus', { size: 20, stroke: recent ? 2.6 : 2 }),
      ),
    );
  }

  function paintList() {
    if (!library) return;
    const needle = query.trim().toLowerCase();
    const chip = PICKER_GROUPS.find((g) => g.key === group);
    const matches = library
      .filter((e) => !chip?.match || chip.match(e))
      .filter((e) => !needle || `${e.name} ${muscleLabel(e.muscle_group)} ${muscleLabel(e.equipment ?? '')}`.toLowerCase().includes(needle))
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
          .filter((e) => e && (!chip?.match || chip.match(e)));
    if (recents.length) {
      list.append(
        h(
          'div',
          { class: 'portal-pick-head' },
          h('h3', {}, 'Recent'),
          h(
            'button',
            {
              class: 'portal-pick-clear',
              type: 'button',
              onclick: () => {
                recentExercises.clear();
                paintList();
              },
            },
            'Clear',
          ),
        ),
        h('div', { class: 'portal-pick-group' }, ...recents.map((item) => pickRow(item, { recent: true }))),
      );
    }

    list.append(h('div', { class: 'portal-pick-head' }, h('h3', {}, needle ? 'Results' : chip?.key ? `${chip.label} Exercises` : 'All Exercises')));
    if (!matches.length) {
      list.append(h('div', { class: 'portal-empty' }, 'No exercise matches that.'));
      return;
    }
    list.append(h('div', { class: 'portal-pick-group' }, ...matches.slice(0, 120).map((item) => pickRow(item))));
  }

  const search = h(
    'label',
    { class: 'portal-pick-search' },
    renderIcon('search', { size: 20 }),
    h('input', {
      type: 'search',
      placeholder: 'Search exercises (e.g. bicep curl, bench press)',
      'aria-label': 'Search exercises',
      oninput: (event) => {
        query = event.target.value;
        paintList();
      },
    }),
  );
  const chips = h(
    'div',
    { class: 'portal-pick-chips' },
    ...PICKER_GROUPS.map((option) =>
      h(
        'button',
        {
          class: `portal-pick-chip${option.key === group ? ' active' : ''}`,
          type: 'button',
          onclick: (event) => {
            group = option.key;
            for (const el of chips.children) el.classList.remove('active');
            event.currentTarget.classList.add('active');
            paintList();
          },
        },
        option.icon ? renderIcon(option.icon, { size: 16 }) : null,
        h('span', {}, option.label),
      ),
    ),
  );

  openModal({
    title,
    className: 'portal-pick-modal',
    body: h('div', { class: 'portal-pick-sheet' }, search, chips, list, footer),
  });
  // openModal focuses the first input; browsing is the common case, so the
  // keyboard stays down until the member taps the search box.
  search.querySelector('input').blur();
  api.portal
    .exercises()
    .then((res) => {
      library = res.items;
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

  const subtitle = [item.muscle_group, item.equipment].filter(Boolean).map((part) => capitalise(muscleLabel(part))).join(' · ');
  body.append(
    h(
      'div',
      { class: 'portal-exd-hero' },
      pickerThumb(item),
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

/* ── Food search sheet ─────────────────────────────────────────────────── */

/**
 * The add-food sheet: search the library, or type a packet's numbers in.
 *
 * Serving arithmetic is previewed live but recomputed on the server (see the
 * entries POST) — the preview is a courtesy, not the source of truth.
 */
function openFoodSearch({ mealType, mealLabel, logDate, onAdded }) {
  let foods = [];
  let recent = [];
  let selected = null;
  let quantity = 1;

  const results = h('div', { class: 'portal-food-results' }, h('div', { class: 'portal-loading' }, 'Loading foods…'));
  const detail = h('div', {});

  function paintDetail() {
    clear(detail);
    if (!selected) return;
    const scale = quantity || 1;
    const scaled = {
      calories: Math.round(selected.calories * scale),
      protein_g: Math.round(selected.protein_g * scale * 10) / 10,
      carbs_g: Math.round(selected.carbs_g * scale * 10) / 10,
      fats_g: Math.round(selected.fats_g * scale * 10) / 10,
    };

    const qtyInput = h('input', {
      class: 'portal-input portal-qty',
      type: 'number',
      min: 0.05,
      step: 0.25,
      value: quantity,
      oninput: (event) => {
        quantity = Number(event.target.value);
        paintDetail();
      },
    });

    const addBtn = h(
      'button',
      { class: 'btn primary block', type: 'button' },
      `Add to ${mealLabel}`,
    );
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        await api.portal.addFoodEntry({
          meal_type: mealType,
          food_id: selected.id,
          quantity: quantity || 1,
          log_date: logDate,
        });
        closeModal();
        toast(`${selected.name} added`);
        sound.playFoodLogged();
        await onAdded({ calories: scaled.calories, protein_g: scaled.protein_g });
      } catch (err) {
        toast(err.message || 'Could not log that', 'error');
        addBtn.disabled = false;
      }
    });

    append(detail, [
      h(
        'div',
        { class: 'portal-food-detail' },
        h('div', { class: 'portal-food-detail-name' }, selected.name),
        h(
          'div',
          { class: 'portal-food-qty-row' },
          h('span', { class: 'muted' }, `× serving of ${selected.serving_unit}`),
          qtyInput,
        ),
        h(
          'div',
          { class: 'portal-food-macros' },
          h('div', {}, h('strong', {}, String(scaled.calories)), h('span', {}, 'kcal')),
          h('div', {}, h('strong', {}, `${scaled.protein_g}g`), h('span', {}, 'protein')),
          h('div', {}, h('strong', {}, `${scaled.carbs_g}g`), h('span', {}, 'carbs')),
          h('div', {}, h('strong', {}, `${scaled.fats_g}g`), h('span', {}, 'fats')),
        ),
        addBtn,
      ),
    ]);
  }

  function foodRow(food) {
    return h(
      'button',
      {
        class: `portal-food-row${selected?.id === food.id ? ' active' : ''}`,
        type: 'button',
        onclick: () => {
          selected = food;
          quantity = 1;
          paintResults();
          paintDetail();
        },
      },
      h(
        'div',
        {},
        h('div', { class: 'portal-food-name' }, food.name),
        h('div', { class: 'muted' }, `${food.serving_unit} · P ${food.protein_g}g · C ${food.carbs_g}g · F ${food.fats_g}g`),
      ),
      h('div', { class: 'portal-food-kcal' }, `${food.calories}`),
    );
  }

  let query = '';

  function paintResults() {
    const needle = query.trim().toLowerCase();
    const matches = needle ? foods.filter((f) => f.name.toLowerCase().includes(needle)) : foods;
    clear(results);

    if (!needle && recent.length) {
      results.append(h('div', { class: 'portal-food-section' }, 'Your recent foods'));
      // Recent rows come from the member's own log, so they carry no library id
      // — logging one re-sends its stored macros as a hand-typed entry.
      for (const item of recent.slice(0, 6)) {
        results.append(
          h(
            'button',
            {
              class: 'portal-food-row',
              type: 'button',
              onclick: async (event) => {
                event.currentTarget.disabled = true;
                try {
                  await api.portal.addFoodEntry({
                    meal_type: mealType,
                    food_name: item.food_name,
                    serving_unit: item.serving_unit,
                    calories: item.calories,
                    protein_g: item.protein_g,
                    carbs_g: item.carbs_g,
                    fats_g: item.fats_g,
                    log_date: logDate,
                  });
                  closeModal();
                  toast(`${item.food_name} added`);
                  sound.playFoodLogged();
                  await onAdded({ calories: item.calories, protein_g: item.protein_g });
                } catch (err) {
                  toast(err.message || 'Could not log that', 'error');
                  event.currentTarget.disabled = false;
                }
              },
            },
            h(
              'div',
              {},
              h('div', { class: 'portal-food-name' }, item.food_name),
              h('div', { class: 'muted' }, `${item.serving_unit} · one tap to log again`),
            ),
            h('div', { class: 'portal-food-kcal' }, `${item.calories}`),
          ),
        );
      }
      results.append(h('div', { class: 'portal-food-section' }, 'Food library'));
    }

    if (!matches.length) {
      results.append(h('div', { class: 'portal-empty' }, 'Nothing matches — try the Custom tab.'));
      return;
    }
    for (const food of matches.slice(0, 60)) results.append(foodRow(food));
  }

  const search = h('input', {
    class: 'portal-input',
    type: 'search',
    placeholder: 'Search foods…',
    oninput: (event) => {
      query = event.target.value;
      paintResults();
    },
  });

  const customForm = buildForm(
    [
      { name: 'food_name', label: 'What did you eat?', required: true, full: true, placeholder: 'e.g. Cafe protein shake' },
      { name: 'calories', label: 'Calories', type: 'number', required: true, min: 0 },
      { name: 'protein_g', label: 'Protein (g)', type: 'number', min: 0, step: '0.1' },
      { name: 'carbs_g', label: 'Carbs (g)', type: 'number', min: 0, step: '0.1' },
      { name: 'fats_g', label: 'Fats (g)', type: 'number', min: 0, step: '0.1' },
    ],
    {
      submitLabel: `Add to ${mealLabel}`,
      onSubmit: async (values) => {
        const calories = Number(values.calories || 0);
        const protein_g = Number(values.protein_g || 0);
        await api.portal.addFoodEntry({
          meal_type: mealType,
          food_name: values.food_name,
          calories,
          protein_g,
          carbs_g: Number(values.carbs_g || 0),
          fats_g: Number(values.fats_g || 0),
          log_date: logDate,
        });
        closeModal();
        toast('Logged');
        sound.playFoodLogged();
        await onAdded({ calories, protein_g });
      },
    },
  );

  const libraryPane = h('div', {}, search, results, detail);
  const customPane = h('div', { class: 'hidden' }, customForm);
  const switcher = h(
    'div',
    { class: 'portal-sheet-switch' },
    ...[
      ['Search', libraryPane],
      ['Custom', customPane],
    ].map(([label, pane], index) =>
      h(
        'button',
        {
          class: `portal-sheet-tab${index === 0 ? ' active' : ''}`,
          type: 'button',
          onclick: (event) => {
            for (const el of switcher.children) el.classList.remove('active');
            event.currentTarget.classList.add('active');
            libraryPane.classList.toggle('hidden', pane !== libraryPane);
            customPane.classList.toggle('hidden', pane !== customPane);
          },
        },
        label,
      ),
    ),
  );

  openModal({ title: `Add to ${mealLabel}`, body: h('div', { class: 'portal-food-sheet' }, switcher, libraryPane, customPane) });

  api.portal
    .foods()
    .then((res) => {
      foods = res.items;
      recent = res.recent ?? [];
      paintResults();
      search.focus();
    })
    .catch((err) => {
      clear(results).append(h('div', { class: 'portal-empty' }, err.message || 'Could not load the food library'));
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
 */
function buildTabs() {
  if (isLibrary()) {
    return [
      { key: 'home', label: 'Home', icon: 'dashboard' },
      { key: 'pass', label: 'Pass', icon: 'idCard' },
      { key: 'schedule', label: 'Shift', icon: 'seats' },
      { key: 'profile', label: 'Profile', icon: 'member' },
    ];
  }
  return [
    { key: 'home', label: 'Home', icon: 'home' },
    { key: 'workout', label: 'Workout', icon: 'weight' },
    { key: 'diet', label: 'Diet', icon: 'apple' },
    { key: 'schedule', label: 'Schedule', icon: 'classes' },
    { key: 'profile', label: 'Profile', icon: 'member' },
  ];
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

  function paintTabbar() {
    clear(tabbar).append(
      ...TABS.map((tabDef) =>
        h(
          'button',
          { class: `portal-tab${active === tabDef.key ? ' active' : ''}`, type: 'button', onclick: () => switchTab(tabDef.key) },
          renderIcon(tabDef.icon, { size: 22 }),
          h('span', {}, tabDef.label),
        ),
      ),
    );
  }

  async function switchTab(key) {
    stopTicking();
    active = key;
    paintTabbar();
    topbarSub.textContent = TOPBAR_SUBTITLES[key] ?? '';
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
          class: `portal-set-check${set.completed ? ' done' : ''}`,
          type: 'button',
          'aria-label': set.completed ? 'Mark set as not done' : 'Mark set as done',
          onclick: () => {
            set.completed = !set.completed;
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
              { class: `portal-set-1rm${beatsPrevious ? ' beats' : ''}` },
              beatsPrevious ? renderIcon('trophy', { size: 11 }) : null,
              ` ~${weightLabel(oneRm)} 1RM`,
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
    const [plan, day] = await Promise.all([api.portal.currentDiet(), api.portal.dietDay(logDate)]);
    const targets = plan.targets;

    // `added` is the macros of a food entry that just went in — undefined for a
    // deletion or a water bump, which can only move totals away from target.
    // Comparing the pre-add snapshot still held in `day` against the delta
    // catches the exact moment a target is crossed without a second fetch.
    const reload = async (added) => {
      if (added) {
        const crossedCalories = day.totals.calories < targets.target_calories
          && day.totals.calories + (added.calories || 0) >= targets.target_calories;
        const crossedProtein = day.totals.protein_g < targets.target_protein_g
          && day.totals.protein_g + (added.protein_g || 0) >= targets.target_protein_g;
        if (crossedCalories || crossedProtein) sound.playTargetReached();
      }
      dietDate = logDate;
      await switchTab('diet');
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

    /* Hero: calorie ring + macro bars, with the plan underneath */
    body.append(
      h(
        'section',
        { class: 'portal-diet-hero' },
        calorieRing(day.totals.calories, targets.target_calories, { size: 168, stroke: 12, icon: 'flame' }),
        h(
          'div',
          { class: 'portal-dmacro-stack' },
          dietMacro('Protein', day.totals.protein_g, targets.target_protein_g, 'protein', renderIcon('droplet', { size: 13, stroke: 2.4 })),
          dietMacro('Carbs', day.totals.carbs_g, targets.target_carbs_g, 'carbs'),
          dietMacro('Fats', day.totals.fats_g, targets.target_fats_g, 'fats', renderIcon('droplet', { size: 13, stroke: 2.4 })),
        ),
      ),
    );

    body.append(
      plan.plan
        ? h(
            'button',
            { class: 'portal-plan-row', type: 'button', onclick: () => openPlanSheet(plan.plan, targets) },
            h('span', { class: 'portal-plan-ico' }, renderIcon('target', { size: 22 })),
            h('span', { class: 'portal-plan-text' }, `Plan: ${plan.plan.name}`),
            renderIcon('chevronRight', { size: 18 }),
          )
        : h(
            'div',
            { class: 'portal-plan-row static' },
            h('span', { class: 'portal-plan-ico' }, renderIcon('target', { size: 22 })),
            h('span', { class: 'portal-plan-text' }, `Default targets — ${targets.target_calories} kcal. Ask a trainer to set yours.`),
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
                    `${entry.quantity === 1 ? '' : `${entry.quantity} × `}${entry.serving_unit} · P ${entry.protein_g}g · C ${entry.carbs_g}g · F ${entry.fats_g}g`,
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
                ? h('div', { class: 'portal-trainer-box empty' }, 'Nothing logged yet.', h('br'), 'Tap Add food to start.')
                : null,
            ),
          ),
          planned.length ? loggedBox : null,
          h(
            'button',
            {
              class: 'portal-add-food',
              type: 'button',
              onclick: () =>
                openFoodSearch({ mealType: slot.key, mealLabel: slot.label, logDate, onAdded: reload }),
            },
            h('span', { class: 'portal-add-ico' }, renderIcon('plus', { size: 13, stroke: 2.4 })),
            'Add food',
          ),
        ),
      );
    }

    return body;
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

    const reachable = new Set([...TABS.map((tab) => tab.key), 'pass', 'pay']);
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
  const reachable = new Set([...TABS.map((tab) => tab.key), 'pass', 'pay']);
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
