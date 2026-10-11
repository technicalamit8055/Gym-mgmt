import { api } from '../api.js';
import { append, buildForm, clear, closeModal, confirmDialog, date, fullName, h, money, openModal, renderIcon, table, toast } from '../ui.js';

/** Replaces an element's children. ui.js's append, not the DOM's: the DOM's
 * would print a conditional child that came out null as the text "null". */
const fill = (el, ...children) => append(clear(el), children);

/**
 * Billing → Store & Commissions: what the gym earns beyond memberships, in
 * two kinds.
 *
 *  - Platform products (affiliate cut): the gym's commission on what its
 *    members bought from the platform's store, and on in-app Diet & Workout
 *    purchases. A statement, not something the gym edits.
 *  - Our gym products (direct sales): the gym's own shelf — tees, shakers,
 *    bars, drinks — with stock, and every rupee the gym's own.
 */

const CATEGORY_LABEL = {
  apparel: 'Apparel', accessories: 'Accessories', drinks: 'Drinks', snacks: 'Snacks', supplements: 'Supplements', other: 'Other',
};
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'online', label: 'Online' },
];
const COMMISSION_STATUS = {
  pending: ['amber', 'clock', 'Awaiting delivery'],
  approved: ['blue', 'wallet', 'Payable'],
  paid: ['green', 'checkCircle', 'Paid'],
  void: ['grey', 'xCircle', 'Cancelled'],
};

const iconBadge = (tone, icon, text) =>
  h('span', { class: `badge ${tone} bill-badge` }, renderIcon(icon, { size: 13, stroke: 2.4 }), text);

/* ── Our gym products: forms ──────────────────────────────────────────── */

function openProductForm(product, onSaved) {
  const isNew = !product;
  const p = product ?? { category: 'apparel', stock_quantity: 0, low_stock_at: 5 };
  openModal({
    title: isNew ? 'Add a gym product' : `Edit · ${product.name}`,
    icon: 'bag',
    body: buildForm(
      [
        { name: 'name', label: 'Product name', value: p.name ?? '', required: true, full: true, placeholder: 'Iron Works dry-fit tee' },
        { name: 'category', label: 'Category', type: 'select', value: p.category, options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })) },
        { name: 'sku', label: 'SKU / size', value: p.sku ?? '', placeholder: 'TEE-BLK-M' },
        { name: 'price', label: 'Selling price', type: 'number', step: '0.01', min: 0, value: p.price ?? '', required: true },
        { name: 'cost_price', label: 'Cost price', type: 'number', step: '0.01', min: 0, value: p.cost_price ?? '', hint: 'Optional — for your own margin.' },
        isNew
          ? { name: 'stock_quantity', label: 'Opening stock', type: 'number', min: 0, step: '1', value: p.stock_quantity }
          : null,
        { name: 'low_stock_at', label: 'Warn when stock falls to', type: 'number', min: 0, step: '1', value: p.low_stock_at },
        { name: 'description', label: 'Description', type: 'textarea', value: p.description ?? '', full: true },
      ],
      {
        submitLabel: isNew ? 'Add product' : 'Save changes',
        onSubmit: async (values) => {
          const payload = {
            name: values.name,
            category: values.category,
            sku: values.sku.trim() || null,
            price: Number(values.price),
            cost_price: values.cost_price === '' ? null : Number(values.cost_price),
            low_stock_at: Number(values.low_stock_at || 0),
            description: values.description.trim() || null,
          };
          if (isNew) payload.stock_quantity = Number(values.stock_quantity || 0);
          if (isNew) await api.storeHub.createProduct(payload);
          else await api.storeHub.updateProduct(product.id, payload);
          closeModal();
          toast(isNew ? 'Product added' : 'Product saved');
          await onSaved();
        },
      },
    ),
  });
}

function openRestockForm(product, onSaved) {
  openModal({
    title: `Restock · ${product.name}`,
    subtitle: `${product.stock_quantity} on the shelf now`,
    icon: 'package',
    body: buildForm(
      [{ name: 'quantity', label: 'Units received', type: 'number', min: 1, step: '1', value: 10, required: true, full: true }],
      {
        submitLabel: 'Add to stock',
        onSubmit: async (values) => {
          const updated = await api.storeHub.restock(product.id, Number(values.quantity));
          closeModal();
          toast(`${product.name}: ${updated.stock_quantity} in stock`);
          await onSaved();
        },
      },
    ),
  });
}

function openSaleForm(products, preselect, onSaved) {
  const sellable = products.filter((p) => p.stock_quantity > 0);
  if (!sellable.length) return toast('Nothing in stock to sell — restock a product first', 'error');
  const first = preselect && preselect.stock_quantity > 0 ? preselect : sellable[0];
  const form = buildForm(
    [
      {
        name: 'product_id',
        label: 'Product',
        type: 'select',
        value: first.id,
        full: true,
        options: sellable.map((p) => ({ value: p.id, label: `${p.name} — ${money(p.price)} (${p.stock_quantity} left)` })),
      },
      { name: 'quantity', label: 'Quantity', type: 'number', min: 1, step: '1', value: 1, required: true },
      { name: 'unit_price', label: 'Price each', type: 'number', min: 0, step: '0.01', value: first.price, hint: 'Change it for a one-off discount.' },
      { name: 'method', label: 'Paid by', type: 'select', value: 'cash', options: METHODS },
      { name: 'note', label: 'Note', full: true, placeholder: 'Optional' },
    ],
    {
      submitLabel: 'Record sale',
      onSubmit: async (values) => {
        const res = await api.storeHub.sell({
          product_id: Number(values.product_id),
          quantity: Number(values.quantity),
          unit_price: values.unit_price === '' ? undefined : Number(values.unit_price),
          method: values.method,
          note: values.note.trim() || undefined,
        });
        closeModal();
        toast(`Sold ${res.sale.quantity} × ${res.sale.product_name} for ${money(res.sale.total)}`);
        await onSaved();
      },
    },
  );
  // Picking another product brings its shelf price with it.
  const productSelect = form.querySelector('select[name="product_id"]');
  const priceInput = form.querySelector('input[name="unit_price"]');
  productSelect.addEventListener('change', () => {
    const picked = sellable.find((p) => String(p.id) === productSelect.value);
    if (picked) priceInput.value = picked.price;
  });
  openModal({ title: 'Record a sale', subtitle: 'Takes it off the shelf and counts it in this month’s revenue', icon: 'cart', body: form });
}

/* ── The tab ──────────────────────────────────────────────────────────── */

/**
 * `billStat` is the billing page's metric card, passed in so the hub's header
 * reads as part of the same page.
 */
/** The pickups tab's caption: how many parcels need the desk right now. */
function deskCount(items) {
  const waiting = items.filter((o) => o.fulfillment_status === 'ready').length;
  const coming = items.filter((o) => ['placed', 'packed', 'shipped'].includes(o.fulfillment_status)).length;
  if (waiting) return `${waiting} waiting at the desk`;
  if (coming) return `${coming} on the way`;
  return 'Member collections';
}

export async function renderStoreHub({ billStat }) {
  const state = { view: 'platform' };
  const root = h('div', { class: 'grid', style: 'gap:22px' });

  async function draw() {
    const [summary, ledger, products, sales, pickups] = await Promise.all([
      api.storeHub.summary(),
      state.view === 'platform' ? api.storeHub.commissions() : null,
      state.view === 'local' ? api.storeHub.products() : null,
      state.view === 'local' ? api.storeHub.sales({ limit: 50 }) : null,
      // Always fetched: the tab shows how many parcels need the desk.
      api.storeHub.pickups(),
    ]);
    const p = summary.platform;
    const l = summary.local;
    const monthName = new Date(`${summary.month_start}T00:00:00`).toLocaleDateString(undefined, { month: 'long' });

    const views = h(
      'div',
      { class: 'hub-views', role: 'tablist' },
      ...[
        ['platform', 'Platform products', 'Affiliate cut', 'globe'],
        ['local', 'Our gym products', 'Direct sales', 'store'],
        ['pickups', 'Store pickups', deskCount(pickups.items), 'package'],
      ].map(([key, label, sub, icon]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `hub-view${state.view === key ? ' active' : ''}`,
            'aria-selected': String(state.view === key),
            onclick: async () => {
              if (state.view === key) return;
              state.view = key;
              await draw().catch((err) => toast(err.message, 'error'));
            },
          },
          h('span', { class: 'hub-view-icon' }, renderIcon(icon, { size: 18, stroke: 2 })),
          h('span', {}, h('strong', {}, label), h('small', {}, sub)),
        ),
      ),
    );

    fill(root, 
      h(
        'div',
        { class: 'bill-stats' },
        billStat({
          tone: 'violet',
          icon: 'globe',
          label: 'Passive platform commissions',
          value: money(p.month_total, { compact: true }),
          note: `Store ${money(p.month_store)} · Add-on ${money(p.month_addon)}`,
        }),
        billStat({
          tone: 'orange',
          icon: 'store',
          label: 'Local store revenue',
          value: money(l.revenue_month, { compact: true }),
          note: `${l.units_month} unit${l.units_month === 1 ? '' : 's'} sold in ${monthName}`,
        }),
        billStat({
          tone: 'green',
          icon: 'trendUp',
          label: 'Total monthly earnings',
          value: money(summary.total_month, { compact: true }),
          note: `Beyond memberships, ${monthName}`,
        }),
      ),
      views,
      state.view === 'platform'
        ? platformView(summary, ledger.items)
        : state.view === 'pickups'
          ? pickupsView(pickups.items)
          : localView(products.items, sales.items, l),
    );
  }

  function platformView(summary, rows) {
    const p = summary.platform;
    const storeNote = {
      live: 'The store is live in your members’ app.',
      coming_soon: 'The store opens in your members’ app soon — commissions start with the first order.',
      disabled: 'The store is currently switched off platform-wide.',
    }[p.store_status];
    return h(
      'div',
      { class: 'grid', style: 'gap:16px' },
      h(
        'div',
        { class: 'card hub-explainer' },
        h('span', { class: 'hub-explainer-icon' }, renderIcon('sparkle', { size: 22, stroke: 2 })),
        h(
          'div',
          {},
          h('strong', {}, `You earn ${p.store_commission_pct}% of every store order and ${p.addon_commission_pct}% of in-app Diet & Workout purchases by your members.`),
          h('p', { class: 'muted' }, `${storeNote} Store commissions become payable once the order is delivered; payouts go to your bank monthly.`),
        ),
        h(
          'div',
          { class: 'hub-payout' },
          h('small', {}, 'Payout balance'),
          h('strong', {}, money(p.payable)),
          h('small', {}, p.pending > 0 ? `+ ${money(p.pending)} on delivery` : `${money(p.paid)} paid so far`),
        ),
      ),
      h(
        'div',
        { class: 'card bill-table' },
        table(
          [
            { label: 'Date', render: (r) => date(r.earned_on) },
            {
              label: 'Sale',
              render: (r) =>
                r.source_type === 'store_order'
                  ? h('div', {}, h('strong', {}, `Store order ${r.order_code ?? ''}`), h('div', { class: 'muted' }, `${r.item_count} item${r.item_count === 1 ? '' : 's'}`))
                  : h('div', {}, h('strong', {}, 'Diet & Workout add-on'), h('div', { class: 'muted' }, r.description?.replace('Diet & Workout add-on · ', '') ?? '')),
            },
            { label: 'Member', render: (r) => r.member_name ?? '—' },
            { label: 'Order value', align: 'right', render: (r) => money(r.gross_amount) },
            { label: 'Rate', align: 'right', render: (r) => `${r.commission_pct}%` },
            { label: 'Your cut', align: 'right', render: (r) => h('strong', {}, money(r.amount)) },
            {
              label: 'Status',
              render: (r) => {
                const [tone, icon, text] = COMMISSION_STATUS[r.status] ?? COMMISSION_STATUS.pending;
                return h('span', { title: r.payout_ref ? `Payout ref ${r.payout_ref}` : '' }, iconBadge(tone, icon, text));
              },
            },
          ],
          rows,
          { empty: 'No commissions yet. They appear here as soon as a member buys from the store or unlocks Diet & Workout in the app.' },
        ),
      ),
    );
  }

  /**
   * Members who chose "pick up at my gym": the platform ships their order
   * here, the desk marks it arrived (the member gets a push), then hands it
   * over. Collected is what makes the gym's commission on it final.
   */
  function pickupsView(orders) {
    const refresh = () => draw().catch((err) => toast(err.message, 'error'));
    const act = async (fn, message) => {
      try {
        await fn();
        toast(message);
        await refresh();
      } catch (err) {
        toast(err.message || 'Could not update that order', 'error');
      }
    };
    const STATUS = {
      placed: ['blue', 'clock', 'Ordered'],
      packed: ['blue', 'package', 'Packed'],
      shipped: ['violet', 'truck', 'On its way here'],
      ready: ['amber', 'bell', 'Waiting at desk'],
      delivered: ['green', 'checkCircle', 'Collected'],
      cancelled: ['grey', 'xCircle', 'Cancelled'],
    };
    return h(
      'div',
      { class: 'card bill-table' },
      h(
        'div',
        { class: 'card-head', style: 'padding:14px 16px 0' },
        h('h3', {}, renderIcon('package', { size: 17 }), 'Store orders to hand over'),
        h('span', { class: 'muted' }, 'Mark a parcel arrived when it reaches the gym — the member is notified to collect it.'),
      ),
      table(
        [
          { label: 'Order', render: (o) => h('div', {}, h('strong', {}, o.order_code), h('div', { class: 'muted' }, date(o.paid_at || o.created_at))) },
          { label: 'Member', render: (o) => h('div', {}, h('strong', {}, o.shipping_name), h('div', { class: 'muted' }, o.shipping_phone)) },
          {
            label: 'Items',
            render: (o) =>
              h('div', { class: 'hub-pickup-items' }, ...o.items.map((i) => h('div', {}, `${i.quantity} × ${i.title}`, i.variant_label ? h('span', { class: 'muted' }, ` · ${i.variant_label}`) : null))),
          },
          {
            label: 'Status',
            render: (o) => {
              const [tone, icon, text] = STATUS[o.fulfillment_status] ?? STATUS.placed;
              return iconBadge(tone, icon, text);
            },
          },
          {
            label: '',
            render: (o) =>
              ['placed', 'packed', 'shipped'].includes(o.fulfillment_status)
                ? h('button', { class: 'btn sm', onclick: () => act(() => api.storeHub.pickupReceived(o.id), `${o.order_code} marked arrived — ${o.shipping_name} has been notified`) }, 'Parcel arrived')
                : o.fulfillment_status === 'ready'
                  ? h(
                      'button',
                      {
                        class: 'btn sm primary',
                        onclick: () =>
                          confirmDialog({
                            title: `Hand over ${o.order_code}?`,
                            message: `Check it is ${o.shipping_name} (${o.shipping_phone}) collecting.`,
                            confirmLabel: 'Handed over',
                            onConfirm: () => act(() => api.storeHub.pickupCollected(o.id), `${o.order_code} collected`),
                          }),
                      },
                      'Hand over',
                    )
                  : null,
          },
        ],
        orders,
        { empty: 'No pickup orders. When a member picks “Pick up at my gym” in the store, the order shows up here.' },
      ),
    );
  }

  function localView(products, sales, l) {
    const lowStock = products.filter((p) => p.stock_quantity <= p.low_stock_at);
    const refresh = () => draw().catch((err) => toast(err.message, 'error'));
    return h(
      'div',
      { class: 'grid', style: 'gap:16px' },
      h(
        'div',
        { class: 'card bill-table' },
        h(
          'div',
          { class: 'card-head', style: 'padding:14px 16px 0' },
          h('h3', {}, renderIcon('store', { size: 17 }), 'Products on your shelf'),
          lowStock.length ? iconBadge('amber', 'alert', `${lowStock.length} running low`) : null,
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => openSaleForm(products, null, refresh) }, renderIcon('cart', { size: 16 }), 'Record sale'),
          h('button', { class: 'btn primary', onclick: () => openProductForm(null, refresh) }, renderIcon('plus', { size: 16 }), 'Add product'),
        ),
        table(
          [
            {
              label: 'Product',
              render: (p) => h('div', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, [CATEGORY_LABEL[p.category], p.sku].filter(Boolean).join(' · '))),
            },
            { label: 'Price', align: 'right', render: (p) => money(p.price) },
            {
              label: 'In stock',
              render: (p) =>
                p.stock_quantity === 0
                  ? iconBadge('red', 'alert', 'Sold out')
                  : p.stock_quantity <= p.low_stock_at
                    ? iconBadge('amber', 'clock', `${p.stock_quantity} left`)
                    : iconBadge('green', 'checkCircle', `${p.stock_quantity}`),
            },
            { label: 'Sold', align: 'right', render: (p) => p.units_sold },
            { label: 'Revenue', align: 'right', render: (p) => money(p.revenue) },
            {
              label: '',
              render: (p) =>
                h(
                  'div',
                  { class: 'row', style: 'gap:4px;justify-content:flex-end;flex-wrap:nowrap' },
                  h('button', { class: 'btn sm', disabled: p.stock_quantity === 0, onclick: () => openSaleForm(products, p, refresh) }, 'Sell'),
                  h('button', { class: 'btn sm ghost', onclick: () => openRestockForm(p, refresh) }, 'Restock'),
                  h('button', { class: 'btn sm ghost', onclick: () => openProductForm(p, refresh) }, 'Edit'),
                  h(
                    'button',
                    {
                      class: 'icon-btn',
                      title: 'Remove',
                      'aria-label': `Remove ${p.name}`,
                      onclick: () =>
                        confirmDialog({
                          title: `Remove ${p.name}?`,
                          message: 'A product with sales is retired instead, so this month’s revenue keeps its history.',
                          confirmLabel: 'Remove',
                          danger: true,
                          onConfirm: async () => {
                            const res = await api.storeHub.deleteProduct(p.id);
                            toast(res.retired ? 'Product retired' : 'Product removed');
                            await refresh();
                          },
                        }),
                    },
                    renderIcon('trash', { size: 15 }),
                  ),
                ),
            },
          ],
          products,
          { empty: 'Nothing on the shelf yet. Add your gym tees, shakers, protein bars or drinks to track stock and sales here.' },
        ),
      ),
      h(
        'div',
        { class: 'card bill-table' },
        h(
          'div',
          { class: 'card-head', style: 'padding:14px 16px 0' },
          h('h3', {}, renderIcon('receipt', { size: 17 }), 'Recent sales'),
          h('span', { class: 'muted' }, `${l.sales_month} this month · stock worth ${money(l.stock_value)}`),
        ),
        table(
          [
            { label: 'Date', render: (s) => date(s.sold_on) },
            { label: 'Product', render: (s) => h('div', {}, h('strong', {}, s.product_name), s.note ? h('div', { class: 'muted' }, s.note) : null) },
            { label: 'Member', render: (s) => (s.first_name ? fullName(s) : 'Walk-in') },
            { label: 'Qty', align: 'right', render: (s) => s.quantity },
            { label: 'Total', align: 'right', render: (s) => h('strong', {}, money(s.total)) },
            { label: 'Paid by', render: (s) => METHODS.find((m) => m.value === s.method)?.label ?? s.method },
            { label: 'Sold by', render: (s) => s.sold_by_name ?? '—' },
          ],
          sales,
          { empty: 'No sales recorded yet.' },
        ),
      ),
    );
  }

  await draw();
  return root;
}
