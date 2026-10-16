import { api } from '../api.js';
import { append, clear, closeModal, confirmDialog, h, openModal, renderIcon, table, toast } from '../ui.js';
import { inr } from './storeAdmin.js';

/**
 * Operator console → Partner shops: the supplement shops that sell to their
 * area's gyms from their own Shop panel (#/seller), never from this console.
 *
 * Adding a shop is the whole onboarding: its details, the platform's fee, the
 * gyms it serves (picked by city), and a one-time password to hand over —
 * ready to send on WhatsApp. See src/sellers.js for the rules behind it.
 */

const fill = (el, ...children) => append(clear(el), children);
const field = (label, control, { full = false, hint } = {}) =>
  h('label', { class: `field${full ? ' full' : ''}` }, h('span', {}, label), control, hint ? h('div', { class: 'muted sa-hint' }, hint) : null);
const panelUrl = () => `${window.location.origin}/#/seller`;

/** The login, shown once: the server keeps only its hash. */
function openCredentials(seller, password) {
  const message = [
    `Hi ${seller.owner_name}, your shop panel for ${seller.name} is ready.`,
    '',
    `Open: ${panelUrl()}`,
    `Email: ${seller.email}`,
    `Temporary password: ${password}`,
    '',
    'Sign in, set your own password, and add your products — members of your area’s gyms can then order from you.',
  ].join('\n');
  const digits = String(seller.phone).replace(/\D/g, '');
  const wa = `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}?text=${encodeURIComponent(message)}`;
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast('Copy is blocked here — select the text instead', 'error');
    }
  };
  openModal({
    title: `Login for ${seller.name}`,
    subtitle: 'Shown once — send it now. You can always reset it later.',
    body: h(
      'div',
      { class: 'op-stack' },
      h('div', { class: 'shp-password' }, h('div', {}, h('div', { class: 'muted' }, seller.email), h('code', {}, password)), h('button', { class: 'btn sm', type: 'button', onclick: () => copy(password, 'Password') }, renderIcon('copy', { size: 14 }), 'Copy')),
      h('p', { class: 'muted', style: 'margin:0' }, 'They sign in at ', h('strong', {}, panelUrl()), ' and are asked to pick their own password.'),
    ),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => copy(message, 'Message') }, renderIcon('copy', { size: 15 }), 'Copy message'),
      h('a', { class: 'btn primary', href: wa, target: '_blank', rel: 'noopener' }, renderIcon('whatsapp', { size: 15 }), 'Send on WhatsApp'),
    ],
  });
}

/**
 * Gyms grouped by city, each a checkbox, with "all in city" per group — an
 * area is usually a city or a part of one. A gym another shop serves says so;
 * ticking it moves it here.
 */
function gymPicker(gyms, selected, sellerId) {
  const search = h('input', { type: 'search', placeholder: 'Search gyms, cities or PIN codes', 'aria-label': 'Search gyms' });
  const list = h('div', { class: 'shp-gyms' });
  const summary = h('span', { class: 'muted' });

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = gyms.filter((g) => !q || [g.gym_name, g.city, g.pincode, g.slug].some((v) => v && String(v).toLowerCase().includes(q)));
    const byCity = new Map();
    for (const g of shown) {
      const city = g.city?.trim() || 'No city set';
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city).push(g);
    }
    summary.textContent = `${selected.size} gym${selected.size === 1 ? '' : 's'} selected`;
    fill(
      list,
      shown.length
        ? [...byCity.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([city, rows]) => {
              const all = rows.every((g) => selected.has(g.slug));
              return [
                h(
                  'div',
                  { class: 'shp-city' },
                  `${city} · ${rows.length}`,
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'linklike',
                      onclick: () => {
                        for (const g of rows) all ? selected.delete(g.slug) : selected.add(g.slug);
                        draw();
                      },
                    },
                    all ? 'Clear city' : 'Select all in city',
                  ),
                ),
                ...rows.map((g) => {
                  const taken = g.seller && g.seller.id !== sellerId;
                  return h(
                    'label',
                    { class: 'shp-gym' },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(g.slug),
                      onchange: (e) => {
                        if (e.target.checked) selected.add(g.slug);
                        else selected.delete(g.slug);
                        summary.textContent = `${selected.size} gym${selected.size === 1 ? '' : 's'} selected`;
                      },
                    }),
                    h('span', {}, g.gym_name, g.pincode ? h('small', {}, ` · ${g.pincode}`) : null),
                    taken ? h('small', { class: 'taken' }, `now: ${g.seller.name}`) : null,
                  );
                }),
              ];
            })
        : h('p', { class: 'muted', style: 'margin:6px 0' }, gyms.length ? 'No gym matches that search.' : 'No gyms on the platform yet.'),
    );
  }
  search.oninput = draw;
  draw();
  return h('div', { class: 'field full' }, h('span', { class: 'row', style: 'justify-content:space-between' }, 'Gyms this shop serves', summary), search, list);
}

/**
 * The money on one shop's orders, chosen in three steps: whose store it is
 * (a partner's, or your own dark store — no platform fee, nothing to pay
 * out), the gym's cut (the platform default, a custom rate, or none), and for
 * a partner the platform fee. A worked ₹1,000 order underneath shows the
 * result as it is chosen.
 */
function moneySettings(s, defaultGymPct) {
  const state = {
    owned: Boolean(s.owned),
    gymMode: s.gym_commission_pct === null || s.gym_commission_pct === undefined ? 'default' : Number(s.gym_commission_pct) === 0 ? 'none' : 'custom',
  };
  const customPct = h('input', { type: 'number', min: 0, max: 50, step: '0.5', value: state.gymMode === 'custom' ? s.gym_commission_pct : defaultGymPct, 'aria-label': 'Custom gym commission (%)' });
  const feePct = h('input', { type: 'number', min: 0, max: 60, step: '0.5', value: s.platform_fee_pct ?? 10, required: true, 'aria-label': 'Platform fee (%)' });
  const typeSeg = h('div', { class: 'sa-seg two', role: 'radiogroup', 'aria-label': 'Whose store' });
  const gymSeg = h('div', { class: 'sa-seg', role: 'radiogroup', 'aria-label': 'Gym commission' });
  const customRow = h('div', { class: 'shp-inline' }, customPct, h('span', { class: 'muted' }, '% of each order goes to the gym'));
  const feeBlock = h('div', { class: 'field full' }, h('span', {}, 'Platform fee (%)'), h('div', { class: 'shp-inline' }, feePct, h('span', { class: 'muted' }, 'your cut of each order, on top of the gym’s share')));
  const example = h('div', { class: 'sp-money shp-example' });

  const gymPct = () => (state.gymMode === 'default' ? defaultGymPct : state.gymMode === 'none' ? 0 : Number(customPct.value) || 0);
  const segButton = (title, hint, isOn, pick) =>
    h(
      'button',
      { type: 'button', role: 'radio', 'aria-checked': String(isOn), class: `sa-seg-btn${isOn ? ' active green' : ''}`, onclick: pick },
      h('strong', {}, title),
      h('small', {}, hint),
    );

  function draw() {
    fill(
      typeSeg,
      segButton('Partner shop', 'A local shop sells; you take a platform fee and pay it out', !state.owned, () => {
        state.owned = false;
        draw();
      }),
      segButton('My own store', 'Your dark store — no platform fee, sales are already yours', state.owned, () => {
        // Your own store usually keeps the whole sale; the gym cut can still be set below.
        if (!state.owned && state.gymMode === 'default') state.gymMode = 'none';
        state.owned = true;
        draw();
      }),
    );
    fill(
      gymSeg,
      segButton(`Platform default · ${defaultGymPct}%`, 'Follows the rate in Store & monetization', state.gymMode === 'default', () => {
        state.gymMode = 'default';
        draw();
      }),
      segButton('Custom rate', 'A different % for this shop’s gyms', state.gymMode === 'custom', () => {
        state.gymMode = 'custom';
        draw();
      }),
      segButton('No gym commission', 'The gyms earn nothing on these orders', state.gymMode === 'none', () => {
        state.gymMode = 'none';
        draw();
      }),
    );
    customRow.hidden = state.gymMode !== 'custom';
    feeBlock.hidden = state.owned;

    const order = 1000;
    const gym = (order * gymPct()) / 100;
    const fee = state.owned ? 0 : (order * (Number(feePct.value) || 0)) / 100;
    const row = (label, value, strong) => h('div', { class: 'sp-money-row' }, strong ? h('strong', {}, label) : h('span', { class: 'muted' }, label), strong ? h('strong', {}, value) : h('span', {}, value));
    fill(
      example,
      row(`On a ${inr(order)} order`, ''),
      row(`Gym’s share (${gymPct()}%)`, gym ? `− ${inr(gym)}` : 'none'),
      state.owned ? null : row(`Platform fee (${Number(feePct.value) || 0}%)`, `+ ${inr(fee)} to you`),
      row(state.owned ? 'You keep' : 'The shop receives', inr(Math.max(0, order - gym - fee)), true),
    );
  }
  customPct.oninput = draw;
  feePct.oninput = draw;
  draw();

  return {
    node: h(
      'div',
      { class: 'field full shp-money-settings' },
      h('span', {}, 'Whose store is it?'),
      typeSeg,
      h('span', { style: 'margin-top:10px' }, 'Gym commission on this shop’s orders'),
      gymSeg,
      customRow,
      feeBlock,
      example,
    ),
    values: () => ({
      owned: state.owned,
      gym_commission_pct: state.gymMode === 'default' ? null : gymPct(),
      platform_fee_pct: Number(feePct.value) || 0,
    }),
  };
}

function openShopModal(seller, gyms, onSaved, defaultGymPct = 0) {
  const isNew = !seller;
  const s = seller ?? { platform_fee_pct: 10, active: true, gyms: [] };
  const money = moneySettings(s, defaultGymPct);
  const input = (name, attrs = {}) => h('input', { name, value: s[name] ?? '', ...attrs });
  const inputs = {
    name: input('name', { required: true, maxlength: 80, placeholder: 'Muscle Mart Bandra' }),
    owner_name: input('owner_name', { required: true, maxlength: 80, placeholder: 'Rahul Shah' }),
    email: input('email', { type: 'email', required: true, placeholder: 'shop@example.com' }),
    phone: input('phone', { required: true, placeholder: '98200 11111' }),
    city: input('city', { required: true, maxlength: 60, placeholder: 'Mumbai' }),
    area: input('area', { maxlength: 80, placeholder: 'Bandra West' }),
    gstin: input('gstin', { maxlength: 20, placeholder: 'Optional' }),
    address: h('textarea', { name: 'address', rows: 2, maxlength: 300 }, s.address ?? ''),
    active: h('input', { type: 'checkbox', checked: s.active !== false }),
  };
  const selected = new Set(s.gyms.map((g) => g.slug));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add shop' : 'Save changes');

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const payload = {
          ...Object.fromEntries(['name', 'owner_name', 'email', 'phone', 'city', 'area', 'gstin'].map((k) => [k, inputs[k].value.trim()])),
          address: inputs.address.value.trim(),
          ...money.values(),
          gyms: [...selected],
          ...(isNew ? {} : { active: inputs.active.checked }),
        };
        submit.disabled = true;
        try {
          const res = isNew ? await api.platformCreateSeller(payload) : await api.platformUpdateSeller(seller.id, payload);
          closeModal();
          await onSaved();
          if (res.moved?.length) toast(`${res.moved.length} gym${res.moved.length === 1 ? '' : 's'} moved over from another shop`);
          else toast(isNew ? 'Shop added' : 'Shop saved');
          if (isNew) openCredentials(res.seller, res.password);
        } catch (err) {
          const detail = err.details && Object.entries(err.details).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ');
          toast(detail ? `${err.message}: ${detail}` : err.message || 'Could not save the shop', 'error');
        } finally {
          submit.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'form-grid' },
      field('Shop name *', inputs.name, { full: true }),
      field('Owner *', inputs.owner_name),
      field('Phone *', inputs.phone, { hint: 'The login can be sent here on WhatsApp.' }),
      field('Sign-in email *', inputs.email, { full: true }),
      field('City *', inputs.city),
      field('Area', inputs.area),
      field('GSTIN', inputs.gstin, { full: true }),
      money.node,
      field('Shop address', inputs.address, { full: true }),
      gymPicker(gyms, selected, seller?.id),
      isNew ? null : h('div', { class: 'field full sa-checks' }, h('label', {}, inputs.active, ' Active — unticking pauses the shop: it is signed out, and its gyms go back to the central catalogue')),
    ),
    h('div', { class: 'modal-foot', style: 'padding:14px 0 0;border:none' }, h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), submit),
  );

  const extra = isNew
    ? null
    : h(
        'div',
        { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)' },
        h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            // The editor closes first: confirmDialog closes the top modal once
            // onConfirm resolves, so the login opens only after it has gone.
            onclick: () => {
              closeModal();
              confirmDialog({
                title: `Reset ${seller.name}'s password?`,
                message: 'They are signed out everywhere and get a new temporary password from you.',
                confirmLabel: 'Reset password',
                // Returns straight after the reset, with no other await, so
                // confirmDialog has closed itself before the timeout fires.
                onConfirm: async () => {
                  const res = await api.platformResetSellerPassword(seller.id);
                  setTimeout(() => {
                    openCredentials(res.seller, res.password);
                    onSaved();
                  });
                },
              });
            },
          },
          renderIcon('key', { size: 14 }),
          'Reset password',
        ),
        !seller.stats.orders
          ? h(
              'button',
              {
                class: 'btn sm ghost danger',
                type: 'button',
                onclick: () => {
                  closeModal();
                  confirmDialog({
                    title: `Delete ${seller.name}?`,
                    message: 'Its login and products are deleted, and its gyms go back to the central catalogue.',
                    confirmLabel: 'Delete shop',
                    danger: true,
                    onConfirm: async () => {
                      await api.platformDeleteSeller(seller.id);
                      toast('Shop deleted');
                      await onSaved();
                    },
                  });
                },
              },
              renderIcon('trash', { size: 14 }),
              'Delete shop',
            )
          : null,
      );

  openModal({ title: isNew ? 'Add a partner shop' : `Edit · ${seller.name}`, wide: true, body: h('div', {}, form, extra) });
}

function openPayout(seller, onSaved) {
  const ref = h('input', { placeholder: 'UTR / transfer reference', maxlength: 80 });
  const save = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        save.disabled = true;
        try {
          const res = await api.platformSellerPayout(seller.id, { payout_ref: ref.value.trim() });
          closeModal();
          toast(`${inr(res.total)} marked paid to ${seller.name}`);
          await onSaved();
        } catch (err) {
          toast(err.message || 'Could not record the payout', 'error');
        } finally {
          save.disabled = false;
        }
      },
    },
    `Mark ${inr(seller.stats.payable)} paid`,
  );
  openModal({
    title: `Payout · ${seller.name}`,
    subtitle: 'Record the bank transfer once it has gone out',
    body: h(
      'div',
      {},
      h('p', { class: 'muted', style: 'margin-top:0' }, `Every delivered order not yet paid (${inr(seller.stats.payable)}) is marked paid under this reference. Orders still on their way wait for delivery. The shop sees the reference in its panel.`),
      field('Transfer reference', ref, { full: true }),
    ),
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
  });
}

export function renderShopsSection({ onExpired } = {}) {
  const root = h('div', { class: 'op-stack' }, h('div', { class: 'empty' }, 'Loading partner shops…'));

  async function refresh() {
    let data;
    try {
      data = await api.platformSellers();
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && onExpired) return onExpired();
      toast(err.message || 'Could not load the shops', 'error');
      return;
    }
    const { items: shops, gyms } = data;
    const active = shops.filter((s) => s.active);
    const covered = gyms.filter((g) => g.seller && active.some((s) => s.id === g.seller.id));
    const sum = (key) => shops.reduce((n, s) => n + s.stats[key], 0);
    // Your own stores' takings are already yours: nothing is owed on them.
    const owed = (key) => shops.filter((s) => !s.owned).reduce((n, s) => n + s.stats[key], 0);
    const kpi = (label, value, icon, tone, foot) =>
      h(
        'div',
        { class: `card op-kpi tone-${tone}` },
        h('div', { class: 'op-kpi-head' }, h('span', { class: 'op-kpi-label' }, label), h('span', { class: 'op-kpi-icon' }, renderIcon(icon, { size: 17 }))),
        h('div', { class: 'op-kpi-value' }, value),
        h('div', { class: 'op-kpi-foot' }, foot),
      );
    const uncovered = gyms.filter((g) => !covered.includes(g));

    fill(
      root,
      h(
        'div',
        { class: 'op-kpis' },
        kpi('Active shops', String(active.length), 'store', 'violet', `${shops.length - active.length} paused`),
        kpi('Gyms covered', `${covered.length} / ${gyms.length}`, 'building', 'blue', `${uncovered.length} on the central catalogue`),
        kpi('Shop sales', inr(sum('gmv')), 'bag', 'green', `${sum('to_ship')} order${sum('to_ship') === 1 ? '' : 's'} waiting to ship`),
        kpi('Owed to partner shops', inr(owed('payable')), 'wallet', 'amber', `${inr(owed('paid'))} paid out`),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('div', { class: 'op-card-title tone-violet' }, h('span', { class: 'head-icon' }, renderIcon('store', { size: 17 })), h('h3', {}, 'Partner shops')),
          h('span', { class: 'muted' }, 'Each signs in at ', h('a', { href: '#/seller' }, '#/seller'), ' with its own login'),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn primary sm', onclick: () => openShopModal(null, gyms, refresh, data.gym_commission_pct) }, renderIcon('plus', { size: 14 }), 'Add shop'),
        ),
        table(
          [
            {
              label: 'Shop',
              render: (s) =>
                h(
                  'div',
                  {},
                  h('strong', {}, s.name, s.owned ? h('span', { class: 'badge violet', style: 'margin-left:6px' }, 'Own store') : null),
                  h('div', { class: 'muted' }, [s.area, s.city].filter(Boolean).join(', ')),
                ),
            },
            { label: 'Owner', render: (s) => h('div', {}, s.owner_name, h('div', { class: 'muted' }, s.phone)) },
            { label: 'Gyms', render: (s) => (s.gyms.length ? `${s.gyms.length}` : h('span', { class: 'op-note-amber' }, 'None yet')) },
            { label: 'Products', render: (s) => (s.products.active ? `${s.products.active} on sale` : h('span', { class: 'op-note-amber' }, 'Empty shelf')) },
            { label: 'To ship', align: 'right', render: (s) => s.stats.to_ship },
            { label: 'Sales', align: 'right', render: (s) => inr(s.stats.gmv) },
            {
              label: 'Cuts',
              render: (s) =>
                h(
                  'div',
                  { style: 'white-space:nowrap' },
                  s.rates.gym_commission_pct > 0 ? `Gym ${s.rates.gym_commission_pct}%${s.rates.gym_commission_custom ? ' (custom)' : ''}` : 'No gym cut',
                  h('div', { class: 'muted' }, s.owned ? 'No platform fee' : `Fee ${s.rates.platform_fee_pct}%`),
                ),
            },
            { label: 'Payable', align: 'right', render: (s) => (s.owned ? h('span', { class: 'muted' }, '—') : h('strong', {}, inr(s.stats.payable))) },
            {
              label: 'Status',
              render: (s) =>
                h(
                  'span',
                  { class: 'row', style: 'gap:6px' },
                  h('span', { class: `badge dot ${s.active ? 'green' : 'grey'}` }, s.active ? 'Active' : 'Paused'),
                  s.must_change_password ? h('span', { class: 'badge amber', title: 'Has not set their own password yet' }, 'Not signed in yet') : null,
                ),
            },
            {
              label: '',
              render: (s) =>
                !s.owned && s.stats.payable > 0
                  ? h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); openPayout(s, refresh); } }, 'Record payout')
                  : null,
            },
          ],
          shops,
          {
            onRowClick: (s) => openShopModal(s, gyms, refresh, data.gym_commission_pct),
            empty: 'No partner shops yet. Add a local supplement shop, pick the gyms around it, and send them their login.',
          },
        ),
      ),
      uncovered.length && shops.length
        ? h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('div', { class: 'op-card-title tone-blue' }, h('span', { class: 'head-icon' }, renderIcon('building', { size: 17 })), h('h3', {}, 'Gyms without a shop'))),
            h('p', { class: 'muted', style: 'margin-top:0' }, 'These gyms’ members shop from the central catalogue, fulfilled by you.'),
            h('div', { class: 'op-pills' }, ...uncovered.map((g) => h('span', { class: 'op-pill' }, g.gym_name, g.city ? h('span', { class: 'muted' }, ` · ${g.city}`) : null))),
          )
        : null,
    );
  }

  refresh();
  return root;
}
