import nodemailer from 'nodemailer';
import { badRequest } from './errors.js';

/**
 * Outgoing email, for the one thing the app needs it for: a member's
 * "email me a code" password setup. One platform-wide SMTP account sends for
 * every gym, with the gym's name as the display name on the From line.
 *
 * Off until SMTP_HOST is set — every caller checks emailEnabled() first and
 * tells the member to ask the front desk instead. MAIL_TRANSPORT=memory keeps
 * messages in `outbox` rather than sending them, which is what the tests use.
 */

const memoryMode = () => process.env.MAIL_TRANSPORT === 'memory';

/** Messages captured in memory mode, oldest first. */
export const outbox = [];

let transport = null;

export function emailEnabled() {
  return memoryMode() || Boolean(process.env.SMTP_HOST);
}

function transportFor() {
  if (transport) return transport;
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587/25 upgrade with STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

/** The bare address mail goes out from: MAIL_FROM, else the SMTP login. */
function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@gymbook.app';
}

/**
 * Sends one message. A provider failure surfaces as a 400 the member can read
 * ("could not send the email"), never a 500 with the SMTP server's reply in it.
 */
export async function sendEmail({ to, subject, text, html, fromName }) {
  if (!emailEnabled()) throw badRequest('Email is not set up on this server');
  const from = fromName ? { name: fromName, address: fromAddress() } : fromAddress();

  if (memoryMode()) {
    outbox.push({ to, from, subject, text, html });
    return { ok: true };
  }

  try {
    await transportFor().sendMail({ to, from, subject, text, html });
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    throw badRequest('We could not send the email right now. Try again in a few minutes.');
  }
  return { ok: true };
}
