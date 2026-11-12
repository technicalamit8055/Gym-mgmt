/**
 * The words on the root domain's marketing pages — GymBook at "/" and
 * SeatBook at "/library" — as plain data.
 *
 * Two readers, one source. The browser draws the page from it
 * (views/landing.js), and the server writes the same title, description,
 * FAQ and features into the HTML it sends (src/marketing.js), so a crawler
 * that never runs JavaScript — and WhatsApp's link preview — reads exactly
 * what a visitor sees. Search engines also require FAQ markup to match an
 * FAQ that is actually on the page; one copy keeps that true by construction.
 *
 * That is also why this file imports nothing: Node loads it directly, so it
 * must never reach for the DOM, ui.js or api.js.
 *
 * Every claim here is one the product backs up (see README.md). Nothing about
 * pricing beyond the trial: the subscription price is set in the operator
 * console, not here, and a stale number on a marketing page is worse than none.
 */

export const MARKETING_BRANDS = ['gym', 'library'];

/** Where each page lives. Paths, not hashes: these are what gets indexed. */
export const MARKETING_PATHS = { gym: '/', library: '/library' };

/** Comparison cells: `true` is a tick, `false` a cross, `null` "partly". */
const GYM = (trialDays) => ({
  brand: 'gym',
  name: 'GymBook',
  icon: 'dumbbell',
  path: MARKETING_PATHS.gym,
  // ≤ 60 characters, so a search result shows all of it.
  title: 'Gym Management Software with WhatsApp & UPI | GymBook',
  // ≤ 160 characters, for the same reason.
  description:
    'Gym management software with QR and fingerprint check-in, WhatsApp renewal reminders and UPI payments straight to your account. Free trial.',
  category: 'Gym management software',
  ogImage: '/images/og/gymbook.png',
  appleIcon: '/icons/apple-touch-icon.png',
  favicon: '/icons/favicon-32.png',

  eyebrow: 'Gym management software',
  headline: ['Run your gym. ', 'All of it.'],
  lede:
    'Memberships, QR and fingerprint check-in, renewal reminders on WhatsApp and UPI payments that land straight in your account — in one place, on any screen at the front desk.',
  proof: ['No card needed', '0% commission on UPI', 'Ready in about a minute'],
  signin: {},

  featuresHeading: 'Everything the front desk needs',
  featuresLede: 'One system for the people, the payments and the place — so nothing lives in a register or a spreadsheet.',
  features: [
    {
      icon: 'fingerprint',
      title: 'Check-in that keeps up',
      body: 'Printable QR ID cards, phone biometrics, or an eSSL / ZKTeco-family fingerprint terminal at the door. One rescan checks a member back out.',
    },
    {
      icon: 'whatsapp',
      title: 'WhatsApp that sends itself',
      body: 'Pair your own number once by scanning a QR. Receipts with the PDF, renewal reminders before expiry and birthday wishes go out on their own.',
    },
    {
      icon: 'wallet',
      title: 'UPI straight to your account',
      body: 'Reminders carry a pay link to your own UPI ID — no gateway, no commission. The desk confirms and the membership renews from the right day.',
    },
    {
      icon: 'sparkle',
      title: 'An AI front desk, day and night',
      body: 'An optional add-on answers WhatsApp enquiries in English, Hinglish or Hindi from your real plans and timings, saves the lead and books a free trial.',
    },
    {
      icon: 'billing',
      title: 'Memberships and dues',
      body: 'Sell plans, freeze and resume them, take cash, card, UPI or bank, and see what every member owes. Renewals start the day the old plan ends.',
    },
    {
      icon: 'classes',
      title: 'Classes and equipment',
      body: 'A weekly timetable with trainers, rooms and capacity, plus an equipment register with service dates and maintenance alerts.',
    },
    {
      icon: 'smartphone',
      title: 'A member app: GymVym',
      body: 'Members see their plan, visits and invoices, pay their dues, and follow the workout and diet plans their trainer writes.',
    },
    {
      icon: 'reports',
      title: 'Numbers you can act on',
      body: 'Revenue by plan and method, attendance by hour, and members at risk — no visit in 14 days — before they quietly stop paying. Exports to CSV.',
    },
    {
      icon: 'database',
      title: 'Your data, on its own',
      body: 'Every gym gets its own separate database file — not a shared table with a filter on it — backed up daily and checked after every backup.',
    },
  ],

  demo: {
    heading: 'Take it for a spin',
    lede: 'Tap through the two things a front desk does all day. Sample data, no sign-up.',
  },

  roi: {
    heading: 'What are late renewals costing you?',
    lede: 'Move the sliders to match your gym. The estimate updates as you go.',
    unit: 'members',
    count: { min: 20, max: 1500, step: 10, value: 150 },
    fee: { min: 300, max: 6000, step: 100, value: 1200 },
  },

  compare: {
    heading: 'Register, spreadsheet or GymBook?',
    lede: 'What changes the day the register goes in a drawer.',
    columns: ['Paper register', 'Spreadsheet', 'GymBook'],
    rows: [
      ['Who expires this week', [false, 'Leaf through it'], [null, 'If the formulas hold'], [true, 'On the dashboard']],
      ['Renewal reminders', [false, 'One call at a time'], [false, 'Copy, paste, repeat'], [true, 'Sent on WhatsApp, with a pay link']],
      ['Collecting dues', [false, 'Chase at the desk'], [false, 'Chase at the desk'], [true, 'UPI to your own account']],
      ['Check-in', [null, 'A signature'], [false, 'Typed in later'], [true, 'QR, phone or fingerprint']],
      ['Who is inside right now', [false, 'No idea'], [false, 'No idea'], [true, 'Live list']],
      ['Members about to drop off', [false, 'Noticed too late'], [false, 'Noticed too late'], [true, 'Flagged after 14 quiet days']],
      ['Receipts', [null, 'Handwritten'], [false, 'None'], [true, 'PDF on WhatsApp, automatically']],
      ['Backups', [false, 'One copy, on paper'], [null, 'Whoever remembers'], [true, 'Daily, and verified']],
    ],
  },

  steps: {
    heading: 'From nothing to checking members in',
    items: [
      ['Pick your address.', ' It becomes the link your staff sign in at.'],
      ['Create the owner account.', ' You land straight in, already signed in.'],
      ['Three plans are waiting for you.', ' Edit the prices, add your members, and start scanning people in.'],
    ],
    cta: 'Create my gym',
  },

  faqHeading: 'Questions gym owners ask',
  faqs: [
    {
      q: 'Does it work with my fingerprint machine?',
      a: 'Yes, with eSSL, Realtime and ZKTeco-family terminals that support cloud (ADMS) push — it has been tested on a Realtime T-52. Point the device at your GymBook address, enter each member’s fingerprint ID once, and punches arrive as check-ins. No machine? Members can check in with a QR ID card, or with the fingerprint reader built into a phone or tablet.',
    },
    {
      q: 'Can it send WhatsApp reminders from my own number?',
      a: 'Yes. You pair your gym’s WhatsApp once by scanning a QR code — no WhatsApp Business API account needed. After that, receipts, renewal reminders, freeze notices and birthday wishes go out on their own, each from a template you can edit or switch off.',
    },
    {
      q: 'How do members pay online, and do you take a cut?',
      a: 'Members pay to your own UPI ID — from the pay link in their reminder or from the GymVym app — with any UPI app. There is no payment gateway in between and no commission: the money goes straight to your account. The desk confirms each payment, and the membership renews from the day the old one ends.',
    },
    {
      q: 'Is my gym’s data kept separate from other gyms?',
      a: 'Yes. Every gym gets its own database file, so one gym’s members can never show up in another’s. Every gym is backed up every day, and each backup is reopened and checked before it counts.',
    },
    {
      q: 'Do I need to install anything?',
      a: 'No. GymBook runs in the browser on any PC, tablet or phone, and installs like an app from the browser menu. Members use the GymVym app or the web.',
    },
    {
      q: 'Can my staff and trainers have their own logins?',
      a: 'Yes, with four roles. Admins manage staff, managers handle billing, plans and classes, and trainers and front-desk staff work with members, check-ins and bookings.',
    },
    {
      q: 'What is the AI front desk?',
      a: 'An optional add-on that answers your WhatsApp around the clock in English, Hinglish or Hindi. It quotes only your real plans and prices, saves every enquiry as a lead and books a free trial pass. When you reply yourself, it steps back in that chat.',
    },
    {
      q: 'What happens after the free trial?',
      a: `You get ${trialDays} days free, with no card needed. After that it is a single monthly subscription — there is no setup fee, and nothing is charged per member.`,
    },
  ],

  finalCta: {
    heading: 'Your next renewal reminder could send itself tonight.',
    lede: 'Set up your gym in about a minute. Bring your members over whenever you are ready.',
    button: 'Start my free trial',
  },

  footer: 'GymBook — every gym on its own database.',
});

const LIBRARY = (trialDays) => ({
  brand: 'library',
  name: 'SeatBook',
  icon: 'book',
  path: MARKETING_PATHS.library,
  title: 'Library & Study Hall Management Software | SeatBook',
  description:
    'Study hall and library management software: a live seat map by shift, fee reminders on WhatsApp, UPI payments, lockers and student records. Free trial.',
  category: 'Study hall management software',
  ogImage: '/images/og/seatbook.png',
  appleIcon: '/icons/library/apple-touch-icon.png',
  favicon: '/icons/library/favicon-32.png',

  eyebrow: 'Library & study hall software',
  headline: ['Every seat. Every shift. ', 'Accounted for.'],
  lede:
    'Run a library, study hall or reading room: a live seat map by shift, passes, lockers, fee reminders on WhatsApp and UPI payments — in one place, on any screen at the front desk.',
  proof: ['No card needed', '0% commission on UPI', 'Ready in about a minute'],
  signin: {
    placeholder: 'your-hall',
    ariaLabel: 'Your hall address',
    errorMessage: 'Enter your hall address first',
    buttonLabel: 'Go to my hall',
  },

  featuresHeading: 'Everything the front desk needs',
  featuresLede: 'Seats, passes, lockers and fees in one place — so nothing lives in a notebook.',
  features: [
    {
      icon: 'seats',
      title: 'A live seat map',
      body: 'Every desk, every shift, at a glance. Assign, transfer or release a seat in one tap — the map always matches who is actually sitting there.',
    },
    {
      icon: 'clock',
      title: 'Passes sold per shift',
      body: 'Morning, Afternoon, Evening, Night or Full Day. A desk sold for the morning is free again in the evening — and nothing can double-book it.',
    },
    {
      icon: 'whatsapp',
      title: 'Fee reminders on WhatsApp',
      body: 'Pair your own number once. Reminders before a pass runs out, receipts with the PDF and birthday wishes go out on their own.',
    },
    {
      icon: 'wallet',
      title: 'UPI straight to your account',
      body: 'Students pay from the link in their reminder to your own UPI ID — no gateway, no commission. The desk confirms, and the pass renews.',
    },
    {
      icon: 'lockers',
      title: 'Lockers, tracked like seats',
      body: 'One live allocation per locker, with fees, deposits and keys tracked — released the moment a student leaves.',
    },
    {
      icon: 'fingerprint',
      title: 'Check-in by QR or fingerprint',
      body: 'QR ID cards, phone biometrics or an eSSL / ZKTeco-family terminal at the door — so “seated now” is a count, not a guess.',
    },
    {
      icon: 'expenses',
      title: 'Expenses, not just income',
      body: 'Rent, electricity, wifi, staff — log what goes out and see collected vs. spent at a glance instead of guessing at month end.',
    },
    {
      icon: 'idCard',
      title: 'ID proof on file',
      body: 'Aadhaar, college ID, whatever you ask for — uploaded once, stored per student, and behind short-lived private links.',
    },
    {
      icon: 'database',
      title: 'Your data, on its own',
      body: 'Every hall gets its own separate database file — not a shared table with a filter on it — backed up daily and checked after every backup.',
    },
  ],

  demo: {
    heading: 'Take it for a spin',
    lede: 'Assign a seat, switch shifts, then follow a fee reminder all the way to the receipt. Sample data, no sign-up.',
  },

  roi: {
    heading: 'What are late fees costing you?',
    lede: 'Move the sliders to match your hall. The estimate updates as you go.',
    unit: 'students',
    count: { min: 10, max: 600, step: 5, value: 80 },
    fee: { min: 200, max: 4000, step: 50, value: 800 },
  },

  compare: {
    heading: 'Notebook, spreadsheet or SeatBook?',
    lede: 'What changes the day the notebook goes in a drawer.',
    columns: ['Notebook', 'Spreadsheet', 'SeatBook'],
    rows: [
      ['Which seats are free this shift', [false, 'Walk the hall'], [null, 'If it is up to date'], [true, 'Live map, per shift']],
      ['Selling one desk twice', [false, 'Happens'], [false, 'Happens'], [true, 'Blocked, with who holds it']],
      ['Fee reminders', [false, 'One call at a time'], [false, 'Copy, paste, repeat'], [true, 'Sent on WhatsApp, with a pay link']],
      ['Collecting dues', [false, 'Chase at the desk'], [false, 'Chase at the desk'], [true, 'UPI to your own account']],
      ['Lockers and keys', [null, 'A separate page'], [null, 'A separate sheet'], [true, 'Billed with the pass']],
      ['ID proof', [false, 'Photocopies in a file'], [false, 'Not kept'], [true, 'Uploaded, per student']],
      ['Collected vs. spent', [false, 'At month end, roughly'], [null, 'If someone adds it up'], [true, 'Always on the dashboard']],
      ['Backups', [false, 'One copy, on paper'], [null, 'Whoever remembers'], [true, 'Daily, and verified']],
    ],
  },

  steps: {
    heading: 'From nothing to a full hall',
    items: [
      ['Pick your address.', ' It becomes the link your staff sign in at.'],
      ['Create the owner account.', ' You land straight in, already signed in.'],
      ['Map your seats.', ' Rows, zones, aisles — set up once, then assign students shift by shift.'],
    ],
    cta: 'Create my hall',
  },

  faqHeading: 'Questions study hall owners ask',
  faqs: [
    {
      q: 'Can one seat be sold for the morning and again for the evening?',
      a: 'Yes. Every seat is booked per shift — Morning, Afternoon, Evening, Night or Full Day — so a desk sold for the morning is free again in the evening. A Full Day pass holds it for every shift, and a seat already held is refused with the name of the student holding it.',
    },
    {
      q: 'Can it send fee reminders on WhatsApp from my own number?',
      a: 'Yes. You pair your hall’s WhatsApp once by scanning a QR code — no WhatsApp Business API account needed. Reminders before a pass ends, receipts with the PDF and birthday wishes then go out on their own, each from a template you can edit or switch off.',
    },
    {
      q: 'How do students pay online, and do you take a cut?',
      a: 'Students pay to your own UPI ID, from the pay link in their reminder, with any UPI app. There is no payment gateway in between and no commission: the money goes straight to your account. The desk confirms each payment, and the pass renews.',
    },
    {
      q: 'Can I manage lockers and ID documents too?',
      a: 'Yes. Lockers are allocated like seats, with their fee, deposit and key tracked. ID proof — Aadhaar front and back, college ID or anything else — is uploaded per student and opened through private links that expire in minutes.',
    },
    {
      q: 'Is my hall’s data kept separate from everyone else’s?',
      a: 'Yes. Every hall gets its own database file, so one hall’s students can never show up in another’s. Every hall is backed up every day, and each backup is reopened and checked before it counts.',
    },
    {
      q: 'Do I need to install anything?',
      a: 'No. SeatBook runs in the browser on any PC, tablet or phone, and installs like an app from the browser menu.',
    },
    {
      q: 'What happens after the free trial?',
      a: `You get ${trialDays} days free, with no card needed. After that it is a single monthly subscription — there is no setup fee, and nothing is charged per student.`,
    },
  ],

  finalCta: {
    heading: 'Your next fee reminder could send itself tonight.',
    lede: 'Set up your hall in about a minute. Map the seats whenever you are ready.',
    button: 'Start my free trial',
  },

  footer: 'SeatBook — every seat, every shift, in one map.',
});

/** The other products, for the switcher and the footer. CoachBook has no
 * marketing page of its own yet, so it links straight into its signup. */
export const PRODUCT_LINKS = [
  { brand: 'gym', name: 'GymBook', href: MARKETING_PATHS.gym, label: 'Gyms' },
  { brand: 'library', name: 'SeatBook', href: MARKETING_PATHS.library, label: 'Study halls' },
];
export const COACHBOOK_SIGNUP = '/#/signup?type=coaching';

/**
 * Everything one marketing page says. `trialDays` comes from the server's
 * config (the browser has it as context.trial_days), so the FAQ never
 * promises a trial length the signup does not give.
 */
export function marketingContent(brand, { trialDays = 7 } = {}) {
  return brand === 'library' ? LIBRARY(trialDays) : GYM(trialDays);
}

/**
 * The ROI estimate, kept here rather than in the view so it is a pure
 * function a test can pin down. Every assumption is a named input the page
 * shows the visitor — nothing is hidden in a constant they cannot see.
 *
 * @param {object} input
 * @param {number} input.count     Active members / students.
 * @param {number} input.fee       Average monthly fee, in rupees.
 * @param {number} input.lateRate  Share who renew late or lapse in a month (0–1).
 * @param {number} input.recovery  Share of those a timely reminder brings back (0–1).
 */
export function roiEstimate({ count, fee, lateRate, recovery }) {
  const atRisk = count * fee * lateRate;
  const recovered = atRisk * recovery;
  // One renewal reminder and one receipt per person a month, at about two
  // minutes each when typed by hand.
  const messages = Math.round(count * 2);
  const hours = (messages * 2) / 60;
  return {
    atRisk: Math.round(atRisk),
    recovered: Math.round(recovered),
    yearly: Math.round(recovered * 12),
    messages,
    hours: Math.round(hours),
  };
}
