import { ApiError, api, pathSlug, session } from './api.js';
import { buildForm, clear, h, openModal, setCurrency, toast } from './ui.js';
import { renderLanding } from './views/landing.js';
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

const NAV = [
  { section: 'Daily' },
  { path: '/dashboard', label: 'Dashboard', icon: '📊' },
  { path: '/check-in', label: 'Check-in desk', icon: '🎫' },
  { path: '/members', label: 'Members', icon: '🧑' },
  { section: 'Business' },
  { path: '/billing', label: 'Memberships & billing', icon: '💳' },
  { path: '/plans', label: 'Plans', icon: '🏷️' },
  { path: '/reports', label: 'Reports', icon: '📈' },
  { section: 'Operations' },
  { path: '/classes', label: 'Classes', icon: '🧘' },
  { path: '/equipment', label: 'Equipment', icon: '🏋️' },
  { path: '/devices', label: 'Biometric devices', icon: '🖐️' },
  { path: '/sessions', label: 'Gym sessions', icon: '⏰' },
  { path: '/staff', label: 'Staff', icon: '👥' },
  { path: '/settings', label: 'Gym settings', icon: '⚙️' },
];

const ROUTES = [
  { pattern: /^\/dashboard$/, title: 'Dashboard', view: renderDashboard },
  { pattern: /^\/check-in$/, title: 'Check-in desk', view: renderCheckIn },
  { pattern: /^\/members$/, title: 'Members', view: renderMembers },
  { pattern: /^\/members\/(\d+)$/, title: 'Member', view: renderMemberDetail },
  { pattern: /^\/billing$/, title: 'Memberships & billing', view: renderBilling },
  { pattern: /^\/plans$/, title: 'Membership plans', view: renderPlans },
  { pattern: /^\/reports$/, title: 'Reports', view: renderReports },
  { pattern: /^\/classes$/, title: 'Classes & timetable', view: renderClasses },
  { pattern: /^\/equipment$/, title: 'Equipment', view: renderEquipment },
  { pattern: /^\/devices$/, title: 'Biometric devices', view: renderDevices },
  { pattern: /^\/sessions$/, title: 'Gym sessions', view: renderSessions },
  { pattern: /^\/staff$/, title: 'Staff', view: renderStaff },
  { pattern: /^\/settings$/, title: 'Gym settings', view: renderSettings },
];

/**
 * Pages that exist before anyone signs in, and outside any one gym.
 *
 * These render full-page instead of inside the app shell: the shell's sidebar
 * is a gym's navigation, and on the root domain there is no gym for it to
 * navigate. Matched ahead of the authenticated routes above.
 */
const PUBLIC_ROUTES = [
  { pattern: /^\/?$/, title: 'GymBook', view: renderLanding },
  { pattern: /^\/signup$/, title: 'Set up your gym', view: renderSignup },
  { pattern: /^\/platform$/, title: 'Operator console', view: renderPlatformConsole },
  // Public by necessity — someone redeeming a reset link cannot sign in. The
  // pattern allows the trailing `?token=…` the link carries in the hash.
  { pattern: /^\/reset(\?|$)/, title: 'Set a new password', view: renderReset },
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
    : '🏋️';

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
          tenant ? 'Sign in to your gym.' : 'Gym management — members, billing, classes and check-ins.',
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
          'div',
          { class: 'row', style: 'margin-top:16px;justify-content:center' },
          h('a', { class: 'btn sm ghost', href: '#/signup' }, 'Set up a new gym'),
        ),
      ),
    ),
  );
  root().className = '';
}

function renderBrandLogoNode() {
  const logoUrl = platform.tenant?.logo_url;
  if (logoUrl) {
    return h('div', { class: 'logo' }, h('img', { class: 'logo-img', src: logoUrl, alt: gymName() }));
  }
  return h('div', { class: 'logo' }, '🏋️');
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
        h('span', { class: 'icon' }, item.icon),
        item.label,
      ),
    );
  }

  nav.append(
    h(
      'div',
      { class: 'sidebar-footer' },
      h('div', {}, user?.name || ''),
      h('div', { style: 'text-transform:capitalize;font-size:12px' }, user?.role || ''),
      h(
        'div',
        { class: 'row', style: 'margin-top:10px;gap:6px' },
        h('button', { class: 'btn sm ghost', onclick: openPasswordModal }, 'Password'),
        h('button', { class: 'btn sm ghost', onclick: signOut }, 'Sign out'),
      ),
    ),
  );

  const title = h('h1', {}, 'Dashboard');
  const content = h('div', { class: 'content' }, h('div', { class: 'empty' }, 'Loading…'));
  const actions = h('div', { class: 'row' });

  const navToggle = h(
    'button',
    {
      class: 'btn ghost nav-toggle',
      type: 'button',
      'aria-label': 'Open navigation',
      'aria-expanded': 'false',
      onclick: () => setNavOpen(!nav.classList.contains('open')),
    },
    '☰',
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
        h('header', { class: 'topbar' }, navToggle, title, h('div', { class: 'spacer' }), actions),
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
  document.title = `${publicRoute.title} — GymBook`;

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
  const skipLanding = publicRoute?.view === renderLanding && Boolean(platform.tenant || session.token);

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

async function boot() {
  platform = await loadPlatformContext();
  // The real fix for a currency that used to come from /api/health, which
  // never returned one — every gym rendered INR regardless of its setting.
  setCurrency(platform.tenant?.currency);
  document.title = `${gymName()} — Gym Management`;
  await dispatch();
}

window.addEventListener('hashchange', () => {
  dispatch();
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

// Raised by the settings page after a rename or logo change. Repainting the brand
// element beats rebuilding the shell and losing scroll position.
window.addEventListener('gymbook:gym-updated', (event) => {
  platform = { ...platform, tenant: event.detail };
  document.title = `${gymName()} — Gym Management`;
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

boot();
