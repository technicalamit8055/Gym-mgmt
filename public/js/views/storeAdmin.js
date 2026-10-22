import { api } from '../api.js';
import { barcodeInput, openProductScanner } from '../productScanner.js';
import { append, clear, closeModal, confirmDialog, date, h, openModal, renderIcon, stat, table, toast } from '../ui.js';

/** Replaces an element's children. ui.js's append, not the DOM's: the DOM's
 * would print a conditional child that came out null as the text "null". */
const fill = (el, ...children) => append(clear(el), children);

/**
 * Operator console → Store & monetization: the platform's revenue switches,
 * the catalogue members shop from, member delivery orders, and what the
 * platform owes each gym in commission.
 *
 * Two stores run on it, picked at the top of the section: the gym store
 * (GymVym's supplements and gear) and the CoachBook store (books, test prep
 * and stationery for coaching students). Each has its own switch, cut,
 * banners, catalogue and orders; the Diet & Workout add-on is the gym's only.
 *
 * Money here is the platform's (INR), not any one gym's currency, so it has
 * its own formatter rather than ui.js's money(), which follows the signed-in
 * gym.
 */

export const inr = (value) => {
  const n = Number(value || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n);
};

const STORE_STATUS = {
  coming_soon: { label: 'Coming soon', tone: 'amber', hint: 'Members see the teaser screen', studentHint: 'Students see the teaser screen' },
  live: { label: 'Live', tone: 'green', hint: 'Members can browse and buy', studentHint: 'Students can browse and buy' },
  disabled: { label: 'Disabled', tone: 'grey', hint: 'Store tab hidden from members', studentHint: 'Store tab hidden from students' },
};
const COLLECTION = {
  online: 'Online only — in-app UPI',
  desk: 'Front desk only',
  both: 'Both — in-app UPI plus the desk',
};
export const CATEGORY_LABEL = {
  protein: 'Protein', creatine: 'Creatine', preworkout: 'Pre-workout', bcaa: 'BCAA & aminos', vitamins: 'Vitamins',
  snacks: 'Snacks & bars', gear: 'Gear & accessories', other: 'Other',
};
export const COACHING_CATEGORY_LABEL = {
  books: 'Books', test_prep: 'Test prep & guides', pyq: 'PYQs & papers', stationery: 'Stationery', calculators: 'Calculators',
  desk: 'Study desk', bags: 'Bags & bottles', other: 'Other',
};
export const categoryLabels = (vertical) => (vertical === 'coaching' ? COACHING_CATEGORY_LABEL : CATEGORY_LABEL);

/**
 * What each store calls things. A book's variants use the same two columns
 * as a supplement's — flavour × size becomes edition/language × format — and
 * the lab-report link becomes a "Look inside" sample.
 */
export const STORE_COPY = {
  gym: {
    name: 'Gym store',
    app: 'GymVym',
    members: 'Members of every gym',
    org: 'gym',
    defaultCategory: 'protein',
    titlePlaceholder: 'Gold Standard 100% Whey',
    brandLabel: 'Brand',
    brandPlaceholder: 'Optimum Nutrition',
    optionA: 'Flavour',
    optionB: 'Size',
    optionAPlaceholder: 'Chocolate',
    optionBPlaceholder: '1 kg',
    generateA: 'Chocolate, Vanilla, Mocha',
    generateB: '1 kg, 2 kg',
    generateEmpty: 'Type some flavours or sizes first',
    variantsHeading: 'Flavours & sizes',
    linkLabel: 'Lab report URL',
    linkPlaceholder: 'https://…/lab-report.pdf',
    linkHint: 'Third-party purity / label-claim test, shown to members as a link.',
    bannerTitle: 'Whey week',
    bannerSub: 'Up to 25% off top brands',
    bannerColor: '#0c831f',
    bannerEmpty: 'No banners yet. A banner with a bold offer (“Whey week — up to 25% off”) linked to a category is the quickest way to drive orders.',
  },
  coaching: {
    name: 'Coaching store',
    app: 'CoachBook',
    members: 'Students of every institute',
    org: 'institute',
    defaultCategory: 'books',
    titlePlaceholder: 'Concepts of Physics — Vol. 1',
    brandLabel: 'Publisher / brand',
    brandPlaceholder: 'Bharati Bhawan',
    optionA: 'Edition / language',
    optionB: 'Format',
    optionAPlaceholder: 'English',
    optionBPlaceholder: 'Paperback',
    generateA: 'English, Hindi',
    generateB: 'Paperback, Hardcover',
    generateEmpty: 'Type some editions or formats first',
    variantsHeading: 'Editions & formats',
    linkLabel: 'Sample pages URL',
    linkPlaceholder: 'https://…/sample-chapter.pdf',
    linkHint: 'A few pages of the book (a PDF) — students see it as “Look inside”.',
    bannerTitle: 'JEE 2027 starter kit',
    bannerSub: 'Physics, Chemistry & Maths — up to 20% off',
    bannerColor: '#4f46e5',
    bannerEmpty: 'No banners yet. A banner for exam season (“NEET crash kit — up to 20% off”) linked to a category is the quickest way to drive orders.',
  },
};
const copyFor = (vertical) => STORE_COPY[vertical] ?? STORE_COPY.gym;
export const FULFILLMENT_TONE = { placed: 'blue', packed: 'amber', shipped: 'violet', ready: 'amber', delivered: 'green', cancelled: 'grey' };
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
const BOOK_FIELDS = [
  ['author', 'Author(s)', 'text', 'H. C. Verma'],
  ['publisher', 'Publisher', 'text', 'Bharati Bhawan'],
  ['edition', 'Edition', 'text', '2025–26'],
  ['year', 'Year', 'number', '2025'],
  ['language', 'Language', 'text', 'English'],
  ['pages', 'Pages', 'number', '480'],
  ['isbn', 'ISBN', 'text', '978…'],
  ['exam', 'For exam / class', 'text', 'JEE Main & Advanced'],
];

export const STATUS_LABEL = {
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

/** Where the product editor saves to. The console writes the central
 * catalogue; the Shop panel (sellerPanel.js) passes its own, shop-scoped set. */
const CONSOLE_PRODUCT_OPS = {
  create: (payload) => api.platformCreateStoreProduct(payload),
  update: (id, payload) => api.platformUpdateStoreProduct(id, payload),
  addImage: (id, file) => api.platformAddProductImage(id, file),
  deleteImage: (id, imageId) => api.platformDeleteProductImage(id, imageId),
  primaryImage: (id, imageId) => api.platformPrimaryProductImage(id, imageId),
};

/**
 * The product editor. `badges` is the operator's quality-badge library to
 * pick from, or null to leave the picker out — badges are the operator's to
 * vouch for, so a partner shop's editor has none. `vertical` is the store a
 * new product goes into; an existing one stays in its own. A coaching
 * product has book details where a supplement has nutrition facts.
 */
export function openProductModal(product, onSaved, badges = [], ops = CONSOLE_PRODUCT_OPS, { prefill = null, variantId = null, vertical = 'gym' } = {}) {
  const isNew = !product;
  const library = badges ?? [];
  const store = product?.vertical ?? vertical;
  const copy = copyFor(store);
  const books = store === 'coaching';
  // `prefill`: a new product's starting values, from a scanned barcode.
  const p = product ?? { category: copy.defaultCategory, active: 1, featured: 0, variants: [], nutrition_facts: null, book_details: null, badges: [], ...prefill };
  const input = (name, value, attrs = {}) => h('input', { name, value: value ?? '', ...attrs });

  const inputs = {
    title: input('title', p.title, { required: true, maxlength: 120, placeholder: copy.titlePlaceholder }),
    brand: input('brand', p.brand, { required: true, maxlength: 80, placeholder: copy.brandPlaceholder }),
    category: h(
      'select',
      { name: 'category' },
      ...Object.entries(categoryLabels(store)).map(([value, label]) => h('option', { value, selected: value === p.category }, label)),
    ),
    mrp: input('mrp', p.mrp, { type: 'number', min: 0, step: '0.01', required: true }),
    price: input('price', p.price, { type: 'number', min: 0, step: '0.01', required: true }),
    image_url: input('image_url', p.image_link, { type: 'url', placeholder: 'https://…/product.webp' }),
    barcode: input('barcode', p.barcode, { inputmode: 'numeric', maxlength: 20, placeholder: books ? 'Scan the ISBN on the back cover' : 'Scan or type the pack’s code' }),
    lab_report_url: input('lab_report_url', p.lab_report_url, { type: 'url', placeholder: copy.linkPlaceholder }),
    description: h('textarea', { name: 'description', rows: 3, maxlength: 2000 }, p.description ?? ''),
    featured: h('input', { type: 'checkbox', checked: Boolean(p.featured) }),
    active: h('input', { type: 'checkbox', checked: Boolean(p.active) }),
  };
  // Nutrition facts for a supplement, book details for the coaching store.
  const factFields = books ? BOOK_FIELDS : NUTRITION_FIELDS;
  const factValues = (books ? p.book_details : p.nutrition_facts) ?? {};
  const facts = Object.fromEntries(
    factFields.map(([key, , type, placeholder]) => [
      key,
      input(key, factValues[key], { type, min: type === 'number' ? 0 : null, step: books ? '1' : 'any', placeholder: placeholder ?? '' }),
    ]),
  );

  // Variant rows are plain objects; the table is redrawn from them.
  let variants = p.variants.map((v) => ({
    id: v.id, flavor: v.flavor ?? '', weight: v.weight ?? '', sku: v.sku ?? '', barcode: v.barcode ?? '', mrp: v.mrp ?? '', price: v.price ?? '', in_stock: Boolean(v.in_stock ?? true),
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
              // The flavour × size a scan just found.
              { class: variantId && v.id === variantId ? 'sa-variant-hit' : null },
              cell('flavor', { placeholder: copy.optionAPlaceholder, maxlength: 60 }),
              cell('weight', { placeholder: copy.optionBPlaceholder, maxlength: 40 }),
              cell('sku', { placeholder: 'SKU', maxlength: 60 }),
              h(
                'td',
                {},
                barcodeInput(h('input', { value: v.barcode, placeholder: 'Barcode', maxlength: 20, inputmode: 'numeric', oninput: (e) => { v.barcode = e.target.value; } })),
              ),
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
        : [h('tr', {}, h('td', { colspan: 8, class: 'muted sa-center' }, 'No variants — the product sells at its own price.'))]),
    );
  }
  drawVariants();

  // Flavours × sizes in one go: the common shape of a supplement listing (a
  // book's: languages × formats).
  const genFlavors = h('input', { placeholder: copy.generateA });
  const genWeights = h('input', { placeholder: copy.generateB });
  const generate = () => {
    const split = (s) => s.value.split(',').map((x) => x.trim()).filter(Boolean);
    const flavors = split(genFlavors);
    const weights = split(genWeights);
    if (!flavors.length && !weights.length) return toast(copy.generateEmpty, 'error');
    for (const flavor of flavors.length ? flavors : ['']) {
      for (const weight of weights.length ? weights : ['']) {
        if (!variants.some((v) => v.flavor === flavor && v.weight === weight)) {
          variants.push({ flavor, weight, sku: '', barcode: '', mrp: '', price: '', in_stock: true });
        }
      }
    }
    genFlavors.value = '';
    genWeights.value = '';
    drawVariants();
  };

  /* Quality badges: tap to pin or unpin. Members see them one at a time on
     the product's card, after Bestseller when that is ticked. */
  const picked = new Set((p.badges ?? []).map((b) => b.id));
  const badgePicker = h('div', { class: 'sa-badge-pick' });
  function drawBadgePicker() {
    fill(
      badgePicker,
      library.length
        ? library.map((b) =>
            h(
              'button',
              {
                type: 'button',
                class: `sa-badge-chip${picked.has(b.id) ? ' on' : ''}${b.active ? '' : ' off'}`,
                'aria-pressed': String(picked.has(b.id)),
                title: b.active ? b.name : `${b.name} (hidden from members)`,
                onclick: () => {
                  if (picked.has(b.id)) picked.delete(b.id);
                  else picked.add(b.id);
                  drawBadgePicker();
                },
              },
              h('span', { class: 'sa-badge-ico' }, badgeIcon(b, 14)),
              b.name,
              picked.has(b.id) ? renderIcon('check', { size: 13, stroke: 2.6 }) : null,
            ),
          )
        : h('p', { class: 'muted sa-hint', style: 'margin:0' }, 'No badges yet — add them under “Quality badges” first.'),
    );
  }
  drawBadgePicker();

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
              ? h('button', { type: 'button', title: 'Make cover', 'aria-label': 'Make cover', onclick: () => photoAction(() => ops.primaryImage(product.id, img.id)) }, renderIcon('crown', { size: 13 }))
              : null,
            h('button', { type: 'button', title: 'Remove photo', 'aria-label': 'Remove photo', onclick: () => photoAction(() => ops.deleteImage(product.id, img.id)) }, renderIcon('trash', { size: 13 })),
          ),
        ),
      ),
      images.length < 8
        ? filePicker(images.length ? 'Add photos' : 'Upload photos', {
            multiple: true,
            onFiles: async (files) => {
              for (const file of files.slice(0, 8 - images.length)) {
                await photoAction(async () => ops.addImage(product.id, await shrinkImage(file)));
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
        const filled = {};
        for (const [key, el] of Object.entries(facts)) if (el.value.trim() !== '') filled[key] = el.value.trim();
        const payload = {
          // The console's own catalogue; a shop's products follow its store.
          ...(isNew ? { vertical: store } : {}),
          title: inputs.title.value,
          brand: inputs.brand.value,
          category: inputs.category.value,
          mrp: num(inputs.mrp.value),
          price: num(inputs.price.value),
          image_url: inputs.image_url.value.trim() || null,
          barcode: inputs.barcode.value.trim() || null,
          lab_report_url: inputs.lab_report_url.value.trim() || null,
          description: inputs.description.value.trim() || null,
          featured: inputs.featured.checked,
          badge_ids: library.filter((b) => picked.has(b.id)).map((b) => b.id),
          active: inputs.active.checked,
          [books ? 'book_details' : 'nutrition_facts']: Object.keys(filled).length ? filled : null,
          variants: variants.map((v) => ({
            id: v.id,
            flavor: v.flavor.trim() || null,
            weight: v.weight.trim() || null,
            sku: String(v.sku).trim() || null,
            barcode: String(v.barcode ?? '').trim() || null,
            mrp: num(v.mrp),
            price: num(v.price),
            in_stock: v.in_stock,
          })),
        };
        submit.disabled = true;
        try {
          const saved = isNew ? await ops.create(payload) : await ops.update(product.id, payload);
          closeModal();
          await onSaved();
          if (isNew) {
            // Straight into edit mode, where the photos section lives.
            toast('Product added — now add its photos');
            openProductModal(saved, onSaved, badges, ops);
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
      field(`${copy.brandLabel} *`, inputs.brand),
      field('Category', inputs.category),
      field('MRP (₹) *', inputs.mrp),
      field('Selling price (₹) *', inputs.price, { hint: 'Variants can override both.' }),
      field(books ? 'Barcode / ISBN' : 'Barcode', barcodeInput(inputs.barcode), {
        full: true,
        hint: books
          ? 'The ISBN barcode on the back cover — scanning it later finds this book. An edition or format with its own ISBN takes it in the table below.'
          : 'The code printed on the pack — scanning it later finds this product. A flavour or size with its own code takes it in the table below.',
      }),
      h('div', { class: 'field full' }, h('span', {}, 'Photos'), photosBlock),
      field('…or an image link', inputs.image_url, { full: true, hint: 'Only used while the product has no uploaded photos.' }),
      badges ? h('div', { class: 'field full' }, h('span', {}, 'Quality badges'), badgePicker) : null,
      field(copy.linkLabel, inputs.lab_report_url, { full: true, hint: copy.linkHint }),
      field('Description', inputs.description, { full: true }),
      h(
        'div',
        { class: 'field full sa-checks' },
        h('label', {}, inputs.active, books ? ' Active — students can see and buy it' : ' Active — members can see and buy it'),
        h('label', {}, inputs.featured, ' Bestseller — pinned to the top, and leads the badges on its card'),
      ),
    ),
    books
      ? h('h4', { class: 'sa-subhead' }, 'Book details ', h('span', { class: 'muted' }, '(leave blank for stationery and gear)'))
      : h('h4', { class: 'sa-subhead' }, 'Nutrition facts ', h('span', { class: 'muted' }, '(per serving)')),
    h('div', { class: 'form-grid sa-nutrition' }, ...factFields.map(([key, label]) => field(label, facts[key]))),
    h('h4', { class: 'sa-subhead' }, copy.variantsHeading),
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
        h('thead', {}, h('tr', {}, ...[copy.optionA, copy.optionB, 'SKU', books ? 'ISBN / barcode' : 'Barcode', 'MRP', 'Price', 'In stock', ''].map((t) => h('th', {}, t)))),
        variantBody,
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onclick: () => {
          variants.push({ flavor: '', weight: '', sku: '', barcode: '', mrp: '', price: '', in_stock: true });
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

  openModal({ title: isNew ? (books ? 'New coaching store product' : 'New store product') : `Edit · ${product.title}`, wide: true, body: form });
}

/* ── Scanning a pack ──────────────────────────────────────────────────── */

const SOURCE_NOTE = {
  catalogue: 'Filled in from an existing listing of this pack — check it and set your price',
  openfoodfacts: 'Filled in from Open Food Facts — check it and set your price',
  openlibrary: 'Filled in from Open Library — check it and set your price',
};

/**
 * "Scan barcode" on a product list. A pack the list already carries opens for
 * editing (its flavour × size row marked); a new one opens the editor with
 * whatever is known about it, and the barcode, already filled in.
 * `lookup(code)` is the panel's own barcode endpoint; `vertical` the store
 * the list belongs to — on the coaching one a book's ISBN fills in the book.
 */
export function scanStoreProduct({ lookup, onSaved, badges = [], ops = CONSOLE_PRODUCT_OPS, vertical = 'gym' }) {
  openProductScanner({
    title: vertical === 'coaching' ? 'Scan a book or product' : 'Scan a product',
    subtitle:
      vertical === 'coaching'
        ? 'Finds it on your list, or starts a new listing from its ISBN or barcode'
        : 'Finds it on your list, or starts a new listing from its barcode',
    resolve: lookup,
    onDone: (res) => {
      if (res.existing) {
        toast(`Already listed — ${res.existing.title}`);
        openProductModal(res.existing, onSaved, badges, ops, { variantId: res.variant_id });
        return;
      }
      const s = res.suggestion;
      const prefill = { barcode: res.barcode };
      if (s) {
        Object.assign(prefill, {
          title: s.title,
          brand: s.brand ?? '',
          category: s.category,
          description: s.description,
          nutrition_facts: s.nutrition_facts,
          book_details: s.book_details ?? null,
          lab_report_url: s.lab_report_url ?? null,
          image_link: s.image_url,
          mrp: s.mrp ?? '',
        });
        // A code belongs to one flavour × size: it goes on that variant.
        if (s.flavor || s.size) {
          prefill.variants = [{ flavor: s.flavor ?? '', weight: s.size ?? '', barcode: res.barcode, in_stock: 1 }];
          prefill.barcode = '';
        }
      }
      toast(s ? SOURCE_NOTE[res.source] : res.lookup_error ? `${res.lookup_error} — add the details by hand` : `New barcode ${res.barcode} — add its details`);
      openProductModal(null, onSaved, badges, ops, { prefill, vertical });
    },
  });
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
        ? h('p', {}, `Pickup at the ${copyFor(order.vertical).org} (${order.tenant_slug}) — ship it there; its desk marks it received and collected.`)
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
      field('Status', status, { hint: `Delivered approves the ${copyFor(order.vertical).org}’s commission; cancelled voids it.` }),
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

/** `vertical`: the store a new banner goes on; an existing one keeps its own. */
function openBannerModal(banner, products, onSaved, vertical = 'gym') {
  const isNew = !banner;
  const store = banner?.vertical ?? vertical;
  const copy = copyFor(store);
  const labels = categoryLabels(store);
  const b = banner ?? { bg_color: copy.bannerColor, link_type: 'category', link_value: copy.defaultCategory, active: 1 };
  const title = h('input', { value: b.title ?? '', maxlength: 60, required: true, placeholder: copy.bannerTitle });
  const subtitle = h('input', { value: b.subtitle ?? '', maxlength: 120, placeholder: copy.bannerSub });
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
      linkValue = h('select', {}, ...Object.entries(labels).map(([v, l]) => h('option', { value: v, selected: v === b.link_value }, l)));
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
        const saved = isNew ? await api.platformCreateBanner({ ...payload, vertical: store }) : await api.platformUpdateBanner(banner.id, payload);
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
    title: isNew ? `New banner · ${copy.name}` : `Banner · ${banner.title}`,
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

/* ── Quality badges ───────────────────────────────────────────────────── */

/** The icon a badge shows, or a shield while it has none. */
const badgeIcon = (b, size = 18) =>
  b.image_url ? h('img', { src: b.image_url, alt: '' }) : renderIcon('shield', { size });

function openBadgeModal(badge, onSaved) {
  const isNew = !badge;
  const name = h('input', { value: badge?.name ?? '', maxlength: 30, required: true, placeholder: 'Trustified' });
  const active = h('input', { type: 'checkbox', checked: badge ? Boolean(badge.active) : true });

  let current = badge;
  // A new badge has no id to upload against yet: its icon waits here, shown
  // as a preview, and goes up straight after the badge is created.
  let pending = null;
  let preview = null;
  const iconBlock = h('div', { class: 'sa-photos' });
  function drawIcon() {
    if (!current) {
      fill(
        iconBlock,
        h('div', { class: 'sa-photo sa-badge-photo' }, preview ? h('img', { src: preview, alt: '' }) : renderIcon('shield', { size: 30 })),
        filePicker(pending ? 'Choose another icon' : 'Choose icon', {
          onFiles: ([file]) => {
            if (preview) URL.revokeObjectURL(preview);
            pending = file;
            preview = URL.createObjectURL(file);
            drawIcon();
          },
        }),
      );
      return;
    }
    fill(
      iconBlock,
      h('div', { class: 'sa-photo sa-badge-photo' }, badgeIcon(current, 30)),
      filePicker(current.image_url ? 'Replace icon' : 'Upload icon', {
        onFiles: async ([file]) => {
          try {
            current = await api.platformBadgeImage(current.id, await shrinkImage(file, 240));
            drawIcon();
            onSaved();
          } catch (err) {
            toast(err.message || 'Could not upload the icon', 'error');
          }
        },
      }),
    );
  }
  drawIcon();

  const save = h('button', {
    class: 'btn primary',
    onclick: async () => {
      save.disabled = true;
      try {
        const payload = { name: name.value.trim(), active: active.checked };
        const saved = isNew ? await api.platformCreateBadge(payload) : await api.platformUpdateBadge(badge.id, payload);
        let iconFailed = false;
        if (isNew && pending) {
          try {
            await api.platformBadgeImage(saved.id, await shrinkImage(pending, 240));
          } catch (err) {
            iconFailed = true;
            toast(`Badge added, but the icon didn’t upload: ${err.message || 'try again'}`, 'error');
          }
        }
        if (preview) URL.revokeObjectURL(preview);
        closeModal();
        await onSaved();
        if (isNew && (!pending || iconFailed)) {
          // Back into the badge so the icon can be added (or retried) there.
          if (!iconFailed) toast('Badge added — now upload its icon');
          openBadgeModal({ ...saved, product_count: 0 }, onSaved);
        } else toast(isNew ? 'Badge added' : 'Badge saved');
      } catch (err) {
        toast(err.message || 'Could not save the badge', 'error');
      } finally {
        save.disabled = false;
      }
    },
  }, isNew ? 'Add badge' : 'Save badge');

  const remove = isNew
    ? null
    : h('button', {
        class: 'btn ghost danger',
        onclick: () =>
          confirmDialog({
            title: `Delete “${badge.name}”?`,
            message: badge.product_count
              ? `It comes off the ${badge.product_count} product${badge.product_count === 1 ? '' : 's'} that carry it, straight away.`
              : 'No product carries it yet.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
              await api.platformDeleteBadge(badge.id);
              toast('Badge deleted');
              await onSaved();
            },
          }),
      }, 'Delete');

  openModal({
    title: isNew ? 'New quality badge' : `Badge · ${badge.name}`,
    body: h(
      'div',
      { class: 'form-grid' },
      field('Name *', name, { full: true, hint: 'Short — it sits on product cards next to the icon. e.g. Trustified, Informed Choice, Lab tested.' }),
      h(
        'div',
        { class: 'field full' },
        h('span', {}, 'Icon'),
        iconBlock,
        h('div', { class: 'muted sa-hint' }, 'The certifier’s seal or logo — a square PNG with a transparent background looks best.'),
      ),
      h('div', { class: 'field full sa-checks' }, h('label', {}, active, ' Show this badge to members')),
    ),
    footer: [remove, h('div', { style: 'flex:1' }), h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
  });
}

/* ── The section ──────────────────────────────────────────────────────── */

const STORE_PICK_KEY = 'gymbook.console.store';

export function renderStoreAdminSection({ onExpired } = {}) {
  const root = h('div', { class: 'sa' }, h('div', { class: 'empty' }, 'Loading store & monetization…'));
  const orderFilter = { status: '' };
  // Which store the section shows, remembered for the next visit.
  let store = 'gym';
  try {
    if (localStorage.getItem(STORE_PICK_KEY) === 'coaching') store = 'coaching';
  } catch {
    // Storage blocked: start on the gym store.
  }
  const pickStore = async (next) => {
    if (next === store) return;
    store = next;
    orderFilter.status = '';
    try {
      localStorage.setItem(STORE_PICK_KEY, next);
    } catch {
      // Not remembered, which is fine.
    }
    await refresh();
  };
  /** A store setting's column: the coaching store's carry a prefix. */
  const col = (key) => (store === 'coaching' ? `coaching_${key}` : key);

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

  /** The two stores, side by side: which one every card below is about. */
  function storePicker(state) {
    return h(
      'div',
      { class: 'sa-seg sa-store-pick', role: 'tablist', 'aria-label': 'Store' },
      ...Object.entries(STORE_COPY).map(([key, copy]) => {
        const status = STORE_STATUS[state.stores[key].store_status];
        return h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(store === key),
            class: `sa-seg-btn${store === key ? ' active blue' : ''}`,
            onclick: () => pickStore(key),
          },
          h('strong', {}, renderIcon(key === 'coaching' ? 'graduation' : 'dumbbell', { size: 15 }), ` ${copy.name}`),
          h('small', {}, `${copy.app} app · ${status.label}`),
        );
      }),
    );
  }

  function controlsCard(state) {
    const s = state.settings;
    const own = state.stores[store];
    const copy = copyFor(store);
    const seg = h(
      'div',
      { class: 'sa-seg', role: 'radiogroup', 'aria-label': 'Store status' },
      ...Object.entries(STORE_STATUS).map(([value, meta]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(own.store_status === value),
            class: `sa-seg-btn${own.store_status === value ? ` active ${meta.tone}` : ''}`,
            onclick: () => {
              if (value === own.store_status) return;
              const apply = () => save({ [col('store_status')]: value }, `${copy.name} is now ${meta.label.toLowerCase()}`);
              if (value === 'live') {
                confirmDialog({
                  title: store === 'coaching' ? 'Open the coaching store to every student?' : 'Open the store to every member?',
                  message: `${copy.members} will see the live catalogue and can pay by UPI straight away.`,
                  confirmLabel: 'Go live',
                  onConfirm: apply,
                });
              } else apply();
            },
          },
          h('strong', {}, meta.label),
          h('small', {}, store === 'coaching' ? meta.studentHint : meta.hint),
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
    const gym = store === 'gym';
    // The Diet & Workout add-on is a gym thing: its rates only show there.
    const rates = {
      [col('store_commission_pct')]: pct('store_commission_pct', own.store_commission_pct),
      ...(gym
        ? {
            addon_commission_pct: pct('addon_commission_pct', s.addon_commission_pct),
            addon_price_1m: rupees('addon_price_1m', s.addon_price_1m),
            addon_price_3m: rupees('addon_price_3m', s.addon_price_3m),
            addon_price_6m: rupees('addon_price_6m', s.addon_price_6m),
          }
        : {}),
    };
    const text = (name, value, placeholder) => h('input', { name, value, maxlength: 60, placeholder });
    const delivery = {
      delivery_eta: text('delivery_eta', own.delivery_eta, gym ? 'Delivery in 2–4 days' : 'Delivery in 3–5 days'),
      pickup_eta: text('pickup_eta', own.pickup_eta, gym ? 'Ready at your gym in 3–5 days' : 'Ready at your institute in 3–5 days'),
    };
    const pickupOn = h('input', { type: 'checkbox', checked: Boolean(own.pickup_enabled) });
    const saveRates = h(
      'button',
      {
        class: 'btn primary',
        onclick: () =>
          save(
            {
              ...Object.fromEntries(Object.entries(rates).map(([k, el]) => [k, Number(el.value)])),
              [col('delivery_eta')]: delivery.delivery_eta.value.trim(),
              [col('pickup_eta')]: delivery.pickup_eta.value.trim(),
              [col('pickup_enabled')]: pickupOn.checked,
            },
            'Settings saved',
          ),
      },
      'Save settings',
    );

    return h(
      'div',
      { class: 'card sa-controls' },
      h('div', { class: 'card-head' }, h('h3', {}, renderIcon('settings', { size: 17 }), `Controls · ${copy.name}`)),
      h('div', { class: 'sa-label' }, gym ? 'Member store' : 'Student store'),
      seg,
      h(
        'div',
        { class: 'form-grid sa-rates' },
        gym
          ? field('Diet & Workout paywall — how members pay', mode, {
              full: true,
              hint: state.razorpay_configured
                ? 'Online and Both show the in-app UPI tiers; Both also offers the gym’s front desk.'
                : 'Razorpay keys are not set, so members are shown the front desk whatever is picked here.',
            })
          : null,
        gym ? field('Gym cut of add-on sales (%)', rates.addon_commission_pct) : null,
        field(gym ? 'Gym cut of store sales (%)' : 'Institute cut of store sales (%)', rates[col('store_commission_pct')], { hint: 'Fixed onto each order when it is placed.' }),
        gym ? field('Add-on · 1 month (₹)', rates.addon_price_1m) : null,
        gym ? field('Add-on · 3 months (₹)', rates.addon_price_3m) : null,
        gym ? field('Add-on · 6 months (₹)', rates.addon_price_6m) : null,
        field('Delivery promise', delivery.delivery_eta, { hint: 'The big line in the store header, like Blinkit’s “10 minutes”.' }),
        field('Pickup promise', delivery.pickup_eta, { hint: gym ? 'Shown when a member chooses to collect at their gym.' : 'Shown when a student chooses to collect at their institute.' }),
        h(
          'div',
          { class: 'field full sa-checks' },
          h(
            'label',
            {},
            pickupOn,
            gym
              ? ' Offer pickup at the member’s gym — orders ship to the gym and its front desk hands them over'
              : ' Offer pickup at the student’s institute — orders ship to the institute and its office hands them over',
          ),
        ),
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
        h('button', { class: 'btn primary sm', onclick: () => openBannerModal(null, products, onChanged, store) }, renderIcon('plus', { size: 14 }), 'Add banner'),
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
                  h('span', {}, b.active ? 'Live' : 'Hidden', ' · ', b.link_type === 'none' ? 'no link' : b.link_type === 'category' ? categoryLabels(store)[b.link_value] : products.find((p) => String(p.id) === String(b.link_value))?.title ?? 'product'),
                  h('button', { type: 'button', class: 'btn sm', onclick: () => openBannerModal(b, products, onChanged) }, 'Edit'),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted', style: 'margin:0' }, copyFor(store).bannerEmpty),
    );
  }

  function badgesCard(badges, onChanged) {
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', {}, renderIcon('verified', { size: 17 }), 'Quality badges'),
        h('span', { class: 'muted' }, 'Tests and certifications a product has passed'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary sm', onclick: () => openBadgeModal(null, onChanged) }, renderIcon('plus', { size: 14 }), 'Add badge'),
      ),
      badges.length
        ? h(
            'div',
            { class: 'sa-badges' },
            ...badges.map((b) =>
              h(
                'button',
                { type: 'button', class: `sa-badge-tile${b.active ? '' : ' off'}`, onclick: () => openBadgeModal(b, onChanged) },
                h('span', { class: 'sa-badge-ico lg' }, badgeIcon(b, 22)),
                h(
                  'span',
                  { class: 'sa-badge-text' },
                  h('strong', {}, b.name),
                  h('small', {}, [b.active ? null : 'Hidden', `${b.product_count} product${b.product_count === 1 ? '' : 's'}`, b.image_url ? null : 'no icon yet'].filter(Boolean).join(' · ')),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted', style: 'margin:0' }, 'No badges yet. Add one per certification (Trustified, Informed Choice, Lab tested…), upload its seal, then tick it on the products that passed.'),
    );
  }

  function catalogCard(products, badges, onChanged) {
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', {}, renderIcon(store === 'coaching' ? 'book' : 'bag', { size: 17 }), `Central catalogue · ${copyFor(store).name}`),
        h('span', { class: 'muted' }, `${products.filter((p) => p.active).length} active of ${products.length}`),
        h('div', { class: 'spacer' }),
        h(
          'button',
          {
            class: 'btn sm',
            onclick: () =>
              scanStoreProduct({ lookup: (code) => api.platformStoreBarcode(code, { vertical: store }), onSaved: onChanged, badges, vertical: store }),
          },
          renderIcon('scan', { size: 14 }),
          store === 'coaching' ? 'Scan ISBN / barcode' : 'Scan barcode',
        ),
        h('button', { class: 'btn primary sm', onclick: () => openProductModal(null, onChanged, badges, undefined, { vertical: store }) }, renderIcon('plus', { size: 14 }), 'Add product'),
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
          { label: 'Category', render: (p) => categoryLabels(p.vertical)[p.category] ?? p.category },
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
            render: (p) => h('span', { class: 'row', style: 'gap:6px' }, p.active ? badge('green', 'Active') : badge('grey', 'Hidden'), p.featured ? badge('amber', 'Bestseller') : null, ...p.badges.map((b) => h('span', { class: 'sa-badge-ico', title: b.name }, badgeIcon(b, 13)))),
          },
          {
            label: '',
            render: (p) =>
              h(
                'div',
                { class: 'row', style: 'gap:4px;justify-content:flex-end' },
                h('button', { class: 'btn sm ghost', onclick: () => openProductModal(p, onChanged, badges) }, 'Edit'),
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
    const gym = store === 'gym';
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, renderIcon('truck', { size: 17 }), gym ? 'Member orders' : 'Student orders'), h('div', { class: 'spacer' }), filter),
      table(
        [
          { label: 'Order', render: (o) => h('div', {}, h('strong', {}, o.order_code), h('div', { class: 'muted' }, date(o.paid_at || o.created_at))) },
          { label: gym ? 'Gym' : 'Institute', render: (o) => o.gym_name || o.tenant_slug },
          {
            label: 'Fulfilled by',
            render: (o) => (o.seller_name ? h('span', { class: 'badge violet' }, o.seller_name) : h('span', { class: 'muted' }, 'Central')),
          },
          {
            label: gym ? 'Member' : 'Student',
            render: (o) =>
              h(
                'div',
                {},
                o.member_name || '—',
                h('div', { class: 'muted' }, o.fulfillment_method === 'pickup' ? (gym ? 'Gym pickup' : 'Institute pickup') : `${o.shipping_city ?? ''} ${o.shipping_pincode ?? ''}`),
              ),
          },
          { label: 'Items', render: (o) => o.items.reduce((n, i) => n + i.quantity, 0) },
          { label: 'Value', align: 'right', render: (o) => inr(o.total_amount) },
          { label: gym ? 'Gym cut' : 'Institute cut', align: 'right', render: (o) => h('span', {}, inr(o.commission_amount), h('div', { class: 'muted' }, `${o.commission_pct}%`)) },
          { label: 'Status', render: (o) => badge(FULFILLMENT_TONE[o.fulfillment_status] ?? 'grey', STATUS_LABEL[o.fulfillment_status] ?? o.fulfillment_status) },
        ],
        orders,
        { onRowClick: (o) => openOrderModal(o, onChanged), empty: 'No paid orders yet.' },
      ),
    );
  }

  function payoutsCard(rows, onChanged) {
    const gym = store === 'gym';
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, renderIcon('wallet', { size: 17 }), gym ? 'Gym commissions & payouts' : 'Institute commissions & payouts')),
      table(
        [
          { label: gym ? 'Gym' : 'Institute', render: (r) => h('div', {}, h('strong', {}, r.gym_name), h('div', { class: 'muted' }, `${r.sales} sale${r.sales === 1 ? '' : 's'}`)) },
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
        api.platformStoreProducts({ vertical: store }),
        api.platformStoreOrders({ status: orderFilter.status, vertical: store }),
        api.platformCommissions(),
        api.platformBanners({ vertical: store }),
        api.platformBadges(),
      ]),
    ).catch((err) => {
      toast(err.message || 'Could not load store & monetization', 'error');
      return null;
    });
    if (!data) return;
    const [state, products, orders, commissions, banners, badges] = data;
    const { summary } = state;
    const status = STORE_STATUS[state.stores[store].store_status];
    const sales = summary.stores?.[store] ?? summary.store;
    const owedTo = commissions.items.filter((r) => (r.vertical ?? 'gym') === store);
    const owed = owedTo.reduce((acc, r) => ({ owed: acc.owed + r.pending + r.payable, paid: acc.paid + r.paid }), { owed: 0, paid: 0 });

    fill(root,
      storePicker(state),
      h(
        'div',
        { class: 'grid cols-4', style: 'gap:12px;margin-bottom:16px' },
        stat(copyFor(store).name, status.label, store === 'coaching' ? status.studentHint : status.hint),
        stat('Store GMV', inr(sales.gmv), `${sales.orders} paid order${sales.orders === 1 ? '' : 's'} · ${sales.to_ship} to ship`),
        store === 'gym'
          ? stat('Add-on sales', inr(summary.addon.revenue), `${summary.addon.sales} in-app purchase${summary.addon.sales === 1 ? '' : 's'}`)
          : stat('Catalogue', String(products.items.filter((p) => p.active).length), 'active products on the central shelf'),
        stat(store === 'gym' ? 'Owed to gyms' : 'Owed to institutes', inr(owed.owed), `${inr(owed.paid)} paid out`),
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
      badgesCard(badges.items, refresh),
      catalogCard(products.items, badges.items, refresh),
      ordersCard(orders.items, refresh),
      payoutsCard(owedTo, refresh),
    );
  }

  refresh();
  return root;
}
