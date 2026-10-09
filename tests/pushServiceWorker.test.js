import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeEach, describe, it } from 'node:test';

/**
 * The push half of public/sw.js, run in a sandbox with a fake worker global —
 * no browser can be driven to receive a real push in CI, but the handlers'
 * decisions (silent or not, which window to reuse) are plain logic.
 */
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js'), 'utf8');

let listeners;
let shown;
let opened;
let badges;
let windows;

function worker() {
  listeners = {};
  shown = [];
  opened = [];
  badges = [];
  windows = [];
  const self = {
    location: { origin: 'https://gym.test' },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    registration: {
      showNotification: async (title, options) => shown.push({ title, options }),
      pushManager: { subscribe: async () => ({}) },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => opened.push(url),
      claim: async () => {},
    },
    navigator: {
      setAppBadge: async (n) => badges.push(n),
      clearAppBadge: async () => badges.push(0),
    },
    skipWaiting() {},
  };
  vm.runInNewContext(source, { self, caches: {}, URL, Response, Request, fetch, console });
}

function fakeWindow(url, { focused = false } = {}) {
  const win = { url, focused, visibilityState: focused ? 'visible' : 'hidden', messages: [], focusCalls: 0 };
  win.postMessage = (message) => win.messages.push(message);
  win.focus = async () => {
    win.focusCalls += 1;
    return win;
  };
  return win;
}

async function dispatch(type, event) {
  const pending = [];
  listeners[type]({ ...event, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

const pushEvent = (payload) => ({ data: { json: () => payload, text: () => JSON.stringify(payload) } });

describe('service worker push handling', () => {
  beforeEach(worker);

  it('shows the notification with sound, vibration and the deep link', async () => {
    await dispatch(
      'push',
      pushEvent({ title: 'Time for water', body: 'You are behind', url: '/g/acme/#/portal/diet', tag: 'water-reminder', sound: 1, vibrate: 1, unread: 3, icon: '/api/platform/tenant-icon/acme?v=2', badge: '/icons/badge-96.png', image: '/g/acme/api/announcement-images/7?t=ab' }),
    );
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'Time for water');
    assert.equal(shown[0].options.silent, false);
    assert.equal(JSON.stringify(shown[0].options.vibrate), '[120,60,120]');
    assert.equal(shown[0].options.data.url, '/g/acme/#/portal/diet');
    assert.equal(shown[0].options.renotify, true);
    assert.deepEqual(badges, [3]);
    assert.equal(shown[0].options.icon, '/api/platform/tenant-icon/acme?v=2');
    assert.equal(shown[0].options.badge, '/icons/badge-96.png');
    assert.equal(shown[0].options.image, '/g/acme/api/announcement-images/7?t=ab');
  });

  it('stays silent when the member turned sound off', async () => {
    await dispatch('push', pushEvent({ title: 'x', sound: 0, vibrate: 1 }));
    assert.equal(shown[0].options.silent, true);
    assert.equal(shown[0].options.vibrate, undefined);
  });

  it('defers to the in-app chime when the app is open on screen, but still shows the notification', async () => {
    const open = fakeWindow('https://gym.test/g/acme/#/portal', { focused: true });
    windows = [open];
    await dispatch('push', pushEvent({ title: 'Closed today', sound: 1, vibrate: 1, urgent: 1 }));
    assert.equal(shown.length, 1, 'a push must always end in a visible notification');
    assert.equal(shown[0].options.silent, true);
    assert.equal(shown[0].options.requireInteraction, true);
    assert.equal(open.messages[0].type, 'gymbook:push');
    assert.equal(open.messages[0].foreground, true);
  });

  it('survives a payload that is not JSON', async () => {
    await dispatch('push', { data: { json: () => JSON.parse('not json'), text: () => 'plain text' } });
    assert.equal(shown[0].options.body, 'plain text');
  });

  it('reuses an open window of the same gym on tap', async () => {
    const acme = fakeWindow('https://gym.test/g/acme/#/portal');
    const pulse = fakeWindow('https://gym.test/g/pulse/#/portal');
    windows = [pulse, acme];
    let closed = false;
    await dispatch('notificationclick', {
      notification: { data: { url: '/g/acme/#/portal/workout' }, close: () => (closed = true) },
    });
    assert.ok(closed);
    assert.equal(acme.focusCalls, 1);
    // Compared as JSON: objects built inside the sandbox have its prototypes.
    assert.equal(JSON.stringify(acme.messages), JSON.stringify([{ type: 'gymbook:navigate', url: 'https://gym.test/g/acme/#/portal/workout' }]));
    assert.equal(pulse.focusCalls, 0);
    assert.deepEqual(opened, []);
  });

  it('opens a new window when no window of that gym is open', async () => {
    windows = [fakeWindow('https://gym.test/g/pulse/#/portal')];
    await dispatch('notificationclick', { notification: { data: { url: '/g/acme/#/portal/pay' }, close() {} } });
    assert.deepEqual(opened, ['https://gym.test/g/acme/#/portal/pay']);
  });
});
