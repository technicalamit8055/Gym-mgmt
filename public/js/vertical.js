/**
 * Client mirror of src/verticals.js. Which product this browser tab is
 * looking at, and the vocabulary that follows from it.
 *
 * Not an i18n system: a flat key -> string, two objects, no interpolation,
 * no plural rules. setVertical() is called once from boot() (mirroring
 * setCurrency() in ui.js), and every consumer reads through t()/tl()/isLibrary()
 * rather than capturing a value — the whole nav and every view is built
 * *after* this runs, never before.
 */

let vertical = 'gym';

/**
 * Light/dark is remembered per app: the staff app defaults to dark, the
 * member app to light. Separate keys so a member's choice never repaints the
 * desk on a shared device, and vice versa. index.html's pre-paint script reads
 * the same keys — keep the two in step.
 */
const MODE_KEY = { staff: 'app_mode', member: 'member_app_mode' };
const DEFAULT_MODE = { staff: 'dark', member: 'light' };
let modeScope = window.location.hash.startsWith('#/portal') ? 'member' : 'staff';

function storedMode() {
  const saved = localStorage.getItem(MODE_KEY[modeScope]);
  return saved === 'light' || saved === 'dark' ? saved : DEFAULT_MODE[modeScope];
}

let currentMode = storedMode();

const DEFAULT_THEME = { gym: 'flame', library: 'emerald', coaching: 'indigo' };

/**
 * The palette the owner saved on this gym (see publicTenant in
 * src/routes/platform.js), so its staff app and member portal paint the same
 * on every device. Held in memory only, never localStorage: storage is per
 * origin, and the landing page, the operator console and — in path mode —
 * every other gym share this one, so a cached palette would leak into them.
 * Null means no gym is loaded, and the default palette stands.
 */
let gymTheme = null;
/** Set while a platform-owned page (landing, signup, operator console) is on
 * screen: those are GymBook's own pages and never wear a gym's palette. */
let platformPage = false;

function paintTheme() {
  document.body.dataset.theme = (!platformPage && gymTheme) || DEFAULT_THEME[vertical];
}

export function setVertical(type, theme) {
  vertical = type === 'library' || type === 'coaching' ? type : 'gym';
  gymTheme = theme || null;
  document.body.dataset.vertical = vertical;
  // Read by index.html's pre-paint script, which picks the next boot splash
  // before this module has loaded.
  try {
    localStorage.setItem('gymbook.splash.vertical', vertical);
  } catch {
    /* storage blocked: the splash falls back to the gym art */
  }
  document.body.dataset.mode = currentMode;
  paintTheme();
}

/** Called by the router on every page change. */
export function usePlatformTheme(on) {
  platformPage = Boolean(on);
  paintTheme();
}

/** Called by the router on every page change: the member portal and the
 * staff app each wear their own saved mode. */
export function useMemberMode(on) {
  modeScope = on ? 'member' : 'staff';
  currentMode = storedMode();
  document.body.dataset.mode = currentMode;
}

export function setAppMode(mode) {
  currentMode = mode === 'light' ? 'light' : 'dark';
  localStorage.setItem(MODE_KEY[modeScope], currentMode);
  document.body.dataset.mode = currentMode;
}

export function getAppMode() {
  return currentMode;
}

export function toggleAppMode() {
  setAppMode(currentMode === 'light' ? 'dark' : 'light');
  return currentMode;
}

/** This gym's palette, after the owner saved a new one. */
export function setAppTheme(theme) {
  gymTheme = theme || null;
  paintTheme();
}

export function getAppTheme() {
  return gymTheme || DEFAULT_THEME[vertical];
}

// Clear the palettes earlier builds cached per browser, so nothing is left
// that could be mistaken for a live setting.
try {
  localStorage.removeItem('gym_theme');
  localStorage.removeItem('library_theme');
} catch {
  // Storage blocked: nothing was cached either.
}

export const isLibrary = () => vertical === 'library';
export const isCoaching = () => vertical === 'coaching';
/** Either education product — the two whose people are students, not
 * members, and whose copy talks about study rather than training. */
export const isEducation = () => vertical === 'library' || vertical === 'coaching';
export const currentVerticalKey = () => vertical;

const TERMS = {
  gym: {
    brand: 'GymBook',
    org: 'gym',
    orgCap: 'Gym',
    member: 'Member',
    members: 'Members',
    membership: 'Membership',
    memberships: 'Memberships & billing',
    plan: 'Plan',
    plans: 'Plans',
    checkin: 'Check-in desk',
    shifts: 'Gym sessions',
    settings: 'Gym settings',
    trainer: 'Trainer',
    staff: 'Staff',
    inNow: 'In the gym now',
    equipment: 'Equipment',
    visit: 'workout',
    emergencyContact: 'Emergency contact',
    seats: 'Seat map',
    lockers: 'Lockers',
    expenses: 'Expenses',
    shift: 'gym session',
    shiftCap: 'Gym session',
  },
  library: {
    brand: 'SeatBook',
    org: 'library',
    orgCap: 'Library',
    member: 'Student',
    members: 'Students',
    membership: 'Seat plan',
    memberships: 'Passes & billing',
    plan: 'Pass',
    plans: 'Passes',
    checkin: 'Attendance',
    shifts: 'Shifts',
    settings: 'Library settings',
    trainer: 'Attendant',
    staff: 'Staff',
    inNow: 'Seated now',
    equipment: 'Assets',
    visit: 'sitting',
    emergencyContact: 'Guardian',
    seats: 'Seat map',
    lockers: 'Lockers',
    expenses: 'Expenses',
    shift: 'shift',
    shiftCap: 'Shift',
  },
  coaching: {
    brand: 'CoachBook',
    tagline: 'Coaching & Institute Management',
    org: 'institute',
    orgCap: 'Institute',
    member: 'Student',
    members: 'Students',
    membership: 'Enrollment',
    memberships: 'Fees & installments',
    plan: 'Course',
    plans: 'Courses',
    checkin: 'Attendance desk',
    shifts: 'Batches',
    settings: 'Institute settings',
    trainer: 'Faculty',
    staff: 'Faculty & staff',
    inNow: 'In the institute now',
    equipment: 'Assets',
    visit: 'lecture',
    emergencyContact: 'Guardian',
    seats: 'Seat map',
    lockers: 'Lockers',
    expenses: 'Expenses',
    shift: 'batch',
    shiftCap: 'Batch',
  },
};

/** A missing library key degrades to the gym word rather than rendering
 * `undefined` — see the trap this guards against in vertical.js's header. */
export const t = (key) => TERMS[vertical]?.[key] ?? TERMS.gym[key] ?? key;
export const tl = (key) => t(key).toLowerCase();
