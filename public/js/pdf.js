/**
 * Wraps a single JPEG image in the smallest valid single-page PDF that can
 * hold it — one Catalog, one Pages, one Page, one content stream that paints
 * the image full-bleed, and the Image XObject itself.
 *
 * Text is rendered to a canvas and rasterized rather than drawn with PDF text
 * operators: the 14 standard PDF fonts only cover WinAnsi/Latin-1, so anything
 * outside that (₹, and most non-Latin scripts) would come out as garbage or a
 * missing glyph. Painting an image sidesteps font embedding entirely and
 * renders exactly what the browser would have shown on screen.
 */
export function imageBytesToPdf(jpegBytes, widthPx, heightPx, { dpi = 72 } = {}) {
  const pageWidth = (widthPx / dpi) * 72;
  const pageHeight = (heightPx / dpi) * 72;

  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;

  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObject = (num) => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
  };

  push('%PDF-1.4\n');

  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  beginObject(3);
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  );

  const content = `q ${pageWidth.toFixed(2)} 0 0 ${pageHeight.toFixed(2)} 0 0 cm /Im0 Do Q`;
  beginObject(4);
  push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  beginObject(5);
  push(
    `<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
  );
  push(jpegBytes);
  push('\nendstream\nendobj\n');

  const xrefOffset = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const result = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}
