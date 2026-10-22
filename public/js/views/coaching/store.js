import { api } from '../../api.js';
import { confirmDialog, date, h, money, renderIcon, stat, table, toast } from '../../ui.js';
import { fill, pillTabs, section } from './common.js';

/**
 * Study store: what the institute gets from the CoachBook store — the books,
 * test prep and stationery its students buy in their app (the platform's
 * catalogue, see src/monetization.js). Nothing here is stocked or priced by
 * the institute; the office has two jobs:
 *
 *   Pickups    the orders students chose to collect here: mark the parcel
 *              arrived (the student is told to come for it), then hand it
 *              over. Handed over is what makes the institute's cut final.
 *   Earnings   the commission statement — every order, the cut on it, and
 *              whether that is waiting for delivery, payable or paid out.
 *
 * The same /api/store-hub endpoints as a gym's Store & Commissions hub, so
 * the same billing roles only.
 */

const PICKUP_STATUS = {
  placed: ['blue', 'Ordered'],
  packed: ['blue', 'Packed'],
  shipped: ['violet', 'On its way here'],
  ready: ['amber', 'Waiting at the office'],
  delivered: ['green', 'Handed over'],
  cancelled: ['grey', 'Cancelled'],
};
const COMMISSION_STATUS = {
  pending: ['amber', 'Awaiting delivery'],
  approved: ['blue', 'Payable'],
  paid: ['green', 'Paid'],
  void: ['grey', 'Cancelled'],
};
const STORE_NOTE = {
  live: 'The store is live in your students’ app.',
  coming_soon: 'The store opens in your students’ app soon — your earnings start with the first order.',
  disabled: 'The store is switched off for now.',
};
const badge = ([tone, label]) => h('span', { class: `badge dot ${tone}` }, label);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Which pane is showing; module state so it survives a reload(). */
let lastPane = 'pickups';

export async function renderCoachingStore({ reload }) {
  const [summary, ledger, pickups] = await Promise.all([api.storeHub.summary(), api.storeHub.commissions(), api.storeHub.pickups()]);
  const p = summary.platform;
  const orders = pickups.items;
  const waiting = orders.filter((o) => o.fulfillment_status === 'ready').length;
  const coming = orders.filter((o) => ['placed', 'packed', 'shipped'].includes(o.fulfillment_status)).length;
  // An institute earns only on the store; add-on rows would be a gym's.
  const statement = ledger.items.filter((r) => r.source_type === 'store_order');

  const act = async (fn, message) => {
    try {
      await fn();
      toast(message);
      await reload();
    } catch (err) {
      toast(err.message || 'Could not update that order', 'error');
    }
  };

  const pickupsPane = () =>
    section(
      'Orders to hand over',
      table(
        [
          { label: 'Order', render: (o) => h('div', {}, h('strong', {}, o.order_code), h('div', { class: 'muted' }, date(o.paid_at || o.created_at))) },
          { label: 'Student', render: (o) => h('div', {}, h('strong', {}, o.shipping_name), h('div', { class: 'muted' }, o.shipping_phone)) },
          {
            label: 'Items',
            render: (o) =>
              h('div', { class: 'cb-store-items' }, ...o.items.map((i) => h('div', {}, `${i.quantity} × ${i.title}`, i.variant_label ? h('span', { class: 'muted' }, ` · ${i.variant_label}`) : null))),
          },
          { label: 'Status', render: (o) => badge(PICKUP_STATUS[o.fulfillment_status] ?? PICKUP_STATUS.placed) },
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
                            message: `Check it is ${o.shipping_name} (${o.shipping_phone}) — or their parent — collecting.`,
                            confirmLabel: 'Handed over',
                            onConfirm: () => act(() => api.storeHub.pickupCollected(o.id), `${o.order_code} handed over`),
                          }),
                      },
                      'Hand over',
                    )
                  : null,
          },
        ],
        orders,
        { empty: 'No pickup orders yet. When a student chooses to collect an order at the institute, it shows up here.' },
      ),
      {
        icon: 'package',
        subtitle: 'Mark a parcel arrived when it reaches the office — the student is notified to come and collect it.',
      },
    );

  const earningsPane = () =>
    section(
      'Commission statement',
      table(
        [
          { label: 'Date', render: (r) => date(r.earned_on) },
          {
            label: 'Order',
            render: (r) => h('div', {}, h('strong', {}, r.order_code ?? '—'), h('div', { class: 'muted' }, plural(r.item_count ?? 0, 'item'))),
          },
          { label: 'Student', render: (r) => r.member_name ?? '—' },
          { label: 'Order value', align: 'right', render: (r) => money(r.gross_amount) },
          { label: 'Rate', align: 'right', render: (r) => `${r.commission_pct}%` },
          { label: 'Your cut', align: 'right', render: (r) => h('strong', {}, money(r.amount)) },
          {
            label: 'Status',
            render: (r) => h('span', { title: r.payout_ref ? `Payout ref ${r.payout_ref}` : '' }, badge(COMMISSION_STATUS[r.status] ?? COMMISSION_STATUS.pending)),
          },
        ],
        statement,
        { empty: 'No earnings yet. They appear here as soon as one of your students buys from the store.' },
      ),
      { icon: 'wallet', subtitle: 'Your cut becomes payable once an order is delivered or handed over; payouts go to your bank monthly.' },
    );

  const tabsHost = h('div', {});
  const paneHost = h('div', {});
  const paint = () => {
    fill(
      tabsHost,
      pillTabs(
        [
          { key: 'pickups', label: 'Pickups', icon: 'package', count: waiting + coming || null },
          { key: 'earnings', label: 'Earnings', icon: 'wallet', count: statement.length || null },
        ],
        lastPane,
        (key) => {
          lastPane = key;
          paint();
        },
      ),
    );
    fill(paneHost, lastPane === 'earnings' ? earningsPane() : pickupsPane());
  };
  paint();

  const showPickups = () => {
    lastPane = 'pickups';
    paint();
  };

  return h(
    'div',
    { class: 'cb-page grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'grid cols-4' },
      stat('Earned this month', money(p.month_store), `${plural(p.orders_month, 'student order')} · ${money(p.gmv_month)} sold`, { icon: 'trendUp', accent: true }),
      stat('Payout balance', money(p.payable), p.pending > 0 ? `+ ${money(p.pending)} once delivered` : `${money(p.paid)} paid so far`, { icon: 'wallet' }),
      stat('Waiting at the office', waiting, waiting ? 'Students have been told to collect' : 'Nothing to hand over', { icon: 'building', onClick: showPickups }),
      stat('On the way here', coming, 'Pickup orders being shipped', { icon: 'truck', onClick: showPickups }),
    ),
    h(
      'div',
      { class: 'card cb-store-note' },
      h('span', { class: 'cb-section-icon' }, renderIcon('book', { size: 18 })),
      h(
        'div',
        {},
        h(
          'strong',
          {},
          p.store_commission_pct > 0
            ? `You earn ${p.store_commission_pct}% of every order your students place in the study store.`
            : 'Orders from your students in the study store carry no commission for the institute.',
        ),
        h(
          'p',
          { class: 'muted' },
          `${STORE_NOTE[p.store_status] ?? ''} Students buy books, test prep and stationery in their app and pay online; the platform delivers to their home or sends the parcel here for pickup.`,
        ),
      ),
    ),
    tabsHost,
    paneHost,
  );
}
