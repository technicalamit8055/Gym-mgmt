import { api } from '../api.js';
import { clear, closeModal, confirmDialog, exerciseMedia, h, openModal, renderIcon, toast } from '../ui.js';

/**
 * The operator's exercise library: one Hevy-style catalogue for every gym on
 * the platform, each exercise with an optional demo image, GIF or short clip.
 *
 * Lives in the operator console rather than in a gym's own staff screens
 * because a demo of a deadlift is the same for everyone — upload it once here
 * and every gym's pickers, routines and members' logger show it.
 */

const label = (value) => String(value ?? '').replace(/_/g, ' ');
const capital = (value) => label(value).replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/** "Pull-Up", "pull_up.gif" and "PULL UP" are the same exercise. */
const normalise = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (filename) => filename.replace(/\.[^.]+$/, '');
/** "ex-deadlift" is the same file as "deadlift": the prefix is a naming habit, not part of the exercise. */
const withoutPrefix = (text) => text.replace(/^ex[-_ ]+/i, '');

/* ── CSV ──────────────────────────────────────────────────────────────── */

/** A small RFC-4180 reader: quoted fields, doubled quotes, commas and
 * newlines inside quotes. Enough for a spreadsheet export; not a library. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = String(text).replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Header-keyed rows from CSV text. Header names are matched loosely
 * ("Muscle Group" = muscle_group) so a sheet from anywhere works. */
export function csvToExercises(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((cell) => normalise(cell).replace(/ /g, '_'));
  return body.map((cells) => {
    const row = {};
    keys.forEach((key, i) => {
      if (key && cells[i] !== undefined) row[key] = cells[i].trim();
    });
    if (row.muscle) row.muscle_group ??= row.muscle;
    if (row.primary_muscle) row.muscle_group ??= row.primary_muscle;
    if (row.muscle_group) row.muscle_group = row.muscle_group.toLowerCase().replace(/[\s-]+/g, '_');
    if (row.equipment) row.equipment = row.equipment.toLowerCase().replace(/[\s-]+/g, '_');
    return row;
  });
}

const CSV_TEMPLATE = [
  'name,muscle_group,equipment,secondary_muscles,tags,instructions',
  '"Landmine Press",shoulders,barbell,"chest, triceps",unilateral,"Press the bar up and slightly forward."',
  '"Incline Dumbbell Curl",arms,dumbbell,,isolation,"Keep the elbows back behind the torso."',
].join('\n');

/* ── Pieces ───────────────────────────────────────────────────────────── */

function previewBox(exercise, className = 'cat-preview') {
  return h(
    'div',
    { class: className },
    exerciseMedia(exercise, { still: true }) ?? h('div', { class: 'cat-preview-empty' }, renderIcon('weight', { size: 26 })),
  );
}

function card(exercise, onOpen) {
  return h(
    'button',
    { class: 'cat-card', type: 'button', onclick: () => onOpen(exercise) },
    previewBox(exercise),
    h(
      'div',
      { class: 'cat-card-body' },
      h('div', { class: 'cat-card-name' }, exercise.name),
      h(
        'div',
        { class: 'cat-card-badges' },
        h('span', { class: 'badge blue' }, capital(exercise.muscle_group)),
        h('span', { class: 'badge grey' }, capital(exercise.equipment)),
        exercise.media_type ? h('span', { class: 'badge green' }, exercise.media_type === 'gif' ? 'GIF' : capital(exercise.media_type)) : h('span', { class: 'badge' }, 'No demo'),
      ),
      exercise.secondary_muscles.length
        ? h('div', { class: 'cat-card-sub' }, `Also: ${exercise.secondary_muscles.map(label).join(', ')}`)
        : null,
    ),
  );
}

/* ── Add / edit ───────────────────────────────────────────────────────── */

function openExerciseModal(exercise, meta, onSaved) {
  const isNew = !exercise;
  const state = {
    secondary: new Set(exercise?.secondary_muscles ?? []),
    file: null,
    removeMedia: false,
  };

  const name = h('input', { type: 'text', value: exercise?.name ?? '', placeholder: 'e.g. Incline Dumbbell Curl' });
  const muscle = h(
    'select',
    {},
    ...meta.muscle_groups.map((m) => h('option', { value: m, selected: m === (exercise?.muscle_group ?? 'chest') }, capital(m))),
  );
  const equipment = h(
    'select',
    {},
    ...meta.equipment.map((e) => h('option', { value: e, selected: e === (exercise?.equipment ?? 'barbell') }, capital(e))),
  );
  const tags = h('input', { type: 'text', value: (exercise?.tags ?? []).join(', '), placeholder: 'compound, unilateral…' });
  const instructions = h('textarea', { rows: 4, placeholder: 'How to perform it — shown to members.' }, exercise?.instructions ?? '');

  const chips = h('div', { class: 'cat-chips' });
  const drawChips = () => {
    clear(chips).append(
      ...meta.muscle_groups
        .filter((m) => m !== muscle.value)
        .map((m) =>
          h(
            'button',
            {
              type: 'button',
              class: `fit-chip${state.secondary.has(m) ? ' active' : ''}`,
              onclick: () => {
                if (state.secondary.has(m)) state.secondary.delete(m);
                else state.secondary.add(m);
                drawChips();
              },
            },
            capital(m),
          ),
        ),
    );
  };
  muscle.addEventListener('change', () => {
    state.secondary.delete(muscle.value);
    drawChips();
  });
  drawChips();

  /* Demo: current preview + picker. A newly chosen file previews locally
     (object URL) before anything is uploaded. */
  const stage = h('div', { class: 'cat-stage' });
  const mediaNote = h('div', { class: 'muted', style: 'font-size:12px' });
  let objectUrl = null;
  const drawStage = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    let shown = state.removeMedia ? null : exercise;
    if (state.file) {
      objectUrl = URL.createObjectURL(state.file);
      shown = { media_url: objectUrl, media_type: state.file.type.startsWith('video/') ? 'video' : 'image' };
    }
    clear(stage).append(exerciseMedia(shown) ?? h('div', { class: 'cat-preview-empty' }, renderIcon('image', { size: 30 }), h('span', {}, 'No demo yet')));
    mediaNote.textContent = state.file
      ? `${state.file.name} · ${mb(state.file.size)} — saved when you press Save`
      : shown?.media_bytes
        ? `${capital(shown.media_type)} · ${mb(shown.media_bytes)}`
        : `PNG, JPG, WebP, GIF, MP4 or WebM, up to ${mb(meta.media.max_bytes)}.`;
  };

  const fileInput = h('input', {
    type: 'file',
    accept: meta.media.mimes.join(','),
    style: 'display:none',
    onchange: (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (!meta.media.mimes.includes(file.type)) return toast('Use a PNG, JPG, WebP, GIF, MP4 or WebM file', 'error');
      if (file.size > meta.media.max_bytes) return toast(`That file is ${mb(file.size)} — the limit is ${mb(meta.media.max_bytes)}`, 'error');
      state.file = file;
      state.removeMedia = false;
      drawStage();
    },
  });
  const removeBtn = h(
    'button',
    {
      class: 'btn sm ghost',
      type: 'button',
      onclick: () => {
        state.file = null;
        state.removeMedia = Boolean(exercise?.media_url);
        drawStage();
      },
    },
    'Remove demo',
  );
  drawStage();

  const save = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add exercise' : 'Save changes');
  const body = h(
    'form',
    {
      class: 'cat-form',
      onsubmit: async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          const payload = {
            name: name.value,
            muscle_group: muscle.value,
            equipment: equipment.value,
            secondary_muscles: [...state.secondary],
            tags: tags.value,
            instructions: instructions.value,
          };
          let saved = isNew ? await api.platformCreateExercise(payload) : await api.platformUpdateExercise(exercise.id, payload);
          if (state.file) saved = await api.platformUploadExerciseMedia(saved.id, state.file);
          else if (state.removeMedia) saved = await api.platformClearExerciseMedia(saved.id);
          closeModal();
          toast(isNew ? `${saved.name} added` : `${saved.name} saved`);
          await onSaved();
        } catch (err) {
          toast(err.message || 'Could not save', 'error');
          // The exercise itself may have saved before a failed upload: reload
          // the list so the operator sees the real state, but keep the modal.
          if (!isNew) onSaved({ keepOpen: true });
        } finally {
          save.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'cat-form-grid' },
      h(
        'div',
        { class: 'cat-form-media' },
        stage,
        mediaNote,
        h(
          'div',
          { class: 'row', style: 'gap:8px' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => fileInput.click() }, renderIcon('upload', { size: 15 }), exercise?.media_url || state.file ? 'Replace' : 'Upload demo'),
          removeBtn,
          fileInput,
        ),
      ),
      h(
        'div',
        { class: 'cat-form-fields' },
        h('label', { class: 'field' }, h('span', {}, 'Name *'), name),
        h(
          'div',
          { class: 'form-grid' },
          h('label', { class: 'field' }, h('span', {}, 'Primary muscle'), muscle),
          h('label', { class: 'field' }, h('span', {}, 'Equipment'), equipment),
        ),
        h('div', { class: 'field' }, h('span', {}, 'Secondary muscles'), chips),
        h('label', { class: 'field' }, h('span', {}, 'Tags'), tags),
        h('label', { class: 'field' }, h('span', {}, 'Instructions'), instructions),
      ),
    ),
    h(
      'div',
      { class: 'modal-foot', style: 'padding:12px 0 0;border:none' },
      isNew
        ? null
        : h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              style: 'margin-right:auto',
              onclick: () =>
                confirmDialog({
                  title: `Delete ${exercise.name}?`,
                  message: 'It disappears from every gym\'s exercise list. Routines that already use the name keep working, without a demo.',
                  confirmLabel: 'Delete exercise',
                  danger: true,
                  onConfirm: async () => {
                    await api.platformDeleteExercise(exercise.id);
                    // The confirm dialog closes itself once this resolves, so
                    // this one closes the edit modal beneath it.
                    closeModal();
                    toast(`${exercise.name} deleted`);
                    await onSaved();
                  },
                }),
            },
            'Delete',
          ),
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
      save,
    ),
  );

  const modal = openModal({ title: isNew ? 'Add exercise' : exercise.name, body, wide: true, onClose: () => objectUrl && URL.revokeObjectURL(objectUrl) });
  modal.classList.add('cat-modal');
}

/* ── Bulk import ──────────────────────────────────────────────────────── */

function openImportModal(onDone) {
  const status = h('div', { class: 'muted', style: 'font-size:13px;min-height:20px' });
  const paste = h('textarea', { rows: 8, placeholder: 'name,muscle_group,equipment,secondary_muscles,tags,instructions\n"Landmine Press",shoulders,barbell,"chest, triceps",unilateral,"Press up and forward."' });
  const results = h('div', {});
  let rows = [];

  const read = () => {
    rows = csvToExercises(paste.value);
    status.textContent = rows.length ? `${rows.length} exercise${rows.length === 1 ? '' : 's'} ready to import` : 'Paste or choose a CSV with a header row.';
    go.disabled = !rows.length;
  };
  paste.addEventListener('input', read);

  const picker = h('input', {
    type: 'file',
    accept: '.csv,text/csv',
    style: 'display:none',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      paste.value = await file.text();
      read();
    },
  });

  const go = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      disabled: true,
      onclick: async () => {
        go.disabled = true;
        try {
          const res = await api.platformImportExercises(rows);
          clear(results).append(
            h('div', { class: 'badge green', style: 'margin-top:12px' }, `${res.created} added · ${res.updated} updated`),
            res.errors.length
              ? h(
                  'div',
                  { style: 'margin-top:10px' },
                  h('div', { style: 'font-weight:600;font-size:13px' }, `${res.errors.length} row${res.errors.length === 1 ? '' : 's'} skipped`),
                  h('ul', { class: 'cat-errors' }, ...res.errors.map((e) => h('li', {}, `Row ${e.line}${e.name ? ` (${e.name})` : ''}: ${e.error}`))),
                )
              : null,
          );
          await onDone();
        } catch (err) {
          toast(err.message || 'Import failed', 'error');
          go.disabled = false;
        }
      },
    },
    'Import',
  );

  const template = h(
    'a',
    {
      class: 'btn sm ghost',
      download: 'exercise-catalog-template.csv',
      href: `data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`,
    },
    'Download template',
  );

  openModal({
    title: 'Import exercises from CSV',
    wide: true,
    body: h(
      'div',
      { class: 'cat-import' },
      h('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px' }, 'Exercises are matched by name: new ones are added, existing ones are updated with the columns you provide (blank columns are left alone). Muscle groups: chest, back, legs, shoulders, arms, core, cardio, full_body.'),
      h('div', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => picker.click() }, renderIcon('upload', { size: 15 }), 'Choose CSV file'), template, picker),
      paste,
      status,
      results,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Close'), go],
  });
}

/* ── Bulk demo upload ─────────────────────────────────────────────────── */

function openBulkMediaModal(items, meta, onDone) {
  const byName = new Map(items.map((item) => [normalise(item.name), item]));
  let matches = [];
  const list = h('div', { class: 'cat-match-list' });
  const status = h('div', { class: 'muted', style: 'font-size:13px' }, 'Name each file after its exercise — "pull-up.gif", "Barbell Bench Press.png" — and they are matched automatically.');

  const draw = () => {
    clear(list).append(
      ...matches.map((m) =>
        h(
          'div',
          { class: `cat-match${m.item ? '' : ' is-missing'}${m.done ? ' is-done' : ''}` },
          h('span', { class: 'cat-match-file' }, m.file.name),
          h('span', { class: 'muted' }, mb(m.file.size)),
          h('span', { class: 'cat-match-target' }, m.error ? m.error : m.done ? 'Uploaded' : m.item ? `→ ${m.item.name}` : 'No exercise with that name'),
        ),
      ),
    );
    const ready = matches.filter((m) => m.item && !m.done && !m.error);
    go.disabled = !ready.length;
    go.textContent = ready.length ? `Upload ${ready.length} demo${ready.length === 1 ? '' : 's'}` : 'Upload';
  };

  const picker = h('input', {
    type: 'file',
    multiple: '',
    accept: meta.media.mimes.join(','),
    style: 'display:none',
    onchange: (e) => {
      matches = [...e.target.files].map((file) => {
        const entry = {
          file,
          item: byName.get(normalise(stem(file.name))) ?? byName.get(normalise(withoutPrefix(stem(file.name)))) ?? null,
        };
        if (!meta.media.mimes.includes(file.type)) entry.error = 'Unsupported file type';
        else if (file.size > meta.media.max_bytes) entry.error = `Over ${mb(meta.media.max_bytes)}`;
        return entry;
      });
      e.target.value = '';
      draw();
    },
  });

  const go = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      disabled: true,
      onclick: async () => {
        go.disabled = true;
        let ok = 0;
        for (const m of matches.filter((x) => x.item && !x.done && !x.error)) {
          status.textContent = `Uploading ${m.file.name}…`;
          try {
            await api.platformUploadExerciseMedia(m.item.id, m.file);
            m.done = true;
            ok += 1;
          } catch (err) {
            m.error = err.message || 'Upload failed';
          }
          draw();
        }
        status.textContent = `${ok} demo${ok === 1 ? '' : 's'} uploaded.`;
        await onDone();
      },
    },
    'Upload',
  );

  openModal({
    title: 'Bulk upload demos',
    wide: true,
    body: h(
      'div',
      {},
      h('div', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => picker.click() }, renderIcon('upload', { size: 15 }), 'Choose files'), picker),
      status,
      list,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Close'), go],
  });
}

/* ── Muscle group pictures ────────────────────────────────────────────── */

/** Filename shorthands for the bulk upload: "abs.png" is the abdominals picture. */
const MUSCLE_ALIASES = { abs: 'abdominals', core: 'abdominals', quads: 'quadriceps', hams: 'hamstrings', delts: 'shoulders', glute: 'glutes', calf: 'calves', bicep: 'biceps', tricep: 'triceps', trap: 'traps', lat: 'lats', forearm: 'forearms', 'full body': 'full_body' };

/** The muscle group a file is named after, or undefined. */
function muscleForFile(filename, muscles) {
  const key = normalise(withoutPrefix(stem(filename)));
  return (
    muscles.find((m) => normalise(m.key) === key || normalise(m.label) === key)?.key ??
    MUSCLE_ALIASES[key]
  );
}

/**
 * One highlighted-body picture per muscle group — what members see beside
 * each group in the picker's "Muscle Group" sheet. Uploads go straight up on
 * choosing a file; there is nothing else to save.
 */
function openMuscleMediaModal() {
  let muscles = [];
  let limits = { max_bytes: 0, mimes: [] };
  const grid = h('div', { class: 'cat-muscle-grid' }, h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Loading…'));
  const status = h('div', { class: 'muted', style: 'font-size:13px' });

  const check = (file) => {
    // Some systems report no type for an .svg; the server reads the bytes anyway.
    const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : '');
    if (!limits.mimes.includes(type)) return 'Use a PNG, JPG, WebP, GIF or SVG picture';
    if (file.size > limits.max_bytes) return `That file is ${mb(file.size)} — the limit is ${mb(limits.max_bytes)}`;
    return null;
  };

  const replace = (updated) => {
    muscles = muscles.map((m) => (m.key === updated.key ? updated : m));
  };

  async function upload(muscle, file) {
    const problem = check(file);
    if (problem) return toast(problem, 'error');
    try {
      replace(await api.platformUploadMuscleMedia(muscle.key, file));
      draw();
    } catch (err) {
      toast(err.message || 'Upload failed', 'error');
    }
  }

  function tile(muscle) {
    const input = h('input', {
      type: 'file',
      accept: [...limits.mimes, '.svg'].join(','),
      style: 'display:none',
      onchange: (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) upload(muscle, file);
      },
    });
    return h(
      'div',
      { class: `cat-muscle${muscle.media_url ? '' : ' is-empty'}` },
      h(
        'button',
        { class: 'cat-muscle-pic', type: 'button', title: `Upload the ${muscle.label} picture`, onclick: () => input.click() },
        muscle.media_url ? h('img', { src: muscle.media_url, alt: '' }) : renderIcon('image', { size: 22 }),
      ),
      h('div', { class: 'cat-muscle-name' }, muscle.label),
      h(
        'div',
        { class: 'cat-muscle-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => input.click() }, muscle.media_url ? 'Replace' : 'Upload'),
        muscle.media_url
          ? h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                onclick: async () => {
                  try {
                    replace(await api.platformClearMuscleMedia(muscle.key));
                    draw();
                  } catch (err) {
                    toast(err.message || 'Could not remove it', 'error');
                  }
                },
              },
              'Remove',
            )
          : null,
        input,
      ),
    );
  }

  function draw() {
    const done = muscles.filter((m) => m.media_url).length;
    status.textContent = `${done} of ${muscles.length} muscle groups have a picture. Square images with the muscle highlighted work best.`;
    clear(grid).append(...muscles.map(tile));
  }

  /* Many at once, matched by filename: "biceps.png", "Upper Back.jpg", "abs.webp". */
  const bulk = h('input', {
    type: 'file',
    multiple: true,
    accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg',
    style: 'display:none',
    onchange: async (e) => {
      const files = [...(e.target.files ?? [])];
      e.target.value = '';
      const unmatched = [];
      let uploaded = 0;
      for (const file of files) {
        const key = muscleForFile(file.name, muscles);
        const muscle = muscles.find((m) => m.key === key);
        if (!muscle) {
          unmatched.push(file.name);
          continue;
        }
        const problem = check(file);
        if (problem) {
          unmatched.push(`${file.name} (${problem})`);
          continue;
        }
        try {
          replace(await api.platformUploadMuscleMedia(muscle.key, file));
          uploaded += 1;
        } catch (err) {
          unmatched.push(`${file.name} (${err.message})`);
        }
      }
      draw();
      if (uploaded) toast(`${uploaded} picture${uploaded === 1 ? '' : 's'} uploaded`);
      if (unmatched.length) toast(`Not matched to a muscle group: ${unmatched.join(', ')}`, 'error');
    },
  });

  const modal = openModal({
    title: 'Muscle group pictures',
    subtitle: 'Shown to members beside each group in the exercise picker\'s Muscle Group filter.',
    wide: true,
    body: h(
      'div',
      {},
      h(
        'div',
        { class: 'row', style: 'gap:10px;margin-bottom:12px;align-items:center;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => bulk.click() }, renderIcon('upload', { size: 15 }), 'Upload many (match by filename)'),
        bulk,
        status,
      ),
      grid,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Done')],
  });
  modal.classList.add('cat-modal');

  api
    .platformMuscles()
    .then((res) => {
      muscles = res.items;
      limits = res.media;
      draw();
    })
    .catch((err) => clear(grid).append(h('div', { class: 'empty', style: 'grid-column:1/-1' }, err.message || 'Could not load the muscle groups')));
}

/* ── The section ──────────────────────────────────────────────────────── */

export function renderCatalogSection({ onExpired } = {}) {
  const state = { q: '', muscle_group: '', equipment: '', media: '' };
  let meta = { muscle_groups: [], equipment: [], media: { max_bytes: 0, mimes: [] } };
  let items = [];

  const grid = h('div', { class: 'cat-grid' });
  const summary = h('div', { class: 'muted', style: 'font-size:13px;margin:-4px 0 12px' });
  const root = h('div', {}, h('div', { class: 'empty' }, 'Loading the exercise library…'));

  const load = async () => {
    try {
      const res = await api.platformCatalog({ q: state.q, muscle_group: state.muscle_group, equipment: state.equipment, media: state.media });
      items = res.items;
      meta = { muscle_groups: res.muscle_groups, equipment: res.equipment, media: res.media };
      return res;
    } catch (err) {
      // The operator's own token lapsed: back to the console's sign-in.
      if ((err.status === 401 || err.status === 403) && onExpired) {
        await onExpired();
        return null;
      }
      toast(err.message || 'Could not load the exercise library', 'error');
      return null;
    }
  };

  const draw = () => {
    const withDemo = items.filter((i) => i.media_url).length;
    summary.textContent = `${items.length} exercise${items.length === 1 ? '' : 's'} · ${withDemo} with a demo`;
    clear(grid).append(...items.map((item) => card(item, (it) => openExerciseModal(it, meta, refresh))));
    if (!items.length) grid.append(h('div', { class: 'empty', style: 'grid-column:1/-1' }, state.q || state.muscle_group || state.equipment || state.media ? 'No exercise matches that' : 'The library is empty — add an exercise or import a CSV'));
  };

  const refresh = async () => {
    if (await load()) draw();
  };

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search exercises…' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = search.value.trim();
      refresh();
    }, 200);
  });

  const select = (key, placeholder, options) =>
    h(
      'select',
      {
        onchange: (e) => {
          state[key] = e.target.value;
          refresh();
        },
      },
      h('option', { value: '' }, placeholder),
      ...options.map(([value, text]) => h('option', { value }, text)),
    );

  const muscleSelect = h('select', { onchange: (e) => { state.muscle_group = e.target.value; refresh(); } }, h('option', { value: '' }, 'All muscles'));
  const equipmentSelect = h('select', { onchange: (e) => { state.equipment = e.target.value; refresh(); } }, h('option', { value: '' }, 'All equipment'));
  const mediaSelect = select('media', 'Any demo status', [['yes', 'Has a demo'], ['no', 'Missing a demo']]);

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    search,
    muscleSelect,
    equipmentSelect,
    mediaSelect,
    h('div', { class: 'spacer', style: 'flex:1' }),
    h('button', { class: 'btn sm', type: 'button', onclick: openMuscleMediaModal }, renderIcon('bicep', { size: 15 }), 'Muscle pictures'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => openBulkMediaModal(items, meta, refresh) }, renderIcon('image', { size: 15 }), 'Bulk upload demos'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => openImportModal(refresh) }, renderIcon('upload', { size: 15 }), 'Import CSV'),
    h('button', { class: 'btn primary sm', type: 'button', onclick: () => openExerciseModal(null, meta, refresh) }, renderIcon('plus', { size: 15 }), 'Add exercise'),
  );

  (async () => {
    const res = await load();
    if (!res) {
      clear(root).append(h('div', { class: 'empty' }, 'Could not load the exercise library'));
      return;
    }
    for (const m of meta.muscle_groups) muscleSelect.append(h('option', { value: m }, capital(m)));
    for (const e of meta.equipment) equipmentSelect.append(h('option', { value: e }, capital(e)));
    clear(root).append(toolbar, summary, grid);
    draw();
  })();

  return root;
}
