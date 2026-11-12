import { h, renderIcon } from '../ui.js';
import { sectionHead } from './landingSections.js';

/**
 * "Take it for a spin": small, working imitations of the product's busiest
 * screens, for the marketing pages. Unlike the product preview above them
 * (views/landingPreview.js), which is a picture, these respond — a visitor
 * checks a member in, follows a WhatsApp reminder through a UPI payment to the
 * receipt, or sells a desk for one shift and watches it stay free for the next.
 *
 * Everything here is local make-believe: no request leaves the page, and the
 * rules it acts out are the real ones (README.md) — a rescan checks out, an
 * expired plan is refused with what is owed, a UPI payment waits for the desk
 * to confirm it, and a seat held for one shift cannot be sold over it.
 *
 * Dates are worked out from today, so the sample never goes stale.
 */

const DAY = 24 * 60 * 60 * 1000;
const inr = (value) => `₹${new Intl.NumberFormat('en-IN').format(value)}`;
const onDay = (days) => new Date(Date.now() + days * DAY).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDay = (days) => new Date(Date.now() + days * DAY).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const later = (ms, fn) => setTimeout(fn, reduceMotion() ? 0 : ms);

/* ── The section: tabs over the demos ──────────────────────────────────── */

export function testDrive(content) {
  const demos =
    content.brand === 'library'
      ? [
          { id: 'seats', label: 'Live seat map', icon: 'seats', build: seatMapDemo },
          { id: 'pay', label: 'Reminder to receipt', icon: 'whatsapp', build: () => payDemo('library') },
        ]
      : [
          { id: 'checkin', label: 'Check-in desk', icon: 'fingerprint', build: checkinDemo },
          { id: 'pay', label: 'Reminder to receipt', icon: 'whatsapp', build: () => payDemo('gym') },
        ];

  const panels = demos.map((demo) =>
    h('div', { class: 'demo-panel', role: 'tabpanel', id: `demo-${demo.id}`, 'aria-labelledby': `demo-tab-${demo.id}` }),
  );
  const tabs = demos.map((demo, i) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `demo-tab-${demo.id}`,
        'aria-controls': `demo-${demo.id}`,
        class: 'demo-tab',
        onclick: () => select(i),
        onkeydown: (event) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
          if (!step) return;
          event.preventDefault();
          const next = (i + step + demos.length) % demos.length;
          select(next);
          tabs[next].focus();
        },
      },
      renderIcon(demo.icon, { size: 16 }),
      demo.label,
    ),
  );

  // Built on first view and kept, so switching tabs never loses progress.
  function select(index) {
    demos.forEach((demo, i) => {
      const active = i === index;
      tabs[i].setAttribute('aria-selected', String(active));
      tabs[i].tabIndex = active ? 0 : -1;
      panels[i].hidden = !active;
      if (active && !panels[i].firstChild) panels[i].append(demo.build());
    });
  }
  select(0);

  return h(
    'section',
    { class: 'landing-demo', 'aria-labelledby': 'demo-heading' },
    sectionHead(content.demo.heading, content.demo.lede, 'demo-heading'),
    h(
      'div',
      { class: 'demo-shell card' },
      h('div', { class: 'demo-tabs', role: 'tablist', 'aria-label': 'Demos' }, tabs, h('span', { class: 'preview-note' }, 'Sample data')),
      panels,
    ),
  );
}

/* ── GymBook: the check-in desk ────────────────────────────────────────── */

const MEMBERS = [
  { code: 'GM0012', name: 'Aditya Mehta', plan: 'Annual plan', daysLeft: 121, due: 0 },
  { code: 'GM0047', name: 'Kavya Shah', plan: 'Quarterly plan', daysLeft: 2, due: 0 },
  { code: 'GM0103', name: 'Rahul Rao', plan: 'Monthly plan', daysLeft: -4, due: 1500 },
];
const initialsOf = (name) => name.split(' ').map((part) => part[0]).join('');
const firstName = (name) => name.split(' ')[0];

function checkinDemo() {
  const members = MEMBERS.map((member) => ({ ...member }));
  const inside = new Set();
  let others = 14;
  let scanTurn = 0;

  const verdict = h('div', { class: 'demo-verdict', 'aria-live': 'polite' });
  const countNode = h('strong', {});
  const log = h('ul', { class: 'demo-log' });

  const showIdle = () =>
    verdict.replaceChildren(
      h('div', { class: 'demo-idle' }, renderIcon('scan', { size: 26 }), h('span', {}, 'Tap a member card, type a code, or scan a finger.')),
    );

  function logLine(text, tone) {
    log.prepend(h('li', {}, h('span', { class: `badge dot ${tone}` }, new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })), text));
    while (log.children.length > 3) log.lastChild.remove();
  }

  function refreshCount() {
    countNode.textContent = String(others + inside.size);
  }

  function result(tone, icon, title, lines, action) {
    verdict.replaceChildren(
      h(
        'div',
        { class: `demo-result ${tone}` },
        h('div', { class: 'demo-result-icon' }, renderIcon(icon, { size: 22 })),
        h('div', {}, h('strong', {}, title), ...lines.map((line) => h('p', {}, line)), action || null),
      ),
    );
  }

  function checkIn(code) {
    const member = members.find((m) => m.code === code.trim().toUpperCase());
    if (!member) {
      result('red', 'xCircle', `No member with code “${code.trim() || '—'}”`, ['Codes look like GM0012. Try one of the cards.']);
      return;
    }
    const first = firstName(member.name);

    if (inside.has(member.code)) {
      inside.delete(member.code);
      refreshCount();
      logLine(`${member.name} checked out`, 'grey');
      result('blue', 'logout', `Checked out — see you next time, ${first}`, ['A second scan the same day checks a member out.']);
      return;
    }

    if (member.daysLeft < 0) {
      const collect = h(
        'button',
        {
          type: 'button',
          class: 'btn sm primary',
          onclick: () => {
            member.daysLeft = 30;
            member.due = 0;
            member.plan = 'Monthly plan';
            inside.add(member.code);
            refreshCount();
            logLine(`${member.name} renewed and checked in`, 'green');
            result('green', 'checkCircle', `Renewed and checked in — welcome back, ${first}`, [
              `Monthly plan now runs till ${onDay(30)}.`,
              'The receipt PDF is on its way on WhatsApp.',
            ]);
          },
        },
        renderIcon('wallet', { size: 14 }),
        `Collect ${inr(member.due)} and renew`,
      );
      logLine(`${member.name} refused — plan ended`, 'red');
      result(
        'red',
        'ban',
        `Not checked in — ${first}’s plan ended ${-member.daysLeft} days ago`,
        [`${member.plan} · ${inr(member.due)} due`],
        collect,
      );
      return;
    }

    inside.add(member.code);
    refreshCount();
    if (member.daysLeft <= 7) {
      logLine(`${member.name} checked in`, 'amber');
      result('amber', 'hourglass', `Checked in — ${member.daysLeft} days left, ${first}`, [
        `${member.plan} ends on ${onDay(member.daysLeft)}.`,
        'A renewal reminder with a UPI pay link has already gone out on WhatsApp.',
      ]);
    } else {
      logLine(`${member.name} checked in`, 'green');
      result('green', 'checkCircle', `Welcome back, ${first}`, [`${member.plan} · till ${onDay(member.daysLeft)} · ${member.daysLeft} days left`]);
    }
  }

  const codeInput = h('input', {
    placeholder: 'Member code, e.g. GM0012',
    'aria-label': 'Member code',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const fingerprint = h(
    'button',
    {
      type: 'button',
      class: 'demo-finger',
      'aria-label': 'Simulate a fingerprint scan',
      onclick: () => {
        if (fingerprint.classList.contains('scanning')) return;
        fingerprint.classList.add('scanning');
        later(900, () => {
          fingerprint.classList.remove('scanning');
          checkIn(members[scanTurn++ % members.length].code);
        });
      },
    },
    renderIcon('fingerprint', { size: 30 }),
    h('span', {}, 'Scan a finger'),
  );

  showIdle();
  refreshCount();

  return h(
    'div',
    { class: 'demo-checkin' },
    h(
      'div',
      { class: 'demo-desk' },
      h(
        'form',
        {
          class: 'demo-code',
          onsubmit: (event) => {
            event.preventDefault();
            checkIn(codeInput.value);
            codeInput.value = '';
          },
        },
        codeInput,
        h('button', { class: 'btn primary', type: 'submit' }, 'Check in'),
      ),
      h('span', { class: 'demo-caption' }, 'Or tap a QR card'),
      h(
        'div',
        { class: 'demo-cards' },
        members.map((member) =>
          h(
            'button',
            { type: 'button', class: 'demo-card', onclick: () => checkIn(member.code) },
            h('span', { class: 'avatar sm' }, initialsOf(member.name)),
            h('span', {}, h('strong', {}, member.name), h('span', { class: 'muted' }, member.code)),
            renderIcon('qrCode', { size: 18, class: 'demo-card-qr' }),
          ),
        ),
      ),
      fingerprint,
    ),
    h(
      'div',
      { class: 'demo-side' },
      verdict,
      h(
        'div',
        { class: 'demo-inside' },
        h('div', { class: 'demo-inside-head' }, h('span', { class: 'demo-live-dot' }), 'In the gym now', countNode),
        log,
      ),
    ),
  );
}

/* ── Both: a WhatsApp reminder, a UPI payment, the desk, the receipt ───── */

const PAY = {
  gym: {
    org: 'FitPulse Gym',
    host: 'fitpulse.gymbook.app',
    person: 'Kavya Shah',
    plan: 'Quarterly plan',
    amount: 4500,
    upi: 'fitpulse@okhdfcbank',
    endsIn: 2,
    days: 90,
    desk: 'Billing → To confirm',
  },
  library: {
    org: 'Quiet Room Library',
    host: 'quiet-room.seatbook.app',
    person: 'Neha Verma',
    plan: 'Morning Monthly pass',
    amount: 900,
    upi: 'quietroom@okaxis',
    endsIn: 3,
    days: 30,
    desk: 'Billing → To confirm',
  },
};

const STEPS = ['Reminder sent', 'Paid by UPI', 'Desk confirms', 'Receipt sent'];

function payDemo(brand) {
  const p = PAY[brand];
  const first = firstName(p.person);
  const ref = 'GB7K4Q2M';
  const utr = '418277305521';
  const renewedTill = onDay(p.endsIn + p.days);

  const chat = h('div', { class: 'wa-chat' });
  const sheet = h('div', { class: 'wa-sheet', hidden: true });
  const desk = h('div', { class: 'demo-queue', 'aria-live': 'polite' });
  const steps = STEPS.map((label, i) => h('li', {}, h('span', { class: 'demo-step-n' }, String(i + 1)), label));
  const restart = h('button', { type: 'button', class: 'btn sm ghost', hidden: true, onclick: () => reset() }, renderIcon('refresh', { size: 14 }), 'Play again');

  const setStep = (n) =>
    steps.forEach((li, i) => {
      li.classList.toggle('done', i < n);
      li.classList.toggle('now', i === n);
    });

  const bubble = (...children) => h('div', { class: 'wa-bubble' }, ...children, h('span', { class: 'wa-time' }, new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })));

  function deskEmpty() {
    desk.replaceChildren(
      h('div', { class: 'demo-idle' }, renderIcon('inbox', { size: 22 }), h('span', {}, 'Nothing to confirm yet. Pay from the phone to see it land here.')),
    );
  }

  function sheetScreen(...children) {
    sheet.hidden = false;
    sheet.replaceChildren(h('div', { class: 'wa-sheet-card' }, ...children));
  }

  const hint = h('p', { class: 'demo-hint muted' }, 'Tap the pay button in the WhatsApp message to begin.');

  function openPay() {
    hint.hidden = true;
    sheetScreen(
      h('span', { class: 'wa-sheet-kicker' }, 'Pay online'),
      h('strong', { class: 'wa-sheet-org' }, p.org),
      h('span', { class: 'wa-sheet-amount' }, inr(p.amount)),
      h(
        'dl',
        { class: 'wa-sheet-rows' },
        h('div', {}, h('dt', {}, 'For'), h('dd', {}, `${p.plan} renewal`)),
        h('div', {}, h('dt', {}, 'To UPI ID'), h('dd', {}, p.upi)),
        h('div', {}, h('dt', {}, 'Reference'), h('dd', {}, ref)),
      ),
      h('button', { type: 'button', class: 'btn primary block', onclick: payInApp }, renderIcon('smartphone', { size: 15 }), 'Pay with any UPI app'),
      h('span', { class: 'wa-sheet-note' }, 'Straight to the owner’s bank. No gateway, no commission.'),
    );
  }

  function payInApp() {
    sheetScreen(h('div', { class: 'wa-spinner', role: 'status' }, h('span', {}), 'Opening your UPI app…'));
    later(1100, () => {
      setStep(1);
      sheetScreen(
        h('div', { class: 'wa-paid' }, renderIcon('checkCircle', { size: 34 }), h('strong', {}, `${inr(p.amount)} paid`), h('span', {}, `UTR ${utr}`)),
        h('p', { class: 'wa-sheet-note' }, 'Back on the pay page, one tap tells the desk:'),
        h('button', { type: 'button', class: 'btn primary block', onclick: claimed }, 'I’ve paid'),
      );
    });
  }

  function claimed() {
    sheet.hidden = true;
    setStep(2);
    chat.append(h('div', { class: 'wa-system' }, `Payment ${ref} sent to the desk to confirm`));
    const confirm = h('button', { type: 'button', class: 'btn sm primary', onclick: () => confirmed() }, renderIcon('check', { size: 14 }), 'Confirm');
    desk.replaceChildren(
      h(
        'div',
        { class: 'demo-claim' },
        h('span', { class: 'avatar sm' }, initialsOf(p.person)),
        h('div', {}, h('strong', {}, p.person), h('span', { class: 'muted' }, `${p.plan} · ${inr(p.amount)} · UTR ${utr}`)),
        confirm,
      ),
    );
    confirm.focus({ preventScroll: true });
  }

  function confirmed() {
    setStep(3);
    desk.replaceChildren(
      h(
        'div',
        { class: 'demo-result green' },
        h('div', { class: 'demo-result-icon' }, renderIcon('checkCircle', { size: 22 })),
        h('div', {}, h('strong', {}, `Renewed — ${p.person}`), h('p', {}, `${p.plan} now runs till ${renewedTill}, starting the day the old one ends.`)),
      ),
    );
    later(600, () => {
      setStep(4);
      chat.append(
        bubble(
          h('p', {}, `Payment received — ${inr(p.amount)}. Thank you, ${first}! Your ${p.plan} now runs till ${renewedTill}.`),
          h('span', { class: 'wa-file' }, renderIcon('fileText', { size: 16 }), `Receipt-${ref}.pdf`),
        ),
      );
      chat.scrollTop = chat.scrollHeight;
      restart.hidden = false;
    });
  }

  function reset() {
    restart.hidden = true;
    hint.hidden = false;
    sheet.hidden = true;
    setStep(0);
    deskEmpty();
    chat.replaceChildren(
      h('div', { class: 'wa-system' }, 'Today'),
      bubble(
        h('p', {}, `Hi ${first}, your ${p.plan} at ${p.org} ends on ${shortDay(p.endsIn)}. Renew in a few taps — no queue at the desk:`),
        h('button', { type: 'button', class: 'wa-link', onclick: openPay }, `Pay ${inr(p.amount)}`, renderIcon('arrowRight', { size: 14 })),
        h('span', { class: 'wa-url' }, `${p.host}/pay`),
      ),
    );
  }
  reset();

  return h(
    'div',
    { class: 'demo-pay' },
    h(
      'div',
      { class: 'wa-phone' },
      h(
        'div',
        { class: 'wa-head' },
        h('span', { class: 'avatar sm' }, initialsOf(p.org)),
        h('span', {}, h('strong', {}, p.org), h('span', {}, 'WhatsApp')),
      ),
      chat,
      sheet,
    ),
    h(
      'div',
      { class: 'demo-side' },
      h('ol', { class: 'demo-steps' }, steps),
      h('div', { class: 'demo-queue-head' }, renderIcon('billing', { size: 15 }), p.desk),
      desk,
      hint,
      restart,
    ),
  );
}

/* ── SeatBook: the live seat map ───────────────────────────────────────── */

const SHIFTS = ['Morning', 'Evening', 'Full day'];
const ROWS = ['A', 'B', 'C', 'D'];
const COLS = 8;
/** Per seat: m = held for the morning, e = the evening, b = both (by two
 * students), f = a full-day pass, . = free. Fixed, so every visit matches. */
const PATTERN = 'mfe.bmm.f.mbe.fm.emm.bf.mb.fem.e';
const HOLDERS = ['Priya S.', 'Rohan K.', 'Ishita M.', 'Arjun P.', 'Sneha D.', 'Kabir N.', 'Ananya R.', 'Vivek T.', 'Meera J.'];
const NEWCOMERS = ['Aarav G.', 'Diya B.', 'Kunal V.', 'Tanya L.', 'Nikhil S.', 'Pooja A.'];

function seatMapDemo() {
  let shift = 'Morning';
  let turn = 0;
  let newcomer = 0;
  const seats = [];
  ROWS.forEach((row, r) =>
    Array.from({ length: COLS }, (_, c) => {
      const code = PATTERN[r * COLS + c];
      const take = () => HOLDERS[turn++ % HOLDERS.length];
      const held = {};
      if (code === 'm' || code === 'b') held.Morning = { name: take() };
      if (code === 'e' || code === 'b') held.Evening = { name: take() };
      if (code === 'f') held['Full day'] = { name: take() };
      seats.push({ id: `${row}${c + 1}`, held });
    }),
  );

  /** Who blocks this seat for `shift`: a full-day pass blocks every shift, and
   * a full day cannot be sold over any one shift that is taken. */
  const holderFor = (seat, which) =>
    which === 'Full day'
      ? (seat.held['Full day'] ?? seat.held.Morning ?? seat.held.Evening)
      : (seat.held[which] ?? seat.held['Full day']);
  const shiftOf = (seat, holder) => Object.keys(seat.held).find((key) => seat.held[key] === holder);

  const message = h('div', { class: 'demo-seat-msg', 'aria-live': 'polite' });
  const freeCount = h('strong', {});
  const grid = h('div', { class: 'demo-seats', role: 'group', 'aria-label': 'Seat map' });

  const say = (tone, icon, text) =>
    message.replaceChildren(h('div', { class: `demo-result ${tone}` }, h('div', { class: 'demo-result-icon' }, renderIcon(icon, { size: 20 })), h('p', {}, text)));

  function draw() {
    let free = 0;
    grid.replaceChildren(
      ...ROWS.map((row) =>
        h(
          'div',
          { class: 'demo-seat-row' },
          h('span', { class: 'demo-row-label', 'aria-hidden': 'true' }, row),
          seats
            .filter((seat) => seat.id.startsWith(row))
            .map((seat, c) => {
              const holder = holderFor(seat, shift);
              if (!holder) free += 1;
              const state = !holder ? 'free' : holder.mine ? 'mine' : 'taken';
              return h(
                'button',
                {
                  type: 'button',
                  class: `demo-seat ${state}${c === COLS / 2 ? ' aisle' : ''}`,
                  'aria-label': `${seat.id}, ${state === 'free' ? 'free' : `held by ${holder.name}`}`,
                  onclick: () => pick(seat),
                },
                seat.id,
              );
            }),
        ),
      ),
    );
    freeCount.textContent = `${free} of ${seats.length}`;
    shiftButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.shift === shift)));
  }

  function pick(seat) {
    const holder = holderFor(seat, shift);
    if (holder) {
      const heldFor = shiftOf(seat, holder);
      if (heldFor !== shift) {
        say('amber', 'ban', `${seat.id} can’t be sold for the ${shift.toLowerCase()} — ${holder.name} holds it for the ${heldFor.toLowerCase()} shift. Nothing double-books.`);
      } else {
        say('blue', 'user', `${seat.id} · ${shift}: ${holder.name}${holder.mine ? ', assigned just now' : ''}. Pass runs till ${onDay(holder.mine ? 30 : 12)}.`);
      }
      return;
    }
    const name = NEWCOMERS[newcomer++ % NEWCOMERS.length];
    seat.held[shift] = { name, mine: true };
    const freeLater =
      shift === 'Full day' ? 'It is held for every shift.' : `It is still free for the ${shift === 'Morning' ? 'evening' : 'morning'} — switch shifts to see.`;
    say('green', 'checkCircle', `${seat.id} assigned to ${name} for the ${shift.toLowerCase()}. ${freeLater}`);
    draw();
  }

  const shiftButtons = SHIFTS.map((name) =>
    h(
      'button',
      {
        type: 'button',
        class: 'demo-shift',
        dataset: { shift: name },
        onclick: () => {
          shift = name;
          draw();
        },
      },
      name,
    ),
  );

  draw();
  message.replaceChildren(
    h('div', { class: 'demo-idle' }, renderIcon('seats', { size: 22 }), h('span', {}, 'Tap a free seat to sell it for this shift, or a taken one to see who holds it.')),
  );

  return h(
    'div',
    { class: 'demo-seatmap' },
    h(
      'div',
      { class: 'demo-seat-bar' },
      h('div', { class: 'demo-shifts', role: 'group', 'aria-label': 'Shift' }, shiftButtons),
      h('span', { class: 'muted' }, freeCount, ' seats free'),
    ),
    grid,
    h(
      'div',
      { class: 'demo-legend muted', 'aria-hidden': 'true' },
      h('span', {}, h('i', { class: 'free' }), 'Free'),
      h('span', {}, h('i', { class: 'taken' }), 'Taken this shift'),
      h('span', {}, h('i', { class: 'mine' }), 'Just assigned'),
    ),
    message,
  );
}
