import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { run, tenantStorage } from './db.js';
import { badRequest } from './errors.js';

/**
 * WhatsApp Web sessions, one per gym.
 *
 * Every piece of state here is keyed by tenant slug. A single shared socket
 * would let any gym on the platform read another gym's pairing QR and send
 * messages from their number, so the socket, the auth folder on disk, and the
 * send queue are all scoped the same way the tenant databases are.
 *
 * Baileys talks to WhatsApp's servers over a long-lived websocket. It drops
 * often (phone offline, server restart, WhatsApp rotating the session), so
 * reconnection has to be automatic but bounded — an unbounded retry loop
 * against a logged-out session is how accounts get flagged.
 */

const logger = pino({ level: 'silent' });

/** Auth credentials are secrets, so they live under data/ with the databases,
 * which .gitignore already covers. */
const AUTH_ROOT =
  process.env.WHATSAPP_AUTH_DIR || path.join(path.dirname(config.platformDbFile), 'whatsapp_auth');

/** Gap between two queued sends. WhatsApp flags accounts that blast messages
 * back to back, and a renewal-reminder sweep is exactly that shape. */
const MESSAGE_GAP_MS = Number(process.env.WHATSAPP_MESSAGE_GAP_MS || 2500);

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 2000;

/** slug -> session record. */
const sessions = new Map();

function currentSlug() {
  return tenantStorage.getStore()?.slug ?? DEFAULT_TENANT_SLUG;
}

function authFolderFor(slug) {
  return path.join(AUTH_ROOT, slug.replace(/[^a-z0-9_-]/gi, '_'));
}

function sessionFor(slug) {
  let session = sessions.get(slug);
  if (!session) {
    session = {
      slug,
      sock: null,
      state: 'DISCONNECTED', // DISCONNECTED | CONNECTING | QR_READY | CONNECTED
      qr: null,
      lastError: null,
      /** In-flight init. Guarding on this rather than on `state === 'CONNECTING'`
       * matters: the old code set the state to CONNECTING before scheduling a
       * reconnect, and the reconnect then bailed out on seeing it — so a single
       * dropped connection wedged the gym permanently. */
      starting: null,
      attempts: 0,
      reconnectTimer: null,
      /** Serialises sends so MESSAGE_GAP_MS actually applies across callers. */
      queue: Promise.resolve(),
    };
    sessions.set(slug, session);
  }
  return session;
}

function publicStatus(session) {
  return {
    state: session.state,
    qr: session.qr,
    connected: session.state === 'CONNECTED',
    error: session.lastError,
  };
}

/** True when this gym has previously paired and creds are still on disk. */
export function hasStoredCredentials(slug) {
  return fs.existsSync(path.join(authFolderFor(slug), 'creds.json'));
}

export function getWhatsAppStatus(slug = currentSlug()) {
  return publicStatus(sessionFor(slug));
}

/** Detaches listeners and closes the websocket without triggering the
 * reconnect path — used before replacing a socket and on logout. */
function teardown(session) {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  const sock = session.sock;
  session.sock = null;
  if (!sock) return;
  try {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('creds.update');
    sock.end(undefined);
  } catch {
    // Already dead; nothing to clean up.
  }
}

function scheduleReconnect(session) {
  if (session.attempts >= MAX_RECONNECT_ATTEMPTS) {
    session.state = 'DISCONNECTED';
    session.qr = null;
    session.lastError = 'Lost the WhatsApp connection. Reconnect from the WhatsApp page.';
    console.warn(`[whatsapp:${session.slug}] giving up after ${session.attempts} reconnect attempts`);
    return;
  }
  const delay = RECONNECT_BASE_MS * 2 ** session.attempts;
  session.attempts += 1;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    connectWhatsApp({ slug: session.slug, force: true }).catch((err) => {
      console.error(`[whatsapp:${session.slug}] reconnect failed:`, err.message);
    });
  }, delay);
  session.reconnectTimer.unref?.();
}

/**
 * Brings a gym's WhatsApp session up, returning as soon as the socket exists —
 * pairing finishes asynchronously when the owner scans the QR, which the
 * front end polls for via getWhatsAppStatus().
 *
 * @param {object}  [opts]
 * @param {string}  [opts.slug]  Gym to connect; defaults to the request's tenant.
 * @param {boolean} [opts.force] Tear down a live socket and start fresh.
 */
export async function connectWhatsApp({ slug = currentSlug(), force = false } = {}) {
  const session = sessionFor(slug);

  if (session.state === 'CONNECTED' && !force) return publicStatus(session);
  // Coalesce concurrent callers onto one in-flight attempt rather than
  // refusing them, so a second click never wedges the session.
  if (session.starting) {
    await session.starting.catch(() => {});
    return publicStatus(session);
  }

  session.starting = (async () => {
    teardown(session);
    session.state = 'CONNECTING';
    session.qr = null;
    session.lastError = null;

    const folder = authFolderFor(slug);
    fs.mkdirSync(folder, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(folder);

    const sock = makeWASocket({
      auth: state,
      logger,
      browser: ['GymBook', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    session.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      // A socket replaced by a newer one must not keep mutating shared state.
      if (session.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          session.qr = await QRCode.toDataURL(qr);
          session.state = 'QR_READY';
        } catch (err) {
          console.error(`[whatsapp:${slug}] could not render QR:`, err.message);
        }
      }

      if (connection === 'open') {
        session.state = 'CONNECTED';
        session.qr = null;
        session.lastError = null;
        session.attempts = 0;
        console.log(`[whatsapp:${slug}] connected`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        session.sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          // The owner unlinked the device from their phone. The creds on disk
          // are dead — keeping them would retry forever against a session
          // WhatsApp has already revoked.
          session.state = 'DISCONNECTED';
          session.qr = null;
          session.attempts = 0;
          session.lastError = 'This gym was unlinked from WhatsApp. Scan the QR code again to reconnect.';
          clearAuthFolder(slug);
          console.log(`[whatsapp:${slug}] logged out from the phone; credentials cleared`);
          return;
        }

        session.state = 'CONNECTING';
        console.log(`[whatsapp:${slug}] connection closed (status ${statusCode}); reconnecting`);
        scheduleReconnect(session);
      }
    });

    return publicStatus(session);
  })();

  try {
    return await session.starting;
  } catch (err) {
    session.state = 'DISCONNECTED';
    session.qr = null;
    session.lastError = err.message || 'Could not start the WhatsApp connection';
    console.error(`[whatsapp:${slug}] init failed:`, err.message);
    return publicStatus(session);
  } finally {
    session.starting = null;
  }
}

function clearAuthFolder(slug) {
  try {
    fs.rmSync(authFolderFor(slug), { recursive: true, force: true });
  } catch (err) {
    console.error(`[whatsapp:${slug}] could not clear credentials:`, err.message);
  }
}

/** Unlinks the gym from WhatsApp and wipes its stored credentials. */
export async function logoutWhatsApp(slug = currentSlug()) {
  const session = sessionFor(slug);
  try {
    await session.sock?.logout();
  } catch {
    // Already gone — the local teardown below is what actually matters.
  }
  teardown(session);
  session.state = 'DISCONNECTED';
  session.qr = null;
  session.attempts = 0;
  session.lastError = null;
  clearAuthFolder(slug);
  return publicStatus(session);
}

/**
 * Normalises a stored phone number into a WhatsApp JID.
 *
 * Members are typed in however staff got them — "+91 98765-43210",
 * "098765 43210", "9876543210". WhatsApp wants digits with a country code and
 * no leading zeros. A bare national number gets the gym's default country code
 * (WHATSAPP_COUNTRY_CODE, 91 for India), since that is what a local gym's
 * roster is full of.
 */
export function formatPhoneNumber(phone, defaultCountryCode = process.env.WHATSAPP_COUNTRY_CODE || '91') {
  if (phone === null || phone === undefined) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;

  // A trunk prefix ("0" before a national number) is never part of the
  // international form.
  digits = digits.replace(/^0+/, '');
  if (!digits) return null;

  // 11-15 digits already carries a country code; 10 or fewer does not.
  if (digits.length <= 10) digits = `${defaultCountryCode}${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;

  return `${digits}@s.whatsapp.net`;
}

/** Writes the delivery log into the gym's own database, re-entering the tenant
 * context because queued sends resolve outside the request that scheduled them. */
function logDelivery(store, row) {
  const write = () =>
    run(
      `INSERT INTO whatsapp_logs (phone, member_id, type, message, status, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.phone, row.memberId, row.type, row.message, row.status, row.error],
    );
  try {
    if (store) tenantStorage.run(store, write);
    else write();
  } catch (err) {
    console.error('[whatsapp] could not write the delivery log:', err.message);
  }
}

/**
 * Sends one WhatsApp text message and records the outcome.
 *
 * Sends are queued per gym and spaced by MESSAGE_GAP_MS. Callers get a promise
 * that settles when their own message has actually gone out, so a failure is
 * still reportable even though the send may have waited behind others.
 */
export async function sendWhatsAppMessage({ phone, message, document = null, image = null, type = 'custom', memberId = null, slug = currentSlug() }) {
  const session = sessionFor(slug);
  // Captured now, while we are still inside the caller's request context.
  const store = tenantStorage.getStore();
  const jid = formatPhoneNumber(phone);

  /** Logs the failure, then throws it as a 400 — every reason a send can fail
   * here (unlinked, no number, not on WhatsApp) is something the caller can
   * fix, so it must not surface as a 500 with a stack trace. */
  const fail = (reason) => {
    logDelivery(store, { phone: String(phone ?? ''), memberId, type, message, status: 'failed', error: reason });
    throw badRequest(reason);
  };

  if (!phone) fail('No phone number on file for this member');
  if (!jid) fail(`"${phone}" is not a valid phone number`);
  if (!message && !document && !image) fail('Message is empty');
  if (session.state !== 'CONNECTED' || !session.sock) {
    fail('WhatsApp is not connected. Scan the QR code on the WhatsApp page first.');
  }

  const send = async () => {
    const sock = session.sock;
    if (session.state !== 'CONNECTED' || !sock) {
      fail('WhatsApp disconnected before this message could be sent');
    }

    // A number that is not on WhatsApp accepts the send and silently discards
    // it, which would otherwise be logged as a success nobody ever received.
    try {
      const [found] = await sock.onWhatsApp(jid);
      if (found && found.exists === false) fail(`${phone} is not registered on WhatsApp`);
    } catch (err) {
      if (err.message.includes('not registered on WhatsApp')) throw err;
      // The lookup itself failing is not a reason to refuse the send.
    }

    try {
      if (image && image.buffer) {
        await sock.sendMessage(jid, {
          image: image.buffer,
          mimetype: image.mimetype || 'image/png',
          caption: image.caption || message || '',
        });
      } else if (document && document.buffer) {
        await sock.sendMessage(jid, {
          document: document.buffer,
          fileName: document.fileName || 'Receipt.pdf',
          mimetype: document.mimetype || 'application/pdf',
          caption: message || '',
        });
      } else {
        await sock.sendMessage(jid, { text: message });
      }
    } catch (err) {
      fail(err.message || 'WhatsApp rejected the message');
    }

    logDelivery(store, { phone: String(phone), memberId, type, message, status: 'sent', error: null });
    return { ok: true };
  };

  // Chain onto the queue, and keep the queue alive past a rejected link.
  const result = session.queue.then(send);
  session.queue = result.then(
    () => new Promise((resolve) => setTimeout(resolve, MESSAGE_GAP_MS)),
    () => new Promise((resolve) => setTimeout(resolve, MESSAGE_GAP_MS)),
  );
  return result;
}

/** Substitutes {{placeholders}} in a message template. Unknown placeholders are
 * left alone so a typo in a template is visible rather than silently blank. */
export function renderTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(vars, key) && vars[key] !== null && vars[key] !== undefined ? String(vars[key]) : match,
  );
}

/** Builds the payment-receipt message. Lives here rather than in a route so the
 * manual "send receipt" button and the auto-send on payment render identically. */
export function receiptMessage(payment, { gymName, template }) {
  return renderTemplate(template, {
    first_name: payment.first_name,
    last_name: payment.last_name,
    amount: payment.amount,
    plan_name: payment.plan_name || 'Membership',
    end_date: payment.end_date || '—',
    gym_name: gymName,
    paid_on: payment.paid_on,
    method: payment.method,
  });
}

/** Builds the renewal-reminder message, shared by the button and the sweep. */
export function reminderMessage(sub, { gymName, template }) {
  return renderTemplate(template, {
    first_name: sub.first_name,
    last_name: sub.last_name,
    plan_name: sub.plan_name,
    end_date: sub.end_date,
    gym_name: gymName,
  });
}

/** Builds the freeze-notice message, sent when a membership is frozen. */
export function freezeMessage(sub, { gymName, template }) {
  return renderTemplate(template, {
    first_name: sub.first_name,
    last_name: sub.last_name,
    plan_name: sub.plan_name,
    end_date: sub.end_date,
    frozen_on: sub.frozen_on,
    gym_name: gymName,
  });
}

/** Builds the birthday-wish message, shared by the dashboard button and any
 * future auto-send. */
export function birthdayMessage(member, { gymName, template }) {
  return renderTemplate(template, {
    first_name: member.first_name,
    last_name: member.last_name,
    gym_name: gymName,
  });
}

/** Closes every socket — for graceful shutdown. */
export function closeAllWhatsAppSessions() {
  for (const session of sessions.values()) teardown(session);
}
