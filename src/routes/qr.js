import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { performCheckIn } from '../checkin.js';
import { config } from '../config.js';
import { get } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { autoCloseFinishedVisits, expireOverdueSubscriptions } from '../maintenance.js';
import { ensureQrToken, findMemberByScan, issueQrToken, qrPayload, qrPngDataUrl, qrSvg } from '../qr.js';
import { MEMBER_SELECT, publicMember } from './members.js';
import { parse, toInt } from '../validate.js';

/**
 * QR member cards: issuing/printing them, and using one at the front desk.
 *
 * Staff-authenticated throughout — scanning happens on a logged-in desk
 * device, the same trust boundary as the existing check-in-by-code route.
 */
export const qrRoutes = Router();
qrRoutes.use(requireAuth);

const gymNameFor = (req) => req.tenant?.gym_name || config.gymName || 'GymBook';

/** Everything needed to render or print one member's card. */
async function buildCard(req, memberId) {
  const member = get(`${MEMBER_SELECT} WHERE m.id = ?`, [memberId]);
  if (!member) throw notFound('Member not found');

  const token = ensureQrToken(memberId);
  const [svg, png] = await Promise.all([qrSvg(token), qrPngDataUrl(token)]);

  return {
    member: publicMember(member),
    gym_name: gymNameFor(req),
    token,
    payload: qrPayload(token),
    issued_at: get('SELECT qr_issued_at FROM members WHERE id = ?', [memberId])?.qr_issued_at ?? null,
    svg,
    png,
  };
}

/* ── Issuing and printing cards ───────────────────────────────────────── */

/** Batch fetch for the "print many cards at once" sheet. Declared before
 * /member/:memberId only for readability — the paths don't overlap. */
qrRoutes.get('/cards', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((part) => toInt(part.trim(), null))
    .filter((id) => Number.isInteger(id));

  if (!ids.length) throw badRequest('Provide one or more member ids, e.g. ?ids=1,2,3');
  if (ids.length > 200) throw badRequest('Print at most 200 cards at a time');

  const cards = [];
  for (const id of ids) {
    // Skip ids that no longer exist rather than failing the whole sheet —
    // a stale selection shouldn't block printing the rest.
    if (!get('SELECT id FROM members WHERE id = ?', [id])) continue;
    cards.push(await buildCard(req, id));
  }
  res.json({ items: cards });
});

qrRoutes.get('/member/:memberId', async (req, res) => {
  res.json(await buildCard(req, Number(req.params.memberId)));
});

/** Reissue after a lost or damaged card. The previous token stops working the
 * moment this returns, which is the point. */
qrRoutes.post('/member/:memberId/reissue', async (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Member not found');

  issueQrToken(memberId);
  res.json(await buildCard(req, memberId));
});

/* ── Front-desk scanning ──────────────────────────────────────────────── */

/**
 * What the desk sees the instant a card is scanned: who this is and whether
 * they're clear to train. Read-only on purpose, so staff can eyeball dues or
 * an expiry before waving someone through.
 */
qrRoutes.post('/lookup', (req, res) => {
  const body = parse(req.body, { code: { type: 'string', required: true, max: 200 } });

  expireOverdueSubscriptions();
  autoCloseFinishedVisits();
  const scanned = findMemberByScan(body.code);
  if (!scanned) throw notFound('That card is not recognised — it may have been reissued');

  const member = publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [scanned.id]));
  const openVisit = get(
    "SELECT * FROM attendance WHERE member_id = ? AND check_out IS NULL AND date(check_in) = date('now')",
    [member.id],
  );
  const subscription = get(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.member_id = ? AND s.status = 'active' AND date('now') BETWEEN s.start_date AND s.end_date
     ORDER BY s.end_date DESC LIMIT 1`,
    [member.id],
  );

  res.json({
    member,
    subscription: subscription ?? null,
    already_in: Boolean(openVisit),
    open_visit: openVisit ?? null,
    sessions_left:
      subscription && subscription.sessions_total !== null
        ? subscription.sessions_total - subscription.sessions_used
        : null,
  });
});

/** Scan-to-check-in. Reuses the shared rules, so a frozen, lapsed or
 * out-of-sessions member is refused here exactly as at the desk. */
qrRoutes.post('/check-in', (req, res) => {
  const body = parse(req.body, { code: { type: 'string', required: true, max: 200 } });

  const member = findMemberByScan(body.code);
  if (!member) throw notFound('That card is not recognised — it may have been reissued');

  const result = performCheckIn(member, 'qr');
  res.status(result.action === 'checked_in' ? 201 : 200).json(result);
});
