import { api } from '../api.js';
import { buildForm, clear, closeModal, confirmDialog, h, openModal, renderIcon, toast, verifiedTick } from '../ui.js';
import { parseCsv } from './exerciseCatalog.js';

/**
 * The operator's food database: one catalogue every gym's food library is
 * synced from (src/foodCatalog.js), with the Lifesum-style blue tick for
 * foods whose numbers someone has checked.
 *
 * New foods come in one at a time, or in bulk from a CSV or JSON sheet — and
 * the AI prompt builder writes the instructions that get an AI tool to
 * produce exactly that sheet, columns and all.
 */

const CATEGORY_LABELS = {
  protein: 'Protein',
  carbs: 'Carbs',
  fats: 'Fats',
  fruits: 'Fruit & veg',
  dairy: 'Dairy',
  supplements: 'Supplements',
  meal: 'Full meal',
  general: 'Other',
};
const categoryLabel = (key) => CATEGORY_LABELS[key] ?? key;

/** The columns, in the order the template, the export and the AI prompt use. */
const COLUMNS = [
  'name', 'category', 'serving_unit', 'calories', 'protein_g', 'carbs_g', 'fats_g',
  'fiber_g', 'sugar_g', 'serving_size_g', 'serving_label', 'brand',
];

/** What other sheets and AI tools call the columns. */
const KEY_ALIASES = {
  food: 'name', food_name: 'name', item: 'name', title: 'name',
  type: 'category', group: 'category', food_group: 'category',
  unit: 'serving_unit', serving: 'serving_unit', per: 'serving_unit', basis: 'serving_unit', values_per: 'serving_unit',
  kcal: 'calories', energy: 'calories', energy_kcal: 'calories', calories_kcal: 'calories', cal: 'calories',
  protein: 'protein_g', proteins: 'protein_g',
  carbs: 'carbs_g', carb: 'carbs_g', carbohydrate: 'carbs_g', carbohydrates: 'carbs_g', carbohydrate_g: 'carbs_g', carbohydrates_g: 'carbs_g',
  fat: 'fats_g', fats: 'fats_g', fat_g: 'fats_g', total_fat: 'fats_g', total_fat_g: 'fats_g',
  fiber: 'fiber_g', fibre: 'fiber_g', fibre_g: 'fiber_g', dietary_fiber: 'fiber_g', dietary_fibre: 'fiber_g',
  sugar: 'sugar_g', sugars: 'sugar_g', sugars_g: 'sugar_g',
  serving_size: 'serving_size_g', portion_g: 'serving_size_g', portion_size_g: 'serving_size_g', serving_g: 'serving_size_g', serving_size_ml: 'serving_size_g',
  portion: 'serving_label', portion_label: 'serving_label', serving_description: 'serving_label',
  manufacturer: 'brand',
  is_verified: 'verified', tick: 'verified',
};
const normaliseKey = (key) => {
  const clean = String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return KEY_ALIASES[clean] ?? clean;
};

/** The sheet inside a ```csv / ```json fence, as AI tools like to reply. */
const unfence = (text) => {
  const fenced = /```[a-z]*\s*\n([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
};

/** CSV or JSON text → rows with the API's keys. JSON is anything that starts
 * like an array or object; everything else is read as CSV with a header row. */
export function textToFoods(text) {
  const body = unfence(String(text ?? ''));
  if (!body) return [];
  if (body.startsWith('[') || body.startsWith('{')) {
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : parsed.foods ?? parsed.items ?? parsed.data ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((item) => {
      const row = {};
      for (const [key, value] of Object.entries(item ?? {})) {
        if (value !== null && value !== undefined) row[normaliseKey(key)] = typeof value === 'string' ? value.trim() : value;
      }
      return row;
    });
  }
  const [header, ...lines] = parseCsv(body);
  if (!header) return [];
  const keys = header.map(normaliseKey);
  return lines.map((cells) => {
    const row = {};
    keys.forEach((key, i) => {
      if (key && cells[i] !== undefined && cells[i].trim() !== '') row[key] = cells[i].trim();
    });
    return row;
  });
}

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const toCsv = (rows, columns) => [columns.join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\n');

const CSV_TEMPLATE = toCsv(
  [
    { name: 'Idli', category: 'carbs', serving_unit: '100g', calories: 97, protein_g: 3.3, carbs_g: 20, fats_g: 0.7, fiber_g: 1.5, sugar_g: 0.5, serving_size_g: 60, serving_label: '1 idli (60g)' },
    { name: 'Masala Chai (with milk & sugar)', category: 'general', serving_unit: '100ml', calories: 60, protein_g: 1.7, carbs_g: 9, fats_g: 1.9, fiber_g: 0, sugar_g: 8.5, serving_size_g: 150, serving_label: '1 cup (150ml)' },
  ],
  COLUMNS,
);

function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, fallbackInput) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to the clipboard');
  } catch {
    fallbackInput?.select();
    toast('Select all and copy it from the box', 'error');
  }
}

/* ── Add / edit ───────────────────────────────────────────────────────── */

function openFoodModal(food, categories, onSaved) {
  const isNew = !food;
  const form = buildForm(
    [
      { name: 'name', label: 'Food name', required: true, full: true, value: food?.name ?? '', placeholder: 'e.g. Masala Dosa' },
      { name: 'brand', label: 'Brand', value: food?.brand ?? '', hint: 'Only for packaged products' },
      { name: 'category', label: 'Category', type: 'select', value: food?.category ?? 'general', options: categories.map((c) => ({ value: c, label: categoryLabel(c) })) },
      {
        name: 'serving_unit',
        label: 'Numbers are per',
        value: food?.serving_unit ?? '100g',
        hint: '100g or 100ml lets members log by weight. Or a portion, e.g. "1 egg (50g)"',
      },
      { name: 'calories', label: 'Calories (kcal)', type: 'number', required: true, min: 0, value: food?.calories ?? '' },
      { name: 'protein_g', label: 'Protein (g)', type: 'number', min: 0, step: '0.1', value: food?.protein_g ?? '' },
      { name: 'carbs_g', label: 'Carbs (g)', type: 'number', min: 0, step: '0.1', value: food?.carbs_g ?? '' },
      { name: 'fats_g', label: 'Fat (g)', type: 'number', min: 0, step: '0.1', value: food?.fats_g ?? '' },
      { name: 'fiber_g', label: 'Fibre (g)', type: 'number', min: 0, step: '0.1', value: food?.fiber_g ?? '' },
      { name: 'sugar_g', label: 'Sugar (g)', type: 'number', min: 0, step: '0.1', value: food?.sugar_g ?? '' },
      { name: 'serving_size_g', label: 'Typical portion (g or ml)', type: 'number', min: 0, value: food?.serving_size_g ?? '', hint: 'For 100g / 100ml foods: offered as "1 serving"' },
      { name: 'serving_label', label: 'Portion name', value: food?.serving_label ?? '', placeholder: 'e.g. 1 dosa (120g)' },
      {
        name: 'verified',
        label: 'Blue tick',
        type: 'select',
        value: food?.verified ? 'yes' : 'no',
        options: [
          { value: 'no', label: 'Not verified' },
          { value: 'yes', label: 'Verified — numbers checked' },
        ],
      },
    ],
    {
      submitLabel: isNew ? 'Add food' : 'Save changes',
      onSubmit: async (values) => {
        const payload = { ...values, verified: values.verified === 'yes' };
        // Blank optional numbers are "none", not zero.
        for (const key of ['serving_size_g']) if (payload[key] === '') payload[key] = null;
        const saved = isNew ? await api.platformCreateFood(payload) : await api.platformUpdateFood(food.id, payload);
        closeModal();
        toast(isNew ? `${saved.name} added` : `${saved.name} saved`);
        await onSaved();
      },
    },
  );

  // A live check that the macros can make the calories — the slip worth
  // catching before members log it.
  const check = h('div', { class: 'fc-energy' });
  const field = (name) => form.querySelector(`[name="${name}"]`);
  const paintCheck = () => {
    const n = (name) => Number(field(name)?.value || 0);
    const kcal = n('calories');
    const fromMacros = Math.round(n('protein_g') * 4 + n('carbs_g') * 4 + n('fats_g') * 9);
    const off = kcal && Math.abs(fromMacros - kcal) > Math.max(30, kcal * 0.25);
    check.classList.toggle('off', Boolean(off));
    check.textContent = kcal || fromMacros
      ? `Protein × 4 + carbs × 4 + fat × 9 = ${fromMacros} kcal${off ? ` — far from the ${kcal} kcal entered` : ' ✓'}`
      : '';
  };
  form.addEventListener('input', paintCheck);
  paintCheck();
  form.querySelector('.form-grid')?.after(check);

  const deleteBtn = isNew
    ? null
    : h(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: () =>
            confirmDialog({
              title: `Delete ${food.name}?`,
              message: "It leaves every gym's food library. Meals members already logged keep their numbers; favourites of it are removed.",
              confirmLabel: 'Delete food',
              danger: true,
              onConfirm: async () => {
                await api.platformDeleteFood(food.id);
                closeModal();
                toast(`${food.name} deleted`);
                await onSaved();
              },
            }),
        },
        'Delete',
      );
  if (deleteBtn) {
    form.querySelector('.modal-foot')?.prepend(deleteBtn);
    deleteBtn.style.marginRight = 'auto';
  }

  openModal({ title: isNew ? 'Add food' : food.name, wide: true, body: form });
}

/* ── AI prompt ────────────────────────────────────────────────────────── */

export function buildAiPrompt({ topic, count, format, skipNames = [] }) {
  const what = topic.trim() || 'commonly eaten foods';
  const fence = format === 'json' ? 'json' : 'csv';
  const lines = [
    `You are a careful nutrition data assistant. Create a list of ${count} foods: ${what}.`,
    '',
    format === 'json'
      ? `Return ONLY a JSON array inside one \`\`\`json code block. Each item is an object with exactly these keys: ${COLUMNS.join(', ')}. Use null for anything empty.`
      : `Return ONLY a CSV inside one \`\`\`csv code block, with exactly this header row:\n${COLUMNS.join(',')}`,
    '',
    'Rules:',
    '- One entry per food, no duplicates. Use the specific name people would search for, with the preparation in brackets where it changes the numbers, e.g. "Chicken Breast (grilled)", "Rice (cooked)", "Paneer Butter Masala".',
    '- category must be exactly one of: protein, carbs, fats, fruits, dairy, supplements, meal, general. (fruits covers fruit and vegetables; meal is a complete dish or plate; general is drinks, sweets and anything else.)',
    '- Give nutrition per 100 g of the food as eaten, with serving_unit = 100g. For drinks and other liquids give it per 100 ml, with serving_unit = 100ml.',
    '- serving_size_g is one typical portion in grams (ml for liquids), e.g. 60 for one idli, 250 for a glass of milk. serving_label names that portion, e.g. "1 idli (60g)", "1 glass (250ml)", "1 bowl (150g)".',
    '- calories is a whole number of kcal. protein_g, carbs_g, fats_g, fiber_g and sugar_g are grams with at most one decimal. Numbers only: no units, no ranges, no "~".',
    '- The numbers must agree: protein_g × 4 + carbs_g × 4 + fats_g × 9 should be within about 10% of calories.',
    '- Use standard reference values: USDA FoodData Central, IFCT 2017 for Indian foods, or the manufacturer\'s label for branded products. Leave out any food you are not confident about rather than guess.',
    '- brand is only for branded or packaged products; leave it empty otherwise.',
  ];
  if (fence === 'csv') lines.push('- Wrap any value that contains a comma in double quotes.');
  if (skipNames.length) {
    lines.push('', `These foods are already in the database — do not include them or near-duplicates of them:\n${skipNames.join('; ')}`);
  }
  return lines.join('\n');
}

function openAiPromptModal(existingNames, onImport) {
  const topic = h('textarea', {
    rows: 3,
    placeholder: 'e.g. popular South Indian breakfast dishes · Indian street food · high-protein snacks sold in Indian supermarkets · common gym supplements',
  });
  const count = h('input', { type: 'number', min: 5, max: 200, value: 50 });
  const format = h('select', {}, h('option', { value: 'csv' }, 'CSV (recommended)'), h('option', { value: 'json' }, 'JSON'));
  const skip = h('input', { type: 'checkbox', checked: existingNames.length > 0 && existingNames.length <= 1500 });
  const output = h('textarea', { class: 'fc-prompt', rows: 14, readonly: '' });

  const paint = () => {
    output.value = buildAiPrompt({
      topic: topic.value,
      count: Math.min(200, Math.max(5, Number(count.value) || 50)),
      format: format.value,
      skipNames: skip.checked ? existingNames : [],
    });
  };
  for (const el of [topic, count, format, skip]) {
    el.addEventListener('input', paint);
    el.addEventListener('change', paint);
  }
  paint();

  openModal({
    title: 'Generate foods with an AI tool',
    subtitle: 'Paste this into ChatGPT, Claude or Gemini, then import what it replies.',
    icon: 'sparkle',
    wide: true,
    body: h(
      'div',
      { class: 'fc-ai' },
      h('label', { class: 'field' }, h('span', {}, 'Which foods?'), topic),
      h(
        'div',
        { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', {}, 'How many'), count),
        h('label', { class: 'field' }, h('span', {}, 'Reply format'), format),
      ),
      h(
        'label',
        { class: 'fc-check' },
        skip,
        h('span', {}, `Tell it to skip the ${existingNames.length} foods already in the library`),
      ),
      h('div', { class: 'fc-ai-label' }, 'Your prompt'),
      output,
      h(
        'ul',
        { class: 'fc-ai-tips' },
        h('li', {}, 'Ask for 50–100 foods at a time; long replies get cut off.'),
        h('li', {}, 'AI numbers can be wrong. Import them without the tick, spot-check, then tick the ones you trust.'),
        h('li', {}, 'Existing names are updated, not duplicated, so re-importing a corrected sheet is safe.'),
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

function openImportModal({ onDone, onPrompt }) {
  const paste = h('textarea', {
    class: 'fc-paste',
    rows: 9,
    placeholder: `Paste CSV or JSON — or the AI tool's whole reply.\n\n${COLUMNS.join(',')}\nIdli,carbs,100g,97,3.3,20,0.7,1.5,0.5,60,"1 idli (60g)",`,
  });
  const status = h('div', { class: 'fc-status' });
  const preview = h('div', {});
  const results = h('div', {});
  const verify = h('input', { type: 'checkbox' });
  let rows = [];

  const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Import');

  const read = () => {
    clear(results);
    try {
      rows = textToFoods(paste.value).filter((row) => Object.keys(row).length);
      status.classList.remove('error');
      status.textContent = rows.length
        ? `${rows.length} food${rows.length === 1 ? '' : 's'} ready to import`
        : paste.value.trim()
          ? 'No rows found — check the header row has a "name" column.'
          : '';
    } catch (err) {
      rows = [];
      status.classList.add('error');
      status.textContent = `That JSON does not parse: ${err.message}`;
    }
    go.disabled = !rows.length;
    go.textContent = rows.length ? `Import ${rows.length} food${rows.length === 1 ? '' : 's'}` : 'Import';

    clear(preview);
    if (!rows.length) return;
    const missing = rows.filter((r) => !r.name || r.calories === undefined || r.calories === '').length;
    preview.append(
      h(
        'div',
        { class: 'table-wrap fc-preview' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...['Name', 'Category', 'Per', 'Kcal', 'P', 'C', 'F'].map((t) => h('th', {}, t)))),
          h(
            'tbody',
            {},
            ...rows.slice(0, 6).map((r) =>
              h(
                'tr',
                {},
                h('td', {}, r.name ?? h('em', { class: 'fc-missing' }, 'missing')),
                h('td', {}, r.category ?? ''),
                h('td', {}, r.serving_unit ?? '100g'),
                h('td', { class: 'num' }, r.calories ?? h('em', { class: 'fc-missing' }, '—')),
                h('td', { class: 'num' }, r.protein_g ?? ''),
                h('td', { class: 'num' }, r.carbs_g ?? ''),
                h('td', { class: 'num' }, r.fats_g ?? ''),
              ),
            ),
          ),
        ),
      ),
      ...[
        rows.length > 6 ? h('div', { class: 'fc-status' }, `…and ${rows.length - 6} more`) : null,
        missing ? h('div', { class: 'fc-status error' }, `${missing} row${missing === 1 ? ' is' : 's are'} missing a name or calories and will be skipped.`) : null,
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
      const res = await api.platformImportFoods(rows, { verified: verify.checked });
      const list = (title, items, tone) =>
        items.length
          ? h(
              'details',
              { class: `fc-report ${tone}`, open: items.length <= 8 ? '' : null },
              h('summary', {}, title),
              h('ul', {}, ...items.map((e) => h('li', {}, `Row ${e.line}${e.name ? ` · ${e.name}` : ''}: ${e.error ?? e.warning}`))),
            )
          : null;
      clear(results).append(
        ...[
          h('div', { class: 'fc-done' }, renderIcon('checkCircle', { size: 18 }), `${res.created} added · ${res.updated} updated`),
          list(`${res.errors.length} row${res.errors.length === 1 ? '' : 's'} skipped`, res.errors, 'error'),
          list(`${res.warnings.length} to double-check — the macros don't add up to the calories`, res.warnings, 'warn'),
        ].filter(Boolean),
      );
      await onDone();
    } catch (err) {
      toast(err.message || 'Import failed', 'error');
      go.disabled = false;
    }
  });

  openModal({
    title: 'Import foods',
    subtitle: 'CSV or JSON. Foods are matched by name: new ones are added, existing ones updated with the columns you give.',
    icon: 'upload',
    wide: true,
    body: h(
      'div',
      { class: 'fc-import' },
      h(
        'div',
        { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => picker.click() }, renderIcon('upload', { size: 15 }), 'Choose file'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => download('food-catalogue-template.csv', CSV_TEMPLATE) }, renderIcon('download', { size: 15 }), 'CSV template'),
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
      h(
        'label',
        { class: 'fc-check' },
        verify,
        h('span', {}, 'Give these foods the blue tick', h('small', {}, "Leave off for AI-generated numbers you haven't checked yet. A \"verified\" column in the sheet overrides this per row.")),
      ),
      results,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Close'), go],
  });
}

/* ── The section ──────────────────────────────────────────────────────── */

export function renderFoodCatalogSection({ onExpired } = {}) {
  const state = { q: '', category: '', verified: '' };
  let items = [];
  let totals = { total: 0, verified_total: 0 };
  let categories = Object.keys(CATEGORY_LABELS);
  const selected = new Set();

  const root = h('div', {}, h('div', { class: 'empty' }, 'Loading the food library…'));
  const summary = h('div', { class: 'fc-summary' });
  const bar = h('div', { class: 'fc-bulk hidden' });
  const tbody = h('tbody', {});
  const selectAll = h('input', { type: 'checkbox', 'aria-label': 'Select all shown' });

  const load = async () => {
    try {
      const res = await api.platformFoods({ q: state.q, category: state.category, verified: state.verified });
      items = res.items;
      totals = { total: res.total, verified_total: res.verified_total };
      categories = res.categories;
      for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);
      return res;
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && onExpired) {
        await onExpired();
        return null;
      }
      toast(err.message || 'Could not load the food library', 'error');
      return null;
    }
  };

  const refresh = async () => {
    if (await load()) draw();
  };

  async function bulk(action, ids = [...selected]) {
    try {
      const res = await api.platformBulkFoods(ids, action);
      const n = res.changed;
      toast(
        action === 'delete'
          ? `${n} food${n === 1 ? '' : 's'} deleted`
          : action === 'verify'
            ? `${n} food${n === 1 ? '' : 's'} verified`
            : `Tick removed from ${n} food${n === 1 ? '' : 's'}`,
      );
      if (action === 'delete') selected.clear();
      await refresh();
    } catch (err) {
      toast(err.message || 'Could not update those foods', 'error');
    }
  }

  function paintBar() {
    bar.classList.toggle('hidden', !selected.size);
    selectAll.checked = items.length > 0 && items.every((i) => selected.has(i.id));
    selectAll.indeterminate = selected.size > 0 && !selectAll.checked;
    clear(bar).append(
      h('strong', {}, `${selected.size} selected`),
      h('button', { class: 'btn sm fc-verify-btn', type: 'button', onclick: () => bulk('verify') }, verifiedTick({ size: 15 }), 'Verify'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => bulk('unverify') }, 'Remove tick'),
      h(
        'button',
        {
          class: 'btn sm danger',
          type: 'button',
          onclick: () =>
            confirmDialog({
              title: `Delete ${selected.size} food${selected.size === 1 ? '' : 's'}?`,
              message: "They leave every gym's food library. Meals already logged keep their numbers.",
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: () => bulk('delete'),
            }),
        },
        'Delete',
      ),
      h('div', { class: 'spacer', style: 'flex:1' }),
      h(
        'button',
        {
          class: 'btn sm ghost',
          type: 'button',
          onclick: () => {
            selected.clear();
            draw();
          },
        },
        'Clear selection',
      ),
    );
  }

  function row(food) {
    const check = h('input', {
      type: 'checkbox',
      checked: selected.has(food.id),
      'aria-label': `Select ${food.name}`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        if (e.target.checked) selected.add(food.id);
        else selected.delete(food.id);
        paintBar();
      },
    });
    const tickToggle = h(
      'button',
      {
        class: `fc-tick${food.verified ? ' on' : ''}`,
        type: 'button',
        title: food.verified ? 'Verified — click to remove the tick' : 'Click to verify',
        'aria-pressed': String(food.verified),
        'aria-label': food.verified ? `Remove the tick from ${food.name}` : `Verify ${food.name}`,
        onclick: (e) => {
          e.stopPropagation();
          bulk(food.verified ? 'unverify' : 'verify', [food.id]);
        },
      },
      renderIcon('verified', { size: 20, stroke: 2 }),
    );
    const portion = food.serving_label ? ` · ${food.serving_label}` : '';
    return h(
      'tr',
      { class: 'clickable', onclick: () => openFoodModal(food, categories, refresh) },
      h('td', { class: 'fc-col-check' }, check),
      h(
        'td',
        {},
        h('div', { class: 'fc-name' }, h('strong', {}, food.name), food.verified ? verifiedTick() : null),
        h('div', { class: 'fc-sub' }, `${food.brand ? `${food.brand} · ` : ''}per ${food.serving_unit}${portion}`),
      ),
      h('td', {}, h('span', { class: 'badge grey' }, categoryLabel(food.category))),
      h('td', { class: 'num' }, h('strong', {}, String(food.calories))),
      h('td', { class: 'num' }, `${food.protein_g}`),
      h('td', { class: 'num' }, `${food.carbs_g}`),
      h('td', { class: 'num' }, `${food.fats_g}`),
      h('td', { class: 'num fc-col-extra' }, `${food.fiber_g}`),
      h('td', { class: 'num fc-col-extra' }, `${food.sugar_g}`),
      h('td', { class: 'fc-col-tick' }, tickToggle),
    );
  }

  function draw() {
    const filtered = state.q || state.category || state.verified;
    clear(summary).append(
      h('span', {}, `${totals.total} food${totals.total === 1 ? '' : 's'}`),
      h('span', { class: 'fc-summary-verified' }, verifiedTick({ size: 14 }), `${totals.verified_total} verified`),
      ...(filtered ? [h('span', {}, `· ${items.length} shown`)] : []),
    );
    clear(tbody).append(...items.map(row));
    if (!items.length) {
      tbody.append(
        h(
          'tr',
          {},
          h('td', { colspan: 10, class: 'fc-empty' }, filtered ? 'No food matches that.' : 'The library is empty — add a food, import a sheet or generate one with AI.'),
        ),
      );
    }
    paintBar();
  }

  selectAll.addEventListener('change', () => {
    for (const item of items) {
      if (selectAll.checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    draw();
  });

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search foods or brands…' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = search.value.trim();
      refresh();
    }, 200);
  });
  const categorySelect = h('select', { onchange: (e) => { state.category = e.target.value; refresh(); } }, h('option', { value: '' }, 'All categories'));
  const verifiedSelect = h(
    'select',
    { onchange: (e) => { state.verified = e.target.value; refresh(); } },
    h('option', { value: '' }, 'Verified or not'),
    h('option', { value: 'yes' }, 'Verified only'),
    h('option', { value: 'no' }, 'Not verified yet'),
  );

  const openImport = () => openImportModal({ onDone: refresh, onPrompt: openPrompt });
  const openPrompt = async () => {
    // The whole catalogue's names, not just what the filters show, so the AI
    // is told about everything that already exists.
    let names = items.map((i) => i.name);
    if (state.q || state.category || state.verified) {
      try {
        names = (await api.platformFoods({})).items.map((i) => i.name);
      } catch {
        // Fall back to what is on screen.
      }
    }
    openAiPromptModal(names, openImport);
  };

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    search,
    categorySelect,
    verifiedSelect,
    h('div', { class: 'spacer', style: 'flex:1' }),
    h('button', { class: 'btn sm', type: 'button', onclick: openPrompt }, renderIcon('sparkle', { size: 15 }), 'AI prompt'),
    h('button', { class: 'btn sm', type: 'button', onclick: openImport }, renderIcon('upload', { size: 15 }), 'Import'),
    h(
      'button',
      {
        class: 'btn sm ghost',
        type: 'button',
        title: 'Download what is shown as CSV',
        onclick: () =>
          download(
            'food-catalogue.csv',
            toCsv(items.map((i) => ({ ...i, verified: i.verified ? 'yes' : 'no' })), [...COLUMNS, 'verified']),
          ),
      },
      renderIcon('download', { size: 15 }),
      'Export',
    ),
    h('button', { class: 'btn primary sm', type: 'button', onclick: () => openFoodModal(null, categories, refresh) }, renderIcon('plus', { size: 15 }), 'Add food'),
  );

  const table = h(
    'div',
    { class: 'table-wrap fc-table' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { class: 'fc-col-check' }, selectAll),
          h('th', {}, 'Food'),
          h('th', {}, 'Category'),
          h('th', { class: 'num' }, 'Kcal'),
          h('th', { class: 'num' }, 'Protein'),
          h('th', { class: 'num' }, 'Carbs'),
          h('th', { class: 'num' }, 'Fat'),
          h('th', { class: 'num fc-col-extra' }, 'Fibre'),
          h('th', { class: 'num fc-col-extra' }, 'Sugar'),
          h('th', { class: 'fc-col-tick' }, 'Tick'),
        ),
      ),
      tbody,
    ),
  );

  (async () => {
    const res = await load();
    if (!res) {
      clear(root).append(h('div', { class: 'empty' }, 'Could not load the food library'));
      return;
    }
    for (const c of categories) categorySelect.append(h('option', { value: c }, categoryLabel(c)));
    clear(root).append(
      h(
        'p',
        { class: 'fc-intro' },
        "Every gym's food library is synced from this list, and members see the ",
        verifiedTick({ size: 14 }),
        ' on foods you verify. Gyms keep their own additions and scanned packs alongside.',
      ),
      toolbar,
      summary,
      bar,
      table,
    );
    draw();
  })();

  return root;
}
