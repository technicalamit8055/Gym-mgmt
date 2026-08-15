import PDFDocument from 'pdfkit';

function formatDate(value) {
  if (!value) return '—';
  const iso = String(value).includes('T') ? value : String(value).replace(' ', 'T');
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const year = parsed.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatMoney(amount, currency = 'INR') {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `₹${value.toFixed(0)}`;
  }
}

/**
 * Generates a PDF receipt matching Gymbook's built-in printer-friendly receipt layout field-for-field.
 * Returns a Promise<Buffer> containing the binary PDF bytes.
 */
export function generateReceiptPdf(data, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const RECEIPT_WIDTH = 340;
      const MARGIN_X = 24;
      const CONTENT_WIDTH = RECEIPT_WIDTH - MARGIN_X * 2;

      // Estimate document height dynamically
      let y = MARGIN_X;
      let estimatedHeight = 360;
      if (data.member_code) estimatedHeight += 19;
      if (data.phone) estimatedHeight += 19;
      if (data.reference) estimatedHeight += 19;
      if (data.note) estimatedHeight += 19;
      if (data.plan_name) {
        estimatedHeight += 50;
        if (data.start_date && data.end_date) estimatedHeight += 19;
        if (data.price != null) estimatedHeight += 19;
        if (data.discount) estimatedHeight += 19;
      }
      if (options.logoBuffer) estimatedHeight += 36;

      const doc = new PDFDocument({
        size: [RECEIPT_WIDTH, estimatedHeight],
        margin: 0,
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const gymName = options.gymName || data.gym_name || 'GymBook';
      const logoBuffer = options.logoBuffer || null;
      const currencyCode = options.currency || 'INR';

      // --- Header ---
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, (RECEIPT_WIDTH - 28) / 2, y, { width: 28, height: 28 });
          y += 34;
        } catch (e) {}
      }

      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text(gymName, MARGIN_X, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      y += 24;

      doc.fillColor('#6b7280').font('Helvetica').fontSize(11).text('PAYMENT RECEIPT', MARGIN_X, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      y += 18;

      const drawDottedLine = () => {
        y += 6;
        doc.save()
           .strokeColor('#d1d5db')
           .lineWidth(1)
           .dash(3, { space: 3 })
           .moveTo(MARGIN_X, y)
           .lineTo(RECEIPT_WIDTH - MARGIN_X, y)
           .stroke()
           .restore();
        y += 6;
      };

      const drawThickLine = () => {
        y += 8;
        doc.save()
           .strokeColor('#111827')
           .lineWidth(2)
           .undash()
           .moveTo(MARGIN_X, y)
           .lineTo(RECEIPT_WIDTH - MARGIN_X, y)
           .stroke()
           .restore();
        y += 8;
      };

      const drawSectionTitle = (title) => {
        doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(10).text(title.toUpperCase(), MARGIN_X, y);
        y += 18;
      };

      const drawRow = (label, val, bold = false) => {
        const valStr = String(val ?? '');
        doc.fillColor('#4b5563').font('Helvetica').fontSize(11).text(label, MARGIN_X, y, { width: 120, align: 'left' });
        doc.fillColor('#111827').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).text(valStr, MARGIN_X + 120, y, {
          width: CONTENT_WIDTH - 120,
          align: 'right',
        });
        y += 19;
      };

      // ── Dotted Divider ──
      drawDottedLine();

      // ── MEMBER Section ──
      drawSectionTitle('Member');
      const memberName = data.first_name ? `${data.first_name} ${data.last_name || ''}`.trim() : (data.member_name || 'Member');
      drawRow('Name', memberName);
      if (data.member_code) drawRow('Code', data.member_code);
      if (data.phone) drawRow('Phone', data.phone);

      // ── Dotted Divider ──
      drawDottedLine();

      // ── PAYMENT DETAILS Section ──
      drawSectionTitle('Payment Details');
      drawRow('Receipt #', data.id ? `PAY-${String(data.id).padStart(5, '0')}` : '—');
      drawRow('Date', formatDate(data.paid_on || new Date().toISOString().split('T')[0]));
      drawRow('Method', String(data.method || 'cash').toUpperCase());
      if (data.reference) drawRow('Reference', data.reference);
      if (data.note) drawRow('Note', data.note);

      // ── MEMBERSHIP Section ──
      if (data.plan_name) {
        drawDottedLine();
        drawSectionTitle('Membership');
        drawRow('Plan', data.plan_name);
        if (data.start_date && data.end_date) {
          drawRow('Period', `${formatDate(data.start_date)} → ${formatDate(data.end_date)}`);
        }
        if (data.price != null) drawRow('Plan price', formatMoney(data.price, currencyCode));
        if (data.discount) drawRow('Discount', `− ${formatMoney(data.discount, currencyCode)}`);
      }

      // ── Thick Line Divider ──
      drawThickLine();

      // ── Amount Paid ──
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16).text('Amount Paid', MARGIN_X, y + 4, { width: 140, align: 'left' });
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16).text(formatMoney(data.amount, currencyCode), MARGIN_X + 140, y + 4, {
        width: CONTENT_WIDTH - 140,
        align: 'right',
      });
      y += 28;

      // ── Dotted Divider ──
      drawDottedLine();

      // ── Footer ──
      doc.fillColor('#6b7280').font('Helvetica').fontSize(12).text('Thank you for your payment!', MARGIN_X, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      y += 18;

      const timestamp = `${formatDate(new Date())}, ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
      doc.fillColor('#9ca3af').font('Helvetica').fontSize(10).text(`Printed on ${timestamp}`, MARGIN_X, y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
