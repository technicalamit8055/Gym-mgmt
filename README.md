# GymBook — Gym Management Software

A complete gym management system in the spirit of GymBook: members and their
memberships, billing and dues, front-desk check-ins, class timetables and
bookings, trainers, equipment maintenance, and the reports that tie it together.

Runs on Node.js with SQLite. No build step, no native modules, one dependency
(Express) — clone, install, seed, open.

![Dashboard](docs/dashboard.png)

## Quick start

```bash
npm install
npm run seed     # optional: 68 demo members, a year of history
npm start        # http://localhost:3000
```

The first run creates an admin account and prints the credentials
(`admin@gymbook.local` / `admin12345` unless you set `ADMIN_EMAIL` and
`ADMIN_PASSWORD`). Change the password from the sidebar once you are in.

After seeding, these demo logins also work — all with the password `demo12345`:

| Login | Role | Can do |
| --- | --- | --- |
| `priyanka@gymbook.local` | manager | Everything except staff accounts |
| `dinesh@gymbook.local` | trainer | Members, check-ins, classes |
| `desk@gymbook.local` | front desk | Members, check-ins, classes |

## What it does

**Members** — searchable, filterable roster with member codes (`GM0001`),
contact and emergency details, health notes for trainers, join date and status.
Filter by membership state (active, expiring within 7 days, expired, has dues,
never subscribed) and sort by name, join date, expiry or outstanding balance.
Each member gets a profile with membership history, payments, visits, class
bookings, total dues and visit counts.

**Plans and memberships** — define plans by price, duration and optional session
limit (e.g. "Personal Training — 12"). Selling a membership derives the end date
from the plan and can collect payment in the same step. Renewals start the day
after the current membership ends, so nobody loses days they paid for; a queued
renewal is shown on the member's card. Memberships can be frozen and resumed —
resuming credits back every day the membership sat frozen. Cancelling keeps the
payment history intact.

**Billing** — record payments against a membership or standalone, in cash, card,
UPI, bank transfer or online. Dues are derived, never stored: what was billed
across non-cancelled memberships minus what was collected. The billing view
totals contract value, collected and outstanding for whatever you filter to, and
offers a one-click Collect on anything unpaid.

**Check-in desk** — type or scan a member code and press enter. The desk gets an
immediate verdict: welcome with the expiry date and remaining sessions, or a
refusal that says why (no active membership, frozen, sessions used up). Session
plans decrement on check-in. Repeat scans the same day are recognised rather than
duplicated. Live list of who is in the gym, with check-out.

**Classes** — weekly timetable with trainers, rooms, capacity and live seat
counts. Book members into a class; the server enforces capacity, the right
weekday and no double-booking, and lets a cancelled seat be re-booked. Mark
rosters as attended or no-show.

**Equipment** — inventory with categories, serial numbers, purchase cost and
service dates. Send an item to maintenance and mark it serviced in one click;
the next service date rolls forward automatically. Overdue services surface on
the dashboard.

**Staff** — accounts with four roles. Admins manage staff and can delete
records; managers handle billing, plans, classes and equipment; trainers and
front-desk staff work with members, check-ins and bookings.

**Reports** — revenue by month or day, split by payment method and by plan;
check-ins per day, per hour and per weekday; most regular members; members at
risk (no visit in 14 days); new members per month; memberships sold versus
lapsed. Everything exports to CSV: members, payments, attendance, memberships.

**Dashboard** — active members, revenue this month against last, who is in the
gym right now, renewals due, unpaid dues, plan mix, upcoming birthdays and
equipment needing attention.

## Configuration

All optional — sensible defaults apply.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/gym.db` | SQLite database location |
| `AUTH_SECRET` | dev value | Token signing key — **set this in production** |
| `TOKEN_TTL` | `43200` | Session length in seconds |
| `CURRENCY` | `INR` | Currency for all money formatting |
| `GYM_NAME` | `GymBook` | Name shown in the UI |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | First-run admin account |

## Layout

```
src/
  server.js        entry point
  app.js           express app and route mounting
  config.js        environment configuration
  db.js            schema and query helpers (node:sqlite)
  auth.js          scrypt hashing, signed tokens, role guards
  validate.js      request validation and date helpers
  maintenance.js   expires memberships past their end date
  bootstrap.js     first-run admin account
  routes/          auth, members, plans, subscriptions, payments,
                   attendance, classes, equipment, dashboard, reports
public/
  index.html       single page app shell
  css/app.css      dark theme
  js/api.js        typed API client and session storage
  js/ui.js         DOM helpers, formatting, tables, modals, SVG charts
  js/app.js        router and layout
  js/views/        one module per screen
scripts/seed.js    demo data
tests/api.test.js  API test suite
```

## Testing

```bash
npm test
```

31 tests over a throwaway database cover authentication and token tampering,
validation, member codes and duplicate detection, membership end-date maths,
overlap rejection, renewal start dates, dues, check-in rules and idempotency,
freeze/resume day credits, class capacity and weekday enforcement, role
permissions, dashboard aggregates and CSV export.

## Notes on the design

- **Dues are computed, not stored.** Balances are always derived from
  memberships and payments, so a corrected payment immediately corrects the
  balance and no reconciliation job is needed.
- **Membership expiry is lazy.** Rather than run a scheduler, any read that
  reports on membership state first flips memberships past their end date to
  expired. Cheap, and the numbers can never be stale.
- **Plans in use are archived, not deleted**, so historical memberships keep
  pointing at a real plan.
- **`node:sqlite` and Express only.** No ORM, no bundler, no CSS framework, no
  native compilation — `npm install` is fast and the app runs anywhere Node 22.5+
  does.
