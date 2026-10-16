import { api, sellerSession } from '../api.js';
import { buildForm, clear, closeModal, confirmDialog, date, h, openModal, renderIcon, table, toast } from '../ui.js';
import { getAppMode, toggleAppMode } from '../vertical.js';
import { CATEGORY_LABEL, FULFILLMENT_TONE, inr, openProductModal, scanStoreProduct } from './storeAdmin.js';

/**
 * The Shop panel (#/seller) — what a partner supplement shop signs in to.
 *
 * Its own credentials, handed over by the operator, and its own token: it
 * cannot open the operator console or any gym, and only ever sees this one
 * shop's shelf, orders and money. Built for a shop counter on a phone as much
 * as a desk: the first screen is "what needs packing", every order has one
 * big next-step button, and the customer is one tap away by phone or WhatsApp.
 */

/** Which page is showing; module state so it survives each full redraw. */
let section = 'today';

const SECTIONS = [
  { id: 'today', icon: 'dashboard', label: 'Today', title: 'Today', sub: 'What needs packing, what is on its way, and what you are owed.' },
  { id: 'orders', icon: 'truck', label: 'Orders', title: 'Orders', sub: 'Every paid order from the gyms you serve.' },
  { id: 'products', icon: 'package', label: 'Products', title: 'Your products', sub: 'What members of your gyms can buy from you.' },
  { id: 'shop', icon: 'store', label: 'Shop & payouts', title: 'Shop & payouts', sub: 'Your delivery promise, contact details, password and payouts.' },
];

/** The shop's own words for each status — pickup orders go via the gym. */
function statusText(order) {
  const pickup = order.fulfillment_method === 'pickup';
  return {
    placed: 'New — to pack',
    packed: 'Packed',
    shipped: pickup ? 'Sent to the gym' : 'Out for delivery',
    ready: 'At the gym desk',
    delivered: pickup ? 'Collected' : 'Delivered',
    cancelled: 'Cancelled',
  }[order.fulfillment_status] ?? order.fulfillment_status;
}

const statusBadge = (order) => h('span', { class: `badge dot ${FULFILLMENT_TONE[order.fulfillment_status] ?? 'grey'}` }, statusText(order));
const itemCount = (order) => order.items.reduce((n, i) => n + i.quantity, 0);

/** The one thing to do next with an order, or null when it is the gym's turn
 * (a pickup at the desk) or there is nothing left to do. */
function nextStep(order) {
  const pickup = order.fulfillment_method === 'pickup';
  switch (order.fulfillment_status) {
    case 'placed':
      return { to: 'packed', label: 'Mark packed', icon: 'package' };
    case 'packed':
      return { to: 'shipped', label: pickup ? 'Sent to the gym' : 'Mark shipped', icon: 'truck' };
    case 'shipped':
      return pickup ? null : { to: 'delivered', label: 'Mark delivered', icon: 'checkCircle' };
    default:
      return null;
  }
}

function waitingNote(order) {
  if (order.fulfillment_method !== 'pickup') return null;
  if (order.fulfillment_status === 'shipped') return `${order.gym_name}'s front desk marks it received when it arrives.`;
  if (order.fulfillment_status === 'ready') return `Waiting at ${order.gym_name}'s desk for the member to collect.`;
  return null;
}

/** wa.me wants the number with its country code and nothing else. */
function whatsappLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}`;
}

async function move(order, to, onChanged, extra = {}) {
  try {
    await api.sellerUpdateOrder(order.id, { fulfillment_status: to, ...extra });
    toast(`${order.order_code}: ${statusText({ ...order, fulfillment_status: to }).toLowerCase()}`);
    await onChanged();
  } catch (err) {
    toast(err.message || 'Could not update the order', 'error');
  }
}

/* ── One order ────────────────────────────────────────────────────────── */

function openOrder(order, onChanged) {
  const pickup = order.fulfillment_method === 'pickup';
  const step = nextStep(order);
  const courier = h('input', { value: order.courier_name ?? '', placeholder: 'Own rider / Delhivery / Shiprocket', maxlength: 60 });
  const trackingId = h('input', { value: order.tracking_id ?? '', placeholder: 'AWB / tracking number', maxlength: 80 });
  const trackingUrl = h('input', { type: 'url', value: order.tracking_url ?? '', placeholder: 'https://…' });
  const tracking = () => ({
    courier_name: courier.value.trim() || null,
    tracking_id: trackingId.value.trim() || null,
    tracking_url: trackingUrl.value.trim() || null,
  });
  const wa = whatsappLink(order.shipping_phone);
  const line = (label, value, strong = false) =>
    h('div', { class: 'sp-money-row' }, h('span', {}, label), strong ? h('strong', {}, value) : h('span', {}, value));

  const body = h(
    'div',
    { class: 'sp-order' },
    h(
      'div',
      { class: 'sp-order-who' },
      h(
        'div',
        {},
        h('strong', {}, order.shipping_name),
        h(
          'div',
          { class: 'muted' },
          order.member_name && order.member_name !== order.shipping_name ? `${order.member_name} · ${order.gym_name}` : `Member at ${order.gym_name}`,
        ),
      ),
      h(
        'div',
        { class: 'sp-contact' },
        h('a', { class: 'btn sm', href: `tel:${order.shipping_phone}` }, renderIcon('phone', { size: 14 }), order.shipping_phone),
        wa ? h('a', { class: 'btn sm', href: wa, target: '_blank', rel: 'noopener' }, renderIcon('whatsapp', { size: 14 }), 'WhatsApp') : null,
      ),
    ),
    h(
      'div',
      { class: 'sp-order-where' },
      renderIcon(pickup ? 'building' : 'mapPin', { size: 16 }),
      pickup
        ? h('p', {}, h('strong', {}, `Pickup at ${order.gym_name}`), ' — take the parcel to the gym’s front desk; they hand it over.')
        : h('p', {}, [order.shipping_address, order.shipping_city, order.shipping_state, order.shipping_pincode].filter(Boolean).join(', ')),
    ),
    h(
      'ul',
      { class: 'sp-items' },
      ...order.items.map((i) =>
        h(
          'li',
          {},
          i.image_url ? h('img', { src: i.image_url, alt: '', loading: 'lazy' }) : h('span', { class: 'sa-thumb' }, renderIcon('bag', { size: 14 })),
          h('div', {}, h('strong', {}, `${i.quantity} × ${i.title}`), h('div', { class: 'muted' }, [i.brand, i.variant_label].filter(Boolean).join(' · '))),
          h('span', {}, inr(i.line_total)),
        ),
      ),
    ),
    h(
      'div',
      { class: 'sp-money' },
      line('Order value', inr(order.total_amount)),
      order.commission_amount > 0 ? line(`Gym’s share (${order.commission_pct}%)`, `− ${inr(order.commission_amount)}`) : null,
      order.seller_fee_amount > 0 ? line(`Platform fee (${order.seller_fee_pct}%)`, `− ${inr(order.seller_fee_amount)}`) : null,
      line(order.seller_paid_at ? 'Paid to you' : order.seller_fee_amount > 0 || order.commission_amount > 0 ? 'You receive' : 'You keep', inr(order.seller_amount), true),
    ),
    order.fulfillment_status !== 'cancelled'
      ? h(
          'div',
          { class: 'form-grid' },
          h('label', { class: 'field' }, h('span', {}, 'Courier'), courier),
          h('label', { class: 'field' }, h('span', {}, 'Tracking number'), trackingId),
          h('label', { class: 'field full' }, h('span', {}, 'Tracking link'), trackingUrl),
        )
      : null,
    waitingNote(order) ? h('p', { class: 'sp-wait' }, renderIcon('clock', { size: 14 }), waitingNote(order)) : null,
  );

  const footer = [h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')];
  if (['placed', 'packed'].includes(order.fulfillment_status)) {
    footer.unshift(
      h(
        'button',
        {
          class: 'btn ghost danger',
          // The order closes first, so the confirm is the only modal left
          // for confirmDialog to close when it is done.
          onclick: () => {
            closeModal();
            confirmDialog({
              title: `Cancel ${order.order_code}?`,
              message: 'Only if you cannot fulfil it. The platform refunds the member, and you are not paid for it.',
              confirmLabel: 'Cancel order',
              danger: true,
              onConfirm: () => move(order, 'cancelled', onChanged),
            });
          },
        },
        'Cancel order',
      ),
    );
  }
  if (order.fulfillment_status !== 'cancelled') {
    footer.push(
      h(
        'button',
        {
          class: step ? 'btn' : 'btn primary',
          onclick: async () => {
            try {
              await api.sellerUpdateOrder(order.id, tracking());
              closeModal();
              toast('Tracking saved');
              await onChanged();
            } catch (err) {
              toast(err.message || 'Could not save', 'error');
            }
          },
        },
        'Save tracking',
      ),
    );
  }
  if (step) {
    footer.push(
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            closeModal();
            await move(order, step.to, onChanged, tracking());
          },
        },
        renderIcon(step.icon, { size: 15 }),
        step.label,
      ),
    );
  }
  openModal({ title: `Order ${order.order_code}`, subtitle: `${date(order.paid_at || order.created_at, { withTime: true })} · ${statusText(order)}`, body, footer });
}

/** A compact order row with its next-step button inline — the Today list. */
function orderRow(order, onChanged) {
  const step = nextStep(order);
  return h(
    'div',
    { class: 'op-list-row interactive sp-row', onclick: () => openOrder(order, onChanged) },
    h('span', { class: 'op-list-icon' }, renderIcon(order.fulfillment_method === 'pickup' ? 'building' : 'truck', { size: 16 })),
    h(
      'div',
      { class: 'op-list-main' },
      h('div', { class: 'op-list-title' }, `${order.order_code} · ${order.shipping_name}`),
      h(
        'div',
        { class: 'op-list-note' },
        `${itemCount(order)} item${itemCount(order) === 1 ? '' : 's'} · ${inr(order.total_amount)} · ${order.fulfillment_method === 'pickup' ? `pickup at ${order.gym_name}` : order.shipping_city || order.gym_name}`,
      ),
    ),
    step
      ? h(
          'button',
          {
            class: 'btn sm primary',
            type: 'button',
            onclick: (event) => {
              event.stopPropagation();
              // Shipping wants a courier; everything else is one tap.
              if (step.to === 'shipped') openOrder(order, onChanged);
              else move(order, step.to, onChanged);
            },
          },
          step.label,
        )
      : statusBadge(order),
  );
}

/* ── Pages ────────────────────────────────────────────────────────────── */

function kpi(label, value, { icon, tone = 'blue', foot, onClick } = {}) {
  return h(
    onClick ? 'button' : 'div',
    { class: `card op-kpi tone-${tone}${onClick ? ' clickable' : ''}`, type: onClick ? 'button' : null, onclick: onClick || null },
    h('div', { class: 'op-kpi-head' }, h('span', { class: 'op-kpi-label' }, label), h('span', { class: 'op-kpi-icon' }, renderIcon(icon, { size: 17 }))),
    h('div', { class: 'op-kpi-value' }, value),
    foot ? h('div', { class: 'op-kpi-foot' }, foot) : null,
  );
}

const cardTitle = (icon, text, tone = 'blue') =>
  h('div', { class: `op-card-title tone-${tone}` }, h('span', { class: 'head-icon' }, renderIcon(icon, { size: 17 })), h('h3', {}, text));

function gettingStarted(me, products, go) {
  const s = me.seller;
  const steps = [
    { done: !s.must_change_password, text: 'Set your own password', action: () => go('shop') },
    { done: products.some((p) => p.active), text: 'Add your first product with a photo', action: () => go('products') },
    { done: Boolean(s.delivery_eta), text: 'Write your delivery promise (e.g. “Delivery today in Bandra”)', action: () => go('shop') },
  ];
  if (steps.every((x) => x.done)) return null;
  return h(
    'div',
    { class: 'card sp-start' },
    h('div', { class: 'card-head' }, cardTitle('sparkle', 'Get your shop ready', 'violet')),
    h(
      'ol',
      { class: 'sp-steps' },
      ...steps.map((x) =>
        h(
          'li',
          { class: x.done ? 'done' : '' },
          h('span', { class: 'sp-step-mark' }, x.done ? renderIcon('check', { size: 13, stroke: 2.6 }) : null),
          x.done ? h('span', {}, x.text) : h('button', { type: 'button', class: 'linklike', onclick: x.action }, x.text),
        ),
      ),
    ),
    !products.some((p) => p.active)
      ? h('p', { class: 'muted', style: 'margin:10px 0 0' }, 'Until your shelf has an active product, your gyms keep showing the central catalogue.')
      : null,
  );
}

function todayPage(me, orders, products, { onChanged, go }) {
  const s = me.seller.stats;
  const toPack = orders.filter((o) => ['placed', 'packed'].includes(o.fulfillment_status));
  const moving = orders.filter((o) => ['shipped', 'ready'].includes(o.fulfillment_status));
  return h(
    'div',
    { class: 'op-stack' },
    me.store_status !== 'live'
      ? h('div', { class: 'card sa-warn' }, renderIcon('alert', { size: 18 }), h('p', {}, 'The member store is not open yet, so no orders can come in. Stock your shelf now — it shows the moment the platform goes live.'))
      : null,
    gettingStarted(me, products, go),
    h(
      'div',
      { class: 'op-kpis' },
      kpi('To pack', String(toPack.length), { icon: 'package', tone: toPack.length ? 'amber' : 'green', foot: toPack.length ? 'Tap an order to start' : 'All caught up', onClick: () => go('orders') }),
      kpi('On the way', String(moving.length), { icon: 'truck', tone: 'violet', foot: `${inr(s.pending)} to be earned on delivery` }),
      ...(me.seller.owned
        ? [
            kpi('Delivered sales', inr(s.payable + s.paid), { icon: 'wallet', tone: 'green', foot: 'After any gym share — yours already' }),
            kpi('Total sales', inr(s.gmv), { icon: 'bank', tone: 'blue', foot: `${s.orders} paid order${s.orders === 1 ? '' : 's'}` }),
          ]
        : [
            kpi('Payable to you', inr(s.payable), { icon: 'wallet', tone: 'green', foot: 'Delivered orders, paid out by the platform' }),
            kpi('Paid to you', inr(s.paid), { icon: 'bank', tone: 'blue', foot: `${inr(s.gmv)} sold in total`, onClick: () => go('shop') }),
          ]),
    ),
    h(
      'div',
      { class: 'op-split' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, cardTitle('package', 'Needs packing', 'amber')),
        toPack.length
          ? h('div', { class: 'op-list' }, ...toPack.map((o) => orderRow(o, onChanged)))
          : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing to pack right now. New paid orders show up here — and in your email.'),
        moving.length
          ? [
              h('h4', { class: 'sa-subhead' }, 'On the way'),
              h('div', { class: 'op-list' }, ...moving.map((o) => orderRow(o, onChanged))),
            ]
          : null,
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, cardTitle('building', 'Gyms you serve', 'blue')),
        me.seller.gyms.length
          ? h(
              'div',
              { class: 'op-list' },
              ...me.seller.gyms.map((g) =>
                h(
                  'div',
                  { class: 'op-list-row' },
                  h('span', { class: 'op-list-icon' }, renderIcon('dumbbell', { size: 15 })),
                  h('div', { class: 'op-list-main' }, h('div', { class: 'op-list-title' }, g.gym_name), g.city ? h('div', { class: 'op-list-note' }, g.city) : null),
                ),
              ),
            )
          : h('p', { class: 'muted', style: 'margin:0' }, 'No gyms assigned yet — the platform team adds the gyms in your area.'),
      ),
    ),
  );
}

let orderFilter = 'open';
const ORDER_FILTERS = [
  ['open', 'To do', (o) => ['placed', 'packed', 'shipped', 'ready'].includes(o.fulfillment_status)],
  ['delivered', 'Done', (o) => o.fulfillment_status === 'delivered'],
  ['cancelled', 'Cancelled', (o) => o.fulfillment_status === 'cancelled'],
  ['all', 'All', () => true],
];

function ordersPage(orders, { onChanged, redraw }) {
  const [, , matches] = ORDER_FILTERS.find(([id]) => id === orderFilter) ?? ORDER_FILTERS[0];
  const rows = orders.filter(matches);
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        { class: 'filter-tabs', role: 'tablist' },
        ...ORDER_FILTERS.map(([id, label, test]) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: `filter-tab${orderFilter === id ? ' active' : ''}`,
              'aria-selected': String(orderFilter === id),
              onclick: () => {
                orderFilter = id;
                redraw();
              },
            },
            label,
            h('span', { class: 'op-tab-count' }, orders.filter(test).length),
          ),
        ),
      ),
    ),
    table(
      [
        { label: 'Order', render: (o) => h('div', {}, h('strong', {}, o.order_code), h('div', { class: 'muted' }, date(o.paid_at || o.created_at))) },
        { label: 'Customer', render: (o) => h('div', {}, o.shipping_name, h('div', { class: 'muted' }, o.gym_name)) },
        { label: 'Items', render: (o) => itemCount(o) },
        { label: 'Value', align: 'right', render: (o) => inr(o.total_amount) },
        { label: 'You get', align: 'right', render: (o) => h('strong', {}, inr(o.seller_amount)) },
        { label: 'Status', render: (o) => statusBadge(o) },
      ],
      rows,
      { onRowClick: (o) => openOrder(o, onChanged), empty: orderFilter === 'open' ? 'Nothing to do — all orders are handled.' : 'No orders here yet.' },
    ),
  );
}

const SHOP_PRODUCT_OPS = {
  create: (payload) => api.sellerCreateProduct(payload),
  update: (id, payload) => api.sellerUpdateProduct(id, payload),
  addImage: (id, file) => api.sellerAddProductImage(id, file),
  deleteImage: (id, imageId) => api.sellerDeleteProductImage(id, imageId),
  primaryImage: (id, imageId) => api.sellerPrimaryProductImage(id, imageId),
};

function productsPage(products, { onChanged }) {
  const add = () => openProductModal(null, onChanged, null, SHOP_PRODUCT_OPS);
  const toggle = async (p) => {
    try {
      await api.sellerUpdateProduct(p.id, { active: !p.active });
      toast(p.active ? `${p.title} hidden from members` : `${p.title} is on sale`);
      await onChanged();
    } catch (err) {
      toast(err.message || 'Could not update the product', 'error');
    }
  };
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      cardTitle('package', 'Your shelf', 'blue'),
      h('span', { class: 'muted' }, `${products.filter((p) => p.active).length} on sale of ${products.length}`),
      h('div', { class: 'spacer' }),
      h(
        'button',
        { class: 'btn sm', onclick: () => scanStoreProduct({ lookup: api.sellerBarcode, onSaved: onChanged, badges: null, ops: SHOP_PRODUCT_OPS }) },
        renderIcon('scan', { size: 14 }),
        'Scan barcode',
      ),
      h('button', { class: 'btn primary sm', onclick: add }, renderIcon('plus', { size: 14 }), 'Add product'),
    ),
    table(
      [
        {
          label: 'Product',
          render: (p) =>
            h(
              'div',
              { class: 'sa-product' },
              p.image_url ? h('img', { class: 'sa-thumb', src: p.image_url, alt: '', loading: 'lazy' }) : h('span', { class: 'sa-thumb' }, renderIcon('bag', { size: 16 })),
              h('div', {}, h('strong', {}, p.title), h('div', { class: 'muted' }, `${p.brand} · ${CATEGORY_LABEL[p.category] ?? p.category}`)),
            ),
        },
        {
          label: 'Stock',
          render: (p) => {
            if (!p.variants.length) return '—';
            const inStock = p.variants.filter((v) => v.in_stock).length;
            return h('span', { class: inStock ? '' : 'op-note-red' }, `${inStock} of ${p.variants.length} in stock`);
          },
        },
        {
          label: 'Price',
          align: 'right',
          render: (p) => h('span', {}, p.variants.length > 1 ? 'from ' : '', inr(p.from_price), p.mrp > p.price ? h('s', { class: 'muted sa-mrp' }, inr(p.mrp)) : null),
        },
        { label: 'Status', render: (p) => h('span', { class: `badge dot ${p.active ? 'green' : 'grey'}` }, p.active ? 'On sale' : 'Hidden') },
        {
          label: '',
          render: (p) =>
            h(
              'div',
              { class: 'row', style: 'gap:4px;justify-content:flex-end' },
              h('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); toggle(p); } }, p.active ? 'Hide' : 'Put on sale'),
              h('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); openProductModal(p, onChanged, null, SHOP_PRODUCT_OPS); } }, 'Edit'),
              h(
                'button',
                {
                  class: 'btn sm ghost danger',
                  onclick: (e) => {
                    e.stopPropagation();
                    confirmDialog({
                      title: `Remove ${p.title}?`,
                      message: 'A product that has been ordered is hidden instead of deleted, so your order history keeps it.',
                      confirmLabel: 'Remove',
                      danger: true,
                      onConfirm: async () => {
                        const res = await api.sellerDeleteProduct(p.id);
                        toast(res.retired ? 'Product hidden (it has orders)' : 'Product deleted');
                        await onChanged();
                      },
                    });
                  },
                },
                'Remove',
              ),
            ),
        },
      ],
      products,
      { onRowClick: (p) => openProductModal(p, onChanged, null, SHOP_PRODUCT_OPS), empty: 'No products yet. Add your best sellers first — a clear photo, the MRP, your price, and each flavour and size.' },
    ),
  );
}

function shopPage(me, { onChanged, rerender }) {
  const s = me.seller;
  const profile = buildForm(
    [
      { name: 'delivery_eta', label: 'Delivery promise', value: s.delivery_eta ?? '', placeholder: me.defaults.delivery_eta, full: true },
      me.defaults.pickup_enabled ? { name: 'pickup_eta', label: 'Gym pickup promise', value: s.pickup_eta ?? '', placeholder: me.defaults.pickup_eta, full: true } : null,
      { name: 'phone', label: 'Shop phone', value: s.phone },
      { name: 'gstin', label: 'GSTIN', value: s.gstin ?? '', placeholder: 'Optional' },
      { name: 'address', label: 'Shop address', type: 'textarea', value: s.address ?? '', full: true },
    ],
    {
      submitLabel: 'Save shop details',
      onSubmit: async (values) => {
        await api.sellerUpdateMe(values);
        toast('Shop details saved');
        await onChanged();
      },
    },
  );

  const password = buildForm(
    [
      { name: 'current_password', label: s.must_change_password ? 'Temporary password' : 'Current password', type: 'password', required: true, full: true },
      { name: 'new_password', label: 'New password (8+ characters)', type: 'password', required: true, full: true },
    ],
    {
      submitLabel: 'Change password',
      onSubmit: async (values) => {
        const res = await api.sellerChangePassword(values);
        sellerSession.save(res.token);
        toast('Password changed — other devices were signed out');
        await rerender();
      },
    },
  );

  const example = 1000;
  const gymCut = (example * me.gym_commission_pct) / 100;
  const fee = (example * (me.platform_fee_pct ?? 0)) / 100;
  const info = (label, value) => h('div', { class: 'sp-money-row' }, h('span', { class: 'muted' }, label), h('span', {}, value));

  return h(
    'div',
    { class: 'op-split even' },
    h(
      'div',
      { class: 'op-stack' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, cardTitle('truck', 'What members see', 'blue')), h('p', { class: 'muted', style: 'margin-top:0' }, 'Your delivery promise is the big line at the top of the store. Leave it empty to use the platform’s.'), profile),
      h(
        'div',
        { class: `card${s.must_change_password ? ' sp-attention' : ''}` },
        h('div', { class: 'card-head' }, cardTitle('key', s.must_change_password ? 'Set your own password' : 'Password', s.must_change_password ? 'amber' : 'blue')),
        s.must_change_password ? h('p', { class: 'muted', style: 'margin-top:0' }, 'You are still on the temporary password you were given. Pick your own now.') : null,
        password,
      ),
    ),
    h(
      'div',
      { class: 'op-stack' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, cardTitle('store', s.name, 'violet')),
        info('Owner', s.owner_name),
        info('Sign-in email', s.email),
        info('Area', [s.area, s.city].filter(Boolean).join(', ')),
        info('Store type', s.owned ? 'Your own store' : 'Partner shop'),
        info('Gym share', me.gym_commission_pct > 0 ? `${me.gym_commission_pct}% of each order` : 'None'),
        s.owned ? null : info('Platform fee', `${me.platform_fee_pct}% of each order`),
        h('p', { class: 'muted sa-hint' }, 'To change these, contact the platform team.'),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, cardTitle('wallet', s.owned ? 'Your money' : 'How you are paid', 'green')),
        h(
          'p',
          { class: 'muted', style: 'margin-top:0' },
          s.owned
            ? `This is your own store: members pay into the platform account, which is yours, so there are no payouts to wait for and no platform fee. On a ${inr(example)} order:`
            : `Members pay online; once an order is delivered, its amount is added to your payout. On a ${inr(example)} order:`,
        ),
        h(
          'div',
          { class: 'sp-money' },
          info('Order value', inr(example)),
          info(`Gym’s share (${me.gym_commission_pct}%)`, gymCut ? `− ${inr(gymCut)}` : 'none'),
          s.owned ? null : info(`Platform fee (${me.platform_fee_pct}%)`, `− ${inr(fee)}`),
          h('div', { class: 'sp-money-row' }, h('strong', {}, s.owned ? 'You keep' : 'You receive'), h('strong', {}, inr(example - gymCut - fee))),
        ),
      ),
      s.owned
        ? null
        : h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, cardTitle('bank', 'Payouts', 'blue'), h('div', { class: 'spacer' }), h('strong', {}, `${inr(s.stats.payable)} due`)),
        table(
          [
            { label: 'Paid on', render: (p) => date(p.paid_at) },
            { label: 'Reference', render: (p) => p.payout_ref },
            { label: 'Orders', render: (p) => p.orders },
            { label: 'Amount', align: 'right', render: (p) => h('strong', {}, inr(p.total)) },
          ],
          me.payouts,
          { empty: 'No payouts yet.' },
        ),
      ),
    ),
  );
}

/* ── Sign-in and frame ────────────────────────────────────────────────── */

function loginCard(rerender) {
  const form = buildForm(
    [
      { name: 'email', label: 'Shop email', type: 'email', required: true, full: true },
      { name: 'password', label: 'Password', type: 'password', required: true, full: true },
    ],
    {
      submitLabel: 'Sign in',
      onSubmit: async (values) => {
        const { token } = await api.sellerLogin(values.email, values.password);
        sellerSession.save(token);
        section = 'today';
        await rerender();
      },
    },
  );
  form.querySelector('.modal-foot').remove();
  form.append(h('button', { class: 'btn primary block lg', type: 'submit' }, renderIcon('store', { size: 17 }), 'Sign in to my shop'));

  const mark = () => h('div', { class: 'login-logo-mark' }, renderIcon('store', { size: 20 }));
  const point = (icon, text) => h('li', {}, h('span', { class: 'pt-icon' }, renderIcon(icon, { size: 16 })), text);
  return h(
    'div',
    { class: 'auth op-auth' },
    h(
      'aside',
      { class: 'auth-aside' },
      h('div', { class: 'auth-brand' }, mark(), 'Shop panel'),
      h(
        'div',
        { class: 'auth-pitch' },
        h('span', { class: 'op-eyebrow' }, renderIcon('store', { size: 14 }), 'For partner shops'),
        h('h2', {}, 'Sell to every gym in your area.'),
        h('p', {}, 'List your supplements once. Members of your nearby gyms order and pay in their gym app, and you pack and deliver.'),
        h(
          'ul',
          { class: 'auth-points' },
          point('package', 'Your own products, prices and stock'),
          point('truck', 'Orders with the customer’s phone and address'),
          point('wallet', 'Payouts for every delivered order'),
        ),
      ),
      h('div', { class: 'auth-foot' }, 'Your login comes from the platform team. Ask them if you have not received it.'),
    ),
    h(
      'main',
      { class: 'auth-main' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-mobile-brand' }, mark(), 'Shop panel'),
        h('h1', {}, 'Welcome back'),
        h('p', { class: 'sub' }, 'Sign in with the email and password the platform team gave you.'),
        form,
      ),
    ),
  );
}

function shell(me, body, { rerender }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const go = async (id) => {
    if (id === section) return;
    section = id;
    window.scrollTo(0, 0);
    await rerender();
  };
  const signOut = async () => {
    sellerSession.clear();
    await rerender();
  };
  const modeButton = () => {
    const button = h('button', { class: 'btn sm ghost icon-only', type: 'button', title: 'Switch between light and dark' });
    const paint = () => {
      const light = getAppMode() === 'light';
      clear(button).append(renderIcon(light ? 'moon' : 'sun', { size: 15 }));
      button.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
    };
    button.onclick = () => {
      toggleAppMode();
      paint();
    };
    paint();
    return button;
  };
  const toPack = me.seller.stats.to_ship;

  return h(
    'div',
    { class: 'console op-shell' },
    h(
      'aside',
      { class: 'op-side' },
      h(
        'div',
        { class: 'op-side-brand' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }, renderIcon('store', { size: 18 })), h('div', { class: 'op-brand-text' }, h('span', {}, me.seller.name), h('small', {}, 'Shop panel'))),
        h(
          'div',
          { class: 'op-side-quick' },
          modeButton(),
          h('button', { class: 'btn sm ghost icon-only', type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut }, renderIcon('logout', { size: 15 })),
        ),
      ),
      h(
        'nav',
        { class: 'op-nav', 'aria-label': 'Shop sections' },
        ...SECTIONS.map((s) =>
          h(
            'button',
            { class: `nav-link${s.id === current.id ? ' active' : ''}`, type: 'button', 'aria-current': s.id === current.id ? 'page' : null, onclick: () => go(s.id) },
            h('span', { class: 'icon' }, renderIcon(s.icon, { size: 18 })),
            h('span', {}, s.label),
            s.id === 'orders' && toPack ? h('span', { class: 'op-tab-count sp-nav-count' }, toPack) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'op-side-foot' },
        h(
          'div',
          { class: 'sidebar-user' },
          h('span', { class: 'op-user-mark' }, renderIcon('user', { size: 16 })),
          h('div', { class: 'sidebar-user-meta' }, h('div', { class: 'sidebar-user-name' }, me.seller.owner_name), h('div', { class: 'sidebar-user-role' }, [me.seller.area, me.seller.city].filter(Boolean).join(', '))),
        ),
        h('div', { class: 'sidebar-actions' }, modeButton(), h('button', { class: 'btn sm ghost op-signout', type: 'button', onclick: signOut }, renderIcon('logout', { size: 15 }), 'Sign out')),
      ),
    ),
    h(
      'main',
      { class: 'op-main' },
      h(
        'header',
        { class: 'op-page-head' },
        h('div', { class: 'op-page-title' }, h('span', { class: 'op-eyebrow' }, renderIcon(current.icon, { size: 14 }), me.seller.name), h('h1', {}, current.title), h('p', {}, current.sub)),
        h('div', { class: 'op-page-actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => rerender() }, renderIcon('refreshCw', { size: 15 }), 'Refresh')),
      ),
      h('div', { class: 'op-body' }, body),
    ),
  );
}

export async function renderSellerPanel({ rerender }) {
  if (!sellerSession.token) return loginCard(rerender);

  let me;
  let orders;
  let products;
  try {
    [me, orders, products] = await Promise.all([api.sellerMe(), api.sellerOrders(), api.sellerProducts()]);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      sellerSession.clear();
      if (err.status === 403) toast(err.message, 'error');
      return loginCard(rerender);
    }
    throw err;
  }

  // Redraws just the page body (a filter tab), without refetching.
  const host = h('div', {});
  const ctx = {
    rerender,
    onChanged: rerender,
    go: async (id) => {
      section = id;
      window.scrollTo(0, 0);
      await rerender();
    },
    redraw: () => clear(host).append(page()),
  };
  const page = () => {
    if (section === 'orders') return ordersPage(orders.items, ctx);
    if (section === 'products') return productsPage(products.items, ctx);
    if (section === 'shop') return shopPage(me, ctx);
    return todayPage(me, orders.items, products.items, ctx);
  };
  host.append(page());
  return shell(me, host, ctx);
}
