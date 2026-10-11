import { api } from '../api.js';
import { append, clear, closeModal, confirmDialog, date, h, openModal, renderIcon, stat, table, toast } from '../ui.js';

/** Replaces an element's children. ui.js's append, not the DOM's: the DOM's
 * would print a conditional child that came out null as the text "null". */
const fill = (el, ...children) => append(clear(el), children);

/**
 * Operator console → Store & monetization: the platform's revenue switches,
 * the one supplement catalogue every gym's members shop from, member delivery
 * orders, and what the platform owes each gym in commission.
 *
 * Money here is the platform's (INR), not any one gym's currency, so it has
 * its own formatter rather than ui.js's money(), which follows the signed-in
 * gym.
 */

const inr = (value) => {
  const n = Number(value || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n);
};

const STORE_STATUS = {
  coming_soon: { label: 'Coming soon', tone: 'amber', hint: 'Members see the teaser screen' },
  live: { label: 'Live', tone: 'green', hint: 'Members can browse and buy' },
  disabled: { label: 'Disabled', tone: 'grey', hint: 'Store tab hidden from members' },
};
const COLLECTION = {
  online: 'Online only — in-app UPI',
  desk: 'Front desk only',
  both: 'Both — in-app UPI plus the desk',
};
const CATEGORY_LABEL = {
  protein: 'Protein', creatine: 'Creatine', preworkout: 'Pre-workout', bcaa: 'BCAA & aminos', vitamins: 'Vitamins',
  snacks: 'Snacks & bars', gear: 'Gear & accessories', other: 'Other',
};
const FULFILLMENT_TONE = { placed: 'blue', packed: 'amber', shipped: 'violet', ready: 'amber', delivered: 'green', cancelled: 'grey' };
const NUTRITION_FIELDS = [
  ['serving_size', 'Serving size', 'text', '1 scoop (33 g)'],
  ['servings', 'Servings / pack', 'number', '30'],
  ['calories', 'Calories (kcal)', 'number'],
  ['protein_g', 'Protein (g)', 'number'],
  ['carbs_g', 'Carbs (g)', 'number'],
  ['sugar_g', 'Sugar (g)', 'number'],
  ['fat_g', 'Fat (g)', 'number'],
  ['bcaa_g', 'BCAAs (g)', 'number'],
  ['creatine_g', 'Creatine (g)', 'number'],
  ['caffeine_mg', 'Caffeine (mg)', 'number'],
];

const STATUS_LABEL = {
  placed: 'Placed', packed: 'Packed', shipped: 'Shipped', ready: 'Ready at gym', delivered: 'Delivered / collected', cancelled: 'Cancelled',
};

/**
 * Shrinks a photo in the browser before upload — the server has no image
 * decoder (see photo.js) — to at most `maxSide` px as WebP, keeping
 * transparency so cut-out product shots sit cleanly on the store's tiles.
 */
async function shrinkImage(file, maxSide = 1000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`${file.name} is not an image this browser can read`));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    // Browsers without WebP encoding hand back a PNG instead, which is fine.
    return blob ?? file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A hidden file input behind a normal-looking button. */
function filePicker(label, { multiple = false, onFiles }) {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple, hidden: true, onchange: () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) onFiles(files);
  } });
  return h('span', {}, input, h('button', { type: 'button', class: 'btn sm', onclick: () => input.click() }, renderIcon('upload', { size: 14 }), label));
}

const badge = (tone, text) => h('span', { class: `badge dot ${tone}` }, text);
const field = (label, control, { full = false, hint } = {}) =>
  h('label', { class: `field${full ? ' full' : ''}` }, h('span', {}, label), control, hint ? h('div', { class: 'muted sa-hint' }, hint) : null);

/* ── Product editor ───────────────────────────────────────────────────── */

function openProductModal(product, onSaved) {
  const isNew = !product;
  const p = product ?? { category: 'protein', active: 1, featured: 0, variants: [], nutrition_facts: null };
  const input = (name, value, attrs = {}) => h('input', { name, value: value ?? '', ...attrs });

  const inputs = {
    title: input('title', p.title, { required: true, maxlength: 120, placeholder: 'Gold Standard 100% Whey' }),
    brand: input('brand', p.brand, { required: true, maxlength: 80, placeholder: 'Optimum Nutrition' }),
    category: h(
      'select',
      { name: 'category' },
      ...Object.entries(CATEGORY_LABEL).map(([value, label]) => h('option', { value, selected: value === p.category }, label)),
    ),
    mrp: input('mrp', p.mrp, { type: 'number', min: 0, step: '0.01', required: true }),
    price: input('price', p.price, { type: 'number', min: 0, step: '0.01', required: true }),
    image_url: input('image_url', isNew ? '' : p.image_link, { type: 'url', placeholder: 'https://…/product.webp' }),
    lab_report_url: input('lab_report_url', p.lab_report_url, { type: 'url', placeholder: 'https://…/lab-report.pdf' }),
    description: h('textarea', { name: 'description', rows: 3, maxlength: 2000 }, p.description ?? ''),
    featured: h('input', { type: 'checkbox', checked: Boolean(p.featured) }),
    active: h('input', { type: 'checkbox', checked: Boolean(p.active) }),
  };
  const nutrition = Object.fromEntries(
    NUTRITION_FIELDS.map(([key, , type, placeholder]) => [
      key,
      input(key, p.nutrition_facts?.[key], { type, min: type === 'number' ? 0 : null, step: 'any', placeholder: placeholder ?? '' }),
    ]),
  );

  // Variant rows are plain objects; the table is redrawn from them.
  let variants = p.variants.map((v) => ({
    id: v.id, flavor: v.flavor ?? '', weight: v.weight ?? '', sku: v.sku ?? '', mrp: v.mrp ?? '', price: v.price ?? '', in_stock: Boolean(v.in_stock),
  }));
  const variantBody = h('tbody', {});
  function drawVariants() {
    fill(variantBody, 
      ...(variants.length
        ? variants.map((v, i) => {
            const cell = (key, attrs = {}) =>
              h('td', {}, h('input', { value: v[key], ...attrs, oninput: (e) => { v[key] = e.target.value; } }));
            return h(
              'tr',
              {},
              cell('flavor', { placeholder: 'Chocolate', maxlength: 60 }),
              cell('weight', { placeholder: '1 kg', maxlength: 40 }),
              cell('sku', { placeholder: 'SKU', maxlength: 60 }),
              cell('mrp', { type: 'number', min: 0, step: '0.01', placeholder: 'Product MRP' }),
              cell('price', { type: 'number', min: 0, step: '0.01', placeholder: 'Product price' }),
              h('td', { class: 'sa-center' }, h('input', { type: 'checkbox', checked: v.in_stock, 'aria-label': 'In stock', onchange: (e) => { v.in_stock = e.target.checked; } })),
              h(
                'td',
                {},
                h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove variant', onclick: () => { variants.splice(i, 1); drawVariants(); } }, renderIcon('trash', { size: 15 })),
              ),
            );
          })
        : [h('tr', {}, h('td', { colspan: 7, class: 'muted sa-center' }, 'No variants — the product sells at its own price.'))]),
    );
  }
  drawVariants();

  // Flavours × sizes in one go: the common shape of a supplement listing.
  const genFlavors = h('input', { placeholder: 'Chocolate, Vanilla, Mocha' });
  const genWeights = h('input', { placeholder: '1 kg, 2 kg' });
  const generate = () => {
    const split = (s) => s.value.split(',').map((x) => x.trim()).filter(Boolean);
    const flavors = split(genFlavors);
    const weights = split(genWeights);
    if (!flavors.length && !weights.length) return toast('Type some flavours or sizes first', 'error');
    for (const flavor of flavors.length ? flavors : ['']) {
      for (const weight of weights.length ? weights : ['']) {
        if (!variants.some((v) => v.flavor === flavor && v.weight === weight)) {
          variants.push({ flavor, weight, sku: '', mrp: '', price: '', in_stock: true });
        }
      }
    }
    genFlavors.value = '';
    genWeights.value = '';
    drawVariants();
  };

  /* Photos: uploaded straight away (they don't wait for "Save"), the first
     one is the cover the store's cards show. */
  const photosBlock = h('div', { class: 'sa-photos' });
  let images = (p.images ?? []).filter((img) => img.id);
  function drawPhotos() {
    if (isNew) {
      fill(photosBlock, h('p', { class: 'muted sa-hint' }, 'Save the product first — its photos are added right after.'));
      return;
    }
    fill(
      photosBlock,
      ...images.map((img, i) =>
        h(
          'div',
          { class: 'sa-photo' },
          h('img', { src: img.url, alt: '' }),
          i === 0 ? h('span', { class: 'sa-photo-cover' }, 'Cover') : null,
          h(
            'div',
            { class: 'sa-photo-actions' },
            i > 0
              ? h('button', { type: 'button', title: 'Make cover', 'aria-label': 'Make cover', onclick: () => photoAction(() => api.platformPrimaryProductImage(product.id, img.id)) }, renderIcon('crown', { size: 13 }))
              : null,
            h('button', { type: 'button', title: 'Remove photo', 'aria-label': 'Remove photo', onclick: () => photoAction(() => api.platformDeleteProductImage(product.id, img.id)) }, renderIcon('trash', { size: 13 })),
          ),
        ),
      ),
      images.length < 8
        ? filePicker(images.length ? 'Add photos' : 'Upload photos', {
            multiple: true,
            onFiles: async (files) => {
              for (const file of files.slice(0, 8 - images.length)) {
                await photoAction(async () => api.platformAddProductImage(product.id, await shrinkImage(file)));
              }
            },
          })
        : null,
    );
  }
  async function photoAction(fn) {
    try {
      const updated = await fn();
      images = updated.images.filter((img) => img.id);
      drawPhotos();
      onSaved();
    } catch (err) {
      toast(err.message || 'Could not update the photos', 'error');
    }
  }
  drawPhotos();

  const submit = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add product' : 'Save changes');
  const num = (value) => (value === '' || value === null || value === undefined ? null : Number(value));

  const form = h(
    'form',
    {
      class: 'sa-product-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const facts = {};
        for (const [key, el] of Object.entries(nutrition)) if (el.value.trim() !== '') facts[key] = el.value.trim();
        const payload = {
          title: inputs.title.value,
          brand: inputs.brand.value,
          category: inputs.category.value,
          mrp: num(inputs.mrp.value),
          price: num(inputs.price.value),
          image_url: inputs.image_url.value.trim() || null,
          lab_report_url: inputs.lab_report_url.value.trim() || null,
          description: inputs.description.value.trim() || null,
          featured: inputs.featured.checked,
          active: inputs.active.checked,
          nutrition_facts: Object.keys(facts).length ? facts : null,
          variants: variants.map((v) => ({
            id: v.id,
            flavor: v.flavor.trim() || null,
            weight: v.weight.trim() || null,
            sku: String(v.sku).trim() || null,
            mrp: num(v.mrp),
            price: num(v.price),
            in_stock: v.in_stock,
          })),
        };
        submit.disabled = true;
        try {
          const saved = isNew ? await api.platformCreateStoreProduct(payload) : await api.platformUpdateStoreProduct(product.id, payload);
          closeModal();
          await onSaved();
          if (isNew) {
            // Straight into edit mode, where the photos section lives.
            toast('Product added — now add its photos');
            openProductModal(saved, onSaved);
          } else toast('Product saved');
        } catch (err) {
          const detail = err.details && Object.entries(err.details).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ');
          toast(detail ? `${err.message}: ${detail}` : err.message || 'Could not save the product', 'error');
        } finally {
          submit.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('Product name *', inputs.title, { full: true }),
      field('Brand *', inputs.brand),
      field('Category', inputs.category),
      field('MRP (₹) *', inputs.mrp),
      field('Selling price (₹) *', inputs.price, { hint: 'Variants can override both.' }),
      h('div', { class: 'field full' }, h('span', {}, 'Photos'), photosBlock),
      field('…or an image link', inputs.image_url, { full: true, hint: 'Only used while the product has no uploaded photos.' }),
      field('Lab report URL', inputs.lab_report_url, { full: true, hint: 'Third-party purity / label-claim test, shown to members as a link.' }),
      field('Description', inputs.description, { full: true }),
      h(
        'div',
        { class: 'field full sa-checks' },
        h('label', {}, inputs.active, ' Active — members can see and buy it'),
        h('label', {}, inputs.featured, ' Bestseller — pinned to the top with a badge'),
      ),
    ),
    h('h4', { class: 'sa-subhead' }, 'Nutrition facts ', h('span', { class: 'muted' }, '(per serving)')),
    h('div', { class: 'form-grid sa-nutrition' }, ...NUTRITION_FIELDS.map(([key, label]) => field(label, nutrition[key]))),
    h('h4', { class: 'sa-subhead' }, 'Flavours & sizes'),
    h(
      'div',
      { class: 'sa-generate' },
      genFlavors,
      h('span', { class: 'muted' }, '×'),
      genWeights,
      h('button', { type: 'button', class: 'btn sm', onclick: generate }, renderIcon('plus', { size: 14 }), 'Generate'),
    ),
    h(
      'div',
      { class: 'table-wrap sa-variants' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...['Flavour', 'Size', 'SKU', 'MRP', 'Price', 'In stock', ''].map((t) => h('th', {}, t)))),
        variantBody,
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onclick: () => {
          variants.push({ flavor: '', weight: '', sku: '', mrp: '', price: '', in_stock: true });
          drawVariants();
        },
      },
      renderIcon('plus', { size: 14 }),
      'Add a variant',
    ),
    h(
      'div',
      { class: 'modal-foot', style: 'padding:14px 0 0;border:none' },
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
      submit,
    ),
  );

  openModal({ title: isNew ? 'New store product' : `Edit · ${product.title}`, wide: true, body: form });
}

/* ── Orders ───────────────────────────────────────────────────────────── */

function openOrderModal(order, onSaved) {
  const status = h(
    'select',
    { name: 'fulfillment_status' },
    ...['placed', 'packed', 'shipped', 'ready', 'delivered', 'cancelled']
      .filter((s) => s !== 'ready' || order.fulfillment_method === 'pickup')
      .map((s) => h('option', { value: s, selected: s === order.fulfillment_status }, STATUS_LABEL[s])),
  );
  const courier = h('input', { value: order.courier_name ?? '', placeholder: 'Delhivery / Shiprocket' });
  const trackingId = h('input', { value: order.tracking_id ?? '', placeholder: 'AWB number' });
  const trackingUrl = h('input', { type: 'url', value: order.tracking_url ?? '', placeholder: 'https://…' });

  const body = h(
    'div',
    {},
    h(
      'div',
      { class: 'sa-order-ship' },
      h('strong', {}, order.shipping_name, ' · ', order.shipping_phone),
      order.fulfillment_method === 'pickup'
        ? h('p', {}, `Pickup at the gym (${order.tenant_slug}) — ship it to the gym; its desk marks it received and collected.`)
        : h('p', {}, [order.shipping_address, order.shipping_city, order.shipping_state, order.shipping_pincode].filter(Boolean).join(', ')),
      h(
        'ul',
        {},
        ...order.items.map((i) => h('li', {}, `${i.quantity} × ${i.brand ? `${i.brand} ` : ''}${i.title}${i.variant_label ? ` (${i.variant_label})` : ''} — ${inr(i.line_total)}`)),
      ),
    ),
    h(
      'div',
      { class: 'form-grid' },
      field('Status', status, { hint: 'Delivered approves the gym’s commission; cancelled voids it.' }),
      field('Courier', courier),
      field('Tracking / AWB', trackingId),
      field('Tracking link', trackingUrl),
    ),
  );
  const save = h('button', {
    class: 'btn primary',
    onclick: async () => {
      save.disabled = true;
      try {
        await api.platformUpdateStoreOrder(order.id, {
          fulfillment_status: status.value,
          courier_name: courier.value.trim() || null,
          tracking_id: trackingId.value.trim() || null,
          tracking_url: trackingUrl.value.trim() || null,
        });
        closeModal();
        toast(`${order.order_code} updated`);
        await onSaved();
      } catch (err) {
        toast(err.message || 'Could not update the order', 'error');
      } finally {
        save.disabled = false;
      }
    },
  }, 'Save');
  openModal({
    title: `Order ${order.order_code}`,
    subtitle: `${order.member_name || 'Member'} · ${order.tenant_slug} · ${inr(order.total_amount)}`,
    body,
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Close'), save],
  });
}

function openPayoutModal(row, onSaved) {
  const ref = h('input', { placeholder: 'UTR / transfer reference', maxlength: 80 });
  const save = h('button', {
    class: 'btn primary',
    onclick: async () => {
      save.disabled = true;
      try {
        const res = await api.platformRecordPayout(row.tenant_slug, { payout_ref: ref.value.trim() });
        closeModal();
        toast(`${inr(res.total)} marked paid to ${row.gym_name}`);
        await onSaved();
      } catch (err) {
        toast(err.message || 'Could not record the payout', 'error');
      } finally {
        save.disabled = false;
      }
    },
  }, `Mark ${inr(row.payable)} paid`);
  openModal({
    title: `Payout · ${row.gym_name}`,
    subtitle: 'Record the bank transfer once it has gone out',
    body: h(
      'div',
      {},
      h('p', { class: 'muted', style: 'margin-top:0' }, `Every approved commission (${inr(row.payable)}) is marked paid under this reference. Pending store commissions wait until their orders are delivered.`),
      field('Transfer reference', ref, { full: true }),
    ),
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
  });
}

/* ── Banners ──────────────────────────────────────────────────────────── */

function openBannerModal(banner, products, onSaved) {
  const isNew = !banner;
  const b = banner ?? { bg_color: '#0c831f', link_type: 'category', link_value: 'protein', active: 1 };
  const title = h('input', { value: b.title ?? '', maxlength: 60, required: true, placeholder: 'Whey week' });
  const subtitle = h('input', { value: b.subtitle ?? '', maxlength: 120, placeholder: 'Up to 25% off top brands' });
  const cta = h('input', { value: b.cta_label ?? '', maxlength: 24, placeholder: 'Shop now' });
  const color = h('input', { type: 'color', value: b.bg_color });
  const active = h('input', { type: 'checkbox', checked: Boolean(b.active) });
  const linkType = h(
    'select',
    { onchange: () => drawTarget() },
    ...[['none', 'No link'], ['category', 'A category'], ['product', 'A product']].map(([v, l]) => h('option', { value: v, selected: v === b.link_type }, l)),
  );
  const target = h('span', {});
  let linkValue = h('select', {});
  function drawTarget() {
    if (linkType.value === 'category') {
      linkValue = h('select', {}, ...Object.entries(CATEGORY_LABEL).map(([v, l]) => h('option', { value: v, selected: v === b.link_value }, l)));
    } else if (linkType.value === 'product') {
      linkValue = h('select', {}, ...products.map((p) => h('option', { value: p.id, selected: String(p.id) === String(b.link_value) }, `${p.brand} · ${p.title}`)));
    } else linkValue = null;
    fill(target, linkValue ? field('Links to', linkValue) : null);
  }
  drawTarget();

  let current = banner;
  const imageBlock = h('div', { class: 'sa-photos' });
  function drawImage() {
    if (!current) {
      fill(imageBlock, h('p', { class: 'muted sa-hint' }, 'Save the banner first — its picture is added right after.'));
      return;
    }
    fill(
      imageBlock,
      current.image_url ? h('div', { class: 'sa-photo wide' }, h('img', { src: current.image_url, alt: '' })) : null,
      filePicker(current.image_url ? 'Replace picture' : 'Upload picture', {
        onFiles: async ([file]) => {
          try {
            current = await api.platformBannerImage(current.id, await shrinkImage(file, 900));
            drawImage();
            onSaved();
          } catch (err) {
            toast(err.message || 'Could not upload the picture', 'error');
          }
        },
      }),
      current.image_url
        ? h('button', { type: 'button', class: 'btn sm ghost', onclick: async () => { current = await api.platformClearBannerImage(current.id); drawImage(); onSaved(); } }, 'Remove picture')
        : null,
    );
  }
  drawImage();

  const save = h('button', {
    class: 'btn primary',
    onclick: async () => {
      const payload = {
        title: title.value.trim(),
        subtitle: subtitle.value.trim() || null,
        cta_label: cta.value.trim() || null,
        bg_color: color.value,
        link_type: linkType.value,
        link_value: linkValue ? String(linkValue.value) : null,
        active: active.checked,
      };
      save.disabled = true;
      try {
        const saved = isNew ? await api.platformCreateBanner(payload) : await api.platformUpdateBanner(banner.id, payload);
        closeModal();
        await onSaved();
        if (isNew) {
          toast('Banner added — now give it a picture');
          openBannerModal(saved, products, onSaved);
        } else toast('Banner saved');
      } catch (err) {
        toast(err.message || 'Could not save the banner', 'error');
      } finally {
        save.disabled = false;
      }
    },
  }, isNew ? 'Add banner' : 'Save banner');

  const remove = isNew
    ? null
    : h('button', {
        class: 'btn ghost danger',
        onclick: () =>
          confirmDialog({
            title: 'Delete this banner?',
            message: 'It disappears from every member’s store straight away.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
              await api.platformDeleteBanner(banner.id);
              toast('Banner deleted');
              await onSaved();
            },
          }),
      }, 'Delete');

  openModal({
    title: isNew ? 'New banner' : `Banner · ${banner.title}`,
    wide: true,
    body: h(
      'div',
      {},
      h(
        'div',
        { class: 'form-grid' },
        field('Headline *', title, { full: true }),
        field('Subline', subtitle, { full: true }),
        field('Button text', cta, { hint: 'Shown when the banner links somewhere.' }),
        field('Background colour', color),
        field('When tapped', linkType),
        target,
        h('div', { class: 'field full' }, h('span', {}, 'Picture'), imageBlock, h('div', { class: 'muted sa-hint' }, 'A cut-out product shot works best; it sits on the right of the banner.')),
        h('div', { class: 'field full sa-checks' }, h('label', {}, active, ' Show this banner in the store')),
      ),
    ),
    footer: [remove, h('div', { style: 'flex:1' }), h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
  });
}

/* ── The section ──────────────────────────────────────────────────────── */

export function renderStoreAdminSection({ onExpired } = {}) {
  const root = h('div', { class: 'sa' }, h('div', { class: 'empty' }, 'Loading store & monetization…'));
  const orderFilter = { status: '' };

  async function guard(fn) {
    try {
      return await fn();
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && onExpired) {
        await onExpired();
        return null;
      }
      throw err;
    }
  }

  async function save(payload, message) {
    try {
      await api.platformUpdateMonetization(payload);
      toast(message);
    } catch (err) {
      toast(err.message || 'Could not save', 'error');
    }
    await refresh();
  }

  function controlsCard(state) {
    const s = state.settings;
    const seg = h(
      'div',
      { class: 'sa-seg', role: 'radiogroup', 'aria-label': 'Store status' },
      ...Object.entries(STORE_STATUS).map(([value, meta]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(s.store_status === value),
            class: `sa-seg-btn${s.store_status === value ? ` active ${meta.tone}` : ''}`,
            onclick: () => {
              if (value === s.store_status) return;
              const apply = () => save({ store_status: value }, `Store is now ${meta.label.toLowerCase()}`);
              if (value === 'live') {
                confirmDialog({
                  title: 'Open the store to every member?',
                  message: 'Members of every gym will see the live catalogue and can pay by UPI straight away.',
                  confirmLabel: 'Go live',
                  onConfirm: apply,
                });
              } else apply();
            },
          },
          h('strong', {}, meta.label),
          h('small', {}, meta.hint),
        ),
      ),
    );

    const mode = h(
      'select',
      { onchange: (e) => save({ fitness_addon_collection_mode: e.target.value }, 'Paywall collection mode saved') },
      ...Object.entries(COLLECTION).map(([value, label]) => h('option', { value, selected: value === s.fitness_addon_collection_mode }, label)),
    );

    const pct = (name, value) => h('input', { name, type: 'number', min: 0, max: 100, step: '0.1', value });
    const rupees = (name, value) => h('input', { name, type: 'number', min: 1, step: '1', value });
    const rates = {
      addon_commission_pct: pct('addon_commission_pct', s.addon_commission_pct),
      store_commission_pct: pct('store_commission_pct', s.store_commission_pct),
      addon_price_1m: rupees('addon_price_1m', s.addon_price_1m),
      addon_price_3m: rupees('addon_price_3m', s.addon_price_3m),
      addon_price_6m: rupees('addon_price_6m', s.addon_price_6m),
    };
    const text = (name, value, placeholder) => h('input', { name, value, maxlength: 60, placeholder });
    const delivery = {
      delivery_eta: text('delivery_eta', s.delivery_eta, 'Delivery in 2–4 days'),
      pickup_eta: text('pickup_eta', s.pickup_eta, 'Ready at your gym in 3–5 days'),
    };
    const pickupOn = h('input', { type: 'checkbox', checked: Boolean(s.pickup_enabled) });
    const saveRates = h(
      'button',
      {
        class: 'btn primary',
        onclick: () =>
          save(
            {
              ...Object.fromEntries(Object.entries(rates).map(([k, el]) => [k, Number(el.value)])),
              delivery_eta: delivery.delivery_eta.value.trim(),
              pickup_eta: delivery.pickup_eta.value.trim(),
              pickup_enabled: pickupOn.checked,
            },
            'Settings saved',
          ),
      },
      'Save settings',
    );

    return h(
      'div',
      { class: 'card sa-controls' },
      h('div', { class: 'card-head' }, h('h3', {}, renderIcon('settings', { size: 17 }), 'Controls')),
      h('div', { class: 'sa-label' }, 'Member store'),
      seg,
      h(
        'div',
        { class: 'form-grid sa-rates' },
        field('Diet & Workout paywall — how members pay', mode, {
          full: true,
          hint: state.razorpay_configured
            ? 'Online and Both show the in-app UPI tiers; Both also offers the gym’s front desk.'
            : 'Razorpay keys are not set, so members are shown the front desk whatever is picked here.',
        }),
        field('Gym cut of add-on sales (%)', rates.addon_commission_pct),
        field('Gym cut of store sales (%)', rates.store_commission_pct, { hint: 'Fixed onto each order when it is placed.' }),
        field('Add-on · 1 month (₹)', rates.addon_price_1m),
        field('Add-on · 3 months (₹)', rates.addon_price_3m),
        field('Add-on · 6 months (₹)', rates.addon_price_6m),
        field('Delivery promise', delivery.delivery_eta, { hint: 'The big line in the store header, like Blinkit’s “10 minutes”.' }),
        field('Pickup promise', delivery.pickup_eta, { hint: 'Shown when a member chooses to collect at their gym.' }),
        h('div', { class: 'field full sa-checks' }, h('label', {}, pickupOn, ' Offer pickup at the member’s gym — orders ship to the gym and its front desk hands them over')),
      ),
      h('div', { class: 'sa-actions' }, saveRates),
    );
  }

  function bannersCard(banners, products, onChanged) {
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', {}, renderIcon('image', { size: 17 }), 'Store banners'),
        h('span', { class: 'muted' }, 'The swipeable strip at the top of the store'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary sm', onclick: () => openBannerModal(null, products, onChanged) }, renderIcon('plus', { size: 14 }), 'Add banner'),
      ),
      banners.length
        ? h(
            'div',
            { class: 'sa-banners' },
            ...banners.map((b) =>
              h(
                'div',
                { class: `sa-banner${b.active ? '' : ' off'}`, style: `--bn:${b.bg_color}` },
                h('div', { class: 'sa-banner-text' }, h('strong', {}, b.title), b.subtitle ? h('small', {}, b.subtitle) : null),
                b.image_url ? h('img', { src: b.image_url, alt: '' }) : null,
                h(
                  'div',
                  { class: 'sa-banner-foot' },
                  h('span', {}, b.active ? 'Live' : 'Hidden', ' · ', b.link_type === 'none' ? 'no link' : b.link_type === 'category' ? CATEGORY_LABEL[b.link_value] : products.find((p) => String(p.id) === String(b.link_value))?.title ?? 'product'),
                  h('button', { type: 'button', class: 'btn sm', onclick: () => openBannerModal(b, products, onChanged) }, 'Edit'),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted', style: 'margin:0' }, 'No banners yet. A banner with a bold offer (“Whey week — up to 25% off”) linked to a category is the quickest way to drive orders.'),
    );
  }

  function catalogCard(products, onChanged) {
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', {}, renderIcon('bag', { size: 17 }), 'Central catalogue'),
        h('span', { class: 'muted' }, `${products.filter((p) => p.active).length} active of ${products.length}`),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary sm', onclick: () => openProductModal(null, onChanged) }, renderIcon('plus', { size: 14 }), 'Add product'),
      ),
      table(
        [
          {
            label: 'Product',
            render: (p) =>
              h(
                'div',
                { class: 'sa-product' },
                p.image_url
                  ? h('img', { class: 'sa-thumb', src: p.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
                  : h('span', { class: 'sa-thumb' }, renderIcon('bag', { size: 16 })),
                h('div', {}, h('strong', {}, p.title), h('div', { class: 'muted' }, p.brand)),
              ),
          },
          { label: 'Category', render: (p) => CATEGORY_LABEL[p.category] ?? p.category },
          {
            label: 'Variants',
            render: (p) => (p.variants.length ? `${p.variants.length} · ${p.variants.filter((v) => v.in_stock).length} in stock` : '—'),
          },
          {
            label: 'Price',
            align: 'right',
            render: (p) => h('span', {}, p.variants.length > 1 ? 'from ' : '', inr(p.from_price), p.mrp > p.price ? h('s', { class: 'muted sa-mrp' }, inr(p.mrp)) : null),
          },
          {
            label: 'Status',
            render: (p) => h('span', { class: 'row', style: 'gap:6px' }, p.active ? badge('green', 'Active') : badge('grey', 'Hidden'), p.featured ? badge('amber', 'Bestseller') : null),
          },
          {
            label: '',
            render: (p) =>
              h(
                'div',
                { class: 'row', style: 'gap:4px;justify-content:flex-end' },
                h('button', { class: 'btn sm ghost', onclick: () => openProductModal(p, onChanged) }, 'Edit'),
                h(
                  'button',
                  {
                    class: 'btn sm ghost danger',
                    onclick: () =>
                      confirmDialog({
                        title: `Remove ${p.title}?`,
                        message: 'A product that has been ordered is hidden instead of deleted, so order history keeps it.',
                        confirmLabel: 'Remove',
                        danger: true,
                        onConfirm: async () => {
                          const res = await api.platformDeleteStoreProduct(p.id);
                          toast(res.retired ? 'Product hidden (it has orders)' : 'Product deleted');
                          await onChanged();
                        },
                      }),
                  },
                  'Remove',
                ),
              ),
          },
        ],
        products,
        { empty: 'No products yet. Add the first one — the store can only go live with at least one active product.' },
      ),
    );
  }

  function ordersCard(orders, onChanged) {
    const filter = h(
      'select',
      {
        'aria-label': 'Filter orders',
        onchange: async (e) => {
          orderFilter.status = e.target.value;
          await refresh();
        },
      },
      h('option', { value: '' }, 'All paid orders'),
      ...['placed', 'packed', 'shipped', 'ready', 'delivered', 'cancelled'].map((s) => h('option', { value: s, selected: s === orderFilter.status }, STATUS_LABEL[s])),
    );
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, renderIcon('truck', { size: 17 }), 'Member orders'), h('div', { class: 'spacer' }), filter),
      table(
        [
          { label: 'Order', render: (o) => h('div', {}, h('strong', {}, o.order_code), h('div', { class: 'muted' }, date(o.paid_at || o.created_at))) },
          { label: 'Gym', render: (o) => o.tenant_slug },
          {
            label: 'Member',
            render: (o) =>
              h(
                'div',
                {},
                o.member_name || '—',
                h('div', { class: 'muted' }, o.fulfillment_method === 'pickup' ? 'Gym pickup' : `${o.shipping_city ?? ''} ${o.shipping_pincode ?? ''}`),
              ),
          },
          { label: 'Items', render: (o) => o.items.reduce((n, i) => n + i.quantity, 0) },
          { label: 'Value', align: 'right', render: (o) => inr(o.total_amount) },
          { label: 'Gym cut', align: 'right', render: (o) => h('span', {}, inr(o.commission_amount), h('div', { class: 'muted' }, `${o.commission_pct}%`)) },
          { label: 'Status', render: (o) => badge(FULFILLMENT_TONE[o.fulfillment_status] ?? 'grey', STATUS_LABEL[o.fulfillment_status] ?? o.fulfillment_status) },
        ],
        orders,
        { onRowClick: (o) => openOrderModal(o, onChanged), empty: 'No paid orders yet.' },
      ),
    );
  }

  function payoutsCard(rows, onChanged) {
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, renderIcon('wallet', { size: 17 }), 'Gym commissions & payouts')),
      table(
        [
          { label: 'Gym', render: (r) => h('div', {}, h('strong', {}, r.gym_name), h('div', { class: 'muted' }, `${r.sales} sale${r.sales === 1 ? '' : 's'}`)) },
          { label: 'Pending delivery', align: 'right', render: (r) => inr(r.pending) },
          { label: 'Payable now', align: 'right', render: (r) => h('strong', {}, inr(r.payable)) },
          { label: 'Paid out', align: 'right', render: (r) => inr(r.paid) },
          {
            label: '',
            render: (r) =>
              r.payable > 0 ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); openPayoutModal(r, onChanged); } }, 'Record payout') : null,
          },
        ],
        rows,
        { empty: 'No commissions earned yet.' },
      ),
    );
  }

  async function refresh() {
    const data = await guard(() =>
      Promise.all([
        api.platformMonetization(),
        api.platformStoreProducts(),
        api.platformStoreOrders({ status: orderFilter.status }),
        api.platformCommissions(),
        api.platformBanners(),
      ]),
    ).catch((err) => {
      toast(err.message || 'Could not load store & monetization', 'error');
      return null;
    });
    if (!data) return;
    const [state, products, orders, commissions, banners] = data;
    const { summary, settings } = state;
    const status = STORE_STATUS[settings.store_status];

    fill(root, 
      h(
        'div',
        { class: 'grid cols-4', style: 'gap:12px;margin-bottom:16px' },
        stat('Store', status.label, status.hint),
        stat('Store GMV', inr(summary.store.gmv), `${summary.store.orders} paid order${summary.store.orders === 1 ? '' : 's'} · ${summary.store.to_ship} to ship`),
        stat('Add-on sales', inr(summary.addon.revenue), `${summary.addon.sales} in-app purchase${summary.addon.sales === 1 ? '' : 's'}`),
        stat('Owed to gyms', inr(summary.commissions.owed), `${inr(summary.commissions.paid)} paid out`),
      ),
      !state.razorpay_configured
        ? h(
            'div',
            { class: 'card sa-warn' },
            renderIcon('alert', { size: 18 }),
            h('p', {}, 'Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET), so in-app payments are off: the paywall falls back to the front desk, and a live store can be browsed but its checkout stays closed.'),
          )
        : null,
      controlsCard(state),
      bannersCard(banners.items, products.items, refresh),
      catalogCard(products.items, refresh),
      ordersCard(orders.items, refresh),
      payoutsCard(commissions.items, refresh),
    );
  }

  refresh();
  return root;
}
