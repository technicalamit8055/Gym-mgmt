import { get, run } from './db.js';
import { badRequest } from './errors.js';

/**
 * The owner's print templates: how receipts, member/student ID cards and
 * CoachBook OMR answer sheets look. One JSON row per kind in print_templates,
 * always read through templateFor(), which lays the saved values over the
 * defaults — so a gym that never opened the editor, or a setting added after
 * it saved, still gets a complete, valid template.
 *
 * Every field is validated on save (cleanTemplate) rather than trusted on
 * read, so the renderers can use the values as they are.
 */

const HEX = /^#[0-9a-f]{6}$/i;

/** Field rules per kind: { type, default, ... }. */
const SCHEMAS = {
  receipt: {
    style: { type: 'enum', values: ['modern', 'classic', 'minimal'], default: 'modern' },
    accent: { type: 'color', default: '#4f46e5' },
    show_logo: { type: 'bool', default: true },
    address: { type: 'text', max: 160, default: '' },
    contact: { type: 'text', max: 100, default: '' },
    footer_note: { type: 'text', max: 120, default: 'Thank you for your payment!' },
    terms: { type: 'text', max: 300, default: '' },
    show_signature: { type: 'bool', default: false },
    signature_label: { type: 'text', max: 40, default: 'Authorised signatory' },
  },
  id_card: {
    style: { type: 'enum', values: ['classic', 'band', 'vertical'], default: 'classic' },
    accent: { type: 'color', default: '#111827' },
    show_photo: { type: 'bool', default: true },
    show_validity: { type: 'bool', default: true },
    show_phone: { type: 'bool', default: false },
    title: { type: 'text', max: 40, default: '' },
    qr_hint: { type: 'text', max: 40, default: 'Scan at reception' },
    footer_note: { type: 'text', max: 90, default: '' },
  },
  omr: {
    default_style: { type: 'enum', values: ['coachbook', 'board', 'competitive'], default: 'coachbook' },
    heading: { type: 'text', max: 60, default: '' },
    subheading: { type: 'text', max: 80, default: '' },
    hindi: { type: 'bool', default: true },
    instructions: { type: 'text', max: 600, default: '' },
    extra_fields: { type: 'list', max: 4, itemMax: 30, default: [] },
  },
};

export const TEMPLATE_KINDS = Object.keys(SCHEMAS);

/** The choices each enum offers, for the editor's dropdowns. */
export const TEMPLATE_CHOICES = Object.fromEntries(
  Object.entries(SCHEMAS).map(([kind, schema]) => [
    kind,
    Object.fromEntries(Object.entries(schema).filter(([, rule]) => rule.type === 'enum').map(([key, rule]) => [key, rule.values])),
  ]),
);

export function defaultTemplate(kind) {
  const schema = SCHEMAS[kind];
  if (!schema) throw badRequest(`Unknown template "${kind}"`);
  return Object.fromEntries(Object.entries(schema).map(([key, rule]) => [key, Array.isArray(rule.default) ? [...rule.default] : rule.default]));
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const multiLine = (value) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Validates a (partial) template against its kind. Unknown keys are dropped;
 * a bad value is a 400 naming the field, so the editor can point at it.
 */
export function cleanTemplate(kind, input) {
  const schema = SCHEMAS[kind];
  if (!schema) throw badRequest(`Unknown template "${kind}"`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Send the template as an object');
  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (!(key in input)) continue;
    const raw = input[key];
    switch (rule.type) {
      case 'enum':
        if (!rule.values.includes(raw)) throw badRequest(`${key} must be one of ${rule.values.join(', ')}`, { [key]: 'invalid' });
        out[key] = raw;
        break;
      case 'color': {
        const value = String(raw ?? '').trim();
        if (!HEX.test(value)) throw badRequest(`${key} must be a colour like #4f46e5`, { [key]: 'invalid' });
        out[key] = value.toLowerCase();
        break;
      }
      case 'bool':
        out[key] = raw === true || raw === 1 || raw === '1' || raw === 'true';
        break;
      case 'text': {
        const value = key === 'instructions' || key === 'terms' || key === 'address' ? multiLine(raw) : oneLine(raw);
        if (value.length > rule.max) throw badRequest(`${key} can be at most ${rule.max} characters`, { [key]: 'too long' });
        out[key] = value;
        break;
      }
      case 'list': {
        const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/)).map(oneLine).filter(Boolean);
        if (items.length > rule.max) throw badRequest(`${key} can have at most ${rule.max} entries`, { [key]: 'too many' });
        if (items.some((item) => item.length > rule.itemMax)) throw badRequest(`Each of ${key} can be at most ${rule.itemMax} characters`, { [key]: 'too long' });
        out[key] = items;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The saved template laid over the defaults. Never throws: a missing table or bad row means defaults. */
export function templateFor(kind) {
  const base = defaultTemplate(kind);
  try {
    const row = get('SELECT data FROM print_templates WHERE kind = ?', [kind]);
    if (!row) return base;
    const saved = JSON.parse(row.data);
    // Re-validate what was stored: a value a newer version no longer accepts falls back to its default.
    for (const key of Object.keys(base)) {
      if (!(key in saved)) continue;
      try {
        Object.assign(base, cleanTemplate(kind, { [key]: saved[key] }));
      } catch {
        /* keep the default for that one field */
      }
    }
  } catch {
    /* defaults */
  }
  return base;
}

/** Merges `input` into the saved template and stores it. Returns the full template. */
export function saveTemplate(kind, input) {
  const next = { ...templateFor(kind), ...cleanTemplate(kind, input) };
  run(
    `INSERT INTO print_templates (kind, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [kind, JSON.stringify(next)],
  );
  return next;
}

/** Back to the defaults. */
export function resetTemplate(kind) {
  defaultTemplate(kind);
  run('DELETE FROM print_templates WHERE kind = ?', [kind]);
  return templateFor(kind);
}
