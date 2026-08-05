import { ApiError, api, session } from './api.js';
import { buildForm, clear, h, openModal, setCurrency, toast } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMembers, renderMemberDetail } from './views/members.js';
import { renderCheckIn } from './views/checkin.js';
import { renderPlans } from './views/plans.js';
import { renderBilling } from './views/billing.js';
import { renderClasses } from './views/classes.js';
import { renderEquipment } from './views/equipment.js';
import { renderStaff } from './views/staff.js';
import { renderDevices } from './views/devices.js';
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
  { path: '/staff', label: 'Staff', icon: '👥' },
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
  { pattern: /^\/staff$/, title: 'Staff', view: renderStaff },
];

const root = () => document.getElementById('app');

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/dashboard';
}

export function navigate(path) {
  window.location.hash = path;
}

/* ------------------------------------------------------------------- login */

function renderLogin(message) {
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

  clear(root()).append(
    h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        h('h1', {}, '🏋️ GymBook'),
        h('p', { class: 'sub' }, 'Gym management — members, billing, classes and check-ins.'),
        message ? h('p', { class: 'field-error' }, message) : null,
        form,
        h(
          'div',
          { class: 'login-hint' },
          h('strong', {}, 'Demo logins'),
          h('div', {}, 'admin@gymbook.local / admin12345 — owner'),
          h('div', {}, 'priyanka@gymbook.local / demo12345 — manager'),
          h('div', {}, 'desk@gymbook.local / demo12345 — front desk'),
        ),
      ),
    ),
  );
  root().className = '';
}

/* ------------------------------------------------------------------- shell */

function renderShell() {
  const user = session.user;
  const nav = h('nav', { class: 'sidebar' });
  nav.append(h('div', { class: 'brand' }, h('div', { class: 'logo' }, '🏋️'), 'GymBook'));

  for (const item of NAV) {
    if (item.section) {
      nav.append(h('div', { class: 'nav-section' }, item.section));
      continue;
    }
    nav.append(
      h(
        'a',
        { class: 'nav-link', href: `#${item.path}`, dataset: { path: item.path } },
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
        h(
          'button',
          {
            class: 'btn sm ghost',
            onclick: () => {
              session.clear();
              renderLogin();
            },
          },
          'Sign out',
        ),
      ),
    ),
  );

  const title = h('h1', {}, 'Dashboard');
  const content = h('div', { class: 'content' }, h('div', { class: 'empty' }, 'Loading…'));
  const actions = h('div', { class: 'row' });

  clear(root()).append(
    h(
      'div',
      { class: 'shell' },
      nav,
      h(
        'div',
        { class: 'main' },
        h('header', { class: 'topbar' }, title, h('div', { class: 'spacer' }), actions),
        content,
      ),
    ),
  );
  root().className = '';
  return { nav, title, content, actions };
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

async function renderRoute() {
  const path = currentPath();
  const match = ROUTES.map((route) => ({ route, params: path.match(route.pattern) })).find((r) => r.params);

  if (!match) {
    navigate('/dashboard');
    return;
  }

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

async function boot() {
  if (!session.token) {
    renderLogin();
    return;
  }
  try {
    const health = await fetch('/api/health').then((r) => r.json());
    setCurrency(health.currency);
    await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderLogin('Your session expired — please sign in again');
      return;
    }
  }
  shell = renderShell();
  await renderRoute();
}

window.addEventListener('hashchange', () => {
  if (session.token && shell) renderRoute();
});

window.addEventListener('gymbook:signed-out', () => {
  shell = undefined;
  renderLogin('Your session expired — please sign in again');
});

boot();
