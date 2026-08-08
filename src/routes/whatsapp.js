import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { parse, toInt } from '../validate.js';
import { generateReceiptPdf } from '../receiptPdf.js';
import {
  connectWhatsApp,
  getWhatsAppStatus,
  logoutWhatsApp,
  receiptMessage,
  reminderMessage,
  sendWhatsAppMessage,
} from '../whatsapp.js';

export const whatsappRoutes = Router();
whatsappRoutes.use(requireAuth);
// Everything here either sends messages under the gym's own WhatsApp number or
// exposes the pairing QR, so none of it is open to trainers or front desk.
whatsappRoutes.use(requireRole(...MANAGES_BILLING));

/** The gym's own name, as the members know it — not the platform's. The store
 * behind tenantStorage carries slug/dbFile/timezone only, so the display name
 * has to come off the registry row the tenant middleware resolved. */
const gymNameFor = (req) => req.tenant?.gym_name || config.gymName || 'GymBook';

/** Falls back to the column defaults for a gym that has never opened the page. */
function settingsFor() {
  return (
    get('SELECT * FROM whatsapp_settings WHERE id = 1') ?? {
      id: 1,
      auto_receipt: 1,
      send_pdf_receipt: 1,
      auto_reminder: 1,
      reminder_days_before: 3,
      receipt_template:
        'Hi {{first_name}}, thank you for your payment of {{amount}} for {{plan_name}}. Your membership is valid until {{end_date}}. - {{gym_name}}',
      reminder_template:
        'Hi {{first_name}}, your membership ({{plan_name}}) expires on {{end_date}}. Please renew to continue your workouts! - {{gym_name}}',
      welcome_template: 'Welcome to {{gym_name}}, {{first_name}}! We are thrilled to have you on board.',
    }
  );
}

/** GET /api/whatsapp/status */
whatsappRoutes.get('/status', (req, res) => {
  const status = getWhatsAppStatus();
  // The QR *is* the pairing credential — anyone who scans it links their own
  // phone to this gym's number. Only the owner ever needs to see it.
  if (req.user.role !== 'admin') status.qr = null;
  res.json(status);
});

/** POST /api/whatsapp/connect */
whatsappRoutes.post('/connect', requireRole('admin'), async (_req, res, next) => {
  try {
    res.json(await connectWhatsApp({ force: true }));
  } catch (err) {
    next(err);
  }
});

/** POST /api/whatsapp/logout */
whatsappRoutes.post('/logout', requireRole('admin'), async (_req, res, next) => {
  try {
    res.json(await logoutWhatsApp());
  } catch (err) {
    next(err);
  }
});

/** GET /api/whatsapp/settings */
whatsappRoutes.get('/settings', (_req, res) => {
  res.json(settingsFor());
});

/** PUT /api/whatsapp/settings */
whatsappRoutes.put('/settings', (req, res) => {
  const body = parse(req.body, {
    auto_receipt: { type: 'boolean', default: 0 },
    send_pdf_receipt: { type: 'boolean', default: 1 },
    auto_reminder: { type: 'boolean', default: 0 },
    reminder_days_before: { type: 'int', default: 3, min: 0, max: 60 },
    receipt_template: { type: 'string', max: 1000, required: true },
    reminder_template: { type: 'string', max: 1000, required: true },
    welcome_template: { type: 'string', max: 1000, required: true },
  });

  run(
    `INSERT INTO whatsapp_settings
       (id, auto_receipt, send_pdf_receipt, auto_reminder, reminder_days_before,
        receipt_template, reminder_template, welcome_template, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       auto_receipt         = excluded.auto_receipt,
       send_pdf_receipt     = excluded.send_pdf_receipt,
       auto_reminder        = excluded.auto_reminder,
       reminder_days_before = excluded.reminder_days_before,
       receipt_template     = excluded.receipt_template,
       reminder_template    = excluded.reminder_template,
       welcome_template     = excluded.welcome_template,
       updated_at           = excluded.updated_at`,
    [
      body.auto_receipt,
      body.send_pdf_receipt,
      body.auto_reminder,
      body.reminder_days_before,
      body.receipt_template,
      body.reminder_template,
      body.welcome_template,
    ],
  );

  res.json(get('SELECT * FROM whatsapp_settings WHERE id = 1'));
});

/** POST /api/whatsapp/send-receipt */
whatsappRoutes.post('/send-receipt', async (req, res, next) => {
  try {
    const paymentId = toInt(req.body?.payment_id);
    if (!paymentId) throw badRequest('payment_id is required');

    const payment = get(
      `SELECT pay.*, m.first_name, m.last_name, m.phone, m.code AS member_code,
              p.name AS plan_name, s.start_date, s.end_date
       FROM payments pay
       JOIN members m ON m.id = pay.member_id
       LEFT JOIN subscriptions s ON s.id = pay.subscription_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE pay.id = ?`,
      [paymentId],
    );
    if (!payment) throw notFound('Payment not found');
    if (!payment.phone) throw badRequest('That member has no phone number on file');

    const shouldAttachPdf = req.body?.send_pdf !== undefined
      ? Boolean(req.body.send_pdf)
      : Boolean(settingsFor().send_pdf_receipt);

    let doc = null;
    if (shouldAttachPdf) {
      const pdfBuffer = req.body?.pdf_base64
        ? Buffer.from(req.body.pdf_base64, 'base64')
        : await generateReceiptPdf(payment, { gymName: gymNameFor(req) });
      const receiptNo = payment.id ? `PAY-${String(payment.id).padStart(5, '0')}` : '00000';
      doc = {
        buffer: pdfBuffer,
        fileName: `Receipt_${receiptNo}.pdf`,
        mimetype: 'application/pdf',
      };
    }

    await sendWhatsAppMessage({
      phone: payment.phone,
      message: receiptMessage(payment, {
        gymName: gymNameFor(req),
        template: settingsFor().receipt_template,
      }),
      document: doc,
      type: 'receipt',
      memberId: payment.member_id,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/whatsapp/send-id-card */
whatsappRoutes.post('/send-id-card', async (req, res, next) => {
  try {
    const memberId = toInt(req.body?.member_id);
    if (!memberId) throw badRequest('member_id is required');

    const member = get(
      'SELECT id, first_name, last_name, phone, code FROM members WHERE id = ?',
      [memberId],
    );
    if (!member) throw notFound('Member not found');
    if (!member.phone) throw badRequest('That member has no phone number on file');

    const imageBase64 = req.body?.image_base64;
    if (!imageBase64) throw badRequest('image_base64 is required');

    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const gymName = gymNameFor(req);

    await sendWhatsAppMessage({
      phone: member.phone,
      message: `Hi ${member.first_name}, here is your QR ID card for ${gymName}. Show this at reception for quick check-in! 🎟️`,
      image: {
        buffer: imageBuffer,
        mimetype: 'image/png',
        caption: `${member.first_name}'s QR ID Card — ${gymName}`,
      },
      type: 'id_card',
      memberId: member.id,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/whatsapp/send-reminder */
whatsappRoutes.post('/send-reminder', async (req, res, next) => {
  try {
    const subscriptionId = toInt(req.body?.subscription_id);
    const memberId = toInt(req.body?.member_id);
    if (!subscriptionId && !memberId) throw badRequest('member_id or subscription_id is required');

    const SELECT = `
      SELECT s.*, m.first_name, m.last_name, m.phone, p.name AS plan_name
      FROM subscriptions s
      JOIN members m ON m.id = s.member_id
      JOIN plans p ON p.id = s.plan_id
    `;
    const sub = subscriptionId
      ? get(`${SELECT} WHERE s.id = ?`, [subscriptionId])
      : get(`${SELECT} WHERE s.member_id = ? ORDER BY s.end_date DESC LIMIT 1`, [memberId]);

    if (!sub) throw notFound('No membership found for that member');
    if (!sub.phone) throw badRequest('That member has no phone number on file');

    await sendWhatsAppMessage({
      phone: sub.phone,
      message: reminderMessage(sub, {
        gymName: gymNameFor(req),
        template: settingsFor().reminder_template,
      }),
      type: 'reminder',
      memberId: sub.member_id,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/whatsapp/send-test */
whatsappRoutes.post('/send-test', requireRole('admin'), async (req, res, next) => {
  try {
    const body = parse(req.body, {
      phone: { type: 'string', max: 20, required: true },
      message: { type: 'string', max: 1000, required: true },
    });
    await sendWhatsAppMessage({ phone: body.phone, message: body.message, type: 'custom' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** GET /api/whatsapp/logs */
whatsappRoutes.get('/logs', (req, res) => {
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  res.json({
    items: all(
      `SELECT l.*, m.first_name, m.last_name
       FROM whatsapp_logs l
       LEFT JOIN members m ON m.id = l.member_id
       ORDER BY l.id DESC LIMIT ?`,
      [limit],
    ),
  });
});
