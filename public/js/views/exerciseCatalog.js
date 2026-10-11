import { api } from '../api.js';
import { clear, closeModal, confirmDialog, exerciseMedia, h, openModal, renderIcon, toast } from '../ui.js';

/**
 * The operator's exercise library: one Hevy-style catalogue for every gym on
 * the platform, each exercise with an optional demo image, GIF or short clip.
 *
 * Lives in the operator console rather than in a gym's own staff screens
 * because a demo of a deadlift is the same for everyone — upload it once here
 * and every gym's pickers, routines and members' logger show it.
 *
 * New exercises come in one at a time, or in bulk from a CSV or JSON sheet —
 * and the AI prompt builder writes the instructions that get an AI tool to
 * produce exactly that sheet, columns and all.
 */

const label = (value) => String(value ?? '').replace(/_/g, ' ');
const capital = (value) => label(value).replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/** "Pull-Up", "pull_up.gif" and "PULL UP" are the same exercise. */
const normalise = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (filename) => filename.replace(/\.[^.]+$/, '');
/** "ex-deadlift" is the same file as "deadlift": the prefix is a naming habit, not part of the exercise. */
const withoutPrefix = (text) => text.replace(/^ex[-_ ]+/i, '');

/** Everyday names for muscle groups, as filenames ("abs.png" is the
 * abdominals picture) and reference sites' muscle lists write them. */
const MUSCLE_ALIASES = {
  abs: 'abdominals', core: 'abdominals', obliques: 'abdominals',
  quads: 'quadriceps', hams: 'hamstrings', calf: 'calves',
  delts: 'shoulders', deltoids: 'shoulders', pecs: 'chest', pectorals: 'chest',
  'front delts': 'shoulders', 'side delts': 'shoulders', 'rear delts': 'shoulders', 'rotator cuff': 'shoulders',
  glute: 'glutes', hips: 'glutes', bicep: 'biceps', tricep: 'triceps', forearm: 'forearms',
  trap: 'traps', trapezius: 'traps', lat: 'lats', 'latissimus dorsi': 'lats',
  'erector spinae': 'lower_back', 'full body': 'full_body',
};

/** "Lower Back", "lower-back", "Glute" and "abs" → the muscle group key, or null. */
function muscleFromText(text, groups) {
  const words = normalise(text);
  if (!words) return null;
  const key = words.replace(/ /g, '_');
  if (groups.includes(key)) return key;
  if (groups.includes(`${key}s`)) return `${key}s`;
  const alias = MUSCLE_ALIASES[words];
  return alias && groups.includes(alias) ? alias : null;
}

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

/** The sheet inside a ```csv / ```json fence, as AI tools like to reply. */
export const unfence = (text) => {
  const fenced = /```[a-z]*\s*\n([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
};

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const toCsv = (rows, columns) => [columns.join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\n');

export function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text, fallbackInput) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to the clipboard');
  } catch {
    fallbackInput?.select();
    toast('Select all and copy it from the box', 'error');
  }
}

/** The columns, in the order the template, the export and the AI prompt use. */
const COLUMNS = ['name', 'muscle_group', 'equipment', 'secondary_muscles', 'tags', 'instructions'];

/** What other sheets and AI tools call the columns. */
const KEY_ALIASES = {
  exercise: 'name', exercise_name: 'name', title: 'name',
  muscle: 'muscle_group', primary_muscle: 'muscle_group', primary_muscle_group: 'muscle_group', target: 'muscle_group', target_muscle: 'muscle_group', body_part: 'muscle_group',
  secondary: 'secondary_muscles', secondary_muscle: 'secondary_muscles', secondary_muscle_groups: 'secondary_muscles', other_muscles: 'secondary_muscles', synergists: 'secondary_muscles',
  equipment_type: 'equipment', gear: 'equipment',
  tag: 'tags', keywords: 'tags', labels: 'tags',
  how_to: 'instructions', description: 'instructions', steps: 'instructions', cues: 'instructions',
};

/** Everyday names for the equipment types. */
const EQUIPMENT_ALIASES = {
  barbells: 'barbell', ez_bar: 'barbell', trap_bar: 'barbell',
  dumbbells: 'dumbbell', kettlebells: 'kettlebell', plates: 'plate', weight_plate: 'plate', weight_plates: 'plate',
  cables: 'cable', cable_machine: 'cable', machines: 'machine', smith: 'smith_machine',
  bands: 'band', resistance_band: 'band', resistance_bands: 'band',
  body_weight: 'bodyweight', none: 'bodyweight', no_equipment: 'bodyweight',
};

const asKey = (text) => normalise(text).replace(/ /g, '_');
/** "Lower Back" → lower_back, "quads" → quadriceps. Unknown values pass
 * through for the server to report against its row. */
const muscleKey = (text) => MUSCLE_ALIASES[normalise(text)] ?? asKey(text);
const asList = (value) => (Array.isArray(value) ? value : String(value).split(/[,;|]/)).map((v) => String(v).trim()).filter(Boolean);

/** Raw sheet values → what the import endpoint takes. Empty columns are
 * dropped, so importing over an existing exercise leaves them alone. */
function cleanRow(raw) {
  const row = {};
  for (const [rawKey, value] of Object.entries(raw ?? {})) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
    const key = KEY_ALIASES[asKey(rawKey)] ?? asKey(rawKey);
    if (key && row[key] === undefined) row[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (row.muscle_group !== undefined) row.muscle_group = muscleKey(row.muscle_group);
  if (row.equipment !== undefined) row.equipment = EQUIPMENT_ALIASES[asKey(row.equipment)] ?? asKey(row.equipment);
  if (row.secondary_muscles !== undefined) row.secondary_muscles = [...new Set(asList(row.secondary_muscles).map(muscleKey))];
  if (row.tags !== undefined) row.tags = asList(row.tags).map((t) => t.toLowerCase());
  if (Array.isArray(row.instructions)) row.instructions = row.instructions.join(' ');
  for (const key of ['secondary_muscles', 'tags']) if (row[key]?.length === 0) delete row[key];
  return row;
}

/** CSV or JSON text — or an AI tool's whole reply — → rows with the API's
 * keys. JSON is anything that starts like an array or object; everything else
 * is read as CSV with a header row. Header names are matched loosely
 * ("Muscle Group" = muscle_group) so a sheet from anywhere works. */
export function textToExercises(text) {
  const body = unfence(String(text ?? ''));
  if (!body) return [];
  if (body.startsWith('[') || body.startsWith('{')) {
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : parsed.exercises ?? parsed.items ?? parsed.data ?? [];
    return Array.isArray(list) ? list.map(cleanRow) : [];
  }
  const [header, ...lines] = parseCsv(body);
  if (!header) return [];
  return lines.map((cells) => cleanRow(Object.fromEntries(header.map((key, i) => [key, cells[i]]))));
}

const CSV_TEMPLATE = toCsv(
  [
    { name: 'Landmine Press', muscle_group: 'shoulders', equipment: 'barbell', secondary_muscles: ['chest', 'triceps'], tags: ['unilateral', 'compound'], instructions: 'Hold the end of the bar at shoulder height. Press it up and slightly forward until the arm is straight, then lower under control.' },
    { name: 'Incline Dumbbell Curl', muscle_group: 'biceps', equipment: 'dumbbell', secondary_muscles: ['forearms'], tags: ['isolation'], instructions: 'Sit back on a 45° bench with the arms hanging. Curl both dumbbells up, keeping the elbows back behind the torso.' },
  ],
  COLUMNS,
);

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
    mediaUrl: null,
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

  /* Secondary muscles: chips to click, plus a text box showing the same
     selection as "Glutes, Lower Back, …" so a list copied from a reference
     site can be pasted in one go. Editing either one updates the other. */
  const chips = h('div', { class: 'cat-chips' });
  const secondaryText = h('input', {
    type: 'text',
    placeholder: 'or paste a list: Glutes, Lower Back, Upper Back, Lats',
    autocomplete: 'off',
    style: 'margin-top:8px',
  });
  const syncSecondaryText = () => {
    secondaryText.value = meta.muscle_groups.filter((m) => state.secondary.has(m)).map(capital).join(', ');
  };
  const applySecondaryText = () => {
    const unknown = [];
    const picked = new Set();
    for (const part of secondaryText.value.split(/[,;\n]+/)) {
      if (!part.trim()) continue;
      const found = muscleFromText(part, meta.muscle_groups);
      if (found) {
        if (found !== muscle.value) picked.add(found);
      } else {
        unknown.push(part.trim());
      }
    }
    state.secondary = picked;
    drawChips();
    if (unknown.length) toast(`Not a muscle group: ${unknown.join(', ')}`, 'error');
  };
  secondaryText.addEventListener('change', applySecondaryText);
  // Enter applies the list rather than submitting the whole form.
  secondaryText.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    applySecondaryText();
  });

  const drawChips = () => {
    syncSecondaryText();
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
     (object URL) and a pasted link straight from its source, before anything
     is uploaded; on Save the server downloads the link and keeps its own copy. */
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
    } else if (state.mediaUrl) {
      shown = { media_url: state.mediaUrl, media_type: /\.(?:mp4|webm|m4v|mov)$/i.test(new URL(state.mediaUrl).pathname) ? 'video' : 'image' };
    }
    clear(stage).append(exerciseMedia(shown) ?? h('div', { class: 'cat-preview-empty' }, renderIcon('image', { size: 30 }), h('span', {}, 'No demo yet')));
    mediaNote.textContent = state.file
      ? `${state.file.name} · ${mb(state.file.size)} — saved when you press Save`
      : state.mediaUrl
        ? 'From link — downloaded and saved when you press Save'
        : shown?.media_bytes
          ? `${capital(shown.media_type)} · ${mb(shown.media_bytes)}`
          : `PNG, JPG, WebP, GIF, MP4 or WebM, up to ${mb(meta.media.max_bytes)} — upload a file or paste a link.`;
  };

  const urlInput = h('input', {
    type: 'url',
    placeholder: 'or paste a link: https://…/demo.mp4',
    autocomplete: 'off',
    style: 'font-size:13px',
  });
  const applyUrl = () => {
    const value = urlInput.value.trim();
    if (!value) {
      state.mediaUrl = null;
      return drawStage();
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      return toast('That is not a valid link', 'error');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return toast('Use an http or https link', 'error');
    state.mediaUrl = url.href;
    state.file = null;
    state.removeMedia = false;
    drawStage();
  };
  urlInput.addEventListener('change', applyUrl);
  // Enter previews the link rather than submitting the whole form.
  urlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    applyUrl();
  });

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
      state.mediaUrl = null;
      urlInput.value = '';
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
        state.mediaUrl = null;
        urlInput.value = '';
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
          else if (state.mediaUrl) saved = await api.platformExerciseMediaFromUrl(saved.id, state.mediaUrl);
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
        urlInput,
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
        h('div', { class: 'field' }, h('span', {}, 'Secondary muscles'), chips, secondaryText),
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

/* ── AI prompt ────────────────────────────────────────────────────────── */

export function buildExerciseAiPrompt({ topic, count, format, muscleGroups, equipment, skipNames = [] }) {
  const what = topic.trim() || 'common gym exercises across every muscle group';
  const lines = [
    `You are a careful strength and conditioning coach building the exercise library of a gym app. Create a list of ${count} exercises: ${what}.`,
    '',
    format === 'json'
      ? `Return ONLY a JSON array inside one \`\`\`json code block. Each item is an object with exactly these keys: ${COLUMNS.join(', ')}. secondary_muscles and tags are arrays of strings; use [] when empty.`
      : `Return ONLY a CSV inside one \`\`\`csv code block, with exactly this header row:\n${COLUMNS.join(',')}`,
    '',
    'Rules:',
    '- One entry per exercise, no duplicates. Use the standard name lifters search for, in Title Case, with the equipment first where the same movement is done with different kit, e.g. "Barbell Bench Press", "Dumbbell Bench Press", "Cable Fly", "Pull-Up", "Romanian Deadlift".',
    `- muscle_group is the ONE muscle the exercise mainly works, exactly one of: ${muscleGroups.join(', ')}. (cardio is for conditioning such as running, rowing or cycling; full_body for Olympic lifts and other whole-body moves; other only when nothing else fits.)`,
    `- equipment is exactly one of: ${equipment.join(', ')}. (band is a resistance band; bodyweight needs no equipment beyond a bar or bench; cardio is a treadmill, bike, rower or other cardio machine; EZ-bar and trap-bar moves are barbell.)`,
    '- secondary_muscles lists the other muscles that work hard, from the same muscle_group list, never repeating the primary one. Leave it empty if there are none.',
    '- tags: up to 4 lowercase words, each 24 characters or fewer, e.g. compound, isolation, unilateral, push, pull, hinge, squat, plyometric, mobility.',
    '- instructions: 2–4 short sentences a member can follow mid-workout — the setup, the movement, and one key form cue. Plain text with no numbering or line breaks, under 400 characters.',
    '- Only real, well-established exercises. Leave out anything you are not sure about rather than invent one.',
  ];
  if (format !== 'json') lines.push('- Wrap any value that contains a comma in double quotes. secondary_muscles and tags hold several values separated by commas, e.g. "glutes, hamstrings".');
  if (skipNames.length) {
    lines.push('', `These exercises are already in the library — do not include them or near-duplicates of them:\n${skipNames.join('; ')}`);
  }
  return lines.join('\n');
}

function openAiPromptModal(existingNames, meta, onImport) {
  const topic = h('textarea', {
    rows: 3,
    placeholder: 'e.g. glute-focused exercises · cable machine exercises · calisthenics and bodyweight progressions · mobility and stretching for lifters',
  });
  const count = h('input', { type: 'number', min: 5, max: 200, value: 40 });
  const format = h('select', {}, h('option', { value: 'csv' }, 'CSV (recommended)'), h('option', { value: 'json' }, 'JSON'));
  const skip = h('input', { type: 'checkbox', checked: existingNames.length > 0 && existingNames.length <= 1500 });
  const output = h('textarea', { class: 'fc-prompt', rows: 14, readonly: '' });

  const paint = () => {
    output.value = buildExerciseAiPrompt({
      topic: topic.value,
      count: Math.min(200, Math.max(5, Number(count.value) || 40)),
      format: format.value,
      muscleGroups: meta.muscle_groups,
      equipment: meta.equipment,
      skipNames: skip.checked ? existingNames : [],
    });
  };
  for (const el of [topic, count, format, skip]) {
    el.addEventListener('input', paint);
    el.addEventListener('change', paint);
  }
  paint();

  openModal({
    title: 'Generate exercises with an AI tool',
    subtitle: 'Paste this into ChatGPT, Claude or Gemini, then import what it replies.',
    icon: 'sparkle',
    wide: true,
    body: h(
      'div',
      { class: 'fc-ai' },
      h('label', { class: 'field' }, h('span', {}, 'Which exercises?'), topic),
      h(
        'div',
        { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', {}, 'How many'), count),
        h('label', { class: 'field' }, h('span', {}, 'Reply format'), format),
      ),
      h('label', { class: 'fc-check' }, skip, h('span', {}, `Tell it to skip the ${existingNames.length} exercises already in the library`)),
      h('div', { class: 'fc-ai-label' }, 'Your prompt'),
      output,
      h(
        'ul',
        { class: 'fc-ai-tips' },
        h('li', {}, 'Ask for 30–60 exercises at a time; long replies get cut off.'),
        h('li', {}, 'Members read the instructions and muscle groups, so skim them after importing.'),
        h('li', {}, 'Existing names are updated, not duplicated, so re-importing a corrected sheet is safe.'),
        h('li', {}, 'Demos are not part of the sheet — add them afterwards with "Bulk upload demos", matched by filename.'),
      ),
    ),
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Close'),
      h('button', { class: 'btn', type: 'button', onclick: () => copyText(output.value, output) }, renderIcon('copy', { size: 15 }), 'Copy prompt'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            closeModal();
            onImport();
          },
        },
        renderIcon('upload', { size: 15 }),
        'Import the reply',
      ),
    ],
  });
}

/* ── Bulk import ──────────────────────────────────────────────────────── */

function openImportModal({ meta, onDone, onPrompt }) {
  const paste = h('textarea', {
    class: 'fc-paste',
    rows: 9,
    placeholder: `Paste CSV or JSON — or the AI tool's whole reply.\n\n${COLUMNS.join(',')}\nLandmine Press,shoulders,barbell,"chest, triceps",unilateral,"Press up and forward."`,
  });
  const status = h('div', { class: 'fc-status' });
  const preview = h('div', {});
  const results = h('div', {});
  let rows = [];

  const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Import');
  const plural = (n) => `${n} exercise${n === 1 ? '' : 's'}`;

  const read = () => {
    clear(results);
    try {
      rows = textToExercises(paste.value).filter((row) => Object.keys(row).length);
      status.classList.remove('error');
      status.textContent = rows.length
        ? `${plural(rows.length)} ready to import`
        : paste.value.trim()
          ? 'No rows found — check the header row has a "name" column.'
          : '';
    } catch (err) {
      rows = [];
      status.classList.add('error');
      status.textContent = `That JSON does not parse: ${err.message}`;
    }
    go.disabled = !rows.length;
    go.textContent = rows.length ? `Import ${plural(rows.length)}` : 'Import';

    // A secondary muscle the app has no group for ("hip flexors") would sink
    // the whole row on the server; keep the exercise and drop just that one.
    const dropped = new Set();
    for (const row of rows) {
      if (!row.secondary_muscles) continue;
      for (const m of row.secondary_muscles) if (!meta.muscle_groups.includes(m)) dropped.add(m);
      row.secondary_muscles = row.secondary_muscles.filter((m) => meta.muscle_groups.includes(m));
      if (!row.secondary_muscles.length) delete row.secondary_muscles;
    }

    clear(preview);
    if (!rows.length) return;
    const missing = rows.filter((r) => !r.name).length;
    preview.append(
      h(
        'div',
        { class: 'table-wrap fc-preview' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...['Name', 'Muscle', 'Equipment', 'Also works'].map((t) => h('th', {}, t)))),
          h(
            'tbody',
            {},
            ...rows.slice(0, 6).map((r) =>
              h(
                'tr',
                {},
                h('td', {}, r.name ?? h('em', { class: 'fc-missing' }, 'missing')),
                h('td', {}, r.muscle_group ? capital(r.muscle_group) : ''),
                h('td', {}, capital(r.equipment ?? 'barbell')),
                h('td', {}, (r.secondary_muscles ?? []).map(capital).join(', ')),
              ),
            ),
          ),
        ),
      ),
      ...[
        rows.length > 6 ? h('div', { class: 'fc-status' }, `…and ${rows.length - 6} more`) : null,
        missing ? h('div', { class: 'fc-status error' }, `${missing} row${missing === 1 ? ' is' : 's are'} missing a name and will be skipped.`) : null,
        dropped.size ? h('div', { class: 'fc-status' }, `Not muscle groups in the app, so left out of secondary muscles: ${[...dropped].map(label).join(', ')}.`) : null,
      ].filter(Boolean),
    );
  };
  paste.addEventListener('input', read);

  const picker = h('input', {
    type: 'file',
    accept: '.csv,.json,.txt,text/csv,application/json,text/plain',
    style: 'display:none',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      paste.value = await file.text();
      read();
    },
  });

  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const res = await api.platformImportExercises(rows);
      clear(results).append(
        ...[
          h('div', { class: 'fc-done' }, renderIcon('checkCircle', { size: 18 }), `${res.created} added · ${res.updated} updated`),
          res.errors.length
            ? h(
                'details',
                { class: 'fc-report error', open: res.errors.length <= 8 ? '' : null },
                h('summary', {}, `${res.errors.length} row${res.errors.length === 1 ? '' : 's'} skipped`),
                h('ul', {}, ...res.errors.map((e) => h('li', {}, `Row ${e.line}${e.name ? ` · ${e.name}` : ''}: ${e.error}`))),
              )
            : null,
        ].filter(Boolean),
      );
      await onDone();
    } catch (err) {
      toast(err.message || 'Import failed', 'error');
      go.disabled = false;
    }
  });

  openModal({
    title: 'Import exercises',
    subtitle: 'CSV or JSON. Exercises are matched by name: new ones are added, existing ones updated with the columns you give.',
    icon: 'upload',
    wide: true,
    body: h(
      'div',
      { class: 'fc-import' },
      h(
        'div',
        { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => picker.click() }, renderIcon('upload', { size: 15 }), 'Choose file'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => download('exercise-catalog-template.csv', CSV_TEMPLATE) }, renderIcon('download', { size: 15 }), 'CSV template'),
        h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              closeModal();
              onPrompt();
            },
          },
          renderIcon('sparkle', { size: 15 }),
          'Get an AI prompt',
        ),
        picker,
      ),
      paste,
      status,
      preview,
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
    if (!items.length) grid.append(h('div', { class: 'empty', style: 'grid-column:1/-1' }, state.q || state.muscle_group || state.equipment || state.media ? 'No exercise matches that' : 'The library is empty — add an exercise, import a sheet or generate one with AI'));
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

  const openImport = () => openImportModal({ meta, onDone: refresh, onPrompt: openPrompt });
  const openPrompt = async () => {
    // The whole library's names, not just what the filters show, so the AI
    // is told about everything that already exists.
    let names = items.map((i) => i.name);
    if (state.q || state.muscle_group || state.equipment || state.media) {
      try {
        names = (await api.platformCatalog({})).items.map((i) => i.name);
      } catch {
        // Fall back to what is on screen.
      }
    }
    openAiPromptModal(names, meta, openImport);
  };

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
    h('button', { class: 'btn sm', type: 'button', onclick: openPrompt }, renderIcon('sparkle', { size: 15 }), 'AI prompt'),
    h('button', { class: 'btn sm', type: 'button', onclick: openImport }, renderIcon('upload', { size: 15 }), 'Import'),
    h(
      'button',
      {
        class: 'btn sm ghost',
        type: 'button',
        title: 'Download what is shown as CSV',
        onclick: () => download('exercise-catalog.csv', toCsv(items, COLUMNS)),
      },
      renderIcon('download', { size: 15 }),
      'Export',
    ),
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
