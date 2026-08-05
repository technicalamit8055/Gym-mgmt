/**
 * Fills the database with a believable gym so the dashboard and reports have
 * something to show. Safe to re-run: it clears the demo tables first.
 */
import { hashPassword } from '../src/auth.js';
import { ensureAdminAccount } from '../src/bootstrap.js';
import { closeDb, getDb, run, get } from '../src/db.js';
import { addDays, today } from '../src/validate.js';

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Rohan', 'Meera', 'Kabir', 'Ananya', 'Vikram', 'Sara', 'Arjun', 'Nisha',
  'Dev', 'Priya', 'Karan', 'Tara', 'Imran', 'Leela', 'Nikhil', 'Zoya', 'Manav', 'Ira',
  'Farhan', 'Rhea', 'Sahil', 'Anika', 'Yash', 'Kavya', 'Omar', 'Neha', 'Raghav', 'Simran',
  'Aditya', 'Pooja', 'Sameer', 'Divya', 'Harsh', 'Isha', 'Varun', 'Sneha', 'Rahul', 'Aisha',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Iyer', 'Khan', 'Nair', 'Reddy', 'Gupta', 'Desai', 'Bose', 'Mehta',
  'Chopra', 'Joshi', 'Rao', 'Malhotra', 'Sethi', 'Verma', 'Kapoor', 'Banerjee', 'Menon', 'Shah',
];

// Deterministic pseudo-randomness keeps repeated seeds comparable.
let seedState = 987_654_321;
const rand = () => {
  seedState = (seedState * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seedState / 2_147_483_648;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

const db = getDb();
ensureAdminAccount();

console.log('Clearing existing demo data…');
db.exec('PRAGMA foreign_keys = OFF');
for (const table of ['bookings', 'attendance', 'payments', 'subscriptions', 'classes', 'equipment', 'members', 'plans']) {
  db.exec(`DELETE FROM ${table}`);
}
db.exec("DELETE FROM users WHERE role != 'admin'");
db.exec('PRAGMA foreign_keys = ON');

/* ------------------------------------------------------------------- staff */

const staff = [
  ['Priyanka Rao', 'priyanka@gymbook.local', 'manager'],
  ['Dinesh Kumar', 'dinesh@gymbook.local', 'trainer'],
  ['Sana Qureshi', 'sana@gymbook.local', 'trainer'],
  ['Alex Fernandes', 'alex@gymbook.local', 'trainer'],
  ['Front Desk', 'desk@gymbook.local', 'staff'],
];
const staffIds = staff.map(([name, email, role]) =>
  Number(
    run('INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)', [
      name,
      email,
      hashPassword('demo12345'),
      role,
      `98${int(10_000_000, 99_999_999)}`,
    ]).lastInsertRowid,
  ),
);
const trainerIds = staffIds.slice(1, 4);

/* ------------------------------------------------------------------- plans */

const planSpecs = [
  ['Monthly Gym', 'Full gym floor access, one month.', 1500, 30, null],
  ['Quarterly Gym', 'Three months of gym floor access at a discount.', 4000, 90, null],
  ['Half Yearly Gym', 'Six months, best value for regulars.', 7500, 180, null],
  ['Annual Gym', 'Twelve months plus a free fitness assessment.', 13_500, 365, null],
  ['Personal Training — 12', '12 one-on-one sessions with a certified trainer.', 9000, 90, 12],
  ['Group Classes', 'Unlimited yoga, zumba and HIIT classes.', 2200, 30, null],
  ['Student Monthly', 'Discounted monthly plan, valid student ID required.', 1100, 30, null],
];
const planIds = planSpecs.map(([name, description, price, days, sessions]) =>
  Number(
    run(
      'INSERT INTO plans (name, description, price, duration_days, sessions) VALUES (?, ?, ?, ?, ?)',
      [name, description, price, days, sessions],
    ).lastInsertRowid,
  ),
);

/* ----------------------------------------------------------------- members */

const MEMBER_COUNT = 68;
const memberIds = [];

for (let i = 0; i < MEMBER_COUNT; i += 1) {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const joinedOn = addDays(today(), -int(1, 500));
  const code = `GM${String(i + 1).padStart(4, '0')}`;

  const id = Number(
    run(
      `INSERT INTO members
        (code, first_name, last_name, email, phone, gender, date_of_birth, address,
         emergency_contact, emergency_phone, health_notes, joined_on, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        first,
        last,
        `${first}.${last}${i}@example.com`.toLowerCase(),
        `9${int(100_000_000, 999_999_999)}`,
        pick(['male', 'female', 'other']),
        `19${int(70, 99)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
        `${int(1, 200)} ${pick(['MG Road', 'Park Street', 'Lake View', 'Hill Colony', 'Sector 7'])}`,
        `${pick(FIRST_NAMES)} ${last}`,
        `9${int(100_000_000, 999_999_999)}`,
        rand() < 0.2 ? pick(['Knee injury — avoid deep squats', 'Asthma', 'High blood pressure', 'Lower back pain']) : null,
        joinedOn,
        rand() < 0.08 ? 'inactive' : rand() < 0.05 ? 'frozen' : 'active',
      ],
    ).lastInsertRowid,
  );
  memberIds.push({ id, joinedOn, first });
}

/* ----------------------------------------- memberships, payments and visits */

let subscriptionCount = 0;
let paymentCount = 0;
let visitCount = 0;

for (const member of memberIds) {
  const planIndex = int(0, planIds.length - 1);
  const [, , price, durationDays, sessions] = planSpecs[planIndex];
  const historyLength = int(1, 4);
  // Most members are current; the rest have lapsed and are waiting to be won back.
  const stillMember = member.status !== 'inactive' && rand() < 0.82;
  let cursor = member.joinedOn;

  for (let n = 0; n < historyLength; n += 1) {
    // Line the final renewal up so it still covers today for current members.
    if (stillMember && n === historyLength - 1) {
      cursor = addDays(today(), -int(0, durationDays - 1));
    }
    const endDate = addDays(cursor, durationDays - 1);
    const discount = rand() < 0.2 ? [100, 200, 500][int(0, 2)] : 0;
    const expired = endDate < today();

    const subId = Number(
      run(
        `INSERT INTO subscriptions
          (member_id, plan_id, start_date, end_date, price, discount, sessions_total, sessions_used, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          member.id,
          planIds[planIndex],
          cursor,
          endDate,
          price,
          discount,
          sessions,
          sessions ? int(0, sessions) : 0,
          expired ? 'expired' : member.status === 'frozen' ? 'frozen' : 'active',
        ],
      ).lastInsertRowid,
    );
    subscriptionCount += 1;

    // Most memberships are paid in full; a few carry a balance.
    const payable = price - discount;
    const paid = rand() < 0.85 ? payable : Math.round(payable * 0.5);
    run(
      'INSERT INTO payments (member_id, subscription_id, amount, method, paid_on, reference) VALUES (?, ?, ?, ?, ?, ?)',
      [
        member.id,
        subId,
        paid,
        pick(['cash', 'card', 'upi', 'upi', 'bank', 'online']),
        cursor,
        `RCPT-${String(subId).padStart(5, '0')}`,
      ],
    );
    paymentCount += 1;

    if (!expired) break;
    cursor = addDays(endDate, int(1, 20));
    if (cursor > today() && !stillMember) break;
  }

  // Visit history for the last 60 days, weighted by how regular the member is.
  const regularity = rand();
  for (let day = 60; day >= 0; day -= 1) {
    if (rand() > regularity * 0.55) continue;
    const date = addDays(today(), -day);
    const hour = rand() < 0.45 ? int(6, 9) : int(17, 21);
    const minute = int(0, 59);
    const checkIn = `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const stay = int(40, 100);
    const checkOutHour = hour + Math.floor((minute + stay) / 60);
    const checkOut =
      day === 0 && rand() < 0.4
        ? null
        : `${date} ${String(Math.min(checkOutHour, 23)).padStart(2, '0')}:${String((minute + stay) % 60).padStart(2, '0')}:00`;

    run('INSERT INTO attendance (member_id, check_in, check_out, source) VALUES (?, ?, ?, ?)', [
      member.id,
      checkIn,
      checkOut,
      pick(['desk', 'desk', 'kiosk', 'app']),
    ]);
    visitCount += 1;
  }
}

/* --------------------------------------------------------- classes/bookings */

const classSpecs = [
  ['Sunrise Yoga', 'Gentle flow to start the day.', 1, '06:30', 60, 18, 'Studio A'],
  ['HIIT Blast', '45 minutes of high intensity intervals.', 1, '18:30', 45, 16, 'Studio B'],
  ['Zumba', 'Dance cardio, no experience needed.', 2, '19:00', 60, 24, 'Studio A'],
  ['Strength Basics', 'Barbell technique for beginners.', 3, '07:00', 60, 12, 'Weight Floor'],
  ['Spin Class', 'Indoor cycling with music.', 3, '18:00', 45, 20, 'Spin Room'],
  ['Power Yoga', 'Strength-focused vinyasa.', 4, '06:30', 60, 18, 'Studio A'],
  ['Core & Mobility', 'Abs, hips and shoulders.', 5, '18:30', 45, 20, 'Studio B'],
  ['Weekend Bootcamp', 'Outdoor circuit training.', 6, '08:00', 75, 25, 'Terrace'],
];
const classIds = classSpecs.map(([name, description, weekday, start, duration, capacity, room], i) =>
  Number(
    run(
      `INSERT INTO classes (name, description, trainer_id, weekday, start_time, duration_min, capacity, room)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, description, trainerIds[i % trainerIds.length], weekday, start, duration, capacity, room],
    ).lastInsertRowid,
  ),
);

let bookingCount = 0;
const activeMembers = memberIds.filter(() => rand() < 0.6);
for (let offset = -14; offset <= 7; offset += 1) {
  const date = addDays(today(), offset);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  classSpecs.forEach((spec, i) => {
    if (spec[2] !== weekday) return;
    const attendees = int(3, Math.min(spec[5], 14));
    const seen = new Set();
    for (let n = 0; n < attendees; n += 1) {
      const member = pick(activeMembers.length ? activeMembers : memberIds);
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      const status = offset < 0 ? pick(['attended', 'attended', 'attended', 'no_show']) : 'booked';
      run('INSERT OR IGNORE INTO bookings (class_id, member_id, class_date, status) VALUES (?, ?, ?, ?)', [
        classIds[i],
        member.id,
        date,
        status,
      ]);
      bookingCount += 1;
    }
  });
}

/* --------------------------------------------------------------- equipment */

const equipmentSpecs = [
  ['Treadmill', 'Cardio', 6, 185_000, 'operational'],
  ['Elliptical Trainer', 'Cardio', 3, 120_000, 'operational'],
  ['Rowing Machine', 'Cardio', 2, 95_000, 'maintenance'],
  ['Spin Bike', 'Cardio', 12, 45_000, 'operational'],
  ['Olympic Barbell', 'Free Weights', 8, 12_000, 'operational'],
  ['Dumbbell Set 1–30kg', 'Free Weights', 2, 160_000, 'operational'],
  ['Squat Rack', 'Free Weights', 4, 75_000, 'operational'],
  ['Bench Press', 'Free Weights', 3, 38_000, 'operational'],
  ['Lat Pulldown', 'Machines', 2, 68_000, 'operational'],
  ['Leg Press', 'Machines', 1, 145_000, 'maintenance'],
  ['Cable Crossover', 'Machines', 1, 195_000, 'operational'],
  ['Yoga Mats', 'Studio', 30, 900, 'operational'],
  ['Kettlebell Set', 'Studio', 2, 22_000, 'operational'],
  ['Battle Ropes', 'Functional', 2, 8500, 'retired'],
];
for (const [name, category, quantity, cost, status] of equipmentSpecs) {
  const lastService = addDays(today(), -int(10, 200));
  run(
    `INSERT INTO equipment (name, category, serial_no, quantity, purchased_on, cost, status, last_service_on, next_service_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      category,
      `SN-${int(100_000, 999_999)}`,
      quantity,
      addDays(today(), -int(200, 1400)),
      cost,
      status,
      lastService,
      addDays(lastService, 180),
    ],
  );
}

run("UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND end_date < date('now')");

const admin = get("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
console.log(`
Seeded:
  ${MEMBER_COUNT} members
  ${planIds.length} plans
  ${subscriptionCount} memberships
  ${paymentCount} payments
  ${visitCount} gym visits
  ${classIds.length} classes, ${bookingCount} bookings
  ${equipmentSpecs.length} equipment records
  ${staff.length + 1} staff accounts

Sign in as ${admin.email} (password: the one printed on first run, default "admin12345").
Staff demo logins use the password "demo12345".
`);

closeDb();
