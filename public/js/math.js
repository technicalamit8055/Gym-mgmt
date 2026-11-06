/**
 * Maths in question papers: text with LaTeX between $…$ (inline) or $$…$$
 * (display), typeset with KaTeX — the vendored build in js/vendor/katex
 * (scripts/vendor-katex.js), fetched on first use so a screen without maths
 * never pays for it.
 *
 * mathHtml() is the one place paper text becomes markup: everything outside
 * the delimiters is escaped, and KaTeX's own output is safe by construction
 * (trust is off, so \href and \includegraphics are refused). A formula KaTeX
 * cannot parse is shown as its source in red rather than breaking the page.
 */

const BASE = '/js/vendor/katex';
let loading = null;

/** Resolves once window.katex and its stylesheet are in the page. */
export function loadMath() {
  if (window.katex) return Promise.resolve(window.katex);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${BASE}/katex.min.css"]`)) {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${BASE}/katex.min.css` }));
    }
    const script = document.createElement('script');
    script.src = `${BASE}/katex.min.js`;
    script.async = true;
    script.onload = () => (window.katex ? resolve(window.katex) : reject(new Error('Maths could not load')));
    script.onerror = () => {
      loading = null;
      reject(new Error('Maths could not load — check the connection'));
    };
    document.head.append(script);
  });
  return loading;
}

/** The stylesheet's absolute address, for a print window of its own. */
export const mathStylesheet = () => new URL(`${BASE}/katex.min.css`, window.location.href).href;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// $$…$$, \[…\], \(…\) and $…$ — an escaped \$ is a literal dollar.
const SEGMENT = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?:\\\$|[^$])+?(?<!\\)\$)/g;

function renderFormula(source, display) {
  try {
    return window.katex.renderToString(source, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' });
  } catch {
    return `<code class="math-error">${escapeHtml(source)}</code>`;
  }
}

/**
 * `text` as HTML, maths typeset. Call loadMath() first; before it has loaded
 * the maths is shown as its source, which is still readable.
 */
export function mathHtml(text) {
  const src = String(text ?? '');
  // Line breaks only in the prose: KaTeX's own SVG paths (\vec, \sqrt) carry
  // newlines in their data, and a <br> there would break the drawing.
  const prose = (s) => escapeHtml(s).replace(/\\\$/g, '$').replace(/\n/g, '<br>');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(SEGMENT)) {
    out += prose(src.slice(last, m.index));
    const seg = m[0];
    if (!window.katex) out += escapeHtml(seg);
    else if (seg.startsWith('$$')) out += renderFormula(seg.slice(2, -2), true);
    else if (seg.startsWith('\\[')) out += renderFormula(seg.slice(2, -2), true);
    else if (seg.startsWith('\\(')) out += renderFormula(seg.slice(2, -2), false);
    else out += renderFormula(seg.slice(1, -1), false);
    last = m.index + seg.length;
  }
  out += prose(src.slice(last));
  return out;
}

/** An element whose content is `text` with its maths typeset. */
export function mathNode(text, { tag = 'div', className = 'math-text' } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.innerHTML = mathHtml(text);
  return node;
}
