/** Small DOM + formatting toolkit shared by every view. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export const svg = (tag, props = {}, ...children) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(3)) {
    if (child) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
};

export function clear(node) {
  node.replaceChildren();
  return node;
}

/* ------------------------------------------------------------- formatting */

let currency = 'INR';
export const setCurrency = (code) => {
  currency = code || 'INR';
};

export function money(amount, { compact = false } = {}) {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
      notation: compact && Math.abs(value) >= 100_000 ? 'compact' : 'standard',
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(0)}`;
  }
}

export function date(value, { withTime = false } = {}) {
  if (!value) return '—';
  const iso = String(value).includes('T') ? value : String(value).replace(' ', 'T');
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function time(value) {
  if (!value) return '—';
  const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number);
  const suffix = hours < 12 ? 'AM' : 'PM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function relativeDays(isoDate) {
  if (!isoDate) return null;
  const target = new Date(`${String(isoDate).slice(0, 10)}T00:00:00`);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Math.round((target - start) / 86_400_000);
}

export function expiryLabel(endDate) {
  const days = relativeDays(endDate);
  if (days === null) return h('span', { class: 'badge grey' }, 'No membership');
  if (days < 0) return h('span', { class: 'badge red' }, `Expired ${Math.abs(days)}d ago`);
  if (days === 0) return h('span', { class: 'badge amber' }, 'Ends today');
  if (days <= 7) return h('span', { class: 'badge amber' }, `${days}d left`);
  return h('span', { class: 'badge green' }, `${days}d left`);
}

export const initials = (first = '', last = '') =>
  `${(first[0] || '').toUpperCase()}${(last[0] || '').toUpperCase()}` || '?';

export const fullName = (person) => `${person.first_name || ''} ${person.last_name || ''}`.trim();

export const today = () => new Date().toLocaleDateString('en-CA');

export const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};

export const STATUS_TONE = {
  active: 'green',
  expired: 'red',
  cancelled: 'grey',
  frozen: 'blue',
  inactive: 'grey',
  operational: 'green',
  maintenance: 'amber',
  retired: 'grey',
  booked: 'blue',
  attended: 'green',
  no_show: 'red',
};

/** Badge colour per check-in channel, so the desk can see at a glance how
 * people are getting in. */
export const SOURCE_TONE = {
  biometric: 'violet',
  qr: 'blue',
  device: 'green',
  desk: 'grey',
};

export const sourceBadge = (source) =>
  h('span', { class: `badge ${SOURCE_TONE[source] || 'grey'}` }, source);

export const statusBadge = (status) =>
  h('span', { class: `badge ${STATUS_TONE[status] || 'grey'}` }, String(status || '').replace('_', ' '));

/**
 * A toolbar control with its caption attached — "From [date]".
 *
 * Pairing them in one flex box is what keeps the caption from being orphaned on
 * the line above its input when a toolbar wraps on a narrow screen.
 */
export const labelledControl = (text, control) =>
  h('label', { class: 'toolbar-pair' }, h('span', { class: 'muted' }, text), control);

export const personCell = (person) =>
  h(
    'div',
    { class: 'person' },
    person.photo_url
      ? h('img', { class: 'avatar', src: person.photo_url, alt: '' })
      : h('div', { class: 'avatar' }, initials(person.first_name, person.last_name)),
    h(
      'div',
      { class: 'meta' },
      h('div', { class: 'name' }, fullName(person)),
      h('div', { class: 'sub' }, person.code || person.email || ''),
    ),
  );

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = 'success') {
  const node = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 300);
  }, kind === 'error' ? 6000 : 3200);
}

/* ------------------------------------------------------------------- modal */

let modalCount = 0;

export function closeModal() {
  const root = document.getElementById('modal-root');
  const last = root.lastElementChild;
  if (last) {
    if (last.onCloseCallback) last.onCloseCallback();
    last.remove();
    modalCount--;
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalCount > 0) {
    closeModal();
  }
});

export function openModal({ title, body, footer, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) closeModal();
      },
    },
    h(
      'div',
      { class: `modal ${wide ? 'wide' : ''}` },
      h(
        'div',
        { class: 'modal-head' },
        h('h2', {}, title),
        h('div', { class: 'spacer' }),
        h('button', { class: 'icon-btn', onclick: closeModal, title: 'Close' }, '×'),
      ),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null,
    ),
  );
  backdrop.onCloseCallback = onClose;
  root.append(backdrop);
  modalCount++;

  const firstInput = backdrop.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
  return backdrop;
}

/* -------------------------------------------------------------------- forms */

/**
 * Builds a form from field descriptors and wires up server-side field errors.
 * fields: [{ name, label, type, options, value, required, full, placeholder, step, hint }]
 */
export function buildForm(fields, { onSubmit, submitLabel = 'Save', wide = false }) {
  const inputs = new Map();
  const grid = h('div', { class: 'form-grid' });

  for (const field of fields) {
    if (!field) continue;
    let input;
    if (field.type === 'select') {
      input = h(
        'select',
        { name: field.name },
        ...(field.options || []).map((option) =>
          h('option', { value: option.value, selected: String(option.value) === String(field.value ?? '') }, option.label),
        ),
      );
    } else if (field.type === 'textarea') {
      input = h('textarea', { name: field.name, placeholder: field.placeholder || '' }, field.value ?? '');
    } else {
      input = h('input', {
        name: field.name,
        type: field.type || 'text',
        value: field.value ?? '',
        placeholder: field.placeholder || '',
        step: field.step,
        min: field.min,
        max: field.max,
        list: field.list,
      });
    }
    inputs.set(field.name, input);

    const errorNode = h('div', { class: 'field-error', style: 'display:none' });
    grid.append(
      h(
        'label',
        { class: `field ${field.full ? 'full' : ''}` },
        h('span', {}, field.label, field.required ? ' *' : ''),
        input,
        field.hint ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, field.hint) : null,
        errorNode,
      ),
    );
    input.dataset.errorFor = field.name;
    input.errorNode = errorNode;
  }

  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        for (const input of inputs.values()) {
          input.errorNode.style.display = 'none';
        }
        const values = {};
        for (const [name, input] of inputs) values[name] = input.value;

        submit.disabled = true;
        try {
          await onSubmit(values);
        } catch (err) {
          if (err.details && Object.keys(err.details).length) {
            const unmapped = [];
            for (const [name, message] of Object.entries(err.details)) {
              const input = inputs.get(name);
              if (input) {
                input.errorNode.textContent = message;
                input.errorNode.style.display = 'block';
              } else {
                unmapped.push(`${name.replace('_', ' ')} ${message}`);
              }
            }
            if (unmapped.length) {
              toast(`${err.message || 'Could not save'}: ${unmapped.join(', ')}`, 'error');
            } else {
              toast(err.message || 'Could not save', 'error');
            }
          } else {
            toast(err.message || 'Could not save', 'error');
          }
        } finally {
          submit.disabled = false;
        }
      },
    },
    grid,
    h(
      'div',
      { class: 'modal-foot', style: 'padding:8px 0 0;border:none' },
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
      submit,
    ),
  );
  form.classList.toggle('wide', wide);
  return form;
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  secondaryLabel,
  onSecondary,
}) {
  const confirm = h(
    'button',
    {
      class: `btn ${danger ? 'danger' : 'primary'}`,
      onclick: async () => {
        confirm.disabled = true;
        try {
          await onConfirm();
          closeModal();
        } catch (err) {
          toast(err.message || 'Action failed', 'error');
          confirm.disabled = false;
        }
      },
    },
    confirmLabel,
  );
  const footer = [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel')];
  if (secondaryLabel && onSecondary) {
    const secondary = h(
      'button',
      {
        class: 'btn ghost',
        onclick: async () => {
          secondary.disabled = true;
          try {
            await onSecondary();
          } catch (err) {
            toast(err.message || 'Action failed', 'error');
          } finally {
            secondary.disabled = false;
          }
        },
      },
      secondaryLabel,
    );
    footer.push(secondary);
  }
  footer.push(confirm);
  openModal({
    title,
    body: h('p', { class: 'muted', style: 'margin:0' }, message),
    footer,
  });
}

/* ------------------------------------------------------------------- tables */

export function table(columns, rows, { onRowClick, empty = 'Nothing here yet' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);

  const body = h(
    'tbody',
    {},
    ...rows.map((row) => {
      const tr = h(
        'tr',
        { class: onRowClick ? 'clickable' : '' },
        ...columns.map((column) => h('td', { class: column.align === 'right' ? 'num' : '' }, column.render(row))),
      );
      if (onRowClick) tr.addEventListener('click', () => onRowClick(row));
      return tr;
    }),
  );

  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { class: c.align === 'right' ? 'num' : '' }, c.label)))),
      body,
    ),
  );
}

/**
 * `trend` — { positive: boolean|null, text: string } — renders a colour-coded
 * pill instead of the plain hint line. `pulse` adds a small live indicator next
 * to the icon, for "this number is changing right now" cards (check-ins).
 */
export const stat = (label, value, hint, { accent = false, icon = null, trend = null, pulse = false, onClick = null } = {}) =>
  h(
    'div',
    {
      class: `card stat ${accent ? 'accent' : ''} ${onClick ? 'clickable' : ''}`,
      onclick: onClick,
      tabindex: onClick ? '0' : null,
    },
    icon || pulse
      ? h(
          'div',
          { class: 'stat-top' },
          icon ? h('div', { class: 'stat-icon' }, icon) : null,
          pulse ? h('span', { class: 'live-pulse' }, h('span', { class: 'live-pulse-core' })) : null,
        )
      : null,
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    trend
      ? h(
          'span',
          { class: `trend-pill ${trend.positive === true ? 'pos' : trend.positive === false ? 'neg' : ''}` },
          trend.text,
        )
      : hint
        ? h('div', { class: 'hint' }, hint)
        : null,
  );

/* ------------------------------------------------------------------- charts */

/**
 * Positions a chart's floating tooltip inside its wrapper, flipping to the
 * left of the cursor once it would otherwise overhang the right edge.
 */
function positionChartTooltip(tooltip, wrap, clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  const overhang = relX + 150 > rect.width;
  tooltip.style.transform = `translate(${overhang ? relX - 150 : relX + 14}px, ${Math.max(relY - 12, 0)}px)`;
}

/**
 * Bars drawn in a fixed 640-unit coordinate space so the SVG scales uniformly —
 * a three-bar chart and a thirty-bar chart both keep readable, undistorted text.
 */
export function barChart(data, { height = 160, format = (v) => v, label = (d) => d.label } = {}) {
  if (!data.length) return h('div', { class: 'empty' }, 'No data for this period');

  const width = 640;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slot = width / data.length;
  const barWidth = Math.min(slot * 0.62, 70);
  const plot = height - 26;
  const plotTop = 18;
  // With many bars there is no room for a caption on every one.
  const labelEvery = Math.ceil(data.length / 16);
  const showValues = data.length <= 12;

  const wrap = h('div', { class: 'chart-wrap' });
  const tooltip = h('div', { class: 'chart-tooltip' });

  const showTip = (event, d) => {
    clear(tooltip).append(
      h('div', { class: 'chart-tooltip-label' }, label(d)),
      h('div', { class: 'chart-tooltip-value' }, format(d.value)),
    );
    tooltip.classList.add('show');
    positionChartTooltip(tooltip, wrap, event.clientX, event.clientY);
  };
  const hideTip = () => tooltip.classList.remove('show');

  const chart = svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${width} ${height}`, style: `height:${height}px;width:100%`, onmouseleave: hideTip },
    ...[0.25, 0.5, 0.75].map((frac) =>
      svg('line', { class: 'grid-line', x1: 0, y1: plotTop + (plot - plotTop) * frac, x2: width, y2: plotTop + (plot - plotTop) * frac }),
    ),
    svg('line', { class: 'axis', x1: 0, y1: plot, x2: width, y2: plot }),
    ...data.flatMap((d, i) => {
      const barHeight = Math.max((d.value / max) * (plot - plotTop), d.value > 0 ? 2 : 0);
      const center = i * slot + slot / 2;
      return [
        svg('rect', {
          class: 'bar',
          x: center - barWidth / 2,
          y: plot - barHeight,
          width: barWidth,
          height: barHeight,
          rx: 3,
          onmousemove: (event) => showTip(event, d),
          onmouseleave: hideTip,
        }),
        i % labelEvery === 0 ? svg('text', { x: center, y: plot + 13, 'text-anchor': 'middle' }, d.label) : null,
        showValues && d.value > 0
          ? svg('text', { x: center, y: plot - barHeight - 5, 'text-anchor': 'middle' }, format(d.value))
          : null,
      ];
    }),
  );

  wrap.append(chart, tooltip);
  return wrap;
}

let chartGradientSeq = 0;

export function lineChart(data, { height = 170, format = (v) => v } = {}) {
  if (data.length < 2) return h('div', { class: 'empty' }, 'Not enough data yet');

  const width = 640;
  const pad = { left: 8, right: 8, top: 14, bottom: 24 };
  const max = Math.max(...data.map((d) => d.value), 1);
  const plotHeight = height - pad.top - pad.bottom;
  const step = (width - pad.left - pad.right) / (data.length - 1);
  const points = data.map((d, i) => [pad.left + i * step, pad.top + plotHeight - (d.value / max) * plotHeight]);
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${points.at(-1)[0].toFixed(1)},${pad.top + plotHeight} L${points[0][0].toFixed(1)},${pad.top + plotHeight} Z`;
  const labelEvery = Math.ceil(data.length / 8);
  const gradientId = `areaFill-${chartGradientSeq++}`;

  const wrap = h('div', { class: 'chart-wrap' });
  const tooltip = h('div', { class: 'chart-tooltip' });
  const crosshair = svg('line', { class: 'crosshair', x1: 0, y1: pad.top, x2: 0, y2: pad.top + plotHeight });
  const hoverDot = svg('circle', { class: 'dot hover-dot', r: 4 });

  const showAt = (index, clientX, clientY) => {
    const [x, y] = points[index];
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    hoverDot.setAttribute('cx', x);
    hoverDot.setAttribute('cy', y);
    crosshair.classList.add('show');
    hoverDot.classList.add('show');
    clear(tooltip).append(
      h('div', { class: 'chart-tooltip-label' }, data[index].label),
      h('div', { class: 'chart-tooltip-value' }, format(data[index].value)),
    );
    tooltip.classList.add('show');
    positionChartTooltip(tooltip, wrap, clientX, clientY);
  };
  const hide = () => {
    crosshair.classList.remove('show');
    hoverDot.classList.remove('show');
    tooltip.classList.remove('show');
  };

  const overlay = svg('rect', {
    x: 0,
    y: 0,
    width,
    height,
    fill: 'transparent',
    onmousemove: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const relX = ((event.clientX - rect.left) / rect.width) * width;
      const index = Math.max(0, Math.min(data.length - 1, Math.round((relX - pad.left) / step)));
      showAt(index, event.clientX, event.clientY);
    },
    onmouseleave: hide,
  });

  const chart = svg(
    'svg',
    { class: 'chart', viewBox: `0 0 ${width} ${height}`, style: `height:${height}px;width:100%` },
    svg(
      'defs',
      {},
      svg(
        'linearGradient',
        { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: '0%', style: 'stop-color:var(--brand);stop-opacity:0.35' }),
        svg('stop', { offset: '100%', style: 'stop-color:var(--brand);stop-opacity:0' }),
      ),
    ),
    svg('path', { class: 'area', d: area, fill: `url(#${gradientId})` }),
    svg('path', { class: 'line', d: path }),
    ...points.map(([x, y]) => svg('circle', { class: 'dot', cx: x, cy: y, r: 2.5 })),
    ...data.map((d, i) =>
      i % labelEvery === 0
        ? svg('text', { x: pad.left + i * step, y: height - 6, 'text-anchor': 'middle' }, d.label)
        : null,
    ),
    crosshair,
    hoverDot,
    overlay,
  );

  wrap.append(chart, tooltip);
  return wrap;
}

/* ------------------------------------------------------------- fullscreen */

export function isFullscreen() {
  return Boolean(
    document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement,
  );
}

export async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) await document.mozCancelFullScreen();
      else if (document.msExitFullscreen) await document.msExitFullscreen();
    } else {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) await docEl.requestFullscreen();
      else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
      else if (docEl.mozRequestFullScreen) await docEl.mozRequestFullScreen();
      else if (docEl.msRequestFullscreen) await docEl.msRequestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen toggle failed:', err);
    toast('Fullscreen mode is not permitted by your browser settings', 'error');
  }
}

export function onFullscreenChange(callback) {
  const events = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
  const handler = () => callback(isFullscreen());
  events.forEach((evt) => document.addEventListener(evt, handler));
  return () => events.forEach((evt) => document.removeEventListener(evt, handler));
}

