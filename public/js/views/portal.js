import { ApiError, api, memberSession } from '../api.js';
import {
  addDays,
  append,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
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

/* ══════════════════════════════════════════════ Diet & workout tracking ══ */

/**
 * The member-facing half of the paid Fitness add-on: a Heavy-style set logger
 * and a Lifesum-style macro tracker, both living in this file's tab shell.
 *
 * Both tabs check entitlement before painting anything (api.portal.fitnessStatus
 * is the one fitness call that answers for an unentitled member) and fall back
 * to the upgrade sheet, which is the same screen the server's 402 describes.
 */

const MEAL_SLOTS = [
  { key: 'breakfast', label: 'Breakfast', icon: 'sun' },
  { key: 'lunch', label: 'Lunch', icon: 'apple' },
  { key: 'dinner', label: 'Dinner', icon: 'moon' },
  { key: 'snack', label: 'Snacks', icon: 'flame' },
  { key: 'pre_workout', label: 'Pre-workout', icon: 'weight' },
  { key: 'post_workout', label: 'Post-workout', icon: 'weight' },
];

const SET_TYPES = [
  { key: 'warmup', short: 'W', label: 'Warmup' },
  { key: 'normal', short: '—', label: 'Normal' },
  { key: 'drop', short: 'D', label: 'Drop set' },
  { key: 'failure', short: 'F', label: 'To failure' },
];

const REST_PRESETS = [30, 60, 90, 120, 180];

/** Kilograms are what the server stores; pounds are this member's own display
 * preference, kept on the device so it survives a reload but never touches
 * their logged history. */
const UNIT_KEY = 'gymbook.portal.weightUnit';
const LB_PER_KG = 2.20462;

const weightUnit = {
  get() {
    try {
      return localStorage.getItem(UNIT_KEY) === 'lb' ? 'lb' : 'kg';
    } catch {
      return 'kg';
    }
  },
  set(unit) {
    try {
      localStorage.setItem(UNIT_KEY, unit === 'lb' ? 'lb' : 'kg');
    } catch {
      // A private window with storage blocked simply stays in kilograms.
    }
  },
};

const toDisplayWeight = (kg) => (weightUnit.get() === 'lb' ? Math.round(kg * LB_PER_KG * 10) / 10 : kg);
const toKg = (value) => (weightUnit.get() === 'lb' ? Math.round((value / LB_PER_KG) * 100) / 100 : Number(value) || 0);
const weightLabel = (kg) => `${toDisplayWeight(kg)} ${weightUnit.get()}`;

const clockFrom = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const minutesLabel = (seconds) => `${Math.max(1, Math.round(seconds / 60))} min`;

/** Epley, mirroring estimate1rm() in src/fitness.js — shown live as the member
 * types, which is why it cannot wait for a round trip. */
const estimate1rm = (kg, reps) => (kg > 0 && reps > 0 ? Math.round(kg * (1 + reps / 30) * 10) / 10 : 0);

/* ── The paywall ───────────────────────────────────────────────────────── */

function upgradeSheet(status, { onRefresh } = {}) {
  const price = money(status.settings.monthly_price);
  return h(
    'div',
    { class: 'portal-tab-body' },
    h(
      'div',
      { class: 'portal-paywall' },
      h('div', { class: 'portal-paywall-glow' }),
      h('div', { class: 'portal-paywall-badge' }, renderIcon('sparkle', { size: 14 }), ' Premium'),
      h('h2', { class: 'portal-paywall-title' }, 'Diet & Workout Tracking'),
      h('p', { class: 'portal-paywall-sub' }, status.settings.description),
      h(
        'div',
        { class: 'portal-paywall-features' },
        ...[
          ['weight', 'Log every set', 'Weights, reps and rest timers, with your last session next to each set.'],
          ['trophy', 'Chase your records', 'Automatic 1RM estimates and a personal-record wall that fills up as you lift.'],
          ['flame', 'Hit your macros', 'Calorie and protein rings, meal by meal, plus a water tracker.'],
          ['member', 'Coached, not guessed', 'Your gym’s trainers assign the plan and can see how you are getting on.'],
        ].map(([icon, title, body]) =>
          h(
            'div',
            { class: 'portal-paywall-feature' },
            h('div', { class: 'portal-paywall-feature-icon' }, renderIcon(icon, { size: 17 })),
            h('div', {}, h('strong', {}, title), h('p', {}, body)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'portal-paywall-price' },
        h('strong', {}, price),
        h('span', {}, '/ month'),
      ),
      h(
        'p',
        { class: 'portal-paywall-cta-note' },
        'Ask the front desk to switch it on — they can activate it while you wait.',
      ),
      h(
        'button',
        { class: 'btn primary block', type: 'button', onclick: onRefresh },
        renderIcon('refresh', { size: 15 }),
        ' I have paid — check again',
      ),
    ),
  );
}

/* ── Rest timer ────────────────────────────────────────────────────────── */

/**
 * The floating countdown between sets.
 *
 * One instance per active session rather than one per set: only one rest can be
 * running at a time, and a per-set timer would leave stray intervals behind
 * every time the set table repainted. stop() is called from the session's own
 * teardown so leaving the tab mid-rest cannot leave an interval running.
 */
function restTimer() {
  const label = h('div', { class: 'portal-rest-time' }, '0:00');
  const bar = h('i');
  const node = h(
    'div',
    { class: 'portal-rest-timer hidden' },
    h('div', { class: 'portal-rest-icon' }, renderIcon('timer', { size: 16 })),
    h(
      'div',
      { class: 'portal-rest-body' },
      h('div', { class: 'portal-rest-label' }, 'Rest'),
      label,
      h('div', { class: 'portal-rest-bar' }, bar),
    ),
    h(
      'div',
      { class: 'portal-rest-actions' },
      h('button', { class: 'portal-rest-btn', type: 'button', title: 'Add 30 seconds', onclick: () => extend(30) }, '+30'),
      h('button', { class: 'portal-rest-btn', type: 'button', title: 'Skip rest', onclick: () => stop() }, renderIcon('close', { size: 14 })),
    ),
  );

  let interval = null;
  let endsAt = 0;
  let total = 0;

  function beep() {
    // WebAudio rather than an audio file: the app is offline-first and a bundled
    // sound file is one more asset the service worker has to carry for one beep.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
      setTimeout(() => ctx.close(), 700);
    } catch {
      // Muted device, autoplay policy, no WebAudio — the pulse still fires.
    }
  }

  function tick() {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    label.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    bar.style.width = `${total ? (remaining / total) * 100 : 0}%`;
    node.classList.toggle('urgent', remaining <= 10 && remaining > 0);
    if (remaining <= 0) {
      clearInterval(interval);
      interval = null;
      node.classList.add('done');
      beep();
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      setTimeout(() => stop(), 2500);
    }
  }

  function start(seconds) {
    if (!seconds) return;
    clearInterval(interval);
    total = seconds;
    endsAt = Date.now() + seconds * 1000;
    node.classList.remove('hidden', 'done');
    tick();
    // Wall-clock driven, not a decrementing counter: a phone that sleeps
    // mid-rest must come back showing the real remaining time.
    interval = setInterval(tick, 250);
  }

  function extend(seconds) {
    if (!interval) return start(seconds);
    endsAt += seconds * 1000;
    total += seconds;
    return tick();
  }

  function stop() {
    clearInterval(interval);
    interval = null;
    node.classList.add('hidden');
    node.classList.remove('done', 'urgent');
  }

  return { node, start, stop };
}

/* ── Active workout session ────────────────────────────────────────────── */

const SESSION_KEY = 'gymbook.portal.activeWorkout';

/** A session in progress, kept on the device.
 *
 * The server only ever sees a finished workout (see the POST in
 * routes/portal.js), so a closed tab or a dropped connection mid-session would
 * otherwise lose an hour of logging. Restoring it is what makes leaving the tab
 * to check a plan safe. */
const activeSession = {
  read() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(state) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch {
      // Storage blocked: the session lives in memory for as long as the tab does.
    }
  },
  clear() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to clear.
    }
  },
};


/* ── Macro rings ───────────────────────────────────────────────────────── */

/** The hero calorie ring: eaten against target, with what is left in the
 * middle — the one number a member opens the Diet tab to read. */
function calorieRing(eaten, target) {
  const size = 168;
  const stroke = 13;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = target > 0 ? Math.min(eaten / target, 1) : 0;
  const remaining = Math.max(0, Math.round(target - eaten));
  const over = eaten > target;

  return h(
    'div',
    { class: 'portal-cal-ring' },
    svg(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
      svg('circle', { class: 'portal-cal-track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, fill: 'none' }),
      svg('circle', {
        class: `portal-cal-fill${over ? ' over' : ''}`,
        cx: size / 2,
        cy: size / 2,
        r,
        'stroke-width': stroke,
        fill: 'none',
        'stroke-linecap': 'round',
        'stroke-dasharray': c.toFixed(2),
        'stroke-dashoffset': (c * (1 - pct)).toFixed(2),
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    ),
    h(
      'div',
      { class: 'portal-cal-center' },
      h('strong', {}, String(over ? Math.round(eaten - target) : remaining)),
      h('span', {}, over ? 'kcal over' : 'kcal left'),
      h('small', {}, `${Math.round(eaten)} of ${target}`),
    ),
  );
}

function macroBar(label, eaten, target, tone) {
  const pct = target > 0 ? Math.min((eaten / target) * 100, 100) : 0;
  return h(
    'div',
    { class: 'portal-macro' },
    h(
      'div',
      { class: 'portal-macro-top' },
      h('span', { class: 'portal-macro-label' }, label),
      h('span', { class: 'portal-macro-value' }, `${Math.round(eaten)} / ${target}g`),
    ),
    h('div', { class: `portal-macro-bar ${tone}` }, h('i', { style: `width:${pct}%` })),
  );
}

/* ── Food search sheet ─────────────────────────────────────────────────── */

/**
 * The add-food sheet: search the library, or type a packet's numbers in.
 *
 * Serving arithmetic is previewed live but recomputed on the server (see the
 * entries POST) — the preview is a courtesy, not the source of truth.
 */
function openFoodSearch({ mealType, mealLabel, logDate, onAdded }) {
  let foods = [];
  let recent = [];
  let selected = null;
  let quantity = 1;

  const results = h('div', { class: 'portal-food-results' }, h('div', { class: 'portal-loading' }, 'Loading foods…'));
  const detail = h('div', {});

  function paintDetail() {
    clear(detail);
    if (!selected) return;
    const scale = quantity || 1;
    const scaled = {
      calories: Math.round(selected.calories * scale),
      protein_g: Math.round(selected.protein_g * scale * 10) / 10,
      carbs_g: Math.round(selected.carbs_g * scale * 10) / 10,
      fats_g: Math.round(selected.fats_g * scale * 10) / 10,
    };

    const qtyInput = h('input', {
      class: 'portal-input portal-qty',
      type: 'number',
      min: 0.05,
      step: 0.25,
      value: quantity,
      oninput: (event) => {
        quantity = Number(event.target.value);
        paintDetail();
      },
    });

    const addBtn = h(
      'button',
      { class: 'btn primary block', type: 'button' },
      `Add to ${mealLabel}`,
    );
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        await api.portal.addFoodEntry({
          meal_type: mealType,
          food_id: selected.id,
          quantity: quantity || 1,
          log_date: logDate,
        });
        closeModal();
        toast(`${selected.name} added`);
        await onAdded();
      } catch (err) {
        toast(err.message || 'Could not log that', 'error');
        addBtn.disabled = false;
      }
    });

    append(detail, [
      h(
        'div',
        { class: 'portal-food-detail' },
        h('div', { class: 'portal-food-detail-name' }, selected.name),
        h(
          'div',
          { class: 'portal-food-qty-row' },
          h('span', { class: 'muted' }, `× serving of ${selected.serving_unit}`),
          qtyInput,
        ),
        h(
          'div',
          { class: 'portal-food-macros' },
          h('div', {}, h('strong', {}, String(scaled.calories)), h('span', {}, 'kcal')),
          h('div', {}, h('strong', {}, `${scaled.protein_g}g`), h('span', {}, 'protein')),
          h('div', {}, h('strong', {}, `${scaled.carbs_g}g`), h('span', {}, 'carbs')),
          h('div', {}, h('strong', {}, `${scaled.fats_g}g`), h('span', {}, 'fats')),
        ),
        addBtn,
      ),
    ]);
  }

  function foodRow(food) {
    return h(
      'button',
      {
        class: `portal-food-row${selected?.id === food.id ? ' active' : ''}`,
        type: 'button',
        onclick: () => {
          selected = food;
          quantity = 1;
          paintResults();
          paintDetail();
        },
      },
      h(
        'div',
        {},
        h('div', { class: 'portal-food-name' }, food.name),
        h('div', { class: 'muted' }, `${food.serving_unit} · P ${food.protein_g}g · C ${food.carbs_g}g · F ${food.fats_g}g`),
      ),
      h('div', { class: 'portal-food-kcal' }, `${food.calories}`),
    );
  }

  let query = '';

  function paintResults() {
    const needle = query.trim().toLowerCase();
    const matches = needle ? foods.filter((f) => f.name.toLowerCase().includes(needle)) : foods;
    clear(results);

    if (!needle && recent.length) {
      results.append(h('div', { class: 'portal-food-section' }, 'Your recent foods'));
      // Recent rows come from the member's own log, so they carry no library id
      // — logging one re-sends its stored macros as a hand-typed entry.
      for (const item of recent.slice(0, 6)) {
        results.append(
          h(
            'button',
            {
              class: 'portal-food-row',
              type: 'button',
              onclick: async (event) => {
                event.currentTarget.disabled = true;
                try {
                  await api.portal.addFoodEntry({
                    meal_type: mealType,
                    food_name: item.food_name,
                    serving_unit: item.serving_unit,
                    calories: item.calories,
                    protein_g: item.protein_g,
                    carbs_g: item.carbs_g,
                    fats_g: item.fats_g,
                    log_date: logDate,
                  });
                  closeModal();
                  toast(`${item.food_name} added`);
                  await onAdded();
                } catch (err) {
                  toast(err.message || 'Could not log that', 'error');
                  event.currentTarget.disabled = false;
                }
              },
            },
            h(
              'div',
              {},
              h('div', { class: 'portal-food-name' }, item.food_name),
              h('div', { class: 'muted' }, `${item.serving_unit} · one tap to log again`),
            ),
            h('div', { class: 'portal-food-kcal' }, `${item.calories}`),
          ),
        );
      }
      results.append(h('div', { class: 'portal-food-section' }, 'Food library'));
    }

    if (!matches.length) {
      results.append(h('div', { class: 'portal-empty' }, 'Nothing matches — try the Custom tab.'));
      return;
    }
    for (const food of matches.slice(0, 60)) results.append(foodRow(food));
  }

  const search = h('input', {
    class: 'portal-input',
    type: 'search',
    placeholder: 'Search foods…',
    oninput: (event) => {
      query = event.target.value;
      paintResults();
    },
  });

  const customForm = buildForm(
    [
      { name: 'food_name', label: 'What did you eat?', required: true, full: true, placeholder: 'e.g. Cafe protein shake' },
      { name: 'calories', label: 'Calories', type: 'number', required: true, min: 0 },
      { name: 'protein_g', label: 'Protein (g)', type: 'number', min: 0, step: '0.1' },
      { name: 'carbs_g', label: 'Carbs (g)', type: 'number', min: 0, step: '0.1' },
      { name: 'fats_g', label: 'Fats (g)', type: 'number', min: 0, step: '0.1' },
    ],
    {
      submitLabel: `Add to ${mealLabel}`,
      onSubmit: async (values) => {
        await api.portal.addFoodEntry({
          meal_type: mealType,
          food_name: values.food_name,
          calories: Number(values.calories || 0),
          protein_g: Number(values.protein_g || 0),
          carbs_g: Number(values.carbs_g || 0),
          fats_g: Number(values.fats_g || 0),
          log_date: logDate,
        });
        closeModal();
        toast('Logged');
        await onAdded();
      },
    },
  );

  const libraryPane = h('div', {}, search, results, detail);
  const customPane = h('div', { class: 'hidden' }, customForm);
  const switcher = h(
    'div',
    { class: 'portal-sheet-switch' },
    ...[
      ['Search', libraryPane],
      ['Custom', customPane],
    ].map(([label, pane], index) =>
      h(
        'button',
        {
          class: `portal-sheet-tab${index === 0 ? ' active' : ''}`,
          type: 'button',
          onclick: (event) => {
            for (const el of switcher.children) el.classList.remove('active');
            event.currentTarget.classList.add('active');
            libraryPane.classList.toggle('hidden', pane !== libraryPane);
            customPane.classList.toggle('hidden', pane !== customPane);
          },
        },
        label,
      ),
    ),
  );

  openModal({ title: `Add to ${mealLabel}`, body: h('div', { class: 'portal-food-sheet' }, switcher, libraryPane, customPane) });

  api.portal
    .foods()
    .then((res) => {
      foods = res.items;
      recent = res.recent ?? [];
      paintResults();
      search.focus();
    })
    .catch((err) => {
      clear(results).append(h('div', { class: 'portal-empty' }, err.message || 'Could not load the food library'));
    });
}

/* -------------------------------------------------------------------- app */

/**
 * The bottom bar, built at render time rather than held as a module constant.
 *
 * isLibrary() is only correct after boot() has called setVertical(), and this
 * module is imported well before that runs (see the t()-at-top-level trap in
 * vertical.js) — so a constant here would freeze the gym's labels onto a study
 * hall's portal, and would decide the Workout/Diet tabs against the wrong
 * product too. Those two only exist for a gym: the fitness module is not part
 * of SeatBook, and their API 404s there.
 */
function buildTabs() {
  const tabs = [
    { key: 'home', label: 'Home', icon: 'dashboard' },
    { key: 'pass', label: 'Pass', icon: 'idCard' },
    { key: 'schedule', label: isLibrary() ? 'Shift' : 'Schedule', icon: isLibrary() ? 'seats' : 'classes' },
  ];
  if (!isLibrary()) {
    tabs.push(
      { key: 'workout', label: 'Workout', icon: 'weight' },
      { key: 'diet', label: 'Diet', icon: 'apple' },
    );
  }
  tabs.push({ key: 'pay', label: 'Pay', icon: 'billing' }, { key: 'profile', label: 'Profile', icon: 'member' });
  return tabs;
}

function renderPortalApp(ctx, initialMe) {
  const TABS = buildTabs();
  let me = initialMe;
  let active = 'home';
  let tickInterval = null;
  let unsubscribeInstall;
  // Teardown callbacks a tab registers for anything it starts and must stop —
  // the workout stopwatch and its rest timer, alongside the pass ticker below.
  let cleanups = [];
  const registerCleanup = (fn) => cleanups.push(fn);
  /** Which day the Diet tab is showing. Held here rather than inside the tab so
   * scrolling back to yesterday and then logging a meal repaints yesterday,
   * not today. */
  let dietDate = today();

  const stopTicking = () => {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    for (const fn of cleanups) fn();
    cleanups = [];
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

  /* ----------------------------------------------------------- Workout tab */

  /**
   * The active-session logger.
   *
   * Everything here is local state until Finish: the set table is a scratchpad,
   * and a round trip per checkbox would put a spinner between the member and
   * their next set. It is mirrored into localStorage on every change so a
   * locked phone or a closed tab does not lose the session — see activeSession.
   */
  function renderActiveWorkout(state, { onFinish, onDiscard }) {
    const rest = restTimer();
    const body = h('div', { class: 'portal-tab-body portal-session' });
    const clockNode = h('div', { class: 'portal-session-clock' }, '00:00:00');
    let clockInterval = null;

    const persist = () => activeSession.write(state);

    const teardown = () => {
      rest.stop();
      if (clockInterval) clearInterval(clockInterval);
      clockInterval = null;
    };
    // The tab shell stops the pass ticker on hashchange the same way; a running
    // rest timer and a stopwatch need exactly the same treatment.
    registerCleanup(teardown);

    const totals = () =>
      state.exercises
        .flatMap((ex) => ex.sets)
        .reduce(
          (acc, set) =>
            set.completed
              ? {
                  sets: acc.sets + 1,
                  reps: acc.reps + (Number(set.reps) || 0),
                  volume: acc.volume + (Number(set.weight_kg) || 0) * (Number(set.reps) || 0),
                }
              : acc,
          { sets: 0, reps: 0, volume: 0 },
        );

    function setRow(exercise, set, index) {
      const previous = exercise.previous;
      const typeButton = h(
        'button',
        {
          class: `portal-set-type t-${set.set_type}`,
          type: 'button',
          title: 'Set type',
          onclick: () => {
            const order = SET_TYPES.map((t) => t.key);
            set.set_type = order[(order.indexOf(set.set_type) + 1) % order.length];
            persist();
            paint();
          },
        },
        SET_TYPES.find((t) => t.key === set.set_type)?.short ?? '—',
      );

      const oneRm = estimate1rm(Number(set.weight_kg) || 0, Number(set.reps) || 0);
      const beatsPrevious = previous && oneRm > estimate1rm(previous.weight_kg, previous.reps);

      const check = h(
        'button',
        {
          class: `portal-set-check${set.completed ? ' done' : ''}`,
          type: 'button',
          'aria-label': set.completed ? 'Mark set as not done' : 'Mark set as done',
          onclick: () => {
            set.completed = !set.completed;
            persist();
            // Ticking a set is what starts the rest clock — that is the moment
            // the member actually stops lifting.
            if (set.completed) rest.start(exercise.rest_seconds || 90);
            paint();
          },
        },
        renderIcon('check', { size: 15 }),
      );

      return h(
        'div',
        { class: `portal-set-row${set.completed ? ' completed' : ''}` },
        h('div', { class: 'portal-set-n' }, typeButton, h('span', {}, String(index + 1))),
        h(
          'div',
          { class: 'portal-set-prev' },
          previous ? `${weightLabel(previous.weight_kg)} × ${previous.reps}` : h('span', { class: 'muted' }, '—'),
        ),
        h('input', {
          class: 'portal-set-input',
          type: 'number',
          inputmode: 'decimal',
          min: 0,
          step: 0.5,
          placeholder: previous ? String(toDisplayWeight(previous.weight_kg)) : '0',
          value: set.weight_display ?? '',
          oninput: (event) => {
            set.weight_display = event.target.value;
            set.weight_kg = toKg(event.target.value);
            persist();
            paintMeta();
          },
        }),
        h('input', {
          class: 'portal-set-input',
          type: 'number',
          inputmode: 'numeric',
          min: 0,
          step: 1,
          placeholder: previous ? String(previous.reps) : '0',
          value: set.reps ?? '',
          oninput: (event) => {
            set.reps = Number(event.target.value);
            persist();
            paintMeta();
          },
        }),
        check,
        oneRm > 0
          ? h(
              'div',
              { class: `portal-set-1rm${beatsPrevious ? ' beats' : ''}` },
              beatsPrevious ? renderIcon('trophy', { size: 11 }) : null,
              ` ~${weightLabel(oneRm)} 1RM`,
            )
          : null,
      );
    }

    function exerciseCard(exercise, exIndex) {
      return h(
        'div',
        { class: 'portal-ex-card' },
        h(
          'div',
          { class: 'portal-ex-head' },
          h(
            'div',
            {},
            h('div', { class: 'portal-ex-name' }, exercise.exercise_name),
            h(
              'div',
              { class: 'portal-ex-meta' },
              h('span', { class: 'portal-muscle-badge' }, exercise.muscle_group.replace('_', ' ')),
              exercise.target_reps ? h('span', { class: 'muted' }, `target ${exercise.target_sets} × ${exercise.target_reps}`) : null,
            ),
          ),
          h(
            'div',
            { class: 'portal-ex-actions' },
            h(
              'button',
              {
                class: 'portal-rest-chip',
                type: 'button',
                title: 'Rest between sets',
                onclick: () => {
                  const next = REST_PRESETS[(REST_PRESETS.indexOf(exercise.rest_seconds) + 1) % REST_PRESETS.length];
                  exercise.rest_seconds = next;
                  persist();
                  paint();
                },
              },
              renderIcon('timer', { size: 12 }),
              ` ${exercise.rest_seconds}s`,
            ),
            h(
              'button',
              {
                class: 'icon-btn',
                type: 'button',
                title: 'Remove exercise',
                onclick: () => {
                  state.exercises.splice(exIndex, 1);
                  persist();
                  paint();
                },
              },
              renderIcon('close', { size: 15 }),
            ),
          ),
        ),
        h(
          'div',
          { class: 'portal-set-row portal-set-header' },
          h('span', {}, 'Set'),
          h('span', {}, 'Previous'),
          h('span', {}, weightUnit.get()),
          h('span', {}, 'Reps'),
          h('span', {}, ''),
        ),
        ...exercise.sets.map((set, index) => setRow(exercise, set, index)),
        h(
          'div',
          { class: 'portal-ex-foot' },
          h(
            'button',
            {
              class: 'btn sm ghost',
              type: 'button',
              onclick: () => {
                const last = exercise.sets[exercise.sets.length - 1];
                // A new set inherits the previous one's load: on a straight-sets
                // day that is what it will be, and it is one fewer thing to type.
                exercise.sets.push({
                  set_type: 'normal',
                  weight_display: last?.weight_display ?? '',
                  weight_kg: last?.weight_kg ?? 0,
                  reps: last?.reps ?? '',
                  completed: false,
                });
                persist();
                paint();
              },
            },
            '＋ Add set',
          ),
          exercise.sets.length > 1
            ? h(
                'button',
                {
                  class: 'btn sm ghost',
                  type: 'button',
                  onclick: () => {
                    exercise.sets.pop();
                    persist();
                    paint();
                  },
                },
                '− Remove set',
              )
            : null,
        ),
      );
    }

    function openAddExercise() {
      let library = [];
      let query = '';
      let group = '';
      const list = h('div', { class: 'portal-food-results' }, h('div', { class: 'portal-loading' }, 'Loading…'));

      function paintList() {
        const needle = query.trim().toLowerCase();
        const matches = library.filter(
          (e) => (!group || e.muscle_group === group) && (!needle || e.name.toLowerCase().includes(needle)),
        );
        clear(list);
        if (!matches.length) {
          list.append(h('div', { class: 'portal-empty' }, 'No exercise matches that.'));
          return;
        }
        for (const item of matches.slice(0, 60)) {
          list.append(
            h(
              'button',
              {
                class: 'portal-food-row',
                type: 'button',
                onclick: () => {
                  state.exercises.push({
                    exercise_name: item.name,
                    muscle_group: item.muscle_group,
                    target_sets: 3,
                    target_reps: '',
                    rest_seconds: 90,
                    previous: item.previous ?? null,
                    sets: [{ set_type: 'normal', weight_display: '', weight_kg: 0, reps: '', completed: false }],
                  });
                  persist();
                  closeModal();
                  paint();
                },
              },
              h(
                'div',
                {},
                h('div', { class: 'portal-food-name' }, item.name),
                h(
                  'div',
                  { class: 'muted' },
                  item.previous
                    ? `Last: ${weightLabel(item.previous.weight_kg)} × ${item.previous.reps}`
                    : item.muscle_group.replace('_', ' '),
                ),
              ),
              h('span', { class: 'portal-muscle-badge' }, item.muscle_group.replace('_', ' ')),
            ),
          );
        }
      }

      const search = h('input', {
        class: 'portal-input',
        type: 'search',
        placeholder: 'Search exercises…',
        oninput: (event) => {
          query = event.target.value;
          paintList();
        },
      });
      const chips = h(
        'div',
        { class: 'portal-chip-row' },
        ...[{ key: '', label: 'All' }, ...['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio'].map((k) => ({ key: k, label: k }))].map(
          (option) =>
            h(
              'button',
              {
                class: `fit-chip${option.key === group ? ' active' : ''}`,
                type: 'button',
                onclick: (event) => {
                  group = option.key;
                  for (const el of chips.children) el.classList.remove('active');
                  event.currentTarget.classList.add('active');
                  paintList();
                },
              },
              option.label,
            ),
        ),
      );

      openModal({ title: 'Add an exercise', body: h('div', { class: 'portal-food-sheet' }, search, chips, list) });
      api.portal
        .exercises()
        .then((res) => {
          library = res.items;
          paintList();
        })
        .catch((err) => clear(list).append(h('div', { class: 'portal-empty' }, err.message || 'Could not load exercises')));
    }

    async function finish() {
      const sets = state.exercises.flatMap((exercise) =>
        exercise.sets
          // Untouched rows are dropped: a member who added three sets and did two
          // should not have a 0 kg × 0 set in their history.
          .filter((set) => set.completed || Number(set.reps) > 0)
          .map((set, index) => ({
            exercise_name: exercise.exercise_name,
            muscle_group: exercise.muscle_group,
            set_number: index + 1,
            set_type: set.set_type,
            weight_kg: Number(set.weight_kg) || 0,
            reps: Number(set.reps) || 0,
            completed: Boolean(set.completed),
          })),
      );

      if (!sets.length) {
        toast('Tick at least one set before finishing', 'error');
        return;
      }

      const res = await api.portal.saveWorkoutLog({
        workout_name: state.workout_name,
        plan_id: state.plan_id ?? undefined,
        day_id: state.day_id ?? undefined,
        duration_seconds: Math.round((Date.now() - state.started_at) / 1000),
        sets,
      });

      teardown();
      activeSession.clear();
      openSummary(res);
      await onFinish();
    }

    function openSummary(res) {
      openModal({
        title: 'Workout complete',
        body: h(
          'div',
          { class: 'portal-summary' },
          h('div', { class: 'portal-summary-burst' }, res.prs.length ? '🏆' : '💪'),
          h('h3', {}, res.prs.length ? `${res.prs.length} new personal record${res.prs.length === 1 ? '' : 's'}!` : 'Session logged'),
          h(
            'div',
            { class: 'portal-summary-grid' },
            h('div', {}, h('strong', {}, weightLabel(res.log.total_volume_kg)), h('span', {}, 'volume')),
            h('div', {}, h('strong', {}, String(res.log.total_sets)), h('span', {}, 'sets')),
            h('div', {}, h('strong', {}, String(res.log.total_reps)), h('span', {}, 'reps')),
            h('div', {}, h('strong', {}, minutesLabel(res.log.duration_seconds)), h('span', {}, 'duration')),
          ),
          res.prs.length
            ? h(
                'div',
                { class: 'portal-summary-prs' },
                ...res.prs.map((pr) =>
                  h(
                    'div',
                    { class: 'portal-pr-line' },
                    renderIcon('trophy', { size: 14 }),
                    h('strong', {}, pr.exercise_name),
                    h('span', {}, `${weightLabel(pr.weight_kg)} × ${pr.reps}`),
                    h(
                      'span',
                      { class: 'portal-pr-delta' },
                      pr.previous_est_1rm_kg
                        ? `+${Math.round((pr.est_1rm_kg - pr.previous_est_1rm_kg) * 10) / 10} kg 1RM`
                        : 'first record',
                    ),
                  ),
                ),
              )
            : null,
          h('button', { class: 'btn primary block', type: 'button', onclick: closeModal }, 'Done'),
        ),
      });
    }

    const metaNode = h('div', { class: 'portal-session-totals' });
    function paintMeta() {
      const t = totals();
      clear(metaNode).append(
        h('div', {}, h('strong', {}, weightLabel(Math.round(t.volume * 10) / 10)), h('span', {}, 'volume')),
        h('div', {}, h('strong', {}, String(t.sets)), h('span', {}, 'sets')),
        h('div', {}, h('strong', {}, String(t.reps)), h('span', {}, 'reps')),
      );
    }

    const finishBtn = h('button', { class: 'btn primary sm', type: 'button' }, 'Finish');
    finishBtn.addEventListener('click', async () => {
      finishBtn.disabled = true;
      try {
        await finish();
      } catch (err) {
        toast(err.message || 'Could not save this workout', 'error');
        finishBtn.disabled = false;
      }
    });

    function paint() {
      clear(body).append(
        h(
          'div',
          { class: 'portal-session-bar' },
          h(
            'div',
            {},
            h('div', { class: 'portal-session-name' }, state.workout_name),
            clockNode,
          ),
          h(
            'div',
            { class: 'row', style: 'gap:6px' },
            h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                onclick: () =>
                  confirmDialog({
                    title: 'Discard this workout?',
                    message: 'Everything logged in this session is thrown away. This cannot be undone.',
                    confirmLabel: 'Discard',
                    danger: true,
                    onConfirm: async () => {
                      teardown();
                      activeSession.clear();
                      await onDiscard();
                    },
                  }),
              },
              'Discard',
            ),
            finishBtn,
          ),
        ),
        metaNode,
        ...state.exercises.map(exerciseCard),
        h(
          'button',
          { class: 'btn block portal-add-ex', type: 'button', onclick: openAddExercise },
          renderIcon('plus', { size: 15 }),
          ' Add exercise',
        ),
        rest.node,
      );
      paintMeta();
    }

    const paintClock = () => {
      clockNode.textContent = clockFrom((Date.now() - state.started_at) / 1000);
    };
    paintClock();
    clockInterval = setInterval(paintClock, 1000);

    paint();
    return body;
  }

  async function renderWorkoutTab() {
    const status = await api.portal.fitnessStatus();
    if (!status.has_access) return upgradeSheet(status, { onRefresh: () => switchTab('workout') });

    // A session interrupted by a locked phone or a closed tab resumes exactly
    // where it was, which is the whole reason it is mirrored to localStorage.
    const resumed = activeSession.read();
    if (resumed) {
      return renderActiveWorkout(resumed, {
        onFinish: () => switchTab('workout'),
        onDiscard: () => switchTab('workout'),
      });
    }

    const [current, history, prs] = await Promise.all([
      api.portal.currentWorkout(),
      api.portal.workoutLogs({ limit: 20 }),
      api.portal.personalRecords(),
    ]);

    const body = h('div', { class: 'portal-tab-body' });

    const startSession = (name, day) => {
      const state = {
        workout_name: name,
        plan_id: current.plan?.id ?? null,
        day_id: day?.id ?? null,
        started_at: Date.now(),
        exercises: (day?.exercises ?? []).map((exercise) => ({
          exercise_name: exercise.exercise_name,
          muscle_group: exercise.muscle_group,
          target_sets: exercise.target_sets,
          target_reps: exercise.target_reps,
          rest_seconds: exercise.rest_seconds,
          previous: current.previous?.[exercise.exercise_name] ?? null,
          sets: Array.from({ length: exercise.target_sets }, () => ({
            set_type: 'normal',
            weight_display: '',
            weight_kg: 0,
            reps: '',
            completed: false,
          })),
        })),
      };
      activeSession.write(state);
      switchTab('workout');
    };

    /* Today's routine */
    if (current.today_day) {
      body.append(
        h(
          'div',
          { class: 'portal-routine-card' },
          h('div', { class: 'portal-routine-glow' }),
          h('div', { class: 'portal-routine-kicker' }, current.plan.name),
          h('h2', { class: 'portal-routine-day' }, current.today_day.day_name),
          current.today_day.notes ? h('p', { class: 'portal-routine-note' }, current.today_day.notes) : null,
          h(
            'div',
            { class: 'portal-routine-exercises' },
            ...current.today_day.exercises.map((exercise) =>
              h(
                'div',
                { class: 'portal-routine-row' },
                h('span', { class: 'portal-muscle-badge' }, exercise.muscle_group.replace('_', ' ')),
                h('span', { class: 'portal-routine-ex-name' }, exercise.exercise_name),
                h('span', { class: 'muted' }, `${exercise.target_sets} × ${exercise.target_reps}`),
                current.previous?.[exercise.exercise_name]
                  ? h(
                      'span',
                      { class: 'portal-routine-prev' },
                      `${weightLabel(current.previous[exercise.exercise_name].weight_kg)} × ${current.previous[exercise.exercise_name].reps}`,
                    )
                  : null,
              ),
            ),
          ),
          h(
            'button',
            {
              class: 'btn primary block',
              type: 'button',
              onclick: () => startSession(current.today_day.day_name, current.today_day),
            },
            renderIcon('play', { size: 15 }),
            ' Start workout',
          ),
        ),
      );

      if (current.plan.days.length > 1) {
        body.append(
          h('h3', { class: 'portal-section-title' }, 'Or train another day'),
          h(
            'div',
            { class: 'portal-chip-row' },
            ...current.plan.days
              .filter((day) => day.id !== current.today_day.id)
              .map((day) =>
                h(
                  'button',
                  { class: 'fit-chip', type: 'button', onclick: () => startSession(day.day_name, day) },
                  day.day_name.replace(/^Day \d+:\s*/, ''),
                ),
              ),
          ),
        );
      }
    } else {
      body.append(
        h(
          'div',
          { class: 'portal-routine-card' },
          h('div', { class: 'portal-routine-glow' }),
          h('h2', { class: 'portal-routine-day' }, 'No routine assigned yet'),
          h(
            'p',
            { class: 'portal-routine-note' },
            'Ask a trainer to put you on a plan — or start a freestyle session and log whatever you do today.',
          ),
          h(
            'button',
            { class: 'btn primary block', type: 'button', onclick: () => startSession('Freestyle workout', null) },
            renderIcon('play', { size: 15 }),
            ' Start a freestyle workout',
          ),
        ),
      );
    }

    /* Lifetime stats */
    body.append(
      h(
        'div',
        { class: 'portal-stat-row' },
        miniStat('weight', history.stats.total_workouts, 'Workouts'),
        miniStat('trendUp', Math.round(history.stats.lifetime_volume_kg / 1000), 'Tonnes lifted'),
        miniStat('trophy', prs.items.length, 'Records'),
      ),
    );

    /* PR wall */
    if (prs.items.length) {
      body.append(
        h('h3', { class: 'portal-section-title' }, 'Personal records'),
        h(
          'div',
          { class: 'portal-pr-wall' },
          ...prs.items.slice(0, 8).map((pr) =>
            h(
              'div',
              { class: 'portal-pr-card' },
              h('div', { class: 'portal-pr-trophy' }, renderIcon('trophy', { size: 15 })),
              h('div', { class: 'portal-pr-name' }, pr.exercise_name),
              h('div', { class: 'portal-pr-value' }, `${weightLabel(pr.max_weight_kg)} × ${pr.max_reps}`),
              h('div', { class: 'portal-pr-1rm' }, `~${weightLabel(pr.est_1rm_kg)} 1RM`),
            ),
          ),
        ),
      );
    }

    /* History */
    body.append(h('h3', { class: 'portal-section-title' }, 'Recent workouts'));
    body.append(
      history.items.length
        ? h(
            'div',
            { class: 'portal-section' },
            ...history.items.map((log) =>
              h(
                'button',
                {
                  class: 'portal-log-row',
                  type: 'button',
                  onclick: async () => {
                    try {
                      const full = await api.portal.workoutLog(log.id);
                      openWorkoutLogDetail(full, () => switchTab('workout'));
                    } catch (err) {
                      toast(err.message || 'Could not open that workout', 'error');
                    }
                  },
                },
                h('div', { class: 'portal-log-icon' }, renderIcon('weight', { size: 15 })),
                h(
                  'div',
                  { class: 'portal-log-meta' },
                  h('div', { class: 'portal-log-name' }, log.workout_name),
                  h('div', { class: 'muted' }, `${date(log.log_date)} · ${minutesLabel(log.duration_seconds)} · ${log.total_sets} sets`),
                ),
                h(
                  'div',
                  { class: 'portal-log-right' },
                  h('div', { class: 'portal-log-volume' }, weightLabel(log.total_volume_kg)),
                  log.pr_count ? h('span', { class: 'badge amber' }, `${log.pr_count} PR`) : null,
                ),
              ),
            ),
          )
        : h('div', { class: 'portal-empty' }, 'No workouts logged yet — your first session will show up here.'),
    );

    /* Units */
    body.append(
      h(
        'button',
        {
          class: 'btn ghost block portal-settings-btn',
          type: 'button',
          onclick: () => {
            weightUnit.set(weightUnit.get() === 'kg' ? 'lb' : 'kg');
            switchTab('workout');
          },
        },
        renderIcon('weight', { size: 15 }),
        ` Show weights in ${weightUnit.get() === 'kg' ? 'pounds' : 'kilograms'}`,
      ),
    );

    return body;
  }

  function openWorkoutLogDetail(log, onDeleted) {
    const byExercise = new Map();
    for (const set of log.sets) {
      if (!byExercise.has(set.exercise_name)) byExercise.set(set.exercise_name, []);
      byExercise.get(set.exercise_name).push(set);
    }

    openModal({
      title: log.workout_name,
      body: h(
        'div',
        { class: 'portal-log-detail' },
        h(
          'div',
          { class: 'portal-summary-grid' },
          h('div', {}, h('strong', {}, weightLabel(log.total_volume_kg)), h('span', {}, 'volume')),
          h('div', {}, h('strong', {}, String(log.total_sets)), h('span', {}, 'sets')),
          h('div', {}, h('strong', {}, String(log.total_reps)), h('span', {}, 'reps')),
          h('div', {}, h('strong', {}, minutesLabel(log.duration_seconds)), h('span', {}, 'duration')),
        ),
        ...[...byExercise].map(([name, sets]) =>
          h(
            'div',
            { class: 'portal-log-ex' },
            h('h4', {}, name),
            ...sets.map((set) =>
              h(
                'div',
                { class: 'portal-log-set' },
                h('span', { class: `portal-set-type t-${set.set_type}` }, SET_TYPES.find((t) => t.key === set.set_type)?.short ?? '—'),
                h('span', {}, `${weightLabel(set.weight_kg)} × ${set.reps}`),
                set.is_pr ? h('span', { class: 'badge amber' }, 'PR') : null,
                h('span', { class: 'muted' }, set.est_1rm_kg ? `~${weightLabel(set.est_1rm_kg)} 1RM` : ''),
              ),
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'btn danger block',
            type: 'button',
            onclick: () =>
              confirmDialog({
                title: 'Delete this workout?',
                message: 'The session is removed from your history. Records you set stay on your wall.',
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: async () => {
                  await api.portal.deleteWorkoutLog(log.id);
                  toast('Workout deleted');
                  closeModal();
                  await onDeleted();
                },
              }),
          },
          'Delete this workout',
        ),
      ),
    });
  }

  /* -------------------------------------------------------------- Diet tab */

  async function renderDietTab() {
    const status = await api.portal.fitnessStatus();
    if (!status.has_access) return upgradeSheet(status, { onRefresh: () => switchTab('diet') });

    let logDate = dietDate;
    const [plan, day] = await Promise.all([api.portal.currentDiet(), api.portal.dietDay(logDate)]);
    const targets = plan.targets;

    const reload = async () => {
      dietDate = logDate;
      await switchTab('diet');
    };

    const body = h('div', { class: 'portal-tab-body' });

    /* Date carousel: the last week, oldest first, ending today */
    const days = Array.from({ length: 7 }, (_, i) => addDays(today(), i - 6));
    let activePill;
    const strip = h(
      'div',
      { class: 'portal-day-strip' },
      ...days.map((iso) => {
        const lbl = dayLabel(iso);
        const pill = h(
          'button',
          {
            class: `portal-day-pill${iso === logDate ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              logDate = iso;
              reload();
            },
          },
          h('span', {}, iso === today() ? 'Today' : lbl.weekday),
          h('strong', {}, String(lbl.day)),
        );
        if (iso === logDate) activePill = pill;
        return pill;
      }),
    );
    body.append(strip);
    // Today sits at the far right of a strip that overflows a phone, so without
    // this the tab opens showing last Friday with the selected day off-screen.
    // Deferred a frame: the strip has no scrollWidth until it is in the document.
    if (activePill) {
      requestAnimationFrame(() => {
        strip.scrollLeft = Math.max(0, activePill.offsetLeft + activePill.offsetWidth - strip.clientWidth);
      });
    }

    /* Hero rings */
    body.append(
      h(
        'div',
        { class: 'portal-diet-hero' },
        calorieRing(day.totals.calories, targets.target_calories),
        h(
          'div',
          { class: 'portal-macro-stack' },
          macroBar('Protein', day.totals.protein_g, targets.target_protein_g, 'protein'),
          macroBar('Carbs', day.totals.carbs_g, targets.target_carbs_g, 'carbs'),
          macroBar('Fats', day.totals.fats_g, targets.target_fats_g, 'fats'),
        ),
      ),
    );

    if (plan.using_default_targets) {
      body.append(
        h(
          'div',
          { class: 'portal-diet-hint' },
          renderIcon('member', { size: 14 }),
          ' These are default targets — ask a trainer to set yours.',
        ),
      );
    } else {
      body.append(
        h('div', { class: 'portal-diet-hint' }, renderIcon('target', { size: 14 }), ` Plan: ${plan.plan.name}`),
      );
    }

    /* Water */
    const glassTarget = Math.max(1, Math.round(targets.target_water_ml / 250));
    const glassesDone = Math.round(day.water_ml / 250);
    const bump = async (ml) => {
      try {
        await api.portal.logWater({ add_ml: ml, log_date: logDate });
        await reload();
      } catch (err) {
        toast(err.message || 'Could not update your water', 'error');
      }
    };

    body.append(
      h(
        'div',
        { class: 'portal-water-card' },
        h(
          'div',
          { class: 'portal-water-head' },
          h('div', {}, renderIcon('droplet', { size: 16 }), h('strong', {}, ' Water')),
          h('span', { class: 'muted' }, `${day.water_ml} / ${targets.target_water_ml} ml`),
        ),
        h(
          'div',
          { class: 'portal-water-glasses' },
          ...Array.from({ length: Math.min(glassTarget, 16) }, (_, i) =>
            h('span', { class: `portal-glass${i < glassesDone ? ' filled' : ''}` }, renderIcon('droplet', { size: 13 })),
          ),
        ),
        h(
          'div',
          { class: 'row', style: 'gap:8px' },
          h('button', { class: 'btn sm primary', type: 'button', onclick: () => bump(250) }, '＋ 250 ml'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => bump(500) }, '＋ 500 ml'),
          day.water_ml > 0
            ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => bump(-250) }, '− 250 ml')
            : null,
        ),
      ),
    );

    /* Meal cards */
    const plannedByMeal = new Map();
    for (const meal of plan.plan?.meals ?? []) {
      // The trainer's meal names are free text ("Pre-Workout", "Snack"); match
      // them to the four fixed log slots by the closest sensible key so the
      // recommendation shows up next to where the member actually logs it.
      const key = MEAL_SLOTS.find((slot) => meal.meal_name.toLowerCase().replace(/[^a-z]/g, '').includes(slot.key.replace('_', '')))?.key
        ?? 'snack';
      if (!plannedByMeal.has(key)) plannedByMeal.set(key, []);
      plannedByMeal.get(key).push(meal);
    }

    const visibleSlots = MEAL_SLOTS.filter(
      (slot) => ['breakfast', 'lunch', 'dinner', 'snack'].includes(slot.key)
        || day.meals[slot.key]?.length
        || plannedByMeal.has(slot.key),
    );

    body.append(h('h3', { class: 'portal-section-title' }, 'Meals'));
    for (const slot of visibleSlots) {
      const entries = day.meals[slot.key] ?? [];
      const eaten = entries.reduce((sum, e) => sum + e.calories, 0);
      const planned = plannedByMeal.get(slot.key) ?? [];

      body.append(
        h(
          'div',
          { class: 'portal-meal-card' },
          h(
            'div',
            { class: 'portal-meal-head' },
            h('div', { class: 'portal-meal-icon' }, renderIcon(slot.icon, { size: 15 })),
            h('div', { class: 'portal-meal-title' }, slot.label),
            h('div', { class: 'portal-meal-kcal' }, `${eaten} kcal`),
          ),
          planned.length
            ? h(
                'div',
                { class: 'portal-meal-planned' },
                h('div', { class: 'portal-meal-planned-label' }, 'Your trainer suggests'),
                ...planned.flatMap((meal) =>
                  meal.items.map((item) =>
                    h(
                      'div',
                      { class: 'portal-planned-row' },
                      h('span', {}, item.food_name),
                      h('span', { class: 'muted' }, `${item.portion_size} · ${item.calories} kcal`),
                    ),
                  ),
                ),
              )
            : null,
          entries.length
            ? h(
                'div',
                { class: 'portal-meal-entries' },
                ...entries.map((entry) =>
                  h(
                    'div',
                    { class: 'portal-entry-row' },
                    h(
                      'div',
                      {},
                      h('div', { class: 'portal-entry-name' }, entry.food_name),
                      h(
                        'div',
                        { class: 'muted' },
                        `${entry.quantity === 1 ? '' : `${entry.quantity} × `}${entry.serving_unit} · P ${entry.protein_g}g · C ${entry.carbs_g}g · F ${entry.fats_g}g`,
                      ),
                    ),
                    h('div', { class: 'portal-entry-kcal' }, String(entry.calories)),
                    h(
                      'button',
                      {
                        class: 'icon-btn',
                        type: 'button',
                        'aria-label': `Remove ${entry.food_name}`,
                        onclick: async (event) => {
                          event.currentTarget.disabled = true;
                          try {
                            await api.portal.deleteFoodEntry(entry.id);
                            await reload();
                          } catch (err) {
                            toast(err.message || 'Could not remove that', 'error');
                            event.currentTarget.disabled = false;
                          }
                        },
                      },
                      renderIcon('close', { size: 14 }),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'button',
            {
              class: 'portal-add-food',
              type: 'button',
              onclick: () =>
                openFoodSearch({ mealType: slot.key, mealLabel: slot.label, logDate, onAdded: reload }),
            },
            renderIcon('plus', { size: 14 }),
            ' Add food',
          ),
        ),
      );
    }

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
    workout: renderWorkoutTab,
    diet: renderDietTab,
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
