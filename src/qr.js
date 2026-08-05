import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { get, run } from './db.js';
import { notFound } from './errors.js';

/**
 * QR member cards. The code printed on a card is a random secret stored on the
 * member row — deliberately NOT derived from the member code, which is
 * sequential (GM0001, GM0002…) and would let anyone print a working card by
 * guessing. Each card can be reissued on its own, which revokes the old one.
 */

/** Version tag, so a future payload change stays distinguishable on the wire
 * and a stray non-GymBook QR can be rejected instead of half-matched. */
export const QR_PREFIX = 'GB1';

/** 128 bits of randomness — unguessable, and still only 22 characters, which
 * keeps the QR at a low version that cheap scanners read reliably. */
export function newQrToken() {
  return crypto.randomBytes(16).toString('base64url');
}

export function qrPayload(token) {
  return `${QR_PREFIX}:${token}`;
}

/**
 * Cleans up whatever the scan box receives. Liberal by design: handheld
 * scanners append their own newline/tab "enter", and staff may type a plain
 * member code, so `GB1:<token>`, a bare token, and `GM0042` all come out
 * usable.
 *
 * `from_card` records whether the value arrived carrying the QR prefix. That
 * distinction is load-bearing — see findMemberByScan.
 */
export function normalizeScan(raw) {
  const cleaned = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!cleaned) return { value: '', from_card: false };
  if (cleaned.slice(0, QR_PREFIX.length + 1).toUpperCase() === `${QR_PREFIX}:`) {
    return { value: cleaned.slice(QR_PREFIX.length + 1).trim(), from_card: true };
  }
  return { value: cleaned, from_card: false };
}

export function issueQrToken(memberId) {
  const token = newQrToken();
  run(
    "UPDATE members SET qr_token = ?, qr_issued_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [token, memberId],
  );
  return token;
}

/** Returns the member's existing card secret, minting one on first use so
 * members created before this feature existed still get a card. */
export function ensureQrToken(memberId) {
  const member = get('SELECT id, qr_token FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Member not found');
  return member.qr_token || issueQrToken(memberId);
}

/**
 * Resolves a scanned or typed value to a member.
 *
 * A value that arrived with the QR prefix is matched against card tokens ONLY.
 * Without that restriction, anyone could print their own QR reading
 * `GB1:GM0042` and have the desk check in whoever owns that sequential code —
 * the member-code fallback would quietly accept it. Typed input keeps the
 * fallback, since the front desk can already check in by code.
 */
export function findMemberByScan(raw) {
  const { value, from_card } = normalizeScan(raw);
  if (!value) return undefined;

  const byToken = get('SELECT * FROM members WHERE qr_token = ?', [value]);
  if (byToken || from_card) return byToken;

  return get('SELECT * FROM members WHERE code = ? COLLATE NOCASE', [value]);
}

/** Vector QR for on-screen display and printing — stays sharp at card size. */
export function qrSvg(token) {
  return QRCode.toString(qrPayload(token), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });
}

/** Raster QR for download/sharing, oversized so it survives being pasted into
 * WhatsApp or a document and reprinted. */
export function qrPngDataUrl(token) {
  return QRCode.toDataURL(qrPayload(token), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
}
