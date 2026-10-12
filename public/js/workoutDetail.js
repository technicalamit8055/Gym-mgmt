import { exerciseMedia, h, initials, renderIcon } from './ui.js';

/**
 * One finished workout laid out the way Hevy's "Workout Detail" is: who and
 * when, the headline numbers, the muscle split and every exercise's sets.
 *
 * Shared by the member app (a pushed screen, with Share and Edit) and the
 * staff member page (a read-only modal), so a trainer reads a session exactly
 * as the member who logged it does. Each side passes what only it has: the
 * member's weight unit, the bundled exercise pictures, what tapping an
 * exercise opens.
 */

/** The bundled demo pictures in /images/workout, for the exercises they show. */
export const EXERCISE_THUMBS = {
  deadlift: 'deadlift',
  'pull-up': 'pullup',
  'seated cable row': 'cable-row',
  'face pull': 'face-pull',
  'barbell curl': 'barbell-curl',
  'hammer curl': 'hammer-curl',
};

/** A logged set's type from what it recorded — for history rows, which carry
 * no equipment. */
export const logTypeOfSet = (set) =>
  Number(set.distance_km) > 0
    ? 'distance_duration'
    : Number(set.duration_seconds) > 0
      ? 'duration'
      : Number(set.weight_kg) > 0
        ? 'weight_reps'
        : 'reps';

/** Seconds as m:ss, or h:mm:ss from an hour up — a stopwatch's reading. */
export function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export const distanceLabel = (km) => `${Math.round((Number(km) || 0) * 100) / 100} km`;

/** A session's length the way Hevy writes it: "48min", "1h 5min". */
export function workoutTimeLabel(seconds) {
  const minutes = Math.max(1, Math.round((Number(seconds) || 0) / 60));
  return minutes < 60 ? `${minutes}min` : `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
}

/** The body regions a session's muscle split is told in — Hevy's, coarser than
 * the groups an exercise is filed under. */
const SPLIT_REGIONS = {
  abdominals: 'Core',
  biceps: 'Arms',
  triceps: 'Arms',
  forearms: 'Arms',
  chest: 'Chest',
  lats: 'Back',
  upper_back: 'Back',
  lower_back: 'Back',
  traps: 'Back',
  shoulders: 'Shoulders',
  quadriceps: 'Legs',
  hamstrings: 'Legs',
  glutes: 'Legs',
  calves: 'Legs',
  abductors: 'Legs',
  adductors: 'Legs',
  cardio: 'Cardio',
  full_body: 'Full body',
};

/** Each region's share of a session's working sets, biggest first. Warm-ups
 * are left out: they prime a muscle, they do not train it. Percentages are
 * rounded so they still add up to 100. */
export function muscleSplit(sets) {
  const working = sets.filter((set) => set.set_type !== 'warmup');
  const counted = working.length ? working : sets;
  const tally = new Map();
  for (const set of counted) {
    const region = SPLIT_REGIONS[set.muscle_group] ?? 'Other';
    tally.set(region, (tally.get(region) ?? 0) + 1);
  }
  const rows = [...tally]
    .map(([label, n]) => ({ label, exact: (n / counted.length) * 100 }))
    .sort((a, b) => b.exact - a.exact)
    .map((row) => ({ ...row, pct: Math.floor(row.exact) }));
  let spare = 100 - rows.reduce((sum, row) => sum + row.pct, 0);
  for (const row of [...rows].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (spare-- <= 0) break;
    row.pct += 1;
  }
  return rows.map(({ label, pct }) => ({ label, pct }));
}

/** A session's sets grouped by exercise, in the order each first appears. */
export function setsByExercise(sets) {
  const grouped = new Map();
  for (const set of sets) {
    if (!grouped.has(set.exercise_name)) grouped.set(set.exercise_name, []);
    grouped.get(set.exercise_name).push(set);
  }
  return grouped;
}

const SET_SHORT = { warmup: 'W', drop: 'D', failure: 'F' };

/** An exercise's picture: the operator's upload, then the bundled one, then a
 * dumbbell, so every row's header is the same shape. */
export function defaultExerciseThumb(exercise) {
  const bundled = EXERCISE_THUMBS[String(exercise.exercise_name).trim().toLowerCase()];
  return (
    exerciseMedia(exercise, { className: 'wd-thumb-media', still: true }) ??
    (bundled
      ? h('img', { class: 'wd-thumb-media', src: `/images/workout/ex-${bundled}.png`, alt: '', loading: 'lazy' })
      : renderIcon('weight', { size: 22 }))
  );
}

/**
 * The detail body for `log` (a workout_logs row with its `sets`).
 *
 *   person      { first_name, last_name, photo_url } shown at the top
 *   toDisplay   kg → the viewer's unit; `unit` names it
 *   thumb       exercise → its picture node
 *   onExercise  exercise → void; without it exercise names are plain text
 *   share, edit optional actions; each adds its button when given
 */
export function workoutDetailBody(
  log,
  { person, unit = 'kg', toDisplay = (kg) => kg, thumb = defaultExerciseThumb, onExercise = null, share = null, edit = null },
) {
  const weightText = (kg) => `${toDisplay(Number(kg) || 0)} ${unit}`;
  const records = log.sets.filter((set) => set.is_pr).length;
  const volume = `${Math.round(toDisplay(Number(log.total_volume_kg) || 0)).toLocaleString()} ${unit}`;

  const started = new Date(`${String(log.started_at).replace(' ', 'T')}Z`);
  const when = Number.isNaN(started.getTime())
    ? new Date(`${log.log_date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
    : `${started.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })} · ${started
        .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        .toLowerCase()}`;

  const stat = (label, value, extra) => h('div', { class: 'wd-stat' }, h('span', {}, label), h('strong', {}, value, extra ?? null));
  const medal = (title) => h('span', { class: 'wd-medal', title }, renderIcon('trophy', { size: 16 }));
  const split = muscleSplit(log.sets);

  return h(
    'div',
    { class: 'wd' },
    h(
      'div',
      { class: 'wd-who' },
      person.photo_url
        ? h('img', { class: 'wd-avatar', src: person.photo_url, alt: '' })
        : h('div', { class: 'wd-avatar is-initials' }, initials(person.first_name, person.last_name)),
      h('div', {}, h('strong', {}, `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim()), h('span', {}, when)),
    ),
    h('h3', { class: 'wd-title' }, log.workout_name),
    log.notes ? h('p', { class: 'wd-notes' }, log.notes) : null,
    h(
      'div',
      { class: 'wd-stats' },
      stat('Time', workoutTimeLabel(log.duration_seconds)),
      stat('Volume', volume),
      stat('Sets', String(log.total_sets)),
      stat('Records', String(records), records ? medal() : null),
    ),
    share
      ? h(
          'div',
          { class: 'wd-actions' },
          h('button', { class: 'wd-action', type: 'button', onclick: share }, renderIcon('upload', { size: 18 }), h('span', {}, 'Share')),
        )
      : null,

    split.length
      ? h(
          'section',
          { class: 'wd-section' },
          h('h4', { class: 'wd-label' }, 'Muscle split'),
          ...split.map(({ label, pct }) =>
            h(
              'div',
              { class: 'wd-split' },
              h('span', { class: 'wd-split-name' }, label),
              h(
                'div',
                { class: 'wd-split-row' },
                h('span', { class: 'wd-split-bar', style: `--w:${(pct / split[0].pct) * 100}%` }),
                h('span', { class: 'wd-split-pct' }, `${pct}%`),
              ),
            ),
          ),
        )
      : null,

    h(
      'section',
      { class: 'wd-section' },
      h(
        'div',
        { class: 'wd-label-row' },
        h('h4', { class: 'wd-label' }, 'Workout'),
        edit ? h('button', { class: 'wd-edit', type: 'button', onclick: edit }, 'Edit workout') : null,
      ),
      ...[...setsByExercise(log.sets)].map(([name, sets]) => exerciseBlock(name, sets)),
    ),
  );

  /** One exercise: its picture and name, then the sets as Hevy lists them —
   * W for a warm-up, working sets numbered, a medal on a record. */
  function exerciseBlock(name, sets) {
    const exercise = { ...sets[0], name, exercise_name: name };
    const type = logTypeOfSet(sets.find((set) => set.set_type !== 'warmup') ?? sets[0]);
    const column = { weight_reps: 'Weight & reps', reps: 'Reps', duration: 'Time', distance_duration: 'Distance & time' }[type];
    const text = (set) => {
      const seconds = Number(set.duration_seconds) || 0;
      const km = Number(set.distance_km) || 0;
      if (type === 'weight_reps') return `${weightText(set.weight_kg)} × ${Number(set.reps) || 0} reps`;
      if (type === 'reps') return `${Number(set.reps) || 0} reps`;
      if (type === 'duration') return seconds > 0 ? durationLabel(seconds) : '—';
      return [km > 0 ? distanceLabel(km) : null, seconds > 0 ? durationLabel(seconds) : null].filter(Boolean).join(' · ') || '—';
    };
    const head = [h('span', { class: 'wd-ex-thumb' }, thumb(exercise)), h('span', { class: 'wd-ex-name' }, name)];

    let working = 0;
    return h(
      'div',
      { class: 'wd-ex' },
      onExercise
        ? h('button', { class: 'wd-ex-head', type: 'button', onclick: () => onExercise(exercise) }, ...head)
        : h('div', { class: 'wd-ex-head' }, ...head),
      h('div', { class: 'wd-set is-head' }, h('span', {}, 'Set'), h('span', {}, column)),
      ...sets.map((set) => {
        if (set.set_type !== 'warmup') working += 1;
        return h(
          'div',
          { class: `wd-set t-${set.set_type}` },
          h('span', { class: 'wd-set-no' }, set.set_type === 'normal' ? String(working) : (SET_SHORT[set.set_type] ?? '')),
          h('span', {}, text(set)),
          set.is_pr ? medal('Personal record') : null,
        );
      }),
    );
  }
}
