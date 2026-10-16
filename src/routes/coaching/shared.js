import { config } from '../../config.js';
import { badRequest } from '../../errors.js';

/** Helpers every CoachBook router uses. */

export const instituteName = (req) => req.tenant?.gym_name || req.tenant?.display_name || config.gymName || 'CoachBook';
export const tenantCurrency = (req) => req.tenant?.currency || 'INR';
export const tenantLogo = (req) => (req.tenant?.logo_bytes ? Buffer.from(req.tenant.logo_bytes) : null);

/** A positive integer route param, or a 400 naming it. */
export function idParam(req, name = 'id') {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`Invalid ${name}`);
  return n;
}

/** A positive integer query value, or null when absent. */
export function idQuery(req, name) {
  if (req.query[name] === undefined || req.query[name] === '') return null;
  const n = Number(req.query[name]);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`Invalid ${name}`, { [name]: 'must be an id' });
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function dateQuery(req, name, fallback) {
  const value = req.query[name];
  if (value === undefined || value === '') return fallback;
  if (!DATE_RE.test(String(value)) || Number.isNaN(Date.parse(String(value)))) {
    throw badRequest(`${name} must be a date formatted YYYY-MM-DD`, { [name]: 'invalid date' });
  }
  return String(value);
}

export function monthQuery(req, name, fallback) {
  const value = req.query[name];
  if (value === undefined || value === '') return fallback;
  if (!MONTH_RE.test(String(value))) throw badRequest(`${name} must be formatted YYYY-MM`, { [name]: 'invalid month' });
  return String(value);
}

/** The same field specs with `required` and `default` dropped, for a PATCH —
 * see `optional` in routes/members.js for why the default has to go too. */
export const optional = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([key, { default: _unused, ...spec }]) => [key, { ...spec, required: false }]));

/** Builds "UPDATE table SET a = ?, b = ? WHERE id = ?" from a parsed body. */
export function updateSql(table, body, id) {
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');
  return {
    sql: `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    params: [...columns.map((c) => body[c]), id],
  };
}

export function insertSql(table, body) {
  const columns = Object.keys(body).filter((c) => body[c] !== undefined);
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    params: columns.map((c) => body[c]),
  };
}

/** '1,3,5' from [1, 3, 5] or '1,3,5' — validated, sorted, de-duplicated. */
export function weekdaysValue(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((d) => Number.parseInt(d, 10))
    .filter((d) => Number.isInteger(d));
  if (list.some((d) => d < 0 || d > 6)) throw badRequest('Weekdays run 0 (Sunday) to 6 (Saturday)', { weekdays: 'invalid' });
  return [...new Set(list)].sort((a, b) => a - b).join(',') || null;
}
