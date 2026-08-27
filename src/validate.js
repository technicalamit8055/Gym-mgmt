import { badRequest } from './errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tiny schema checker. Each field maps to a spec:
 *   { type, required, min, max, values, default }
 * Unknown keys in the payload are ignored so the API stays forgiving.
 */
export function parse(payload, schema) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  const errors = {};

  for (const [field, spec] of Object.entries(schema)) {
    let value = body[field];

    if (value === undefined || value === null || value === '') {
      if (spec.required) {
        errors[field] = 'is required';
      } else if (spec.default !== undefined) {
        out[field] = spec.default;
      } else if (value === '' && spec.type === 'string') {
        out[field] = '';
      } else if (field in body) {
        out[field] = null;
      }
      continue;
    }

    switch (spec.type) {
      case 'string': {
        value = String(value).trim();
        if (spec.min && value.length < spec.min) errors[field] = `must be at least ${spec.min} characters`;
        if (spec.max && value.length > spec.max) errors[field] = `must be at most ${spec.max} characters`;
        break;
      }
      case 'email': {
        value = String(value).trim().toLowerCase();
        if (!EMAIL_RE.test(value)) errors[field] = 'must be a valid email address';
        break;
      }
      case 'int': {
        const n = Number(value);
        if (!Number.isInteger(n)) errors[field] = 'must be a whole number';
        else value = n;
        break;
      }
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) errors[field] = 'must be a number';
        else value = n;
        break;
      }
      case 'boolean': {
        value = value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
        break;
      }
      case 'date': {
        value = String(value).trim();
        if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
          errors[field] = 'must be a date formatted YYYY-MM-DD';
        }
        break;
      }
      case 'time': {
        value = String(value).trim();
        if (!TIME_RE.test(value)) errors[field] = 'must be a time formatted HH:MM';
        break;
      }
      case 'enum': {
        value = String(value).trim();
        if (!spec.values.includes(value)) errors[field] = `must be one of: ${spec.values.join(', ')}`;
        break;
      }
      default:
        throw new Error(`Unknown field type "${spec.type}" for ${field}`);
    }

    if (spec.type === 'int' || spec.type === 'number') {
      if (spec.min !== undefined && value < spec.min) errors[field] = `must be at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) errors[field] = `must be at most ${spec.max}`;
    }

    if (!errors[field]) out[field] = value;
  }

  if (Object.keys(errors).length) {
    throw badRequest('Some fields need attention', errors);
  }
  return out;
}

/**
 * Today's date *where the gym is* — not in UTC.
 *
 * Every caller of this wants a calendar date to compare against a stored
 * `start_date`/`paid_on`/`class_date`, all of which are gym-local dates, so
 * this has to be gym-local too. Re-exported through clock.js's gymToday() so
 * there is only one definition of "today" in the codebase.
 */
export { gymToday as today } from './clock.js';

/** Pure string arithmetic on a `YYYY-MM-DD`, so no timezone can leak in. */
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `isoDate` plus `months` calendar months, clamped to the shorter month.
 *
 * "Monthly" is a calendar notion, not 30 days: a member who buys the fitness
 * add-on on the 31st of January is paid up to the 28th of February, not to a
 * date that does not exist. Pure UTC arithmetic on the parts, so no timezone
 * can leak in — the same discipline as addDays above.
 */
export function addMonths(isoDate, months) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const lastDayOfTarget = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDayOfTarget)));
  return d.toISOString().slice(0, 10);
}

/** The first of `isoDate`'s month, optionally `monthsBack` months earlier. */
export function startOfMonth(isoDate, monthsBack = 0) {
  const [year, month] = isoDate.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 - monthsBack, 1));
  return d.toISOString().slice(0, 10);
}

export function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
