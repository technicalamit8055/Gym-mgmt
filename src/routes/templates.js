import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { config } from '../config.js';
import { get, getBusinessType } from '../db.js';
import { notFound } from '../errors.js';
import { cleanTemplate, resetTemplate, saveTemplate, TEMPLATE_CHOICES, TEMPLATE_KINDS, templateFor } from '../printTemplates.js';
import { generateReceiptPdf } from '../receiptPdf.js';

/**
 * The owner's print templates (src/printTemplates.js): read by any signed-in
 * staff member — they print receipts and cards — changed by an admin only.
 * The preview routes render a sample with unsaved values, so the editor shows
 * exactly what Save would produce.
 */
export const templateRoutes = Router();
templateRoutes.use(requireAuth);

/** The OMR template only exists for CoachBook institutes. */
const kindsHere = () => TEMPLATE_KINDS.filter((kind) => kind !== 'omr' || getBusinessType() === 'coaching');

function kindParam(req) {
  const kind = String(req.params.kind || '');
  if (!kindsHere().includes(kind)) throw notFound('No such template');
  return kind;
}

templateRoutes.get('/', (_req, res) => {
  const kinds = kindsHere();
  res.json({
    templates: Object.fromEntries(kinds.map((kind) => [kind, templateFor(kind)])),
    choices: Object.fromEntries(kinds.map((kind) => [kind, TEMPLATE_CHOICES[kind]])),
  });
});

templateRoutes.put('/:kind', requireRole('admin'), (req, res) => {
  res.json({ template: saveTemplate(kindParam(req), req.body ?? {}) });
});

templateRoutes.delete('/:kind', requireRole('admin'), (req, res) => {
  res.json({ template: resetTemplate(kindParam(req)) });
});

const orgName = (req) => req.tenant?.gym_name || config.gymName || 'GymBook';
const logoOf = (req) => (req.tenant?.logo_bytes ? Buffer.from(req.tenant.logo_bytes) : null);

/** A made-up payment in this vertical's shape: a course fee for an institute, a membership otherwise. */
function samplePayment() {
  const today = new Date().toISOString().slice(0, 10);
  if (getBusinessType() === 'coaching') {
    return {
      data: {
        receipt_no: 'FEE-00042', amount: 15000, method: 'upi', paid_on: today, reference: 'UPI 412398765432',
        first_name: 'Aarav', last_name: 'Kumar', member_code: 'CB0042', phone: '9876543210', person_label: 'Student',
        course_name: 'Class 12 Science (Board + JEE)', batch_name: 'Batch 12-A (Evening)', components: [],
        plan_total: 45000, plan_discount: 5000, plan_final: 40000,
        fee_items: [{ installment_number: 1, label: 'At admission', amount: 15000 }], balance_after: 25000,
      },
      title: 'FEE RECEIPT',
    };
  }
  const end = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  return {
    data: {
      id: 42, amount: 4500, method: 'upi', paid_on: today, reference: 'UPI 412398765432',
      first_name: 'Rahul', last_name: 'Sharma', member_code: 'M0042', phone: '9876543210',
      plan_name: 'Quarterly Membership', start_date: today, end_date: end, price: 5000, discount: 500,
    },
    title: undefined,
  };
}

templateRoutes.post('/receipt/preview', requireRole('admin', 'manager'), async (req, res) => {
  // The unsaved values, validated the way Save would, without storing them.
  const template = { ...templateFor('receipt'), ...cleanTemplate('receipt', req.body && typeof req.body === 'object' ? req.body : {}) };
  const sample = samplePayment();
  let gstin = null;
  if (getBusinessType() === 'coaching') {
    try {
      gstin = get('SELECT gstin FROM coaching_settings WHERE id = 1')?.gstin || null;
    } catch {
      gstin = null;
    }
  }
  const pdf = await generateReceiptPdf(sample.data, {
    gymName: orgName(req),
    logoBuffer: logoOf(req),
    currency: req.tenant?.currency || 'INR',
    gstin,
    title: sample.title,
    template,
  });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="Receipt_preview.pdf"');
  res.send(pdf);
});

templateRoutes.post('/omr/preview', requireRole('admin', 'manager'), async (req, res) => {
  if (getBusinessType() !== 'coaching') throw notFound('No such template');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const template = { ...templateFor('omr'), ...cleanTemplate('omr', body) };
  const style = template.default_style;
  const { omrSamplePdf } = await import('../coaching/omrSheet.js');
  const pdf = await omrSamplePdf({ institute: orgName(req), style, template });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="OMR_preview.pdf"');
  res.send(pdf);
});
