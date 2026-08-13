/**
 * The two products this platform sells, and everything that differs between
 * them.
 *
 * GymBook runs gyms; SeatBook runs study halls and reading rooms. They share
 * one deployment, one operator console, one billing pipeline and one WhatsApp
 * stack — a tenant's `business_type` decides which nouns it sees, which
 * modules it gets, how its member codes are numbered, and what its database is
 * seeded with at signup.
 *
 * Every tenant's database carries every table regardless of vertical: a gym
 * simply never writes to `seats`. That keeps migrations linear and means a
 * mis-selected type is fixable from the operator console rather than by
 * re-provisioning.
 *
 * The vertical is read from the AsyncLocalStorage store (see getBusinessType in
 * db.js), not from `req`, so the seeders and the maintenance sweeps can reach
 * it too.
 */

import { getBusinessType } from './db.js';
import { notFound } from './errors.js';

/**
 * Starter catalogue prices are per-currency because "1500" is a sane monthly
 * fee in rupees and an absurd one in dollars; anything unlisted falls back to
 * the generic tier.
 */
const GENERIC_PRICES = [50, 135, 450];

export const VERTICALS = {
  gym: {
    key: 'gym',
    brand: 'GymBook',
    tagline: 'Gym Management',
    /** Two characters, matching every member code issued before verticals
     * existed. nextMemberCode() binds the offset off this length. */
    memberCodePrefix: 'GM',
    iconDir: '/icons',
    vocabulary: {
      org: 'gym',
      member: 'member',
      members: 'Members',
      plan: 'plan',
      plans: 'Plans',
      subscription: 'membership',
      visit: 'workout',
      shift: 'session',
      shifts: 'Gym sessions',
      emergencyContact: 'Emergency contact',
    },
    modules: new Set(['classes', 'bookings', 'equipment']),
    starterPrices: {
      INR: [1500, 4000, 14000],
      USD: [40, 105, 360],
      EUR: [40, 105, 360],
      GBP: [35, 95, 320],
    },
    starterPlans: [
      { name: 'Monthly', description: 'Full gym access, renewed every month', duration_days: 30 },
      { name: 'Quarterly', description: 'Three months of full gym access', duration_days: 90 },
      { name: 'Annual', description: 'Twelve months of full gym access', duration_days: 365 },
    ],
  },

  library: {
    key: 'library',
    brand: 'SeatBook',
    tagline: 'Study Hall Management',
    memberCodePrefix: 'ST',
    iconDir: '/icons/library',
    vocabulary: {
      org: 'library',
      member: 'student',
      members: 'Students',
      plan: 'pass',
      plans: 'Passes',
      subscription: 'seat plan',
      visit: 'sitting',
      shift: 'shift',
      shifts: 'Shifts',
      emergencyContact: 'Guardian',
    },
    modules: new Set(['seats', 'lockers', 'expenses', 'documents', 'waitlist']),
    starterPrices: {
      INR: [600, 600, 1000, 2700, 700],
      USD: [18, 18, 30, 80, 22],
      EUR: [18, 18, 30, 80, 22],
      GBP: [15, 15, 26, 70, 19],
    },
    /**
     * Seeded shifts. The migration in db.js has already written a Morning and
     * an Evening row into this brand-new file (they are gym batch defaults), so
     * the seeder updates those two by name and inserts the rest — see
     * seedVerticalDefaults in bootstrap.js.
     *
     * Night runs past midnight, which is why `overnight` exists: without it the
     * auto-checkout sweep resolves "06:00" to the check-in's own morning, a
     * time already in the past, and closes every night visit on the spot.
     */
    starterShifts: [
      { name: 'Morning', code: 'M', start_time: '06:00', end_time: '11:00', sort_order: 1, overnight: 0 },
      { name: 'Afternoon', code: 'A', start_time: '11:00', end_time: '16:00', sort_order: 2, overnight: 0 },
      { name: 'Evening', code: 'E', start_time: '16:00', end_time: '21:00', sort_order: 3, overnight: 0 },
      { name: 'Night', code: 'N', start_time: '22:00', end_time: '06:00', sort_order: 4, overnight: 1 },
      { name: 'Full Day', code: 'FD', start_time: '06:00', end_time: '22:00', sort_order: 5, overnight: 0 },
    ],
    /** `shift` names the seeded shift this pass is locked to, or null for a
     * pass sellable in any shift. Resolved to a session_id by the seeder. */
    starterPlans: [
      { name: 'Morning Monthly', description: 'One seat, morning shift, 30 days', duration_days: 30, shift: 'Morning' },
      { name: 'Evening Monthly', description: 'One seat, evening shift, 30 days', duration_days: 30, shift: 'Evening' },
      { name: 'Full Day Monthly', description: 'One seat, full day, 30 days', duration_days: 30, shift: 'Full Day' },
      { name: 'Full Day Quarterly', description: 'One seat, full day, 90 days', duration_days: 90, shift: 'Full Day' },
      { name: 'Night Monthly', description: 'One seat, night shift, 30 days', duration_days: 30, shift: 'Night' },
    ],
    /**
     * WhatsApp copy. These cannot be expressed as column defaults: the
     * whatsapp_settings row is inserted by a migration before any seeding runs,
     * so a defaults change would never reach an actual tenant. The seeder
     * UPDATEs the singleton row instead.
     */
    whatsappTemplates: {
      receipt_template:
        'Hi {{first_name}}, we have received {{amount}} for your {{plan_name}} at {{gym_name}}. '
        + 'Receipt attached. Thank you!',
      reminder_template:
        'Hi {{first_name}}, your {{plan_name}} at {{gym_name}} expires on {{end_date}}. '
        + 'Please renew to keep your seat.',
      welcome_template:
        'Welcome to {{gym_name}}, {{first_name}}! Your seat is ready. See you at the hall.',
      freeze_template:
        'Hi {{first_name}}, your {{plan_name}} at {{gym_name}} is on hold from today. '
        + 'Your seat is held for you — message us when you are ready to resume.',
    },
  },
};

export const BUSINESS_TYPES = Object.keys(VERTICALS);

/** Unknown values fall back to gym rather than throwing: a registry row written
 * before this column existed, or hand-edited, must still serve requests. */
export function verticalFor(key) {
  return VERTICALS[key] ?? VERTICALS.gym;
}

export function currentVertical() {
  return verticalFor(getBusinessType());
}

export function moduleEnabled(name) {
  return currentVertical().modules.has(name);
}

/** A vertical's word for something, falling back to the gym word so a term
 * missing from one catalogue degrades instead of rendering `undefined`. */
export function say(key) {
  const v = currentVertical();
  return v.vocabulary[key] ?? VERTICALS.gym.vocabulary[key] ?? key;
}

export function starterPricesFor(vertical, currency) {
  return vertical.starterPrices[String(currency).toUpperCase()] ?? GENERIC_PRICES;
}

/**
 * 404s a router this tenant's product does not include.
 *
 * Mounted inside each router after requireAuth rather than in app.js, so an
 * unauthenticated caller cannot probe which modules a tenant has, and so the
 * mount list in app.js stays a plain map of paths to routers.
 *
 * `code` so the SPA can tell "not part of your account" apart from a genuinely
 * mistyped URL.
 */
export function requireModule(name) {
  return (_req, _res, next) => {
    if (moduleEnabled(name)) return next();
    return next(
      Object.assign(notFound('That is not part of this account'), {
        details: { code: 'module_not_enabled', module: name },
      }),
    );
  };
}
