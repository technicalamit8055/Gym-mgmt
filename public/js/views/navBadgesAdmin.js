import { api } from '../api.js';
import { append, clear, closeModal, confirmDialog, date, dateField, h, openModal, renderIcon, toast, today } from '../ui.js';

/** Replaces an element's children. ui.js's append, not the DOM's: the DOM's
 * would print a conditional child that came out null as the text "null". */
const fill = (el, ...children) => append(clear(el), children);

/**
 * Operator console → Menu badges: small labels pinned on the member app's
 * bottom tabs — "Offer" on the Store while a sale runs, "New" on Diet after a
 * feature ships — either as a text pill or as an uploaded sticker image. One
 * set for every gym; see src/navBadges.js.
 */

const TABS = {
  home: { label: 'Home', icon: 'home' },
  workout: { label: 'Workout', icon: 'barbell', gymOnly: true },
  diet: { label: 'Diet', icon: 'apple', gymOnly: true },
  store: { label: 'Store', icon: 'bag', gymOnly: true },
  profile: { label: 'Profile', icon: 'member' },
  pass: { label: 'Pass', icon: 'idCard', libraryOnly: true },
  schedule: { label: 'Shift', icon: 'seats', libraryOnly: true },
};

const TONES = {
  brand: { label: 'Gym colour', swatch: 'var(--brand)' },
  red: { label: 'Red', swatch: '#ef4444' },
  green: { label: 'Green', swatch: '#16a34a' },
  amber: { label: 'Amber', swatch: '#f59e0b' },
  blue: { label: 'Blue', swatch: '#3b82f6' },
  violet: { label: 'Violet', swatch: '#8b5cf6' },
};

const PRESETS = ['New', 'Offer', 'Sale', 'Hot', 'Free', 'Soon'];

/** A sticker shows at 26px on the tab; 96px covers a 3x phone screen. */
const STICKER_PX = 96;

/** The pill as the member app draws it (same class, so the same look). */
const pill = (label, tone) =>
  h('span', { class: `nb-pill portal-tab-badge${tone && tone !== 'brand' ? ` tone-${tone}` : ''}` }, label);

const sticker = (src, label) => h('img', { class: 'nb-sticker', src, alt: label || '' });

const isEnded = (badge) => Boolean(badge.expires_on && badge.expires_on < today());

/**
 * Clears a flat white backdrop, as on most stickers saved from the web: a
 * flood fill from the edges, so white *inside* the artwork (a ring, a % sign)
 * stays. Only runs when every corner is opaque near-white, and the pixels
 * where the fill meets the artwork fade out rather than leaving a hard halo.
 * Returns whether anything was cleared.
 */
function clearWhiteBackdrop(ctx, w, h) {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  const SOLID = 235; // at or above: backdrop
  const EDGE = 180; // between EDGE and SOLID: anti-aliased rim, faded
  const lightness = (p) => Math.min(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
  const isBackdrop = (p) => d[p * 4 + 3] > 240 && lightness(p) >= SOLID;
  if (![0, w - 1, (h - 1) * w, h * w - 1].every(isBackdrop)) return false;

  const seen = new Uint8Array(w * h);
  const stack = [];
  const visit = (p) => {
    if (seen[p]) return;
    seen[p] = 1;
    const light = lightness(p);
    if (light >= SOLID) {
      d[p * 4 + 3] = 0;
      stack.push(p);
    } else if (light >= EDGE) {
      d[p * 4 + 3] = Math.round((d[p * 4 + 3] * (SOLID - light)) / (SOLID - EDGE));
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < w * (h - 1)) visit(p + w);
  }
  ctx.putImageData(image, 0, 0);
  return true;
}

/** The box around every visible pixel, so empty margins don't shrink the
 * sticker on the tab. */
function visibleBounds(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let [minX, minY, maxX, maxY] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] <= 12) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? { x: 0, y: 0, w, h } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Prepares the sticker in the browser before upload — the server has no
 * image decoder: drops a plain white backdrop, trims empty margins, and
 * shrinks it to a square-bounded WebP that keeps transparency, so the seal
 * sits cleanly on the tab bar. Resolves to { blob, cleared }.
 */
async function prepareSticker(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`${file.name} is not an image this browser can read`));
      el.src = url;
    });
    // Worked on at up to 4x the final size: enough for clean edges, small
    // enough that the flood fill is instant.
    const workScale = Math.min(1, (STICKER_PX * 4) / Math.max(img.naturalWidth, img.naturalHeight));
    const work = document.createElement('canvas');
    work.width = Math.max(1, Math.round(img.naturalWidth * workScale));
    work.height = Math.max(1, Math.round(img.naturalHeight * workScale));
    const workCtx = work.getContext('2d', { willReadFrequently: true });
    workCtx.imageSmoothingQuality = 'high';
    workCtx.drawImage(img, 0, 0, work.width, work.height);
    const cleared = clearWhiteBackdrop(workCtx, work.width, work.height);
    const box = visibleBounds(workCtx, work.width, work.height);

    const scale = Math.min(1, STICKER_PX / Math.max(box.w, box.h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.w * scale));
    canvas.height = Math.max(1, Math.round(box.h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(work, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    // Browsers without WebP encoding hand back a PNG instead, which is fine.
    return { blob: blob ?? file, cleared };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openBadgeModal(tabKey, badge, onSaved) {
  const tab = TABS[tabKey];
  const state = {
    style: badge?.image_url ? 'image' : 'text',
    label: badge?.label ?? 'New',
    tone: badge?.tone ?? 'brand',
    // A picked image waits here, already prepared and shown as a preview,
    // until Save.
    pending: null,
    pendingUrl: null,
    cleared: false,
  };
  const imageSrc = () => state.pendingUrl || badge?.image_url || null;
  const releasePreview = () => {
    if (state.pendingUrl) URL.revokeObjectURL(state.pendingUrl);
  };

  const preview = h('div', { class: 'nb-preview' });
  function drawPreview() {
    const text = state.label.trim();
    let mark = null;
    if (state.style === 'image') mark = imageSrc() ? h('img', { class: 'nb-pill portal-tab-badge is-image', src: imageSrc(), alt: '' }) : null;
    else if (text) mark = pill(text, state.tone);
    fill(
      preview,
      h(
        'div',
        { class: 'nb-preview-tab' },
        h('span', { class: 'nb-preview-icon' }, renderIcon(tab.icon, { size: 22 }), mark),
        h('span', { class: 'nb-preview-label' }, tab.label),
      ),
    );
  }

  const styleSeg = h('div', { class: 'nb-style', role: 'radiogroup', 'aria-label': 'Badge style' });
  function drawStyle() {
    fill(
      styleSeg,
      ...[
        ['text', 'Text', 'type'],
        ['image', 'Image', 'image'],
      ].map(([value, text, icon]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(state.style === value),
            class: `nb-style-btn${state.style === value ? ' active' : ''}`,
            onclick: () => {
              state.style = value;
              drawStyle();
              drawBody();
              drawPreview();
            },
          },
          renderIcon(icon === 'type' ? 'edit' : icon, { size: 15 }),
          text,
        ),
      ),
    );
  }

  const label = h('input', {
    value: state.label,
    maxlength: 10,
    required: true,
    placeholder: 'New',
    oninput: () => {
      state.label = label.value;
      drawChips();
      drawPreview();
    },
  });

  const chips = h('div', { class: 'nb-chips' });
  function drawChips() {
    fill(
      chips,
      ...PRESETS.map((text) =>
        h(
          'button',
          {
            type: 'button',
            class: `nb-chip${state.label.trim().toLowerCase() === text.toLowerCase() ? ' active' : ''}`,
            onclick: () => {
              state.label = text;
              label.value = text;
              drawChips();
              drawPreview();
            },
          },
          text,
        ),
      ),
    );
  }

  const swatches = h('div', { class: 'nb-swatches', role: 'radiogroup', 'aria-label': 'Badge colour' });
  function drawSwatches() {
    fill(
      swatches,
      ...Object.entries(TONES).map(([value, meta]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(state.tone === value),
            'aria-label': meta.label,
            title: meta.label,
            class: `nb-swatch${state.tone === value ? ' active' : ''}`,
            style: `--sw:${meta.swatch}`,
            onclick: () => {
              state.tone = value;
              drawSwatches();
              drawPreview();
            },
          },
          state.tone === value ? renderIcon('check', { size: 14 }) : null,
        ),
      ),
    );
  }

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/png,image/webp,image/jpeg',
    hidden: true,
    // Prepared straight away, so the preview is exactly what will upload.
    onchange: async () => {
      const [file] = fileInput.files;
      fileInput.value = '';
      if (!file) return;
      let prepared;
      try {
        prepared = await prepareSticker(file);
      } catch (err) {
        toast(err.message || 'Could not read that image', 'error');
        return;
      }
      releasePreview();
      state.pending = prepared.blob;
      state.pendingUrl = URL.createObjectURL(prepared.blob);
      state.cleared = prepared.cleared;
      drawUpload();
      drawPreview();
    },
  });
  const upload = h('div', { class: 'nb-upload' });
  function drawUpload() {
    const src = imageSrc();
    fill(
      upload,
      h('div', { class: 'nb-upload-thumb' }, src ? sticker(src, '') : renderIcon('image', { size: 26 })),
      h(
        'div',
        { class: 'nb-upload-text' },
        h(
          'button',
          { type: 'button', class: 'btn sm', onclick: () => fileInput.click() },
          renderIcon('upload', { size: 14 }),
          src ? 'Choose another image' : 'Upload image',
        ),
        h(
          'div',
          { class: 'muted sa-hint' },
          state.pending && state.cleared
            ? 'Its white background was removed so it sits cleanly on the tab bar.'
            : 'A square sticker — a sale seal, a “new” burst. A plain white background is removed automatically.',
        ),
      ),
      fileInput,
    );
  }

  const field = (text, control, hint) =>
    h('div', { class: 'field full' }, h('span', {}, text), control, hint ? h('div', { class: 'muted sa-hint' }, hint) : null);

  // The fields that change with the style: the image picker or the colours,
  // and what the label is for.
  const styleBody = h('div', { class: 'nb-style-body' });
  function drawBody() {
    fill(
      styleBody,
      state.style === 'image' ? field('Image *', upload) : null,
      field(
        state.style === 'image' ? 'Name *' : 'Label *',
        h('div', {}, chips, label),
        state.style === 'image'
          ? 'Read out by screen readers and shown in this list — e.g. Offer.'
          : 'Up to 10 characters — it is shown in capitals on a tiny pill.',
      ),
      state.style === 'text' ? field('Colour', swatches) : null,
    );
  }

  const until = dateField({ value: badge?.expires_on ?? '', min: today(), placeholder: 'No end date' });
  const once = h('input', { type: 'checkbox', checked: Boolean(badge?.hide_when_seen) });

  drawStyle();
  drawChips();
  drawSwatches();
  drawUpload();
  drawBody();
  drawPreview();

  const save = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        if (!label.value.trim()) {
          toast(state.style === 'image' ? 'Give the badge a name' : 'Give the badge a label', 'error');
          label.focus();
          return;
        }
        if (state.style === 'image' && !imageSrc()) {
          toast('Upload an image for the badge', 'error');
          return;
        }
        save.disabled = true;
        try {
          await api.platformSetNavBadge(tabKey, {
            label: label.value.trim(),
            tone: state.tone,
            expires_on: until.value || null,
            hide_when_seen: once.checked,
          });
          if (state.style === 'image' && state.pending) {
            try {
              await api.platformNavBadgeImage(tabKey, state.pending);
            } catch (err) {
              // The text part is saved; keep the modal so the upload can be retried.
              toast(`Badge saved, but the image didn’t upload: ${err.message || 'try again'}`, 'error');
              await onSaved();
              return;
            }
          } else if (state.style === 'text' && badge?.image_url) {
            await api.platformClearNavBadgeImage(tabKey);
          }
          releasePreview();
          closeModal();
          toast(`Badge on ${tab.label} saved`);
          await onSaved();
        } catch (err) {
          toast(err.message || 'Could not save the badge', 'error');
        } finally {
          save.disabled = false;
        }
      },
    },
    badge ? 'Save badge' : 'Add badge',
  );

  openModal({
    title: `${badge ? 'Edit' : 'Add'} badge · ${tab.label} tab`,
    body: h(
      'div',
      { class: 'form-grid nb-form' },
      h('div', { class: 'field full' }, preview),
      field('Style', styleSeg),
      h('div', { class: 'full' }, styleBody),
      field('Show until', until, 'Last day it shows, at midnight where each gym is. Leave empty to keep it on until you remove it.'),
      h(
        'div',
        { class: 'field full sa-checks' },
        h('label', {}, once, ' Hide it on a member’s phone once they open this tab'),
      ),
    ),
    footer: [h('div', { style: 'flex:1' }), h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
    onClose: releasePreview,
  });
}

export function renderNavBadgesSection({ onExpired } = {}) {
  const root = h('div', { class: 'nb' }, h('div', { class: 'empty' }, 'Loading menu badges…'));

  async function refresh() {
    let state;
    try {
      state = await api.platformNavBadges();
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && onExpired) return onExpired();
      fill(root, h('div', { class: 'empty' }, err.message || 'Could not load menu badges'));
      return;
    }
    const byTab = Object.fromEntries(state.items.map((b) => [b.tab_key, b]));

    const remove = (tabKey) =>
      confirmDialog({
        title: `Remove the badge on ${TABS[tabKey].label}?`,
        message: 'It disappears from every member’s app the next time it opens.',
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: async () => {
          await api.platformClearNavBadge(tabKey);
          toast('Badge removed');
          await refresh();
        },
      });

    const row = (tabKey) => {
      const tab = TABS[tabKey];
      const badge = byTab[tabKey];
      const ended = badge && isEnded(badge);
      const notes = [];
      if (tab.gymOnly) notes.push('Gyms only');
      if (tab.libraryOnly) notes.push('Libraries only');
      if (badge) {
        if (badge.image_url) notes.push(`Image · ${badge.label}`);
        if (ended) notes.push(`Ended ${date(badge.expires_on)}`);
        else if (badge.expires_on) notes.push(`Until ${date(badge.expires_on)}`);
        if (badge.hide_when_seen) notes.push('Hides once opened');
      }
      let shown = h('span', { class: 'muted' }, 'No badge');
      if (badge) shown = badge.image_url ? sticker(badge.image_url, badge.label) : pill(badge.label, badge.tone);
      return h(
        'div',
        { class: `nb-row${ended ? ' ended' : ''}` },
        h('span', { class: 'nb-row-icon' }, renderIcon(tab.icon, { size: 18 })),
        h(
          'div',
          { class: 'nb-row-main' },
          h('strong', {}, tab.label),
          notes.length ? h('small', { class: 'muted' }, notes.join(' · ')) : null,
        ),
        h('div', { class: 'nb-row-badge' }, shown),
        h(
          'div',
          { class: 'nb-row-actions' },
          h(
            'button',
            { type: 'button', class: `btn sm${badge ? '' : ' primary'}`, onclick: () => openBadgeModal(tabKey, badge, refresh) },
            badge ? 'Edit' : h('span', {}, renderIcon('plus', { size: 14 }), 'Add'),
          ),
          badge
            ? h(
                'button',
                { type: 'button', class: 'btn sm ghost icon-only', title: 'Remove badge', 'aria-label': `Remove the badge on ${tab.label}`, onclick: () => remove(tabKey) },
                renderIcon('trash', { size: 15 }),
              )
            : null,
        ),
      );
    };

    fill(
      root,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h3', {}, renderIcon('sparkle', { size: 17 }), 'Bottom tab badges'),
          h('span', { class: 'muted' }, 'A label or sticker on a tab icon in every member’s app — “Offer” on Store, “New” on Diet'),
        ),
        h('div', { class: 'nb-list' }, ...state.tabs.filter((key) => TABS[key]).map(row)),
        h(
          'p',
          { class: 'muted sa-hint' },
          'A badge here replaces the Store’s built-in “Soon” label. Members pick up changes the next time the app opens.',
        ),
      ),
    );
  }

  refresh();
  return root;
}
