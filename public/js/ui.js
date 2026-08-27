/** Small DOM + formatting toolkit shared by every view. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export const svg = (tag, props = {}, ...children) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(3)) {
    if (child) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
};

export function clear(node) {
  node.replaceChildren();
  return node;
}

/* ------------------------------------------------------------------- icons */

/**
 * The app's icon set — stroke-drawn vectors on a 24x24 grid, in the Lucide
 * idiom: no fills, round caps, and `currentColor` throughout so an icon takes
 * the colour of whatever it sits in (a nav link, a badge, a stat card's tinted
 * tile) without a per-context override.
 *
 * Kept as geometry rather than markup so renderIcon() can build real nodes
 * with svg() instead of parsing an HTML string on every call. A bare string is
 * a <path d="…">; an object is any other shape — { tag, ...attributes }.
 */
const ICONS = {
  /* --- navigation and domain objects --- */
  dashboard: [
    { tag: 'rect', x: 3, y: 3, width: 7, height: 9, rx: 1 },
    { tag: 'rect', x: 14, y: 3, width: 7, height: 5, rx: 1 },
    { tag: 'rect', x: 14, y: 12, width: 7, height: 9, rx: 1 },
    { tag: 'rect', x: 3, y: 16, width: 7, height: 5, rx: 1 },
  ],
  checkin: [
    'M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z',
    'M13 5v2',
    'M13 11v2',
    'M13 17v2',
  ],
  members: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    { tag: 'circle', cx: 9, cy: 7, r: 4 },
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  member: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', { tag: 'circle', cx: 12, cy: 7, r: 4 }],
  billing: [{ tag: 'rect', x: 2, y: 5, width: 20, height: 14, rx: 2 }, 'M2 10h20', 'M6 15h4'],
  plans: [
    'M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z',
    { tag: 'circle', cx: 7.5, cy: 7.5, r: 1.25, fill: 'currentColor', stroke: 'none' },
  ],
  reports: ['M3 3v18h18', 'M18 17V9', 'M13 17V5', 'M8 17v-3'],
  whatsapp: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  classes: [
    { tag: 'rect', x: 3, y: 4, width: 18, height: 18, rx: 2 },
    'M16 2v4',
    'M8 2v4',
    'M3 10h18',
    'M8 14h.01',
    'M12 14h.01',
    'M16 14h.01',
  ],
  equipment: ['m6.5 6.5 11 11', 'm21 21-1-1', 'm3 3 1 1', 'm18 22 4-4', 'm2 6 4-4', 'm3 10 7-7', 'm14 21 7-7'],
  devices: [
    'M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4',
    'M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2',
    'M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2',
    'M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4',
    'M14 13.12c0 2.38 0 6.38-1 8.88',
    'M17.29 21.02c.12-.6.43-2.3.5-3.02',
    'M8.65 22c.21-.66.45-1.32.57-2',
  ],
  sessions: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 7v5l3.5 2'],
  staff: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', { tag: 'circle', cx: 9, cy: 7, r: 4 }, 'm16 11 2 2 4-4'],
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    { tag: 'circle', cx: 12, cy: 12, r: 3 },
  ],
  seats: [
    'M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3',
    'M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z',
    'M5 18v3',
    'M19 18v3',
  ],
  lockers: [{ tag: 'rect', x: 3, y: 11, width: 18, height: 11, rx: 2 }, 'M7 11V7a5 5 0 0 1 10 0v4'],
  expenses: [
    'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z',
    'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8',
    'M12 17.5v-11',
  ],
  book: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'],
  shield: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  ],
  database: [
    { tag: 'ellipse', cx: 12, cy: 5, rx: 9, ry: 3 },
    'M3 5v14a9 3 0 0 0 18 0V5',
    'M3 12a9 3 0 0 0 18 0',
  ],
  idCard: [
    { tag: 'rect', x: 2, y: 4, width: 20, height: 16, rx: 2 },
    { tag: 'circle', cx: 9, cy: 10, r: 2.5 },
    'M5.5 16.5c.8-1.4 2-2.1 3.5-2.1s2.7.7 3.5 2.1',
    'M15.5 9.5H19',
    'M15.5 13.5H18',
  ],

  /* --- money and metrics --- */
  revenue: [
    { tag: 'rect', x: 2, y: 6, width: 20, height: 12, rx: 2 },
    { tag: 'circle', cx: 12, cy: 12, r: 2.5 },
    'M6 12h.01',
    'M18 12h.01',
  ],
  wallet: [
    'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5',
    'M16 12h3',
  ],
  incoming: ['M12 3v14', 'm6 11 6 6 6-6', 'M5 21h14'],
  outgoing: ['M12 21V7', 'm6 13 6-6 6 6', 'M5 3h14'],
  trendUp: ['m22 7-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
  trendDown: ['m22 17-8.5-8.5-5 5L2 7', 'M16 17h6v-6'],
  hourglass: [
    'M5 2h14',
    'M5 22h14',
    'M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2',
    'M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22',
  ],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],

  /* --- payment methods --- */
  smartphone: [{ tag: 'rect', x: 6, y: 2, width: 12, height: 20, rx: 2 }, 'M11 18h2'],
  bank: ['M3 21h18', 'M6 21V11', 'M10 21V11', 'M14 21V11', 'M18 21V11', 'm2 11 10-6 10 6z'],
  globe: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    'M3 12h18',
    'M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z',
  ],

  /* --- controls --- */
  sun: [
    { tag: 'circle', cx: 12, cy: 12, r: 4 },
    'M12 2v2',
    'M12 20v2',
    'm4.93 4.93 1.41 1.41',
    'm17.66 17.66 1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'm6.34 17.66-1.41 1.41',
    'm19.07 4.93-1.41 1.41',
  ],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  maximize: [
    'M8 3H5a2 2 0 0 0-2 2v3',
    'M21 8V5a2 2 0 0 0-2-2h-3',
    'M3 16v3a2 2 0 0 0 2 2h3',
    'M16 21h3a2 2 0 0 0 2-2v-3',
  ],
  minimize: [
    'M8 3v3a2 2 0 0 1-2 2H3',
    'M21 8h-3a2 2 0 0 1-2-2V3',
    'M3 16h3a2 2 0 0 1 2 2v3',
    'M16 21v-3a2 2 0 0 1 2-2h3',
  ],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  key: [
    'M2.59 17.41A2 2 0 0 0 2 18.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.42-.59l.81-.81a6.5 6.5 0 1 0-4-4z',
    { tag: 'circle', cx: 16.5, cy: 7.5, r: 1.25, fill: 'currentColor', stroke: 'none' },
  ],
  plus: ['M5 12h14', 'M12 5v14'],
  search: [{ tag: 'circle', cx: 11, cy: 11, r: 8 }, 'm21 21-4.3-4.3'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  check: ['M20 6 9 17l-5-5'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  print: [
    'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
    'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6',
    { tag: 'rect', x: 6, y: 14, width: 12, height: 8, rx: 1 },
  ],
  cake: [
    'M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8',
    'M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1',
    'M2 21h20',
    'M7 8v3',
    'M12 8v3',
    'M17 8v3',
    'M7 4h.01',
    'M12 4h.01',
    'M17 4h.01',
  ],
  gift: [
    'M20 12v10H4V12',
    { tag: 'rect', x: 2, y: 7, width: 20, height: 5, rx: 1 },
    'M12 22V7',
    'M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z',
    'M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z',
  ],

  /* --- diet and workout tracking --- */
  // A dumbbell proper, not the crossed-wrenches drawing `equipment` aliases:
  // the Workout tab and the fitness nav item are about lifting, and reusing
  // the maintenance icon for it read as a spanner in a gym.
  weight: [
    'M6.5 6.5v11',
    'M17.5 6.5v11',
    'M3.5 9v6',
    'M20.5 9v6',
    'M6.5 12h11',
  ],
  apple: [
    'M12 8c0-3.5 2.5-5.5 6-5.5 0 3-1.8 5.2-4.5 5.5',
    'M12 8c-4.4 0-7 3-7 6.8C5 18.7 8.2 22 12 22s7-3.3 7-7.2C19 11 16.4 8 12 8z',
  ],
  flame: [
    'M12 22c4 0 6.5-2.6 6.5-6 0-4.3-3.7-6.6-4.6-10.7-.2-.9-1.3-1.2-1.9-.5C10 7.2 9 9.4 9 11c-1.2-.6-1.6-2-1.6-2C6.2 10.5 5.5 12.4 5.5 16c0 3.4 2.5 6 6.5 6z',
    'M12 22c1.9 0 3-1.3 3-3 0-2-1.7-3-2.2-4.9-.4.9-1.3 1.8-1.9 2.6-.5.7-.9 1.4-.9 2.3 0 1.7 1.1 3 2 3z',
  ],
  droplet: ['M12 2.7 6.9 8a7.2 7.2 0 1 0 10.2 0z'],
  trophy: [
    'M8 21h8',
    'M12 17v4',
    'M7 4h10v5a5 5 0 0 1-10 0z',
    'M7 5H5a2 2 0 0 0 0 4h2',
    'M17 5h2a2 2 0 0 1 0 4h-2',
  ],
  timer: [
    'M10 2h4',
    'M12 6v0',
    { tag: 'circle', cx: 12, cy: 14, r: 8 },
    'M12 10v4l2.5 2',
    'M12 6V4',
  ],
  play: ['M6 4.5 19 12 6 19.5z'],
  target: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'circle', cx: 12, cy: 12, r: 5 },
    { tag: 'circle', cx: 12, cy: 12, r: 1.25, fill: 'currentColor', stroke: 'none' },
  ],
  trash: [
    'M3 6h18',
    'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
    'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    'M10 11v6',
    'M14 11v6',
  ],
  chevronLeft: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  sparkle: [
    'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    'M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  ],
};

/** Same drawing under a second name, where a view reads better naming the
 * thing than the picture (a clock vs. a shift, a card vs. billing). */
Object.assign(ICONS, {
  clock: ICONS.sessions,
  user: ICONS.member,
  users: ICONS.members,
  card: ICONS.billing,
  cash: ICONS.revenue,
  dumbbell: ICONS.equipment,
  lock: ICONS.lockers,
  receipt: ICONS.expenses,
  ticket: ICONS.checkin,
  calendar: ICONS.classes,
  fingerprint: ICONS.devices,
  // `dumbbell` above still aliases `equipment`, which every existing screen
  // uses — the new fitness views ask for `weight` instead, so adding a real
  // dumbbell drawing does not silently restyle the portal's brand mark.
  nutrition: ICONS.apple,
  calories: ICONS.flame,
  water: ICONS.droplet,
  pr: ICONS.trophy,
  rest: ICONS.timer,
  macros: ICONS.target,
  delete: ICONS.trash,
});

/**
 * An <svg> node for `name`, or null if there is no such icon — so a caller
 * holding something that may not be an icon name can fall back to it (see
 * iconOrText).
 *
 * `title` turns the icon into a labelled image for assistive tech; without one
 * it is decoration and stays hidden, which is right wherever a visible label
 * sits beside it.
 */
export function renderIcon(name, { size = 18, class: className, stroke = 1.75, title } = {}) {
  const parts = ICONS[name];
  if (!parts) return null;
  return svg(
    'svg',
    {
      class: `svg-icon${className ? ` ${className}` : ''}`,
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      role: title ? 'img' : null,
      'aria-hidden': title ? null : 'true',
      focusable: 'false',
    },
    title ? svg('title', {}, title) : null,
    ...parts.map((part) => {
      if (typeof part === 'string') return svg('path', { d: part });
      const { tag, ...attrs } = part;
      return svg(tag, attrs);
    }),
  );
}

/** An icon name, a ready-made node, or plain text — whichever it is, something
 * appendable comes back. Lets a builder like stat() take `icon: 'members'`
 * without every caller having to import renderIcon. */
export const iconOrText = (value, options) =>
  typeof value === 'string' ? renderIcon(value, options) ?? value : value;

/* ------------------------------------------------------------- formatting */

let currency = 'INR';
export const setCurrency = (code) => {
  currency = code || 'INR';
};

export function money(amount, { compact = false } = {}) {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
      notation: compact && Math.abs(value) >= 100_000 ? 'compact' : 'standard',
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(0)}`;
  }
}

export function date(value, { withTime = false } = {}) {
  if (!value) return '—';
  const iso = String(value).includes('T') ? value : String(value).replace(' ', 'T');
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const year = parsed.getFullYear();
  const formatted = `${day}/${month}/${year}`;
  if (!withTime) return formatted;
  const time = parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${formatted}, ${time}`;
}

export function dayMonth(value) {
  if (!value) return '—';
  const iso = String(value).includes('T') ? value : String(value).replace(' ', 'T');
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

export function time(value) {
  if (!value) return '—';
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  const suffix = hours < 12 ? 'AM' : 'PM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

/* -------------------------------------------------------------- date field */

const isoToDisplay = (iso) => {
  if (!iso || iso.length < 10) return '';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
};

const displayToIso = (display) => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(display.trim());
  if (!match) return '';
  const [, d, m, y] = match;
  const day = Number(d);
  const month = Number(m);
  const probe = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`);
  if (Number.isNaN(probe.getTime()) || probe.getDate() !== day || probe.getMonth() + 1 !== month) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function calendarGrid(viewYear, viewMonth, selectedIso, onPick) {
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // week starts Monday
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayIso = today();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(h('span', { class: 'date-cell empty' }));
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const classes = ['date-cell'];
    if (iso === selectedIso) classes.push('selected');
    if (iso === todayIso) classes.push('today');
    cells.push(
      h('button', { type: 'button', class: classes.join(' '), onclick: () => onPick(iso) }, String(day)),
    );
  }

  return h('div', { class: 'date-grid' }, ...cells);
}

/**
 * A text field that always shows and accepts DD/MM/YYYY, backed by a real
 * ISO value so every existing caller — buildForm's `values[name] = input.value`,
 * direct `input.value = x` assignment, `onchange: (e) => e.target.value` — keeps
 * working exactly as it did with a native `<input type="date">`. The native
 * picker's on-screen format follows OS/browser locale and can't be forced to
 * DD/MM/YYYY from app code, so this replaces it outright rather than fighting it.
 */
export function dateField({ name, value = '', placeholder = 'DD/MM/YYYY', onchange, class: className } = {}) {
  let isoValue = value || '';
  const listeners = new Set();
  if (typeof onchange === 'function') listeners.add(onchange);

  const text = h('input', { type: 'text', inputmode: 'numeric', placeholder, autocomplete: 'off' });
  const toggle = h('button', { type: 'button', class: 'date-toggle', 'aria-label': 'Open calendar' }, renderIcon('calendar', { size: 16 }));
  const panel = h('div', { class: 'date-panel', style: 'display:none' });
  const wrap = h('div', { class: `date-field${className ? ` ${className}` : ''}` }, text, toggle, panel);

  const fireChange = () => {
    for (const fn of listeners) fn({ target: wrap });
  };

  const setIso = (iso, { silent = false } = {}) => {
    isoValue = iso || '';
    text.value = isoToDisplay(isoValue);
    if (!silent) fireChange();
  };

  let view = (() => {
    const base = isoValue ? new Date(`${isoValue}T00:00:00`) : new Date(`${today()}T00:00:00`);
    return { year: base.getFullYear(), month: base.getMonth() };
  })();

  function renderPanel() {
    const header = h(
      'div',
      { class: 'date-panel-head' },
      h('button', { type: 'button', class: 'icon-btn', onclick: () => { view = view.month === 0 ? { year: view.year - 1, month: 11 } : { ...view, month: view.month - 1 }; renderPanel(); } }, '‹'),
      h('span', {}, `${MONTH_NAMES[view.month]} ${view.year}`),
      h('button', { type: 'button', class: 'icon-btn', onclick: () => { view = view.month === 11 ? { year: view.year + 1, month: 0 } : { ...view, month: view.month + 1 }; renderPanel(); } }, '›'),
    );
    const weekdays = h('div', { class: 'date-grid date-weekdays' }, ...['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => h('span', {}, d)));
    const grid = calendarGrid(view.year, view.month, isoValue, (iso) => {
      setIso(iso);
      closePanel();
    });
    clear(panel).append(header, weekdays, grid);
  }

  // Fixed-position + JS placement (rather than absolute + CSS anchoring) so the
  // panel escapes any scroll-clipping ancestor (.table-wrap, .seatmap-tabs) and
  // stays on-screen when the field sits near the right edge of a narrow viewport.
  function placePanel() {
    const rect = wrap.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 260;
    const panelHeight = panel.offsetHeight || 300;
    const margin = 8;

    let left = rect.left;
    if (left + panelWidth > window.innerWidth - margin) left = window.innerWidth - panelWidth - margin;
    if (left < margin) left = margin;

    let top = rect.bottom + 6;
    if (top + panelHeight > window.innerHeight - margin && rect.top - panelHeight - 6 > margin) {
      top = rect.top - panelHeight - 6;
    }

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function onReposition() {
    if (panel.style.display !== 'none') placePanel();
  }

  function openPanel() {
    const base = isoValue ? new Date(`${isoValue}T00:00:00`) : new Date(`${today()}T00:00:00`);
    view = { year: base.getFullYear(), month: base.getMonth() };
    renderPanel();
    panel.style.display = 'block';
    placePanel();
    document.addEventListener('mousedown', onOutsideClick, true);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
  }

  function closePanel() {
    panel.style.display = 'none';
    document.removeEventListener('mousedown', onOutsideClick, true);
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
  }

  function onOutsideClick(event) {
    if (!wrap.contains(event.target)) closePanel();
  }

  toggle.addEventListener('click', () => {
    if (panel.style.display === 'none') openPanel();
    else closePanel();
  });

  text.addEventListener('change', () => {
    if (text.value.trim() === '') {
      setIso('');
      return;
    }
    const iso = displayToIso(text.value);
    if (iso) setIso(iso);
    else text.value = isoToDisplay(isoValue); // invalid typed text: revert to last good value
  });

  setIso(isoValue, { silent: true });
  if (name) {
    wrap.dataset.name = name;
    wrap.setAttribute('name', name);
  }

  Object.defineProperty(wrap, 'value', {
    get: () => isoValue,
    set: (v) => setIso(v, { silent: true }),
  });
  Object.defineProperty(wrap, 'name', { value: name, writable: true });
  wrap.addEventListener = (type, fn) => { if (type === 'change') listeners.add(fn); };
  wrap.focus = () => text.focus();

  return wrap;
}

export function relativeDays(isoDate) {
  if (!isoDate) return null;
  const target = new Date(`${String(isoDate).slice(0, 10)}T00:00:00`);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Math.round((target - start) / 86_400_000);
}

export function expiryLabel(endDate) {
  const days = relativeDays(endDate);
  if (days === null) return h('span', { class: 'badge grey' }, 'No membership');
  if (days < 0) return h('span', { class: 'badge red' }, `Expired ${Math.abs(days)}d ago`);
  if (days === 0) return h('span', { class: 'badge amber' }, 'Ends today');
  if (days <= 7) return h('span', { class: 'badge amber' }, `${days}d left`);
  return h('span', { class: 'badge green' }, `${days}d left`);
}

export const initials = (first = '', last = '') =>
  `${(first[0] || '').toUpperCase()}${(last[0] || '').toUpperCase()}` || '?';

export const fullName = (person) => `${person.first_name || ''} ${person.last_name || ''}`.trim();

export const today = () => new Date().toLocaleDateString('en-CA');

export const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};

export const STATUS_TONE = {
  active: 'green',
  expired: 'red',
  cancelled: 'grey',
  frozen: 'blue',
  inactive: 'grey',
  operational: 'green',
  maintenance: 'amber',
  retired: 'grey',
  booked: 'blue',
  attended: 'green',
  no_show: 'red',
};

/** Badge colour per check-in channel, so the desk can see at a glance how
 * people are getting in. */
export const SOURCE_TONE = {
  biometric: 'violet',
  qr: 'blue',
  device: 'green',
  desk: 'grey',
};

export const sourceBadge = (source) =>
  h('span', { class: `badge ${SOURCE_TONE[source] || 'grey'}` }, source);

/** `dot` prefixes the pill with a filled status dot in the same tone — the
 * lifecycle badges are scanned down a column, and the dot is what makes a
 * change of state visible before the word is read. */
export const statusBadge = (status) =>
  h('span', { class: `badge dot ${STATUS_TONE[status] || 'grey'}` }, String(status || '').replace('_', ' '));

/**
 * A toolbar control with its caption attached — "From [date]".
 *
 * Pairing them in one flex box is what keeps the caption from being orphaned on
 * the line above its input when a toolbar wraps on a narrow screen.
 */
export const labelledControl = (text, control) =>
  h('label', { class: 'toolbar-pair' }, h('span', { class: 'muted' }, text), control);

export const personCell = (person) =>
  h(
    'div',
    { class: 'person' },
    person.photo_url
      ? h('img', { class: 'avatar', src: person.photo_url, alt: '' })
      : h('div', { class: 'avatar' }, initials(person.first_name, person.last_name)),
    h(
      'div',
      { class: 'meta' },
      h('div', { class: 'name' }, fullName(person)),
      h('div', { class: 'sub' }, person.code || person.email || ''),
    ),
  );

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = 'success') {
  const node = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 300);
  }, kind === 'error' ? 6000 : 3200);
}

/* ------------------------------------------------------------------- modal */

let modalCount = 0;

export function closeModal() {
  const root = document.getElementById('modal-root');
  const last = root.lastElementChild;
  if (last) {
    if (last.onCloseCallback) last.onCloseCallback();
    last.remove();
    modalCount--;
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalCount > 0) {
    closeModal();
  }
});

export function openModal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) closeModal();
      },
    },
    h(
      'div',
      { class: `modal ${wide ? 'wide' : ''}` },
      h(
        'div',
        { class: 'modal-head' },
        h('h2', {}, title),
        h('div', { class: 'spacer' }),
        h('button', { class: 'icon-btn', onclick: closeModal, title: 'Close', 'aria-label': 'Close' }, renderIcon('close', { size: 18 })),
      ),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null,
    ),
  );
  backdrop.onCloseCallback = onClose;
  root.append(backdrop);
  modalCount++;

  const firstInput = backdrop.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
  return backdrop;
}

/* -------------------------------------------------------------------- forms */

/**
 * Builds a form from field descriptors and wires up server-side field errors.
 * fields: [{ name, label, type, options, value, required, full, placeholder, step, hint }]
 */
export function buildForm(fields, { onSubmit, submitLabel = 'Save', wide = false }) {
  const inputs = new Map();
  const grid = h('div', { class: 'form-grid' });

  for (const field of fields) {
    if (!field) continue;
    let input;
    if (field.type === 'select') {
      input = h(
        'select',
        { name: field.name },
        ...(field.options || []).map((option) =>
          h('option', { value: option.value, selected: String(option.value) === String(field.value ?? '') }, option.label),
        ),
      );
    } else if (field.type === 'textarea') {
      input = h('textarea', { name: field.name, placeholder: field.placeholder || '' }, field.value ?? '');
    } else if (field.type === 'date') {
      input = dateField({ name: field.name, value: field.value ?? '' });
    } else {
      input = h('input', {
        name: field.name,
        type: field.type || 'text',
        value: field.value ?? '',
        placeholder: field.placeholder || '',
        step: field.step,
        min: field.min,
        max: field.max,
        list: field.list,
      });
    }
    inputs.set(field.name, input);

    const errorNode = h('div', { class: 'field-error', style: 'display:none' });
    grid.append(
      h(
        'label',
        { class: `field ${field.full ? 'full' : ''}` },
        h('span', {}, field.label, field.required ? ' *' : ''),
        input,
        field.hint ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, field.hint) : null,
        errorNode,
      ),
    );
    input.dataset.errorFor = field.name;
    input.errorNode = errorNode;
  }

  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        for (const input of inputs.values()) {
          input.errorNode.style.display = 'none';
        }
        const values = {};
        for (const [name, input] of inputs) values[name] = input.value;

        submit.disabled = true;
        try {
          await onSubmit(values);
        } catch (err) {
          if (err.details && Object.keys(err.details).length) {
            const unmapped = [];
            for (const [name, message] of Object.entries(err.details)) {
              const input = inputs.get(name);
              if (input) {
                input.errorNode.textContent = message;
                input.errorNode.style.display = 'block';
              } else {
                unmapped.push(`${name.replace('_', ' ')} ${message}`);
              }
            }
            if (unmapped.length) {
              toast(`${err.message || 'Could not save'}: ${unmapped.join(', ')}`, 'error');
            } else {
              toast(err.message || 'Could not save', 'error');
            }
          } else {
            toast(err.message || 'Could not save', 'error');
          }
        } finally {
          submit.disabled = false;
        }
      },
    },
    grid,
    h(
      'div',
      { class: 'modal-foot', style: 'padding:8px 0 0;border:none' },
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
      submit,
    ),
  );
  form.classList.toggle('wide', wide);
  return form;
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  secondaryLabel,
  onSecondary,
}) {
  const confirm = h(
    'button',
    {
      class: `btn ${danger ? 'danger' : 'primary'}`,
      onclick: async () => {
        confirm.disabled = true;
        try {
          await onConfirm();
          closeModal();
        } catch (err) {
          toast(err.message || 'Action failed', 'error');
          confirm.disabled = false;
        }
      },
    },
    confirmLabel,
  );
  const footer = [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel')];
  if (secondaryLabel && onSecondary) {
    const secondary = h(
      'button',
      {
        class: 'btn ghost',
        onclick: async () => {
          secondary.disabled = true;
          try {
            await onSecondary();
          } catch (err) {
            toast(err.message || 'Action failed', 'error');
          } finally {
            secondary.disabled = false;
          }
        },
      },
      secondaryLabel,
    );
    footer.push(secondary);
  }
  footer.push(confirm);
  openModal({
    title,
    body: h('p', { class: 'muted', style: 'margin:0' }, message),
    footer,
  });
}

/* ------------------------------------------------------------------- tables */

export function table(columns, rows, { onRowClick, empty = 'Nothing here yet' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);

  const body = h(
    'tbody',
    {},
    ...rows.map((row) => {
      const tr = h(
        'tr',
        { class: onRowClick ? 'clickable' : '' },
        ...columns.map((column) => h('td', { class: column.align === 'right' ? 'num' : '' }, column.render(row))),
      );
      if (onRowClick) tr.addEventListener('click', () => onRowClick(row));
      return tr;
    }),
  );

  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { class: c.align === 'right' ? 'num' : '' }, c.label)))),
      body,
    ),
  );
}

/**
 * `trend` — { positive: boolean|null, text: string } — renders a colour-coded
 * pill instead of the plain hint line. `pulse` adds a small live indicator next
 * to the icon, for "this number is changing right now" cards (check-ins).
 *
 * `icon` takes an icon name ('members', 'revenue', …) and renders it in a
 * tinted tile; anything renderIcon() doesn't know is used as-is, so a node or a
 * bare glyph still works.
 */
export const stat = (label, value, hint, { accent = false, icon = null, trend = null, pulse = false, onClick = null } = {}) =>
  h(
    'div',
    {
      class: `card stat ${accent ? 'accent' : ''} ${onClick ? 'clickable' : ''}`,
      onclick: onClick,
      tabindex: onClick ? '0' : null,
    },
    icon || pulse
      ? h(
          'div',
          { class: 'stat-top' },
          icon ? h('div', { class: 'stat-icon' }, iconOrText(icon, { size: 17 })) : null,
          pulse ? h('span', { class: 'live-pulse' }, h('span', { class: 'live-pulse-core' })) : null,
        )
      : null,
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    trend
      ? h(
          'span',
          { class: `trend-pill ${trend.positive === true ? 'pos' : trend.positive === false ? 'neg' : ''}` },
          trend.text,
        )
      : hint
        ? h('div', { class: 'hint' }, hint)
        : null,
  );

/* ------------------------------------------------------------------- charts */

/**
 * Positions a chart's floating tooltip inside its wrapper, flipping to the
 * left of the cursor once it would otherwise overhang the right edge.
 */
function positionChartTooltip(tooltip, wrap, clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  const overhang = relX + 150 > rect.width;
  tooltip.style.transform = `translate(${overhang ? relX - 150 : relX + 14}px, ${Math.max(relY - 12, 0)}px)`;
}

/**
 * Bars drawn in a fixed 640-unit coordinate space so the SVG scales uniformly —
 * a three-bar chart and a thirty-bar chart both keep readable, undistorted text.
 */
export function barChart(data, { height = 160, format = (v) => v, label = (d) => d.label } = {}) {
  if (!data.length) return h('div', { class: 'empty' }, 'No data for this period');

  const width = 640;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slot = width / data.length;
  const barWidth = Math.min(slot * 0.62, 70);
  const plot = height - 26;
  const plotTop = 18;
  // With many bars there is no room for a caption on every one.
  const labelEvery = Math.ceil(data.length / 16);
  const showValues = data.length <= 12;

  const wrap = h('div', { class: 'chart-wrap' });
  const tooltip = h('div', { class: 'chart-tooltip' });

  const showTip = (event, d) => {
    clear(tooltip).append(
      h('div', { class: 'chart-tooltip-label' }, label(d)),
      h('div', { class: 'chart-tooltip-value' }, format(d.value)),
    );
    tooltip.classList.add('show');
    positionChartTooltip(tooltip, wrap, event.clientX, event.clientY);
  };
  const hideTip = () => tooltip.classList.remove('show');

  const chart = svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${width} ${height}`, style: `height:${height}px;width:100%`, onmouseleave: hideTip },
    ...[0.25, 0.5, 0.75].map((frac) =>
      svg('line', { class: 'grid-line', x1: 0, y1: plotTop + (plot - plotTop) * frac, x2: width, y2: plotTop + (plot - plotTop) * frac }),
    ),
    svg('line', { class: 'axis', x1: 0, y1: plot, x2: width, y2: plot }),
    ...data.flatMap((d, i) => {
      const barHeight = Math.max((d.value / max) * (plot - plotTop), d.value > 0 ? 2 : 0);
      const center = i * slot + slot / 2;
      return [
        svg('rect', {
          class: 'bar',
          x: center - barWidth / 2,
          y: plot - barHeight,
          width: barWidth,
          height: barHeight,
          rx: 3,
          onmousemove: (event) => showTip(event, d),
          onmouseleave: hideTip,
        }),
        i % labelEvery === 0 ? svg('text', { x: center, y: plot + 13, 'text-anchor': 'middle' }, d.label) : null,
        showValues && d.value > 0
          ? svg('text', { x: center, y: plot - barHeight - 5, 'text-anchor': 'middle' }, format(d.value))
          : null,
      ];
    }),
  );

  wrap.append(chart, tooltip);
  return wrap;
}

let chartGradientSeq = 0;

export function lineChart(data, { height = 170, format = (v) => v } = {}) {
  if (data.length < 2) return h('div', { class: 'empty' }, 'Not enough data yet');

  const width = 640;
  const pad = { left: 8, right: 8, top: 14, bottom: 24 };
  const max = Math.max(...data.map((d) => d.value), 1);
  const plotHeight = height - pad.top - pad.bottom;
  const step = (width - pad.left - pad.right) / (data.length - 1);
  const points = data.map((d, i) => [pad.left + i * step, pad.top + plotHeight - (d.value / max) * plotHeight]);
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${points.at(-1)[0].toFixed(1)},${pad.top + plotHeight} L${points[0][0].toFixed(1)},${pad.top + plotHeight} Z`;
  const labelEvery = Math.ceil(data.length / 8);
  const gradientId = `areaFill-${chartGradientSeq++}`;

  const wrap = h('div', { class: 'chart-wrap' });
  const tooltip = h('div', { class: 'chart-tooltip' });
  const crosshair = svg('line', { class: 'crosshair', x1: 0, y1: pad.top, x2: 0, y2: pad.top + plotHeight });
  const hoverDot = svg('circle', { class: 'dot hover-dot', r: 4 });

  const showAt = (index, clientX, clientY) => {
    const [x, y] = points[index];
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    hoverDot.setAttribute('cx', x);
    hoverDot.setAttribute('cy', y);
    crosshair.classList.add('show');
    hoverDot.classList.add('show');
    clear(tooltip).append(
      h('div', { class: 'chart-tooltip-label' }, data[index].label),
      h('div', { class: 'chart-tooltip-value' }, format(data[index].value)),
    );
    tooltip.classList.add('show');
    positionChartTooltip(tooltip, wrap, clientX, clientY);
  };
  const hide = () => {
    crosshair.classList.remove('show');
    hoverDot.classList.remove('show');
    tooltip.classList.remove('show');
  };

  const overlay = svg('rect', {
    x: 0,
    y: 0,
    width,
    height,
    fill: 'transparent',
    onmousemove: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const relX = ((event.clientX - rect.left) / rect.width) * width;
      const index = Math.max(0, Math.min(data.length - 1, Math.round((relX - pad.left) / step)));
      showAt(index, event.clientX, event.clientY);
    },
    onmouseleave: hide,
  });

  const chart = svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${width} ${height}`, style: `height:${height}px;width:100%` },
    svg(
      'defs',
      {},
      svg(
        'linearGradient',
        { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: '0%', style: 'stop-color:var(--brand);stop-opacity:0.35' }),
        svg('stop', { offset: '100%', style: 'stop-color:var(--brand);stop-opacity:0' }),
      ),
    ),
    svg('path', { class: 'area', d: area, fill: `url(#${gradientId})` }),
    svg('path', { class: 'line', d: path }),
    ...points.map(([x, y]) => svg('circle', { class: 'dot', cx: x, cy: y, r: 2.5 })),
    ...data.map((d, i) =>
      i % labelEvery === 0
        ? svg('text', { x: pad.left + i * step, y: height - 6, 'text-anchor': 'middle' }, d.label)
        : null,
    ),
    crosshair,
    hoverDot,
    overlay,
  );

  wrap.append(chart, tooltip);
  return wrap;
}

/* ------------------------------------------------------------- fullscreen */

export function isFullscreen() {
  return Boolean(
    document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement,
  );
}

export async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) await document.mozCancelFullScreen();
      else if (document.msExitFullscreen) await document.msExitFullscreen();
    } else {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) await docEl.requestFullscreen();
      else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
      else if (docEl.mozRequestFullScreen) await docEl.mozRequestFullScreen();
      else if (docEl.msRequestFullscreen) await docEl.msRequestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen toggle failed:', err);
    toast('Fullscreen mode is not permitted by your browser settings', 'error');
  }
}

export function onFullscreenChange(callback) {
  const events = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
  const handler = () => callback(isFullscreen());
  events.forEach((evt) => document.addEventListener(evt, handler));
  return () => events.forEach((evt) => document.removeEventListener(evt, handler));
}

