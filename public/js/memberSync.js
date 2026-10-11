import { api, memberSession, pathSlug } from './api.js';

/**
 * State the member app keeps on the phone — the store cart, a workout in
 * progress, the member's own exercises — mirrored to their account so signing
 * in on another phone picks it up (GET/PUT /api/portal/state/:key).
 *
 * The device copy stays what the screens read, synchronously and offline; the
 * server is told shortly after each change. A change that has not reached the
 * server yet (a dead signal on the gym floor) is flagged `.unsynced` on the
 * device and sent on the next pull, instead of being overwritten there by the
 * older copy on the server.
 */

const instances = new Set();

/**
 * `localName` is the device key under "gymbook.", scoped by gym and member
 * like the session keys in api.js — two members sharing a phone must not
 * inherit each other's cart or workout. `legacyKey` is an unscoped key from
 * before syncing; whatever it holds is handed to the next member to sign in.
 */
export function memberSynced(remoteKey, localName, { delay = 600, legacyKey = null } = {}) {
  let version = 0;
  let timer = null;
  let pendingKey = null;

  const keyFor = () => {
    const id = memberSession.member?.id;
    return id ? `gymbook.${localName}${pathSlug ? `.${pathSlug}` : ''}.${id}` : null;
  };
  const rawGet = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const rawSet = (key, raw) => {
    try {
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    } catch {
      // Private mode or full storage: this just won't survive a reload.
    }
  };
  const flagKey = (key) => `${key}.unsynced`;
  const isUnsynced = (key) => rawGet(flagKey(key)) === '1';

  function adoptLegacy(key) {
    if (!legacyKey) return;
    const old = rawGet(legacyKey);
    if (old === null) return;
    rawSet(legacyKey, null);
    if (rawGet(key) !== null) return;
    rawSet(key, old);
    rawSet(flagKey(key), '1');
  }

  function read() {
    const key = keyFor();
    if (!key) return null;
    adoptLegacy(key);
    try {
      return JSON.parse(rawGet(key));
    } catch {
      return null;
    }
  }

  async function send(key) {
    clearTimeout(timer);
    timer = null;
    pendingKey = null;
    // Signed out (or someone else signed in) before it went: it stays flagged
    // on the device and goes up on that member's next pull.
    if (key !== keyFor()) return;
    const sending = version;
    try {
      await api.portal.saveAppState(remoteKey, read());
      if (version === sending) rawSet(flagKey(key), null);
    } catch {
      // Still flagged: the next pull sends it.
    }
  }

  const self = {
    read,
    /** `null` clears it — on every device, once it syncs. */
    write(value) {
      const key = keyFor();
      if (!key) return;
      version += 1;
      rawSet(key, value == null ? null : JSON.stringify(value));
      rawSet(flagKey(key), '1');
      clearTimeout(timer);
      pendingKey = key;
      timer = setTimeout(() => send(key), delay);
    },
    /** Sends a change still waiting out its delay. */
    flush: () => (pendingKey ? send(pendingKey) : Promise.resolve()),
    /**
     * Brings the device copy up to date with the account. Resolves true when
     * it changed, so the caller knows to repaint. Never rejects: offline, the
     * device copy simply stands.
     */
    async pull() {
      const key = keyFor();
      if (!key) return false;
      adoptLegacy(key);
      try {
        if (isUnsynced(key)) {
          await send(key);
          return false;
        }
        const startedAt = version;
        const remote = await api.portal.appState(remoteKey);
        // Changed here while the request was out: this device's copy is newer.
        if (version !== startedAt || isUnsynced(key) || key !== keyFor()) return false;
        if (remote.updated_at === null) {
          // Never synced: what this phone had from before syncing goes up.
          if (rawGet(key) !== null) await send(key);
          return false;
        }
        const before = rawGet(key);
        rawSet(key, remote.value == null ? null : JSON.stringify(remote.value));
        return rawGet(key) !== before;
      } catch {
        return false;
      }
    },
  };
  instances.add(self);
  return self;
}

/** Sends every change still waiting — before signing out, while the token
 * is still good, and when the app goes to the background. */
export const flushMemberSync = () => Promise.all([...instances].map((s) => s.flush()));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushMemberSync();
});
