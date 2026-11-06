import { api, pathPrefix, session } from './api.js';
import { keyBytes, onPushMessage, permissionState, platformName, pushCapability, registration, sameKey, setAppBadge } from './push.js';
import { clear, closeModal, h, openModal, renderIcon, toast } from './ui.js';

/**
 * The bell in the staff app's topbar: an unread count, a drop-down inbox of
 * alerts (payments to confirm, expiries, trials booked…), and a settings
 * dialog for which alerts this person gets and whether this browser shows
 * them as notifications. What is sent and to whom is src/staffAlerts.js.
 *
 * Staff push is plain Web Push — the Android app is the member app only — and
 * shares the browser's one subscription with the member portal's, so turning
 * staff alerts off here only tells the server to stop; it never unsubscribes
 * the browser out from under a member signed in to the portal on it.
 */

const POLL_MS = 60_000;
const OWNER_KEY = `gymbook.staffpush.owner${pathPrefix ? `.${pathPrefix.slice(3)}` : ''}`;

const KIND_ICON = {
  payment_claim: ['wallet', 'green'],
  fees_overdue: ['wallet', 'red'],
  membership_expired: ['alert', 'red'],
  membership_expiring: ['hourglass', 'amber'],
  trial_booked: ['ticket', 'blue'],
  chat_handoff: ['whatsapp', 'green'],
  test: ['bell', 'violet'],
};

const readStore = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStore = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the worst case is asking again.
  }
};

/** "just now", "5 min ago", "3 h ago", "2 days ago" — from a UTC `YYYY-MM-DD HH:MM:SS`. */
function ago(stamp) {
  const then = Date.parse(`${String(stamp).replace(' ', 'T')}Z`);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------ staff push */

const me = () => String(session.user?.id ?? '');

/** Whether this browser is showing *this* person's alerts as notifications. */
export const staffPushOnHere = () => readStore(OWNER_KEY) === me() && permissionState() === 'granted';

/** Asks for permission and registers this browser. Call straight from a tap. */
async function enableStaffPush(publicKey) {
  const capability = pushCapability();
  if (capability === 'ios-install') throw new Error('On iPhone, add this app to your Home Screen first, then turn notifications on from there.');
  if (capability === 'insecure') throw new Error('Notifications need the secure (https) address of this app.');
  if (capability === 'denied') throw new Error('Notifications are blocked for this site — allow them in your browser’s site settings.');
  if (capability !== 'ready') throw new Error('This browser cannot show notifications.');
  // First, before any other await, so iOS still counts it as part of the tap.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new Error('Notifications are blocked — allow them in your browser’s site settings.');
  if (permission !== 'granted') throw new Error('Notifications were not turned on.');

  const reg = await registration();
  if (!reg) throw new Error('The app is still installing — try again in a moment.');
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  try {
    subscription ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  } catch {
    throw new Error('This browser could not register for notifications. Private or incognito windows cannot receive them.');
  }
  await api.staffAlerts.subscribe({ ...subscription.toJSON(), platform: platformName(), path_prefix: pathPrefix });
  writeStore(OWNER_KEY, me());
}

/** Stops this browser getting staff alerts. Never throws. */
export async function releaseStaffPush() {
  writeStore(OWNER_KEY, null);
  try {
    const reg = await registration();
    const subscription = await reg?.pushManager.getSubscription();
    if (subscription) await api.staffAlerts.unsubscribe(subscription.endpoint);
  } catch {
    // Offline or signed out already: the server drops it after failed sends.
  }
}

/**
 * Run when the shell opens. Re-sends this person's subscription (browsers
 * rotate them), and if someone else turned alerts on in this browser and then
 * left without signing out, stops theirs arriving here.
 */
async function syncStaffPush() {
  const owner = readStore(OWNER_KEY);
  if (!owner) return;
  if (owner !== me()) {
    await releaseStaffPush();
    return;
  }
  if (pushCapability() !== 'ready' || permissionState() !== 'granted') return;
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) {
    writeStore(OWNER_KEY, null);
    return;
  }
  await api.staffAlerts
    .subscribe({ ...subscription.toJSON(), platform: platformName(), path_prefix: pathPrefix })
    .catch(() => {});
}

/* -------------------------------------------------------------- settings */

function toggle(checked, label, onToggle) {
  const button = h(
    'button',
    {
      class: `sa-switch${checked ? ' on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': String(checked),
      'aria-label': label,
    },
    h('span', { class: 'sa-switch-thumb' }),
  );
  button.addEventListener('click', async () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.disabled = true;
    try {
      await onToggle(next);
      button.classList.toggle('on', next);
      button.setAttribute('aria-checked', String(next));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

export async function openAlertSettings() {
  let config;
  try {
    config = await api.staffAlerts.config();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const deviceHost = h('div', { class: 'sa-device' });
  function paintDevice() {
    const on = staffPushOnHere();
    const capability = pushCapability();
    const blocked = capability === 'denied';
    clear(deviceHost).append(
      h(
        'div',
        { class: 'sa-pref-text' },
        h('strong', {}, 'Pop-up notifications on this device'),
        h(
          'small',
          {},
          on
            ? 'On — alerts show on this device even when the app is closed.'
            : blocked
              ? 'Blocked for this site — allow notifications in your browser’s site settings.'
              : capability === 'ios-install'
                ? 'On iPhone, add this app to your Home Screen first.'
                : 'Off — alerts only appear under the bell while the app is open.',
        ),
      ),
      h(
        'div',
        { class: 'sa-device-actions' },
        on
          ? h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: async (event) => {
                  event.currentTarget.disabled = true;
                  try {
                    const result = await api.staffAlerts.test();
                    toast(result.delivered ? 'Test sent — check your notifications' : 'Could not reach this device — try turning it off and on');
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                  paintDevice();
                },
              },
              'Send test',
            )
          : null,
        h(
          'button',
          {
            class: `btn sm${on ? ' ghost' : ' primary'}`,
            type: 'button',
            disabled: blocked && !on,
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              try {
                if (on) {
                  await releaseStaffPush();
                  toast('Notifications turned off on this device');
                } else {
                  await enableStaffPush(config.public_key);
                  toast('Notifications are on for this device');
                }
              } catch (err) {
                toast(err.message, 'error');
              }
              paintDevice();
            },
          },
          on ? 'Turn off' : 'Turn on',
        ),
      ),
    );
  }
  paintDevice();

  const rows = config.kinds.map((kind) => {
    const [icon, tone] = KIND_ICON[kind.key] ?? ['bell', 'grey'];
    return h(
      'div',
      { class: 'sa-pref' },
      h('span', { class: `sa-ico tone-${tone}` }, renderIcon(icon, { size: 17 })),
      h('div', { class: 'sa-pref-text' }, h('strong', {}, kind.label), h('small', {}, kind.hint)),
      toggle(Boolean(config.preferences[kind.key]), kind.label, async (next) => {
        config.preferences = await api.staffAlerts.savePreferences({ [kind.key]: next });
      }),
    );
  });

  openModal({
    title: 'My notifications',
    subtitle: 'Only you see these settings — everyone on the team chooses their own.',
    icon: 'bell',
    body: h(
      'div',
      { class: 'sa-settings' },
      deviceHost,
      h('h4', { class: 'sa-settings-head' }, 'Tell me about'),
      rows.length
        ? h('div', { class: 'sa-pref-list' }, ...rows)
        : h('p', { class: 'muted' }, 'There are no alerts for your role yet.'),
    ),
    footer: h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Done'),
  });
}

/* ------------------------------------------------------------------ bell */

/**
 * The topbar button. Returns the node to place, plus `stop()` for when the
 * shell is torn down (sign-out), which ends its polling and listeners.
 */
export function staffBell({ navigate }) {
  let unread = 0;
  let panel = null;
  let timer = null;

  const count = h('span', { class: 'sa-count', hidden: true });
  const button = h(
    'button',
    {
      class: 'btn ghost icon-only sa-bell',
      type: 'button',
      title: 'Notifications',
      'aria-label': 'Notifications',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onclick: () => (panel ? closePanel() : openPanel()),
    },
    renderIcon('bell'),
    count,
  );

  function setUnread(n) {
    unread = Math.max(0, Number(n) || 0);
    count.hidden = unread === 0;
    count.textContent = unread > 99 ? '99+' : String(unread);
    button.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    setAppBadge(unread);
  }

  async function refresh() {
    if (!session.token) return;
    try {
      setUnread((await api.staffAlerts.unread()).unread);
    } catch {
      // Offline for a moment: the next poll catches up.
    }
  }

  function onKey(event) {
    if (event.key === 'Escape') closePanel();
  }
  function onOutside(event) {
    if (panel && !panel.contains(event.target) && !button.contains(event.target)) closePanel();
  }

  function closePanel() {
    panel?.remove();
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside, true);
  }

  async function openPanel() {
    const list = h('div', { class: 'sa-list' }, h('p', { class: 'sa-empty muted' }, 'Loading…'));
    const markAll = h('button', { class: 'btn sm ghost', type: 'button', disabled: true }, renderIcon('check', { size: 15 }), 'Mark all read');
    panel = h(
      'div',
      { class: 'sa-panel', role: 'dialog', 'aria-label': 'Notifications' },
      h(
        'div',
        { class: 'sa-head' },
        h('strong', {}, 'Notifications'),
        h('div', { class: 'spacer' }),
        markAll,
        h(
          'button',
          {
            class: 'btn sm ghost icon-only',
            type: 'button',
            title: 'Notification settings',
            'aria-label': 'Notification settings',
            onclick: () => {
              closePanel();
              openAlertSettings();
            },
          },
          renderIcon('settings', { size: 16 }),
        ),
      ),
      list,
    );
    const rect = button.getBoundingClientRect();
    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
    document.body.append(panel);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside, true);

    let data;
    try {
      data = await api.staffAlerts.list({ limit: 40 });
    } catch (err) {
      clear(list).append(h('p', { class: 'sa-empty muted' }, err.message));
      return;
    }
    setUnread(data.unread);
    markAll.disabled = !data.unread;
    markAll.onclick = async () => {
      setUnread((await api.staffAlerts.markRead()).unread);
      for (const item of list.querySelectorAll('.sa-item.unread')) item.classList.remove('unread');
      markAll.disabled = true;
    };

    if (!data.items.length) {
      clear(list).append(
        h(
          'div',
          { class: 'sa-empty' },
          renderIcon('inbox', { size: 28 }),
          h('strong', {}, 'You’re all caught up'),
          h('small', { class: 'muted' }, 'Payments to confirm, expiries and front-desk alerts will show here.'),
        ),
      );
    } else {
      clear(list).append(
        ...data.items.map((item) => {
          const [icon, tone] = KIND_ICON[item.kind] ?? ['bell', 'grey'];
          return h(
            'button',
            {
              class: `sa-item${item.read_at ? '' : ' unread'}`,
              type: 'button',
              onclick: async () => {
                closePanel();
                if (!item.read_at) {
                  api.staffAlerts.markRead([item.id]).then((r) => setUnread(r.unread)).catch(() => {});
                }
                if (item.link) navigate(item.link);
              },
            },
            h('span', { class: `sa-ico tone-${tone}` }, renderIcon(icon, { size: 17 })),
            h(
              'span',
              { class: 'sa-item-text' },
              h('strong', {}, item.title),
              item.body ? h('span', {}, item.body) : null,
              h('small', {}, ago(item.created_at)),
            ),
          );
        }),
      );
    }

    // Nudge once towards pop-ups, if this browser could show them but doesn't.
    if (!staffPushOnHere() && pushCapability() === 'ready') {
      panel.append(
        h(
          'button',
          {
            class: 'sa-foot',
            type: 'button',
            onclick: () => {
              closePanel();
              openAlertSettings();
            },
          },
          renderIcon('bell', { size: 15 }),
          'Get these as pop-up notifications on this device',
        ),
      );
    }
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  // A push arriving while the app is open: the count is out of date.
  const offPush = onPushMessage((notification) => {
    if (String(notification.category || '').startsWith('staff:')) {
      if (Number.isFinite(notification.unread)) setUnread(notification.unread);
      else refresh();
      if (notification.title) toast(notification.title);
    }
  });

  refresh();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
  syncStaffPush().catch(() => {});

  return {
    node: button,
    refresh,
    stop() {
      clearInterval(timer);
      closePanel();
      document.removeEventListener('visibilitychange', onVisible);
      offPush();
      setAppBadge(0);
    },
  };
}
