import { ApiError, api, memberSession } from '../api.js';
import {
  addDays,
  append,
  buildForm,
  clear,
  closeModal,
  date,
  h,
  initials,
  money,
  openModal,
  renderIcon,
  statusBadge,
  svg,
  time,
  toast,
  today,
} from '../ui.js';
import { onInstallChange, promptInstall } from '../pwa.js';
import { getAppMode, isLibrary, t, toggleAppMode } from '../vertical.js';

/**
 * The member/student self-service app: a phone-first mini-app a member signs
 * into directly (see api.portal.* and requireMemberAuth on the server), not
 * the staff console. Tab switching is plain in-memory state, not the hash
 * router — a bottom tab bar behaves like a native app's, not like five more
 * routes — so the whole shell is one view that manages its own repaints.
 */

/** Set right after a bootstrap-PIN login, consumed once by the Profile tab to
 * nudge the member into setting a real PIN. Module-level because the login
 * view and the app shell are two separate calls into this module with no
 * other channel between them. */
let pendingPinPrompt = false;

const gymDisplayName = (ctx) => ctx.context?.tenant?.gym_name || (isLibrary() ? 'SeatBook' : 'GymBook');

function dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return { weekday: d.toLocaleDateString(undefined, { weekday: 'short' }), day: d.getDate() };
}

function progressRing(pct, { size = 76, stroke = 7 } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  return h(
    'div',
    { class: 'portal-hero-ring-wrap' },
    svg(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
      svg('circle', { class: 'portal-ring-track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, fill: 'none' }),
      svg('circle', {
        class: 'portal-ring-fill',
        cx: size / 2,
        cy: size / 2,
        r,
        'stroke-width': stroke,
        fill: 'none',
        'stroke-dasharray': c.toFixed(2),
        'stroke-dashoffset': (c * (1 - clamped)).toFixed(2),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
  );
}

function quickAction(icon, label, onclick) {
  return h(
    'button',
    { class: 'portal-quick-btn', type: 'button', onclick },
    h('div', { class: 'portal-quick-icon' }, renderIcon(icon, { size: 20 })),
    h('span', {}, label),
  );
}

function miniStat(icon, value, label) {
  return h(
    'div',
    { class: 'portal-mini-stat' },
    h('div', { class: 'portal-mini-stat-icon' }, renderIcon(icon, { size: 16 })),
    h('div', { class: 'portal-mini-stat-value' }, String(value ?? 0)),
    h('div', { class: 'portal-mini-stat-label' }, label),
  );
}

function profileRow(label, value) {
  if (!value) return null;
  return h('div', { class: 'portal-profile-row' }, h('span', { class: 'muted' }, label), h('span', {}, value));
}

function seatCard(s) {
  return h(
    'div',
    { class: 'portal-seat-card' },
    h('div', { class: 'portal-seat-code' }, s.seat_code),
    h(
      'div',
      { class: 'portal-seat-meta' },
      h('div', {}, [s.zone_name, s.row_label ? `Row ${s.row_label}` : null].filter(Boolean).join(' · ') || 'Unzoned'),
      h('div', { class: 'muted' }, `${s.session_name} · ${time(s.start_time)} – ${time(s.end_time)}`),
    ),
    h('div', { class: 'portal-seat-until' }, `Until ${date(s.end_date)}`),
  );
}

function classCard(c, { onBook, onCancel } = {}) {
  const full = c.seats_left <= 0 && !c.my_booking_id;
  return h(
    'div',
    { class: 'portal-class-card' },
    h('div', { class: 'portal-class-time' }, time(c.start_time)),
    h(
      'div',
      { class: 'portal-class-meta' },
      h('div', { class: 'portal-class-name' }, c.name),
      h('div', { class: 'muted' }, [c.trainer_name, c.room].filter(Boolean).join(' · ') || `${c.duration_min} min`),
      h('div', { class: `portal-class-capacity${full ? ' full' : ''}` }, full ? 'Full' : `${c.seats_left} spots left`),
    ),
    onBook
      ? c.my_booking_id
        ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => onCancel(c) }, 'Cancel')
        : h('button', { class: 'btn sm primary', type: 'button', disabled: full, onclick: () => onBook(c) }, 'Book')
      : c.my_booking_id
        ? h('span', { class: 'badge green' }, 'Booked')
        : null,
  );
}

function openFullscreenPass(pass, member) {
  let overlay;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  overlay = h(
    'div',
    { class: 'portal-pass-fullscreen', onclick: (event) => { if (event.target === overlay) close(); } },
    h('button', { class: 'portal-pass-fullscreen-close', type: 'button', onclick: close, 'aria-label': 'Close' }, renderIcon('close', { size: 22 })),
    h('div', { class: 'portal-pass-fullscreen-qr', html: pass.svg }),
    h('div', { class: 'portal-pass-fullscreen-name' }, `${member.first_name} ${member.last_name || ''}`.trim()),
    h('div', { class: 'portal-pass-fullscreen-code' }, member.code),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
}

function openSupportModal() {
  openModal({
    title: 'Need help?',
    body: h(
      'div',
      { class: 'portal-support-body' },
      h(
        'p',
        {},
        `For membership questions, payments or anything else, reach out to the ${isLibrary() ? 'hall' : 'gym'} front desk directly — they can see your account and sort it out on the spot.`,
      ),
      h('p', { class: 'muted' }, 'You can also change your PIN from the Profile tab.'),
    ),
  });
}

/* ------------------------------------------------------------------ login */

function renderPortalLogin(ctx) {
  const gymName = gymDisplayName(ctx);
  const logoUrl = ctx.context?.tenant?.logo_url;
  const memberWord = isLibrary() ? 'student' : 'member';

  let step = 'identifier';
  let identifier = '';
  let pin = '';
  let busy = false;
  let error = '';

  const card = h('div', { class: 'portal-login-card' });

  function paintIdentifier() {
    clear(card);
    const input = h('input', {
      class: 'portal-input',
      type: 'text',
      autocapitalize: 'none',
      autocorrect: 'off',
      placeholder: isLibrary() ? 'Student ID or phone number' : 'Member ID or phone number',
      value: identifier,
    });
    input.addEventListener('input', (event) => { identifier = event.target.value; });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        goPin();
      }
    });

    append(card, [
      h('h1', { class: 'portal-login-title' }, 'Welcome back'),
      h('p', { class: 'portal-login-sub' }, `Sign in with your ${memberWord} ID or phone number.`),
      h('label', { class: 'portal-field' }, input),
      error ? h('p', { class: 'portal-login-error' }, error) : null,
      h('button', { class: 'btn primary block', type: 'button', onclick: goPin }, 'Continue'),
      h('p', { class: 'portal-login-foot' }, h('a', { href: '#/' }, '← Back to the site')),
    ]);
    input.focus();
  }

  function goPin() {
    error = '';
    if (!identifier.trim()) {
      error = `Enter your ${memberWord} ID or phone number`;
      paintIdentifier();
      return;
    }
    step = 'pin';
    pin = '';
    paintPin();
  }

  function paintPin() {
    clear(card);
    const dots = h(
      'div',
      { class: 'portal-pin-dots' },
      ...Array.from({ length: 6 }, (_, i) => h('span', { class: `portal-pin-dot${i < pin.length ? ' filled' : ''}` })),
    );
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];
    const keypad = h(
      'div',
      { class: 'portal-keypad' },
      ...keys.map((k) => {
        if (k === '') return h('span', { class: 'portal-key portal-key-empty' });
        if (k === 'back') {
          return h(
            'button',
            {
              class: 'portal-key portal-key-action',
              type: 'button',
              'aria-label': 'Delete digit',
              onclick: () => { pin = pin.slice(0, -1); paintPin(); },
            },
            renderIcon('close', { size: 18 }),
          );
        }
        return h(
          'button',
          {
            class: 'portal-key',
            type: 'button',
            onclick: () => {
              if (pin.length < 6) pin += k;
              paintPin();
            },
          },
          k,
        );
      }),
    );

    append(card, [
      h('button', { class: 'portal-back-link', type: 'button', onclick: () => { step = 'identifier'; error = ''; paintIdentifier(); } }, '‹ Back'),
      h('h1', { class: 'portal-login-title' }, 'Enter your PIN'),
      h('p', { class: 'portal-login-sub' }, 'First time here? Use the last 4 digits of your phone number.'),
      dots,
      error ? h('p', { class: 'portal-login-error' }, error) : null,
      keypad,
      h(
        'button',
        { class: 'btn primary block', type: 'button', disabled: pin.length < 4 || busy, onclick: submit },
        busy ? 'Signing in…' : 'Sign in',
      ),
    ]);
  }

  async function submit() {
    if (pin.length < 4 || busy) return;
    busy = true;
    error = '';
    paintPin();
    try {
      const res = await api.portal.login(identifier.trim(), pin);
      memberSession.save(res.token, res.member);
      pendingPinPrompt = Boolean(res.must_set_pin);
      toast(`Welcome, ${res.member.first_name}`);
      await ctx.rerender();
    } catch (err) {
      busy = false;
      error = err.message || 'Could not sign in';
      pin = '';
      paintPin();
    }
  }

  paintIdentifier();

  return h(
    'div',
    { class: 'portal-login' },
    h(
      'div',
      { class: 'portal-login-brand' },
      logoUrl
        ? h('img', { class: 'portal-login-logo-img', src: logoUrl, alt: gymName })
        : h('div', { class: 'portal-login-logo' }, renderIcon(isLibrary() ? 'book' : 'dumbbell', { size: 26 })),
      h('div', { class: 'portal-login-gymname' }, gymName),
    ),
    card,
  );
}

/* -------------------------------------------------------------------- app */

const TABS = [
  { key: 'home', label: 'Home', icon: 'dashboard' },
  { key: 'pass', label: 'Pass', icon: 'idCard' },
  { key: 'schedule', label: isLibrary() ? 'Shift' : 'Schedule', icon: isLibrary() ? 'seats' : 'classes' },
  { key: 'pay', label: 'Pay', icon: 'billing' },
  { key: 'profile', label: 'Profile', icon: 'member' },
];

function renderPortalApp(ctx, initialMe) {
  let me = initialMe;
  let active = 'home';
  let tickInterval = null;
  let unsubscribeInstall;

  const stopTicking = () => {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  };
  // Tab switches never change the hash (see the module header), so the only
  // hashchange a mounted portal instance will ever see is leaving it outright
  // — exactly when a still-running pass ticker needs to stop.
  window.addEventListener('hashchange', stopTicking);

  const content = h('div', { class: 'portal-content' });
  const tabbar = h('nav', { class: 'portal-tabbar' });

  function paintTabbar() {
    clear(tabbar).append(
      ...TABS.map((tabDef) =>
        h(
          'button',
          { class: `portal-tab${active === tabDef.key ? ' active' : ''}`, type: 'button', onclick: () => switchTab(tabDef.key) },
          renderIcon(tabDef.icon, { size: 21 }),
          h('span', {}, tabDef.label),
        ),
      ),
    );
  }

  async function switchTab(key) {
    stopTicking();
    active = key;
    paintTabbar();
    clear(content).append(h('div', { class: 'portal-loading' }, 'Loading…'));
    try {
      const node = await TAB_RENDERERS[key]();
      clear(content).append(node);
      content.scrollTop = 0;
    } catch (err) {
      clear(content).append(
        h(
          'div',
          { class: 'portal-error' },
          h('p', {}, err.message || 'Could not load this page'),
          h('button', { class: 'btn', type: 'button', onclick: () => switchTab(key) }, 'Try again'),
        ),
      );
    }
  }

  /* -------------------------------------------------------------- Home tab */

  async function renderTodaySection() {
    if (isLibrary()) {
      const seatRes = await api.portal.seat().catch(() => ({ items: [] }));
      if (!seatRes.items.length) {
        return h(
          'div',
          { class: 'portal-section' },
          h('h3', {}, 'Your shift'),
          h('div', { class: 'portal-empty' }, 'No seat assigned yet — visit the desk to get seated.'),
        );
      }
      return h('div', { class: 'portal-section' }, h('h3', {}, 'Your shift today'), ...seatRes.items.map(seatCard));
    }

    const todayIso = today();
    const schedule = await api.portal.classes({ week_start: todayIso }).catch(() => ({ items: [] }));
    const mine = schedule.items.filter((c) => c.class_date === todayIso && c.my_booking_id);
    if (!mine.length) {
      return h(
        'div',
        { class: 'portal-section' },
        h('h3', {}, "Today's schedule"),
        h('div', { class: 'portal-empty' }, 'No classes booked for today.'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => switchTab('schedule') }, 'Browse classes'),
      );
    }
    return h('div', { class: 'portal-section' }, h('h3', {}, "Today's schedule"), ...mine.map((c) => classCard(c)));
  }

  async function renderHomeTab() {
    const sub = me.subscription;
    const daysLeft = me.days_left ?? 0;
    const pct = sub && sub.duration_days ? daysLeft / sub.duration_days : 0;

    const heroCard = h(
      'div',
      { class: 'portal-hero-card' },
      h('div', { class: 'portal-hero-glow' }),
      h(
        'div',
        { class: 'portal-hero-top' },
        h(
          'div',
          { class: 'portal-hero-info' },
          h('div', { class: 'portal-hero-label' }, sub ? t('membership') : 'No active plan'),
          h('div', { class: 'portal-hero-plan' }, sub ? sub.plan_name : `Visit the desk to ${isLibrary() ? 'buy a pass' : 'join a plan'}`),
        ),
        sub
          ? h(
              'div',
              { style: 'position:relative' },
              progressRing(pct),
              h(
                'div',
                { class: 'portal-hero-ring-text' },
                h('strong', {}, String(Math.max(daysLeft, 0))),
                h('span', {}, 'days'),
              ),
            )
          : null,
      ),
      sub
        ? h(
            'div',
            { class: 'portal-hero-bottom' },
            h('span', {}, `Valid until ${date(sub.end_date)}`),
            me.sessions_left !== null && me.sessions_left !== undefined
              ? h('span', { class: 'portal-hero-pill' }, `${me.sessions_left} sessions left`)
              : null,
          )
        : h(
            'div',
            { class: 'portal-hero-bottom' },
            h('button', { class: 'btn sm ghost', type: 'button', onclick: () => switchTab('pay') }, 'See renewal plans'),
          ),
    );

    const quickActions = h(
      'div',
      { class: 'portal-quick-grid' },
      quickAction('idCard', 'Digital Pass', () => switchTab('pass')),
      quickAction(isLibrary() ? 'seats' : 'classes', isLibrary() ? 'My Shift' : 'Book Class', () => switchTab('schedule')),
      quickAction('billing', 'Invoices', () => switchTab('pay')),
      quickAction('member', 'Support', openSupportModal),
    );

    const statsRow = h(
      'div',
      { class: 'portal-stat-row' },
      miniStat('activity', me.stats.streak_days, `Day${me.stats.streak_days === 1 ? '' : 's'} streak`),
      miniStat(isLibrary() ? 'seats' : 'checkin', me.stats.visits_this_month, `${isLibrary() ? 'Sittings' : 'Workouts'} this month`),
      miniStat('trendUp', me.stats.total_visits, 'Total visits'),
    );

    const todaySection = await renderTodaySection();

    return h(
      'div',
      { class: 'portal-tab-body' },
      h(
        'div',
        { class: 'portal-greeting' },
        h('h2', {}, `Hi, ${me.member.first_name} 👋`),
        h('p', {}, isLibrary() ? 'Have a productive day.' : 'Ready for today’s workout?'),
      ),
      heroCard,
      quickActions,
      statsRow,
      todaySection,
    );
  }

  /* -------------------------------------------------------------- Pass tab */

  async function renderPassTab() {
    const pass = await api.portal.pass();
    const body = h('div', { class: 'portal-tab-body portal-pass-tab' }, h('h2', { class: 'portal-tab-title' }, 'Digital Pass'));

    const ticker = h('div', { class: 'portal-qr-ticker' });
    const walletCard = h(
      'div',
      { class: 'portal-wallet-card' },
      h(
        'div',
        { class: 'portal-wallet-top' },
        me.member.photo_url
          ? h('img', { class: 'portal-wallet-avatar', src: me.member.photo_url, alt: '' })
          : h('div', { class: 'portal-wallet-avatar portal-wallet-avatar-fallback' }, initials(me.member.first_name, me.member.last_name)),
        h(
          'div',
          { class: 'portal-wallet-meta' },
          h('div', { class: 'portal-wallet-name' }, `${me.member.first_name} ${me.member.last_name || ''}`.trim()),
          h('div', { class: 'portal-wallet-code' }, me.member.code),
        ),
        statusBadge(me.member.status),
      ),
      h('div', { class: 'portal-qr-wrap' }, h('div', { class: 'portal-qr-radar' }), h('div', { class: 'portal-qr-img', html: pass.svg })),
      ticker,
      h(
        'button',
        { class: 'btn primary block', type: 'button', onclick: () => openFullscreenPass(pass, me.member) },
        renderIcon('maximize', { size: 16 }),
        ' Full screen for scanning',
      ),
    );
    body.append(walletCard);

    const mountedAt = Date.now();
    const anchor = Date.parse(pass.server_time) || Date.now();
    const paintTick = () => {
      const now = new Date(anchor + (Date.now() - mountedAt));
      ticker.textContent = `SECURE · ${now.toISOString().slice(11, 19)} UTC`;
    };
    paintTick();
    tickInterval = setInterval(paintTick, 1000);

    return body;
  }

  /* ---------------------------------------------------------- Schedule tab */

  async function renderGymSchedule() {
    const start = today();
    const res = await api.portal.classes({ week_start: start });
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    let selectedDay = days.includes(today()) ? today() : days[0];

    const listWrap = h('div', { class: 'portal-class-list' });
    const strip = h('div', { class: 'portal-day-strip' });

    async function bookClass(c) {
      try {
        await api.portal.bookClass(c.id, { class_date: c.class_date });
        toast('Booked!');
        const updated = await api.portal.classes({ week_start: start });
        res.items = updated.items;
        paintList();
      } catch (err) {
        toast(err.message || 'Could not book this class', 'error');
      }
    }
    async function cancelClass(c) {
      try {
        await api.portal.cancelBooking(c.my_booking_id);
        toast('Booking cancelled');
        const updated = await api.portal.classes({ week_start: start });
        res.items = updated.items;
        paintList();
      } catch (err) {
        toast(err.message || 'Could not cancel this booking', 'error');
      }
    }

    function paintList() {
      const items = res.items.filter((c) => c.class_date === selectedDay);
      clear(listWrap);
      append(
        listWrap,
        items.length
          ? items.map((c) => classCard(c, { onBook: bookClass, onCancel: cancelClass }))
          : [h('div', { class: 'portal-empty' }, 'No classes this day.')],
      );
    }

    clear(strip).append(
      ...days.map((iso) => {
        const lbl = dayLabel(iso);
        const btn = h(
          'button',
          { class: `portal-day-pill${iso === selectedDay ? ' active' : ''}`, type: 'button' },
          h('span', {}, lbl.weekday),
          h('strong', {}, String(lbl.day)),
        );
        btn.addEventListener('click', () => {
          selectedDay = iso;
          for (const el of strip.children) el.classList.remove('active');
          btn.classList.add('active');
          paintList();
        });
        return btn;
      }),
    );
    paintList();

    return h('div', { class: 'portal-tab-body' }, h('h2', { class: 'portal-tab-title' }, 'Schedule'), strip, listWrap);
  }

  async function renderLibrarySchedule() {
    const seatRes = await api.portal.seat();
    const body = h('div', { class: 'portal-tab-body' }, h('h2', { class: 'portal-tab-title' }, 'My shifts'));
    body.append(
      seatRes.items.length
        ? h('div', { class: 'portal-section' }, ...seatRes.items.map(seatCard))
        : h('div', { class: 'portal-empty' }, 'No seat assigned yet — visit the desk to get seated.'),
    );
    if (me.locker) {
      body.append(
        h('h3', { class: 'portal-section-title' }, 'Locker'),
        h(
          'div',
          { class: 'portal-locker-card' },
          h('div', { class: 'portal-locker-icon' }, renderIcon('lockers', { size: 22 })),
          h(
            'div',
            {},
            h('div', { class: 'portal-locker-code' }, me.locker.code),
            h('div', { class: 'muted' }, `Held until ${date(me.locker.held_until)} · ${me.locker.key_issued ? 'Key issued' : 'No key yet'}`),
          ),
        ),
      );
    }
    return body;
  }

  /* --------------------------------------------------------------- Pay tab */

  async function renderPayTab() {
    const [paymentsRes, plansRes] = await Promise.all([api.portal.payments(), api.portal.plans()]);
    const sub = me.subscription;
    const body = h('div', { class: 'portal-tab-body' }, h('h2', { class: 'portal-tab-title' }, isLibrary() ? 'Passes & Payments' : 'Invoices & Payments'));

    if (sub) {
      body.append(
        h(
          'div',
          { class: 'portal-plan-card' },
          h('div', { class: 'portal-plan-name' }, sub.plan_name),
          h('div', { class: 'portal-plan-row' }, h('span', {}, 'Price'), h('span', {}, money(sub.price))),
          sub.discount ? h('div', { class: 'portal-plan-row' }, h('span', {}, 'Discount'), h('span', {}, `-${money(sub.discount)}`)) : null,
          h('div', { class: 'portal-plan-row' }, h('span', {}, 'Valid'), h('span', {}, `${date(sub.start_date)} – ${date(sub.end_date)}`)),
        ),
      );
      if (sub.due > 0) {
        body.append(
          h('div', { class: 'portal-due-banner' }, renderIcon('outgoing', { size: 16 }), ` ${money(sub.due)} due — pay at the front desk`),
        );
      }
    }

    body.append(h('h3', { class: 'portal-section-title' }, 'Payment history'));
    body.append(
      paymentsRes.items.length
        ? h(
            'div',
            { class: 'portal-section' },
            ...paymentsRes.items.map((p) =>
              h(
                'div',
                { class: 'portal-payment-row' },
                h('div', { class: 'portal-payment-icon' }, renderIcon('revenue', { size: 16 })),
                h(
                  'div',
                  { class: 'portal-payment-meta' },
                  h('div', {}, p.plan_name || 'Payment'),
                  h('div', { class: 'muted' }, `${date(p.paid_on)} · ${p.method.toUpperCase()}`),
                ),
                h('div', { class: 'portal-payment-amount' }, money(p.amount)),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    title: 'Download PDF receipt',
                    onclick: async (event) => {
                      event.currentTarget.disabled = true;
                      try {
                        await api.portal.downloadReceipt(p.id);
                      } catch (err) {
                        toast(err.message || 'Could not download receipt', 'error');
                      } finally {
                        event.currentTarget.disabled = false;
                      }
                    },
                  },
                  renderIcon('download', { size: 16 }),
                ),
              ),
            ),
          )
        : h('div', { class: 'portal-empty' }, 'No payments yet.'),
    );

    body.append(
      h('h3', { class: 'portal-section-title' }, 'Renewal plans'),
      h(
        'div',
        { class: 'portal-plan-grid' },
        ...plansRes.items.map((p) =>
          h(
            'div',
            { class: 'portal-plan-tile' },
            h('div', { class: 'portal-plan-tile-name' }, p.name),
            h('div', { class: 'portal-plan-tile-price' }, money(p.price)),
            h('div', { class: 'muted' }, `${p.duration_days} days${p.sessions ? ` · ${p.sessions} sessions` : ''}`),
          ),
        ),
      ),
      h('p', { class: 'muted portal-renew-hint' }, `Ask the front desk to renew or switch your ${t('plan').toLowerCase()}.`),
    );

    return body;
  }

  /* ----------------------------------------------------------- Profile tab */

  function openChangePinModal() {
    openModal({
      title: 'Change your PIN',
      body: buildForm(
        [
          { name: 'current_pin', label: 'Current PIN', type: 'password', required: true, full: true },
          { name: 'new_pin', label: 'New PIN (4-6 digits)', type: 'password', required: true, full: true },
        ],
        {
          submitLabel: 'Update PIN',
          onSubmit: async (values) => {
            await api.portal.setPin(values);
            toast('PIN updated');
            closeModal();
          },
        },
      ),
    });
  }

  async function renderProfileTab() {
    const m = me.member;
    const body = h('div', { class: 'portal-tab-body' }, h('h2', { class: 'portal-tab-title' }, 'Profile'));

    if (pendingPinPrompt) {
      pendingPinPrompt = false;
      body.append(
        h(
          'div',
          { class: 'portal-pin-banner' },
          h('div', {}, renderIcon('key', { size: 16 }), ' Using a temporary PIN — set your own for next time.'),
          h('button', { class: 'btn sm primary', type: 'button', onclick: openChangePinModal }, 'Set PIN'),
        ),
      );
    }

    append(body, [
      h(
        'div',
        { class: 'portal-profile-card' },
        m.photo_url
          ? h('img', { class: 'portal-profile-avatar', src: m.photo_url, alt: '' })
          : h('div', { class: 'portal-profile-avatar portal-profile-avatar-fallback' }, initials(m.first_name, m.last_name)),
        h('div', { class: 'portal-profile-name' }, `${m.first_name} ${m.last_name || ''}`.trim()),
        h('div', { class: 'muted' }, m.code),
      ),
      profileRow('Phone', m.phone),
      profileRow('Email', m.email),
      profileRow(t('emergencyContact'), m.emergency_contact ? `${m.emergency_contact}${m.emergency_phone ? ` · ${m.emergency_phone}` : ''}` : null),
      profileRow('Joined', m.joined_on ? date(m.joined_on) : null),
    ]);

    const installBtn = h(
      'button',
      { class: 'btn ghost block portal-settings-btn install-hidden', type: 'button' },
      renderIcon('download', { size: 16 }),
      ' Add to Home Screen',
    );
    installBtn.addEventListener('click', () => promptInstall());
    unsubscribeInstall?.();
    unsubscribeInstall = onInstallChange((available) => installBtn.classList.toggle('install-hidden', !available));

    body.append(
      h('h3', { class: 'portal-section-title' }, 'Settings'),
      h('button', { class: 'btn ghost block portal-settings-btn', type: 'button', onclick: openChangePinModal }, renderIcon('key', { size: 16 }), ' Change PIN'),
      h(
        'button',
        {
          class: 'btn ghost block portal-settings-btn',
          type: 'button',
          onclick: () => {
            toggleAppMode();
            switchTab('profile');
          },
        },
        renderIcon(getAppMode() === 'light' ? 'moon' : 'sun', { size: 16 }),
        getAppMode() === 'light' ? ' Switch to Dark Mode' : ' Switch to Light Mode',
      ),
      installBtn,
      h(
        'button',
        {
          class: 'btn danger block portal-settings-btn',
          type: 'button',
          onclick: () => {
            memberSession.clear();
            ctx.navigate('/portal/login');
          },
        },
        renderIcon('logout', { size: 16 }),
        ' Sign out',
      ),
    );

    return body;
  }

  const TAB_RENDERERS = {
    home: renderHomeTab,
    pass: renderPassTab,
    schedule: () => (isLibrary() ? renderLibrarySchedule() : renderGymSchedule()),
    pay: renderPayTab,
    profile: renderProfileTab,
  };

  paintTabbar();
  const topbar = h(
    'header',
    { class: 'portal-topbar' },
    ctx.context?.tenant?.logo_url
      ? h('img', { class: 'portal-topbar-logo-img', src: ctx.context.tenant.logo_url, alt: gymDisplayName(ctx) })
      : h('div', { class: 'portal-topbar-logo' }, renderIcon(isLibrary() ? 'book' : 'dumbbell', { size: 16 })),
    h('div', { class: 'portal-topbar-name' }, gymDisplayName(ctx)),
    h('div', { class: 'spacer' }),
    statusBadge(me.member.status),
  );

  switchTab('home');

  return h('div', { class: 'portal-frame' }, h('div', { class: 'portal-app' }, topbar, content, tabbar));
}

/* --------------------------------------------------------------- entry --- */

export async function renderPortal(ctx) {
  if (memberSession.token) {
    try {
      const me = await api.portal.me();
      return renderPortalApp(ctx, me);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // A 401 already cleared memberSession (see request() in api.js) — fall
      // through to the sign-in screen below.
    }
  }
  return renderPortalLogin(ctx);
}
