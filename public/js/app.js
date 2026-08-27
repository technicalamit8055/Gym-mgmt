import { ApiError, api, landingBrand, pathSlug, session } from './api.js';
import {
  buildForm,
  clear,
  h,
  isFullscreen,
  openModal,
  renderIcon,
  setCurrency,
  toast,
  toggleFullscreen,
  onFullscreenChange,
} from './ui.js';
import { applyGymIcons, onInstallChange, promptInstall } from './pwa.js';
import { getAppMode, isLibrary, setVertical, t, toggleAppMode } from './vertical.js';
import { renderLanding } from './views/landing.js';
import { renderLandingLibrary } from './views/landingLibrary.js';
import { renderSignup } from './views/signup.js';
import { renderSettings } from './views/settings.js';
import { renderPlatformConsole } from './views/platform.js';
import { renderReset } from './views/reset.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMembers, renderMemberDetail } from './views/members.js';
import { renderCheckIn } from './views/checkin.js';
import { renderPlans } from './views/plans.js';
import { renderBilling } from './views/billing.js';
import { renderClasses } from './views/classes.js';
import { renderEquipment } from './views/equipment.js';
import { renderStaff } from './views/staff.js';
import { renderDevices } from './views/devices.js';
import { renderSessions } from './views/sessions.js';
import { renderReports } from './views/reports.js';
import { renderWhatsApp } from './views/whatsapp.js';
import { renderSeats } from './views/seats.js';
import { renderLockers } from './views/lockers.js';
import { renderExpenses } from './views/expenses.js';
import { renderFitnessPlans } from './views/fitnessPlans.js';
import { renderPortal } from './views/portal.js';

/**
 * Built by buildNav()/buildRoutes(), called from boot() once the vertical is
 * known — a gym and a library share this shell but not this sidebar, and the
 * static import graph above runs before setVertical() does, so these cannot
 * be module-level constants (see the t()-at-top-level trap in vertical.js).
 */
let NAV = [];
let ROUTES = [];

/** `icon` names an entry in the icon set in ui.js — never a glyph, so the
 * sidebar renders identically on a Windows desk terminal and an iPad. */
function buildNav() {
  if (isLibrary()) {
    return [
      { section: 'Daily' },
      { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
      { path: '/check-in', label: t('checkin'), icon: 'checkin' },
      { path: '/members', label: t('members'), icon: 'members' },
      { section: 'Business' },
      { path: '/billing', label: t('memberships'), icon: 'billing' },
      { path: '/plans', label: t('plans'), icon: 'plans' },
      { path: '/reports', label: 'Reports', icon: 'reports' },
      // Sends under the library's own WhatsApp number, so the API limits it to
      // the billing roles — hide it rather than let staff click into a 403.
      { path: '/whatsapp', label: 'WhatsApp', icon: 'whatsapp', roles: ['admin', 'manager'] },
      { section: 'Operations' },
      { path: '/seats', label: t('seats'), icon: 'seats' },
      { path: '/lockers', label: t('lockers'), icon: 'lockers' },
      { path: '/expenses', label: t('expenses'), icon: 'expenses' },
      { path: '/devices', label: 'Biometric devices', icon: 'devices' },
      { path: '/sessions', label: t('shifts'), icon: 'sessions' },
      { path: '/staff', label: t('staff'), icon: 'staff' },
      { path: '/settings', label: t('settings'), icon: 'settings' },
    ];
  }
  return [
    { section: 'Daily' },
    { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { path: '/check-in', label: 'Check-in desk', icon: 'checkin' },
    { path: '/members', label: 'Members', icon: 'members' },
    { section: 'Business' },
    { path: '/billing', label: 'Memberships & billing', icon: 'billing' },
    { path: '/plans', label: 'Plans', icon: 'plans' },
    { path: '/reports', label: 'Reports', icon: 'reports' },
    // Sends under the gym's own WhatsApp number, so the API limits it to the
    // billing roles — hide it rather than let a trainer click into a 403.
    { path: '/whatsapp', label: 'WhatsApp', icon: 'whatsapp', roles: ['admin', 'manager'] },
    { section: 'Operations' },
    { path: '/classes', label: 'Classes', icon: 'classes' },
    // Under Operations rather than Business: it is what trainers set up, and
    // the money side of it (what the add-on costs) is one tab inside it.
    { path: '/fitness-plans', label: 'Workout & Diet plans', icon: 'weight' },
    { path: '/equipment', label: 'Equipment', icon: 'equipment' },
    { path: '/devices', label: 'Biometric devices', icon: 'devices' },
    { path: '/sessions', label: 'Gym sessions', icon: 'sessions' },
    { path: '/staff', label: 'Staff', icon: 'staff' },
    { path: '/settings', label: 'Gym settings', icon: 'settings' },
  ];
}

function buildRoutes() {
  const shared = [
    { pattern: /^\/dashboard$/, title: 'Dashboard', view: renderDashboard },
    { pattern: /^\/check-in$/, title: t('checkin'), view: renderCheckIn },
    { pattern: /^\/members$/, title: t('members'), view: renderMembers },
    { pattern: /^\/members\/(\d+)$/, title: t('member'), view: renderMemberDetail },
    { pattern: /^\/billing$/, title: t('memberships'), view: renderBilling },
    { pattern: /^\/plans$/, title: t('plans'), view: renderPlans },
    { pattern: /^\/reports$/, title: 'Reports', view: renderReports },
    { pattern: /^\/whatsapp$/, title: 'WhatsApp Automation', view: renderWhatsApp },
    { pattern: /^\/devices$/, title: 'Biometric devices', view: renderDevices },
    { pattern: /^\/sessions$/, title: t('shifts'), view: renderSessions },
    { pattern: /^\/staff$/, title: t('staff'), view: renderStaff },
    { pattern: /^\/settings$/, title: t('settings'), view: renderSettings },
  ];
  if (isLibrary()) {
    return [
      ...shared,
      { pattern: /^\/seats(?:\/(\d+))?$/, title: t('seats'), view: renderSeats },
      { pattern: /^\/lockers$/, title: t('lockers'), view: renderLockers },
      { pattern: /^\/expenses$/, title: t('expenses'), view: renderExpenses },
    ];
  }
  return [
    ...shared,
    { pattern: /^\/classes$/, title: 'Classes & timetable', view: renderClasses },
    { pattern: /^\/fitness-plans$/, title: 'Workout & Diet plans', view: renderFitnessPlans },
    { pattern: /^\/equipment$/, title: 'Equipment', view: renderEquipment },
  ];
}

/**
 * Pages that exist before anyone signs in, and outside any one gym.
 *
 * These render full-page instead of inside the app shell: the shell's sidebar
 * is a gym's navigation, and on the root domain there is no gym for it to
 * navigate. Matched ahead of the authenticated routes above.
 *
 * The first entry is a dispatcher, not a fixed page: which marketing site it
 * shows depends on landingBrand (the real URL path, read once in api.js), not
 * on anything resolved from a tenant — there is no tenant yet.
 */
const PUBLIC_ROUTES = [
  {
    pattern: /^\/?$/,
    landing: true,
    title: () => (landingBrand === 'library' ? 'SeatBook — Study Hall Management' : 'GymBook — Gym Management'),
    view: (ctx) => (landingBrand === 'library' ? renderLandingLibrary(ctx) : renderLanding(ctx)),
  },
  { pattern: /^\/signup$/, title: 'Set up your account', view: renderSignup },
  { pattern: /^\/platform$/, title: 'Operator console', view: renderPlatformConsole },
  // Public by necessity — someone redeeming a reset link cannot sign in. The
  // pattern allows the trailing `?token=…` the link carries in the hash.
  { pattern: /^\/reset(\?|$)/, title: 'Set a new password', view: renderReset },
  // The member app: its own sign-in (member code/phone + PIN, a different
  // credential from any staff login) and its own tab shell. Rendered full-page
  // like every other entry here — a member has no staff sidebar to sit inside.
  // Both patterns share one view: renderPortal itself decides sign-in vs. app
  // shell from whether a member session exists, which is what lets a
  // just-completed sign-in on /portal/login redraw straight into the app
  // (ctx.rerender() re-enters this same route) instead of looping back to the
  // sign-in screen a route-level "always show login" flag would force.
  { pattern: /^\/portal\/login$/, title: 'Member Sign in', view: renderPortal },
  { pattern: /^\/portal(\/.*)?$/, title: 'Member Portal', view: renderPortal },
];

const root = () => document.getElementById('app');

function currentPath() {
  return window.location.hash.replace(/^#/, '');
}

export function navigate(path) {
  window.location.hash = path;
}

/* ---------------------------------------------------------------- platform */

/**
 * Which gym this browser tab is looking at, resolved once at boot from the
 * host or the /g/<slug> path prefix. `tenant` is null on the root domain and
 * in single-gym dev mode; `missing` means the address named a gym that does
 * not exist.
 */
let platform = { tenant: null };

const gymName = () => platform.tenant?.gym_name || 'GymBook';

async function loadPlatformContext() {
  try {
    return await api.tenantContext();
  } catch (err) {
    // resolveTenant serves the SPA shell for an unknown gym so we can say so
    // in HTML; the API call behind it is what actually reports the 404.
    if (err instanceof ApiError && err.status === 404) {
      return { tenant: null, missing: true, slug: pathSlug || window.location.host.split('.')[0] };
    }
    if (err instanceof ApiError && err.status === 403) {
      return { tenant: null, closed: true, slug: pathSlug || window.location.host.split('.')[0] };
    }
    throw err;
  }
}

function renderNotice(title, body, actions) {
  clear(root()).append(
    h(
      'div',
      { class: 'onboard' },
      h(
        'div',
        { class: 'onboard-card', style: 'text-align:center' },
        h('h1', {}, title),
        h('p', { class: 'sub' }, body),
        h('div', { class: 'row', style: 'justify-content:center;gap:8px' }, ...actions),
      ),
    ),
  );
  root().className = '';
}

/* ------------------------------------------------------------------- login */

function renderLogin(message) {
  // The login card replaces the shell wholesale. Leaving `shell` set would
  // leave renderRoute() writing views into nodes that are no longer in the
  // document — a blank page after the next sign-in.
  shell = undefined;

  const form = buildForm(
    [
      { name: 'email', label: 'Email', type: 'email', required: true, full: true, placeholder: 'you@gym.com' },
      { name: 'password', label: 'Password', type: 'password', required: true, full: true },
    ],
    {
      submitLabel: 'Sign in',
      onSubmit: async (values) => {
        const { token, user } = await api.login(values.email, values.password);
        session.save(token, user);
        toast(`Welcome back, ${user.name.split(' ')[0]}`);
        await boot();
      },
    },
  );
  form.querySelector('.modal-foot').remove();
  form.append(h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'));

  const tenant = platform.tenant;
  const logoNode = tenant?.logo_url
    ? h('img', { class: 'login-logo-img', src: tenant.logo_url, alt: gymName() })
    : h('span', { class: 'login-logo-mark' }, renderIcon(isLibrary() ? 'book' : 'dumbbell', { size: 24 }));

  clear(root()).append(
    h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        h('h1', {}, logoNode, gymName()),
        h(
          'p',
          { class: 'sub' },
          tenant
            ? `Sign in to your ${t('org')}.`
            : 'Gym management — members, billing, classes and check-ins.',
        ),
        tenant?.status === 'suspended'
          ? h(
              'p',
              { class: 'login-notice' },
              'Access is paused because the trial or last payment lapsed. Sign in as an admin to subscribe — nothing has been deleted.',
            )
          : null,
        message ? h('p', { class: 'field-error' }, message) : null,
        form,
        h(
          'p',
          { class: 'muted', style: 'text-align:center;margin-top:14px;font-size:13px' },
          `${t('member')}? `,
          h('a', { href: '#/portal' }, `Open the ${t('member')} app →`),
        ),
      ),
    ),
  );
  root().className = '';
}

/** Cancels the previous shell's install-availability subscription. */
let unsubscribeInstall;

function renderBrandLogoNode() {
  const logoUrl = platform.tenant?.logo_url;
  if (logoUrl) {
    return h('div', { class: 'logo' }, h('img', { class: 'logo-img', src: logoUrl, alt: gymName() }));
  }
  return h('div', { class: 'logo' }, renderIcon(isLibrary() ? 'book' : 'dumbbell', { size: 19 }));
}

/** "Amit Singh" -> "AS", for the sidebar's account chip. */
const userInitials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase() || '?';

/**
 * Repaints a control that means two different things depending on state — the
 * fullscreen pair and the light/dark pair both swap their icon rather than
 * their position, so the button never moves under a thumb already on it.
 */
function setControlIcon(button, name, label) {
  clear(button).append(renderIcon(name, { size: label ? 15 : 17 }));
  if (label) button.append(label);
}

function renderShell() {
  const user = session.user;
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Main navigation' });
  nav.append(h('div', { class: 'brand', title: gymName() }, renderBrandLogoNode(), gymName()));

  for (const item of NAV) {
    if (item.section) {
      nav.append(h('div', { class: 'nav-section' }, item.section));
      continue;
    }
    if (item.roles && !item.roles.includes(user?.role)) continue;
    nav.append(
      h(
        'a',
        {
          class: 'nav-link',
          href: `#${item.path}`,
          dataset: { path: item.path },
          // Tapping the link the drawer is already on fires no hashchange, so
          // renderRoute's close never runs — close here too.
          onclick: () => setNavOpen(false),
        },
        h('span', { class: 'icon' }, renderIcon(item.icon)),
        item.label,
      ),
    );
  }

  // Hidden until a browser reports an install is possible — the subscription
  // is also what un-hides it if Chrome fires its prompt after the shell is
  // already on screen. Dropped first, so signing out and back in doesn't leave
  // the previous shell's button subscribed.
  const installBtn = h(
    'button',
    { class: 'btn sm ghost install-hidden', onclick: () => promptInstall() },
    renderIcon('download', { size: 15 }),
    'Install app',
  );
  unsubscribeInstall?.();
  unsubscribeInstall = onInstallChange((available) =>
    installBtn.classList.toggle('install-hidden', !available),
  );

  nav.append(
    h(
      'div',
      { class: 'sidebar-footer' },
      h(
        'div',
        { class: 'sidebar-user' },
        h('div', { class: 'avatar sm' }, userInitials(user?.name)),
        h(
          'div',
          { class: 'sidebar-user-meta' },
          h('div', { class: 'sidebar-user-name' }, user?.name || ''),
          h('div', { class: 'sidebar-user-role' }, user?.role || ''),
        ),
      ),
      h(
        'div',
        { class: 'sidebar-actions' },
        installBtn,
        h(
          'button',
          { id: 'btn-fullscreen-sidebar', class: 'btn sm ghost', onclick: () => toggleFullscreen() },
          renderIcon(isFullscreen() ? 'minimize' : 'maximize', { size: 15 }),
          'Fullscreen',
        ),
        h('button', { class: 'btn sm ghost', onclick: openPasswordModal }, renderIcon('key', { size: 15 }), 'Password'),
        h('button', { class: 'btn sm ghost', onclick: signOut }, renderIcon('logout', { size: 15 }), 'Sign out'),
      ),
    ),
  );

  const title = h('h1', {}, 'Dashboard');
  const content = h('div', { class: 'content' }, h('div', { class: 'empty' }, 'Loading…'));
  const actions = h('div', { class: 'row' });

  const fullscreenTopbarBtn = h(
    'button',
    {
      id: 'btn-fullscreen-topbar',
      class: 'btn ghost icon-only',
      type: 'button',
      title: isFullscreen() ? 'Exit Fullscreen' : 'Enter Fullscreen Mode',
      'aria-label': isFullscreen() ? 'Exit Fullscreen' : 'Enter Fullscreen Mode',
      onclick: () => toggleFullscreen(),
    },
    renderIcon(isFullscreen() ? 'minimize' : 'maximize'),
  );

  const modeTopbarBtn = h(
    'button',
    {
      id: 'btn-mode-topbar',
      class: 'btn ghost icon-only',
      type: 'button',
      title: getAppMode() === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode',
      'aria-label': getAppMode() === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode',
      onclick: () => {
        const mode = toggleAppMode();
        modeTopbarBtn.title = mode === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode';
        modeTopbarBtn.setAttribute('aria-label', modeTopbarBtn.title);
        setControlIcon(modeTopbarBtn, mode === 'light' ? 'sun' : 'moon');
      },
    },
    renderIcon(getAppMode() === 'light' ? 'sun' : 'moon'),
  );

  const navToggle = h(
    'button',
    {
      class: 'btn ghost nav-toggle',
      type: 'button',
      'aria-label': 'Open navigation',
      'aria-expanded': 'false',
      onclick: () => setNavOpen(!nav.classList.contains('open')),
    },
    renderIcon('menu', { size: 19 }),
  );
  const scrim = h('div', { class: 'nav-scrim', onclick: () => setNavOpen(false) });

  clear(root()).append(
    h(
      'div',
      { class: 'shell' },
      nav,
      scrim,
      h(
        'div',
        { class: 'main' },
        h('header', { class: 'topbar' }, navToggle, title, h('div', { class: 'spacer' }), actions, modeTopbarBtn, fullscreenTopbarBtn),
        content,
      ),
    ),
  );
  root().className = '';
  return { nav, title, content, actions, navToggle, scrim };
}

/**
 * Opens or closes the mobile navigation drawer.
 *
 * Above 900px the drawer doesn't exist (CSS pins the sidebar open and hides
 * the toggle), so these classes are inert there and it's safe to call this
 * from shared paths like renderRoute.
 */
function setNavOpen(open) {
  if (!shell) return;
  shell.nav.classList.toggle('open', open);
  shell.scrim.classList.toggle('open', open);
  shell.navToggle.setAttribute('aria-expanded', String(open));
  shell.navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  document.body.classList.toggle('nav-open', open);
}

function openPasswordModal() {
  openModal({
    title: 'Change your password',
    body: buildForm(
      [
        { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true },
        { name: 'new_password', label: 'New password', type: 'password', required: true, full: true, hint: 'At least 8 characters' },
      ],
      {
        submitLabel: 'Update password',
        onSubmit: async (values) => {
          await api.changePassword(values);
          toast('Password updated');
          document.getElementById('modal-root').replaceChildren();
        },
      },
    ),
  });
}

/* ------------------------------------------------------------------ router */

let shell;

/**
 * Renders one of the pre-auth pages, full-page, with no app shell around it.
 *
 * `rerender` re-runs the same public route, which is how the signup success
 * screen and the operator console's sign-in/sign-out swap themselves out
 * without a page load.
 */
async function renderPublicRoute(publicRoute) {
  shell = undefined;
  const ownTitle = typeof publicRoute.title === 'function' ? publicRoute.title() : publicRoute.title;
  // The landing dispatcher already names its own brand; every other public
  // page (signup, the operator console, password reset) is platform-owned and
  // keeps the fixed suffix regardless of which marketing site sent someone
  // there.
  document.title = publicRoute.landing ? ownTitle : `${ownTitle} — GymBook`;

  const swap = (node) => {
    clear(root()).append(node);
    root().className = '';
  };

  try {
    const view = await publicRoute.view({
      context: platform,
      navigate,
      rerender: () => renderPublicRoute(publicRoute),
      swap,
    });
    swap(view);
  } catch (err) {
    console.error(err);
    swap(
      h(
        'div',
        { class: 'onboard' },
        h(
          'div',
          { class: 'onboard-card', style: 'text-align:center' },
          h('h1', {}, 'Could not load this page'),
          h('p', { class: 'sub' }, err.message || 'Unexpected error'),
          h('button', { class: 'btn primary', onclick: () => renderPublicRoute(publicRoute) }, 'Try again'),
        ),
      ),
    );
  }
}

async function renderRoute() {
  const path = currentPath() || '/dashboard';
  const match = ROUTES.map((route) => ({ route, params: path.match(route.pattern) })).find((r) => r.params);

  if (!match) {
    navigate('/dashboard');
    return;
  }

  setNavOpen(false);
  for (const link of shell.nav.querySelectorAll('.nav-link')) {
    link.classList.toggle('active', path.startsWith(link.dataset.path));
  }
  shell.title.textContent = match.route.title;
  clear(shell.actions);
  clear(shell.content).append(h('div', { class: 'empty' }, 'Loading…'));

  const context = {
    params: match.params.slice(1),
    setTitle: (text) => {
      shell.title.textContent = text;
    },
    setActions: (...nodes) => clear(shell.actions).append(...nodes.flat().filter(Boolean)),
    reload: renderRoute,
    navigate,
  };

  try {
    const view = await match.route.view(context);
    clear(shell.content).append(view);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    console.error(err);
    clear(shell.content).append(
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Could not load this page'),
        h('p', { class: 'muted' }, err.message || 'Unexpected error'),
        h('button', { class: 'btn', onclick: renderRoute }, 'Try again'),
      ),
    );
  }
}

/**
 * Decides what this URL should show, given who is signed in and which gym (if
 * any) the address resolves to. Re-run on every hash change, so it is also
 * what moves between the public pages and the app.
 */
async function dispatch() {
  const path = currentPath();

  if (platform.missing) {
    renderNotice(
      'No gym at this address',
      `Nothing is set up at "${platform.slug}". Check the spelling, or create a gym with that address.`,
      [
        h('a', { class: 'btn primary', href: `${window.location.origin}/#/signup` }, 'Set up a gym'),
        h('a', { class: 'btn ghost', href: window.location.origin }, 'Back to the site'),
      ],
    );
    return;
  }
  if (platform.closed) {
    renderNotice('This account is closed', 'Contact support if you think this is a mistake.', [
      h('a', { class: 'btn ghost', href: window.location.origin }, 'Back to the site'),
    ]);
    return;
  }

  const publicRoute = PUBLIC_ROUTES.find((r) => r.pattern.test(path));

  // "#/" means the landing page only on the root domain with nobody signed
  // in. Inside a gym it means the dashboard, and a signed-in dev on the root
  // domain wants their dashboard too rather than bouncing off their own
  // marketing page on every reload. Signup and the console are always public.
  const skipLanding = publicRoute?.landing && Boolean(platform.tenant || session.token);

  if (publicRoute && !skipLanding) {
    await renderPublicRoute(publicRoute);
    return;
  }

  if (!session.token) {
    // A real gym has a login screen; the root domain has nothing to sign into,
    // so send it to the landing page (the hash is non-empty here — an empty
    // one would have matched the landing route above — so this always fires a
    // hashchange, and dispatch() runs again).
    if (!platform.tenant) {
      navigate('/');
      return;
    }
    renderLogin();
    return;
  }

  try {
    await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderLogin('Your session expired — please sign in again');
      return;
    }
    throw err;
  }

  if (!shell) shell = renderShell();
  await renderRoute();
}

/**
 * Whether an error means "the server could not be reached".
 *
 * Offline, this arrives one of two ways: a rejected fetch (TypeError) with no
 * service worker in play, or the worker's own JSON 503 stand-in, which it
 * substitutes precisely so failures land here as an ApiError instead of a bare
 * network exception. See public/sw.js.
 */
function isOfflineError(err) {
  if (err instanceof ApiError) return err.status === 503;
  return err instanceof TypeError || !navigator.onLine;
}

/** Set while the "can't reach the server" notice is on screen, so that
 * reconnecting can clear it without anyone tapping anything. */
let awaitingReconnect = false;

/** The installed app has no browser error page behind it: a failed boot would
 * otherwise leave a home-screen icon that opens to "Loading…" forever. */
function renderBootFailure(err) {
  console.error(err);
  if (isOfflineError(err)) {
    awaitingReconnect = true;
    renderNotice(
      "Can't reach GymBook",
      'You appear to be offline. Nothing has been lost — reconnect and this page will pick up where it left off.',
      [h('button', { class: 'btn primary', onclick: () => boot() }, 'Try again')],
    );
    return;
  }
  renderNotice('Could not start GymBook', err?.message || 'Unexpected error', [
    h('button', { class: 'btn primary', onclick: () => boot() }, 'Try again'),
  ]);
}

async function boot() {
  try {
    platform = await loadPlatformContext();
    // The real fix for a currency that used to come from /api/health, which
    // never returned one — every gym rendered INR regardless of its setting.
    setCurrency(platform.tenant?.currency);
    // Decides every label in the sidebar and every route title below — must
    // run before buildNav()/buildRoutes(), and before anything reads t().
    setVertical(platform.tenant?.business_type);
    NAV = buildNav();
    ROUTES = buildRoutes();
    document.title = `${gymName()} — ${isLibrary() ? 'Study Hall Management' : 'Gym Management'}`;
    // A gym that uploaded a logo installs and appears in the tab strip under
    // its own brand, not GymBook's barbell. A member landing straight on
    // #/portal (their normal entry point — a link or QR code from the gym,
    // not a click-through from the staff app) sees install copy that calls
    // it "<Gym> Member", matching the distinct manifest applyManifestLink()
    // picks for that route.
    applyGymIcons(platform.tenant?.app_icon_url, currentPath().startsWith('/portal') ? `${gymName()} Member` : gymName());
    await dispatch();
    awaitingReconnect = false;
  } catch (err) {
    renderBootFailure(err);
  }
}

window.addEventListener('hashchange', () => {
  dispatch().catch(renderBootFailure);
});

window.addEventListener('online', () => {
  if (awaitingReconnect) boot();
});

/** Drops the session and shows whatever this address offers signed-out
 * visitors — a gym's login card, or the landing page on the root domain. */
function signOut(message) {
  session.clear();
  shell = undefined;
  if (platform.tenant) {
    renderLogin(typeof message === 'string' ? message : undefined);
    return;
  }
  if (currentPath() === '/' || currentPath() === '') {
    renderPublicRoute(PUBLIC_ROUTES[0]);
  } else {
    navigate('/'); // fires hashchange -> dispatch()
  }
}

window.addEventListener('gymbook:signed-out', () => {
  signOut('Your session expired — please sign in again');
});

// The member portal manages its own session entirely inside views/portal.js —
// api.js already cleared memberSession by the time this fires, so all that's
// needed here is to re-enter the portal route, which will now paint its
// sign-in screen instead of the app shell. A no-op anywhere else: nothing
// outside the portal depends on a member session.
window.addEventListener('gymbook:member-signed-out', () => {
  if (currentPath().startsWith('/portal')) dispatch().catch(renderBootFailure);
});

// Raised by the settings page after a rename or logo change. Repainting the brand
// element beats rebuilding the shell and losing scroll position.
window.addEventListener('gymbook:gym-updated', (event) => {
  platform = { ...platform, tenant: event.detail };
  document.title = `${gymName()} — Gym Management`;
  applyGymIcons(platform.tenant?.app_icon_url, gymName());
  const brand = shell?.nav.querySelector('.brand');
  if (brand) {
    brand.setAttribute('title', gymName());
    clear(brand).append(renderBrandLogoNode(), gymName());
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setNavOpen(false);
});

/* Rotating a phone to landscape, or dragging a desktop window wider, can cross
 * 900px while the drawer is open — the drawer styles stop applying but
 * body.nav-open would keep the page unscrollable. */
window.matchMedia('(min-width: 901px)').addEventListener('change', (event) => {
  if (event.matches) setNavOpen(false);
});

function updateFullscreenButtons(active = isFullscreen()) {
  document.body.classList.toggle('is-fullscreen', active);
  const label = active ? 'Exit Fullscreen' : 'Enter Fullscreen Mode';
  const icon = active ? 'minimize' : 'maximize';

  const topbarBtn = document.getElementById('btn-fullscreen-topbar');
  if (topbarBtn) {
    topbarBtn.title = label;
    topbarBtn.setAttribute('aria-label', label);
    setControlIcon(topbarBtn, icon);
  }
  const sidebarBtn = document.getElementById('btn-fullscreen-sidebar');
  if (sidebarBtn) {
    sidebarBtn.title = label;
    setControlIcon(sidebarBtn, icon, 'Fullscreen');
  }
  const checkinBtn = document.getElementById('btn-fullscreen-checkin');
  if (checkinBtn) {
    checkinBtn.title = label;
    setControlIcon(checkinBtn, icon, active ? 'Exit Fullscreen' : 'Kiosk Fullscreen');
  }
}

onFullscreenChange((active) => {
  updateFullscreenButtons(active);
});

boot();
