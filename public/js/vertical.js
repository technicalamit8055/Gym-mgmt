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
let currentLibraryTheme = localStorage.getItem('library_theme') || 'emerald';
let currentGymTheme = localStorage.getItem('gym_theme') || 'flame';
let currentMode = localStorage.getItem('app_mode') || 'dark';

export function setVertical(type) {
  vertical = type === 'library' ? 'library' : 'gym';
  document.body.dataset.vertical = vertical;
  const activeTheme = vertical === 'library' ? currentLibraryTheme : currentGymTheme;
  document.body.dataset.theme = activeTheme;
  document.body.dataset.mode = currentMode;
}

export function setAppMode(mode) {
  currentMode = mode === 'light' ? 'light' : 'dark';
  localStorage.setItem('app_mode', currentMode);
  document.body.dataset.mode = currentMode;
}

export function getAppMode() {
  return currentMode;
}

export function toggleAppMode() {
  setAppMode(currentMode === 'light' ? 'dark' : 'light');
  return currentMode;
}

export function setAppTheme(theme) {
  if (vertical === 'library') {
    currentLibraryTheme = theme || 'emerald';
    localStorage.setItem('library_theme', currentLibraryTheme);
    document.body.dataset.theme = currentLibraryTheme;
  } else {
    currentGymTheme = theme || 'flame';
    localStorage.setItem('gym_theme', currentGymTheme);
    document.body.dataset.theme = currentGymTheme;
  }
}

export function getAppTheme() {
  return vertical === 'library' ? currentLibraryTheme : currentGymTheme;
}

export function setLibraryTheme(theme) { setAppTheme(theme); }
export function getLibraryTheme() { return getAppTheme(); }

export const isLibrary = () => vertical === 'library';

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
};

/** A missing library key degrades to the gym word rather than rendering
 * `undefined` — see the trap this guards against in vertical.js's header. */
export const t = (key) => TERMS[vertical]?.[key] ?? TERMS.gym[key] ?? key;
export const tl = (key) => t(key).toLowerCase();
