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

export function setVertical(type) {
  vertical = type === 'library' ? 'library' : 'gym';
  document.body.dataset.vertical = vertical;
}

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
  },
};

/** A missing library key degrades to the gym word rather than rendering
 * `undefined` — see the trap this guards against in vertical.js's header. */
export const t = (key) => TERMS[vertical]?.[key] ?? TERMS.gym[key] ?? key;
export const tl = (key) => t(key).toLowerCase();
