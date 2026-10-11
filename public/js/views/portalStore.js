import { api, pathSlug } from '../api.js';
import { append, clear, closeModal, date, h, money, openModal, renderIcon, toast } from '../ui.js';
import { memberSynced } from '../memberSync.js';
import { payWithRazorpay } from '../razorpayCheckout.js';

/**
 * The member app's Store once the operator takes it live, laid out the way
 * quick-commerce apps (Blinkit and friends) have taught members to shop:
 *
 *   home      delivery promise + search, banners, a category grid, product
 *             rails, and a green cart bar that follows the member around
 *   pages     category browser (sidebar + grid), search, product page with a
 *             gallery, cart/checkout, order placed, and order tracking
 *
 * Pages are full-screen layers over the tab, each with its own history entry
 * so the phone's back gesture steps back through them. Prices on screen are
 * for showing only — the cart sends ids and the server prices the order (see
 * createStoreCheckout in src/monetization.js).
 */

/** Replaces an element's children. ui.js's append, not the DOM's: the DOM's
 * would print a conditional child that came out null as the text "null". */
const fill = (el, ...children) => append(clear(el), children);

/** `art` is an optional picture in public/images/store/ — a category with
 * none falls back to its first product photo, then to its icon. */
const CATEGORY = {
  protein: { label: 'Protein', icon: 'bottle', tint: '#e8f1ff', art: 'cat-protein' },
  creatine: { label: 'Creatine', icon: 'zap', tint: '#f1ecff', art: 'cat-creatine' },
  preworkout: { label: 'Pre-workout', icon: 'flame', tint: '#fff0e6', art: 'cat-preworkout' },
  bcaa: { label: 'BCAA', icon: 'droplet', tint: '#f3e8ff', art: 'cat-bcaa' },
  vitamins: { label: 'Vitamins', icon: 'heartPulse', tint: '#e8f8ef', art: 'cat-vitamins' },
  snacks: { label: 'Snacks', icon: 'apple', tint: '#fff4e5', art: 'cat-snacks' },
  gear: { label: 'Gear', icon: 'dumbbell', tint: '#f4f1ea', art: 'cat-gear' },
  other: { label: 'More', icon: 'bag', tint: '#eef2f6', art: null },
};
const STORE_ART = '/images/store';
const categoryOf = (key) => CATEGORY[key] ?? CATEGORY.other;

const NUTRITION_ROWS = [
  ['serving_size', 'Serving size', ''],
  ['servings', 'Servings per pack', ''],
  ['calories', 'Energy', ' kcal'],
  ['protein_g', 'Protein', ' g'],
  ['carbs_g', 'Carbohydrates', ' g'],
  ['sugar_g', 'of which sugars', ' g'],
  ['fat_g', 'Fat', ' g'],
  ['bcaa_g', 'BCAAs', ' g'],
  ['creatine_g', 'Creatine', ' g'],
  ['caffeine_mg', 'Caffeine', ' mg'],
];

const MAX_QTY = 10;
/** [status, short label, icon, what it means — for the order page's timeline] */
const STEPS = {
  delivery: [
    ['placed', 'Placed', 'receipt', 'We have your order and payment'],
    ['packed', 'Packed', 'package', 'Your items are packed and sealed'],
    ['shipped', 'Shipped', 'truck', 'Handed to the courier'],
    ['delivered', 'Delivered', 'checkCircle', 'Delivered to your address'],
  ],
  pickup: [
    ['placed', 'Placed', 'receipt', 'We have your order and payment'],
    ['packed', 'Packed', 'package', 'Your items are packed and sealed'],
    ['shipped', 'To your gym', 'truck', 'On its way to your gym'],
    ['ready', 'At the desk', 'building', 'Waiting for you at the front desk'],
    ['delivered', 'Collected', 'checkCircle', 'Collected from the desk'],
  ],
};

/* ── Local state ──────────────────────────────────────────────────────── */

// Scoped by gym and member, like the session keys in api.js: two members
// sharing a phone must not inherit each other's cart, address or searches.
const scope = (memberId) => `${pathSlug ? `.${pathSlug}` : ''}.${memberId}`;

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: this just won't survive a reload.
  }
}

// The cart and wishlist follow the member to another phone; the delivery
// method, address and recent searches stay with this one.
const syncedCart = memberSynced('cart', 'store.cart');
const syncedWish = memberSynced('wishlist', 'store.wish');

/** Brings the cart and wishlist up to date with the member's other devices —
 * awaited alongside the store itself, so the shop opens already current. */
export const pullStoreState = () => Promise.all([syncedCart.pull(), syncedWish.pull()]);

const priceOf = (product, variant) => ({
  price: variant ? variant.effective_price : product.price,
  mrp: variant ? variant.effective_mrp : product.mrp,
});
const offPct = (price, mrp) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);
const soldOutOf = (product) => product.variants.length > 0 && !product.variants.some((v) => v.in_stock);

/** The variant a card advertises: the cheapest one in stock. */
function leadVariant(product) {
  if (!product.variants.length) return null;
  const pool = product.variants.filter((v) => v.in_stock);
  return (pool.length ? pool : product.variants).reduce((a, b) => (b.effective_price < a.effective_price ? b : a));
}

/** "1 kg", "1 kg · 2 kg", or "3 flavours" — the grey line under a card's name. */
function unitLabel(product) {
  if (!product.variants.length) return '1 unit';
  if (product.variants.length === 1) return product.variants[0].weight || product.variants[0].flavor || '1 unit';
  if (product.weights.length) return product.weights.join(' · ');
  return `${product.flavors.length} flavours`;
}

function createCart(products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const listeners = new Set();
  let lines = (syncedCart.read() ?? []).filter(
    (l) => l && byId.has(l.product_id) && Number.isInteger(l.quantity) && l.quantity > 0,
  );

  const same = (l, productId, variantId) => l.product_id === productId && (l.variant_id ?? null) === (variantId ?? null);
  const persist = () => {
    syncedCart.write(lines.length ? lines : null);
    for (const fn of listeners) fn();
  };

  function resolve(line) {
    const product = byId.get(line.product_id);
    const variant = line.variant_id ? product.variants.find((v) => v.id === line.variant_id) ?? null : null;
    // A variant the operator removed, or one now out of stock, stays visible
    // so the member sees why it can't be bought.
    const available = product.variants.length ? Boolean(variant?.in_stock) : true;
    const { price, mrp } = priceOf(product, variant);
    return { ...line, product, variant, price, mrp, available, total: price * line.quantity };
  }

  return {
    lines: () => lines.map(resolve),
    count: () => lines.reduce((sum, l) => sum + l.quantity, 0),
    qty: (productId, variantId) => lines.find((l) => same(l, productId, variantId))?.quantity ?? 0,
    qtyOfProduct: (productId) => lines.filter((l) => l.product_id === productId).reduce((s, l) => s + l.quantity, 0),
    linesOfProduct: (productId) => lines.filter((l) => l.product_id === productId),
    set(productId, variantId, quantity) {
      const line = lines.find((l) => same(l, productId, variantId));
      if (quantity <= 0) lines = lines.filter((l) => l !== line);
      else if (line) line.quantity = Math.min(MAX_QTY, quantity);
      else lines.push({ product_id: productId, variant_id: variantId ?? null, quantity: Math.min(MAX_QTY, quantity) });
      persist();
    },
    clear() {
      lines = [];
      persist();
    },
    onChange: (fn) => listeners.add(fn),
  };
}

/* ── Pages: full-screen layers with real back-button support ──────────── */

function createPager(anchor) {
  const stack = [];
  const sync = () => document.body.classList.toggle('bk-page-open', stack.length > 0);

  function drop(layer) {
    layer.classList.add('leaving');
    setTimeout(() => layer.remove(), 220);
  }

  function onPop() {
    // The store tab was replaced while pages sat in history: tidy up and let
    // the portal's own back handling have this one.
    if (!anchor.isConnected) {
      window.removeEventListener('popstate', onPop);
      stack.splice(0).forEach((l) => l.remove());
      sync();
      return;
    }
    const top = stack.pop();
    if (top) drop(top);
    sync();
  }
  window.addEventListener('popstate', onPop);

  return {
    push(node) {
      // Into the app frame, not the tab: the tab body animates with a
      // transform, which would trap a position:fixed layer inside it.
      const host = anchor.closest('.portal-app') ?? document.body;
      const layer = h('div', { class: 'bk-page' }, node);
      host.append(layer);
      stack.push(layer);
      history.pushState({ storePage: stack.length }, '', window.location.href);
      sync();
      return layer;
    },
    /** Swaps the top page's content in place — the cart becoming "order
     * placed" — without adding a history step. */
    replaceTop(node) {
      const top = stack[stack.length - 1];
      if (top) fill(top, node);
    },
    back: () => history.back(),
    closeAll() {
      if (stack.length) history.go(-stack.length);
    },
  };
}

/* ── Small pieces ─────────────────────────────────────────────────────── */

const stop = (fn) => (event) => {
  event.stopPropagation();
  fn(event);
};

/** The product shot, or the category's icon on a tinted tile when there is
 * none or it fails to load — a broken image is worse than a clean tile. */
function productArt(product, className, url = product.image_url) {
  const fallback = () =>
    h('span', { class: `${className} bk-art-none`, 'aria-hidden': 'true' }, renderIcon(categoryOf(product.category).icon, { size: 34, stroke: 1.7 }));
  if (!url) return fallback();
  const img = h('img', {
    class: className,
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    onerror: () => img.replaceWith(fallback()),
  });
  return img;
}

/** Re-paints `el` whenever the cart changes, for as long as it is on screen. */
function live(ctx, el, paint) {
  const watcher = { el, paint, seen: false };
  ctx.watchers.add(watcher);
  paint();
  return el;
}

function stepper(qty, { onMinus, onPlus, size = '' }) {
  return h(
    'div',
    { class: `bk-step ${size}`, role: 'group', 'aria-label': 'Quantity' },
    h('button', { type: 'button', 'aria-label': 'Remove one', onclick: stop(onMinus) }, renderIcon('minus', { size: 14, stroke: 3 })),
    h('span', { 'aria-live': 'polite' }, String(qty)),
    h('button', { type: 'button', 'aria-label': 'Add one', disabled: qty >= MAX_QTY, onclick: stop(onPlus) }, renderIcon('plus', { size: 14, stroke: 3 })),
  );
}

/** A card's Add button: one tap adds exactly the option the card shows
 * ("1 kg • Double Rich Chocolate"); other options live on the product page. */
function productAdd(product, ctx) {
  return variantAdd(product, leadVariant(product), ctx, { size: 'soft', icon: 'cart', label: 'Add', iconSize: 14 });
}

/** ADD for one specific option — the options sheet and the product page. */
function variantAdd(product, variant, ctx, { size = '', label = 'ADD', icon = null, iconSize = 17 } = {}) {
  const el = h('div', { class: 'bk-add-slot' });
  return live(ctx, el, () => {
    const inStock = variant ? Boolean(variant.in_stock) : true;
    if (!inStock) {
      fill(el, h('span', { class: `bk-add disabled ${size}` }, size === 'soft' ? 'Sold out' : 'Out of stock'));
      return;
    }
    const qty = ctx.cart.qty(product.id, variant?.id ?? null);
    fill(
      el,
      qty
        ? stepper(qty, {
            size,
            onMinus: () => ctx.cart.set(product.id, variant?.id ?? null, qty - 1),
            onPlus: () => ctx.cart.set(product.id, variant?.id ?? null, qty + 1),
          })
        : h(
            'button',
            { type: 'button', class: `bk-add ${size}`, onclick: stop(() => ctx.cart.set(product.id, variant?.id ?? null, 1)) },
            icon ? renderIcon(icon, { size: iconSize, stroke: 2.3 }) : null,
            label,
          ),
    );
  });
}

function offBadge(off) {
  return off ? h('span', { class: 'bk-off' }, h('b', {}, `${off}%`), 'OFF') : null;
}

/** The wishlist heart — kept on this phone, per member. */
function heartButton(product, ctx) {
  const btn = h('button', {
    type: 'button',
    class: `bk-heart${ctx.wish.has(product.id) ? ' on' : ''}`,
    'aria-label': 'Save to wishlist',
    'aria-pressed': String(ctx.wish.has(product.id)),
    dataset: { product: String(product.id) },
    onclick: stop(() => ctx.toggleWish(product.id)),
  }, renderIcon('heart', { size: 17, stroke: 2 }));
  return btn;
}

/* ── Badges: Bestseller and the quality marks a product has earned ────── */

/** Bestseller first when the operator ticked it, then each quality badge
 * (Trustified, Lab tested…) in the order the console lists them. */
function badgeItems(product) {
  return [
    ...(product.featured ? [{ kind: 'best', name: 'Bestseller' }] : []),
    ...(product.badges ?? []).map((b) => ({ kind: 'cert', name: b.name, image_url: b.image_url })),
  ];
}

function badgePill(item, { large = false } = {}) {
  const size = large ? 15 : 12;
  const icon =
    item.kind === 'best'
      ? renderIcon('flame', { size, stroke: 2.4 })
      : item.image_url
        ? h('img', { src: item.image_url, alt: '', loading: 'lazy', decoding: 'async' })
        : renderIcon('shield', { size, stroke: 2.4 });
  return h('span', { class: `bk-tag ${item.kind}${large ? ' lg' : ''}` }, h('i', {}, icon), h('span', {}, item.name));
}

// One clock turns every card's badges together, so a long catalogue doesn't
// run a timer per card. A rotator whose card left the screen drops out on the
// next tick; one that never made it on screen is given a few ticks first.
const BADGE_TURN_MS = 2600;
const rotators = new Set();
let badgeClock = null;

function turnBadges() {
  if (document.hidden) return;
  for (const r of rotators) {
    if (r.el.isConnected) {
      r.seen = true;
      r.turn();
    } else if (r.seen || ++r.misses > 3) rotators.delete(r);
  }
  if (!rotators.size) {
    clearInterval(badgeClock);
    badgeClock = null;
  }
}

/** A card's badge slot: the one badge it has, or each in turn, the leaving
 * one rolling up and out as the next rolls in from below. */
function badgeRotator(product) {
  const items = badgeItems(product);
  if (!items.length) return null;
  const el = h('div', { class: 'bk-tags', role: 'img', 'aria-label': items.map((i) => i.name).join(', ') }, badgePill(items[0]));
  if (items.length < 2) return el;
  let at = 0;
  rotators.add({
    el,
    seen: false,
    misses: 0,
    turn() {
      const leaving = el.lastElementChild;
      at = (at + 1) % items.length;
      const coming = badgePill(items[at]);
      el.append(coming);
      if (calm()) {
        leaving.remove();
        return;
      }
      const timing = { duration: 420, easing: 'cubic-bezier(0.3, 0.7, 0.2, 1)' };
      leaving.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-115%)', opacity: 0 }], timing).onfinish = () => leaving.remove();
      coming.animate([{ transform: 'translateY(115%)', opacity: 0 }, { transform: 'none', opacity: 1 }], timing);
    },
  });
  badgeClock ??= setInterval(turnBadges, BADGE_TURN_MS);
  return el;
}

/** "1 kg • Double Rich Chocolate" — the option a card is showing. */
function optionLine(product, variant) {
  if (!variant) return unitLabel(product);
  return [variant.weight, variant.flavor].filter(Boolean).join(' • ') || unitLabel(product);
}

function productCard(product, ctx, { rail = false } = {}) {
  const lead = leadVariant(product);
  const { price, mrp } = priceOf(product, lead);
  const soldOut = soldOutOf(product);
  const open = () => ctx.openProduct(product, lead);
  return h(
    'div',
    {
      class: `bk-card${rail ? ' rail' : ''}${soldOut ? ' sold-out' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': product.title,
      onclick: open,
      onkeydown: (e) => e.key === 'Enter' && open(),
    },
    h(
      'div',
      { class: 'bk-card-img' },
      productArt(product, 'bk-card-pic'),
      offBadge(offPct(price, mrp)),
      heartButton(product, ctx),
      soldOut ? h('span', { class: 'bk-card-oos' }, 'Out of stock') : null,
      h('span', { class: 'bk-eta' }, renderIcon('clock', { size: 11, stroke: 2.4 }), ctx.etaShort()),
    ),
    badgeRotator(product),
    h('div', { class: 'bk-card-name' }, product.title),
    h(
      'div',
      { class: 'bk-card-foot' },
      h('div', { class: 'bk-card-unit' }, optionLine(product, lead)),
      h('div', { class: 'bk-price inline' }, h('strong', {}, money(price)), mrp > price ? h('s', {}, money(mrp)) : null),
      productAdd(product, ctx),
    ),
  );
}

function rail(title, products, ctx, { onSeeAll } = {}) {
  if (!products.length) return null;
  return h(
    'section',
    { class: 'bk-section' },
    h(
      'div',
      { class: 'bk-section-head' },
      h('h3', {}, title),
      onSeeAll ? h('button', { type: 'button', class: 'bk-see-all', onclick: onSeeAll }, 'see all') : null,
    ),
    h('div', { class: 'bk-rail' }, ...products.map((p) => productCard(p, ctx, { rail: true }))),
  );
}

const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/** The floating "View cart" pill that keeps the cart one tap away, moving the
 * way Blinkit's does: it springs up with the first item, each new product's
 * photo pops into the stack, the pill grows to fit, the count rolls, and it
 * drops away when the cart empties. */
function cartBar(ctx, { onPage = false } = {}) {
  const thumbs = h('span', { class: 'bk-cartbar-thumbs', 'aria-hidden': 'true' });
  const count = h('small', { class: 'bk-cartbar-count' });
  const bar = h(
    'button',
    { type: 'button', class: `bk-cartbar${onPage ? ' on-page' : ''}`, hidden: true, onclick: () => ctx.openCart() },
    thumbs,
    h('span', { class: 'bk-cartbar-text' }, h('strong', {}, 'View cart'), count),
    h('span', { class: 'bk-cartbar-go', 'aria-hidden': 'true' }, renderIcon('chevronRight', { size: 18, stroke: 2.8 })),
  );
  let shownN = 0;
  let shownIds = [];
  let leaving = null;
  let sizing = null;

  return live(ctx, bar, () => {
    const n = ctx.cart.count();
    const motion = !calm();

    if (!n) {
      shownN = 0;
      shownIds = [];
      if (bar.hidden || leaving) return;
      if (!motion || !bar.isConnected) {
        bar.hidden = true;
        return;
      }
      leaving = bar.animate(
        [{ transform: 'none', opacity: 1 }, { transform: 'translateY(150%) scale(0.9)', opacity: 0 }],
        { duration: 240, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
      );
      leaving.onfinish = () => {
        leaving = null;
        if (!ctx.cart.count()) bar.hidden = true;
        bar.getAnimations().forEach((a) => a.cancel());
      };
      return;
    }

    const entering = bar.hidden || Boolean(leaving);
    if (leaving) {
      leaving.onfinish = null;
      leaving.cancel();
      leaving = null;
    }
    // Layout width, so a bump's scale doesn't skew it; mid-resize it is the
    // width on screen right now, which is where the next resize starts.
    const before = !entering && bar.isConnected ? bar.offsetWidth : 0;

    // The three most recently added products, newest in front.
    const lines = ctx.cart.lines();
    const ids = [...new Set(lines.map((l) => l.product_id).reverse())].slice(0, 3).reverse();
    if (ids.join() !== shownIds.join()) {
      const byId = new Map(lines.map((l) => [l.product_id, l.product]));
      fill(
        thumbs,
        ...ids.map((id) => {
          const chip = h('span', {}, productArt(byId.get(id), 'bk-thumb'));
          if (motion && !entering && !shownIds.includes(id)) {
            chip.animate(
              [
                { transform: 'translateX(14px) scale(0.3) rotate(-18deg)', opacity: 0 },
                { transform: 'none', opacity: 1 },
              ],
              { duration: 420, easing: SPRING },
            );
          }
          return chip;
        }),
      );
    }

    if (n !== shownN) {
      const text = h('span', {}, `${n} item${n === 1 ? '' : 's'}`);
      fill(count, text);
      if (motion && !entering && shownN) {
        const from = n > shownN ? '100%' : '-100%';
        text.animate([{ transform: `translateY(${from})`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'ease-out' });
      }
    }
    bar.setAttribute('aria-label', `View cart, ${n} item${n === 1 ? '' : 's'}`);
    bar.hidden = false;

    if (motion && entering) {
      bar.animate(
        [
          { transform: 'translateY(150%) scale(0.85)', opacity: 0 },
          { transform: 'translateY(-8%) scale(1.02)', opacity: 1, offset: 0.65 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 460, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    } else if (motion && before) {
      sizing?.cancel();
      const after = bar.offsetWidth;
      if (Math.abs(after - before) > 1) {
        sizing = bar.animate([{ width: `${before}px` }, { width: `${after}px` }], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
      if (n > shownN) {
        bar.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
      }
    }
    shownN = n;
    shownIds = ids;
  });
}

function pageHead(ctx, title, { sub, search = true, cart = true } = {}) {
  const badge = h('span', { class: 'bk-badge' });
  live(ctx, badge, () => {
    const n = ctx.cart.count();
    badge.textContent = String(n);
    badge.hidden = !n;
  });
  return h(
    'header',
    { class: 'bk-page-head' },
    h('button', { type: 'button', class: 'bk-icon-btn', 'aria-label': 'Back', onclick: ctx.pages.back }, renderIcon('arrowLeft', { size: 20, stroke: 2.2 })),
    h('div', { class: 'bk-page-title' }, h('h2', {}, title), sub ? h('p', {}, sub) : null),
    search
      ? h('button', { type: 'button', class: 'bk-icon-btn', 'aria-label': 'Search', onclick: () => ctx.openSearch() }, renderIcon('search', { size: 20, stroke: 2.2 }))
      : null,
    cart
      ? h('button', { type: 'button', class: 'bk-icon-btn', 'aria-label': 'Cart', onclick: () => ctx.openCart() }, renderIcon('cart', { size: 20, stroke: 2.2 }), badge)
      : null,
  );
}

/* ── Delivery or pickup, and where ────────────────────────────────────── */

const SHIP_FIELDS = [
  ['name', 'Full name', 'text', 'name'],
  ['phone', 'Phone number', 'tel', 'tel'],
  ['address', 'House / flat, street, area', 'text', 'street-address'],
  ['city', 'City', 'text', 'address-level2'],
  ['state', 'State', 'text', 'address-level1'],
  ['pincode', 'PIN code', 'text', 'postal-code'],
];

function shippingProblem(ship, method) {
  if (!ship.name || ship.name.trim().length < 2) return 'Add your name';
  const digits = String(ship.phone || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 12) return 'Add a 10-digit phone number';
  if (method === 'pickup') return null;
  if (!ship.address || ship.address.trim().length < 6) return 'Add the full delivery address';
  if (!ship.city || ship.city.trim().length < 2) return 'Add the city';
  if (!/^\d{6}$/.test(String(ship.pincode || '').trim())) return 'Add a 6-digit PIN code';
  return null;
}

function openAddressSheet(ctx, { onSaved } = {}) {
  const draft = { ...ctx.ship };
  const method = ctx.method;
  const fields = method === 'pickup' ? SHIP_FIELDS.slice(0, 2) : SHIP_FIELDS;
  const error = h('p', { class: 'bk-form-error', hidden: true });
  const body = h(
    'form',
    {
      class: 'bk-form',
      onsubmit: (event) => {
        event.preventDefault();
        const problem = shippingProblem(draft, method);
        if (problem) {
          error.textContent = problem;
          error.hidden = false;
          return;
        }
        ctx.saveShip(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, String(v ?? '').trim()])));
        closeModal();
        onSaved?.();
      },
    },
    method === 'pickup'
      ? h('p', { class: 'bk-form-note' }, renderIcon('building', { size: 16 }), `Collect from the front desk at ${ctx.store.delivery.gym_name}. We'll notify you when it arrives.`)
      : null,
    h(
      'div',
      { class: 'bk-form-grid' },
      ...fields.map(([key, label, type, autocomplete]) =>
        h(
          'label',
          { class: `bk-field${key === 'address' || key === 'name' ? ' wide' : ''}` },
          h('span', {}, label, key === 'state' ? h('em', {}, ' (optional)') : null),
          h('input', {
            type,
            value: draft[key] ?? '',
            autocomplete,
            inputmode: key === 'pincode' || key === 'phone' ? 'numeric' : null,
            maxlength: key === 'pincode' ? 6 : key === 'address' ? 300 : 80,
            oninput: (e) => {
              draft[key] = e.target.value;
            },
          }),
        ),
      ),
    ),
    error,
    h('button', { type: 'submit', class: 'bk-btn-green block' }, method === 'pickup' ? 'Save contact' : 'Save address'),
  );
  openModal({ title: method === 'pickup' ? 'Who is collecting?' : 'Delivery address', className: 'bk-sheet', body });
}

function openMethodSheet(ctx) {
  const d = ctx.store.delivery;
  const option = (method, icon, title, sub) =>
    h(
      'button',
      {
        type: 'button',
        class: `bk-method${ctx.method === method ? ' selected' : ''}`,
        onclick: () => {
          ctx.setMethod(method);
          closeModal();
          if (shippingProblem(ctx.ship, method)) openAddressSheet(ctx);
        },
      },
      h('span', { class: 'bk-method-icon' }, renderIcon(icon, { size: 22, stroke: 2 })),
      h('span', { class: 'bk-method-text' }, h('strong', {}, title), h('small', {}, sub)),
      h('span', { class: 'bk-radio', 'aria-hidden': 'true' }),
    );
  openModal({
    title: 'How do you want it?',
    className: 'bk-sheet',
    body: h(
      'div',
      { class: 'bk-methods' },
      option('delivery', 'truck', 'Deliver to my address', d.eta),
      d.pickup_enabled ? option('pickup', 'building', `Pick up at ${d.gym_name}`, d.pickup_eta) : null,
      ctx.method === 'delivery'
        ? h('button', { type: 'button', class: 'bk-link-btn', onclick: () => { closeModal(); openAddressSheet(ctx); } }, renderIcon('edit', { size: 15 }), 'Edit delivery address')
        : null,
    ),
  });
}

/* ── Pages ────────────────────────────────────────────────────────────── */

function searchMatches(products, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return products.filter((p) => {
    const hay = [p.title, p.brand, categoryOf(p.category).label, ...p.flavors, ...p.weights].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function openSearchPage(ctx, initial = '') {
  const recentKey = `gymbook.store.recent${scope(ctx.memberId)}`;
  let q = initial;
  const results = h('div', { class: 'bk-search-body' });
  const input = h('input', {
    type: 'search',
    class: 'bk-search-input',
    placeholder: 'Search protein, creatine, brands…',
    value: q,
    enterkeyhint: 'search',
    'aria-label': 'Search the store',
    oninput: (e) => {
      q = e.target.value;
      paint();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        remember(q);
        input.blur();
      }
    },
  });
  const clearBtn = h('button', { type: 'button', class: 'bk-icon-btn sm', 'aria-label': 'Clear', onclick: () => { q = ''; input.value = ''; paint(); input.focus(); } }, renderIcon('close', { size: 16 }));

  function remember(term) {
    const t = term.trim();
    if (t.length < 2) return;
    const list = [t, ...loadJson(recentKey, []).filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8);
    saveJson(recentKey, list);
  }

  const chip = (icon, text, onclick) => h('button', { type: 'button', class: 'bk-chip', onclick }, icon ? renderIcon(icon, { size: 14 }) : null, text);

  function paint() {
    clearBtn.hidden = !q;
    if (!q.trim()) {
      const recent = loadJson(recentKey, []);
      const brands = [...new Set(ctx.products.map((p) => p.brand))].slice(0, 10);
      fill(
        results,
        recent.length
          ? h(
              'section',
              { class: 'bk-section' },
              h('div', { class: 'bk-section-head' }, h('h3', {}, 'Recent searches'), h('button', { type: 'button', class: 'bk-see-all', onclick: () => { saveJson(recentKey, null); paint(); } }, 'clear')),
              h('div', { class: 'bk-chips' }, ...recent.map((t) => chip('history', t, () => { q = t; input.value = t; paint(); }))),
            )
          : null,
        brands.length
          ? h(
              'section',
              { class: 'bk-section' },
              h('div', { class: 'bk-section-head' }, h('h3', {}, 'Popular brands')),
              h('div', { class: 'bk-chips' }, ...brands.map((b) => chip(null, b, () => { q = b; input.value = b; remember(b); paint(); }))),
            )
          : null,
        rail('Bestsellers', ctx.bestsellers(), ctx),
      );
      return;
    }
    const found = searchMatches(ctx.products, q);
    fill(
      results,
      found.length
        ? [
            h('p', { class: 'bk-result-count' }, `Showing ${found.length} result${found.length === 1 ? '' : 's'} for “${q.trim()}”`),
            h('div', { class: 'bk-grid' }, ...found.map((p) => productCard(p, ctx))),
          ]
        : h(
            'div',
            { class: 'bk-empty' },
            h('span', { class: 'bk-empty-icon' }, renderIcon('search', { size: 34, stroke: 1.6 })),
            h('strong', {}, `Nothing found for “${q.trim()}”`),
            h('p', {}, 'Try a product type like “whey” or a brand name.'),
          ),
    );
  }

  ctx.pages.push(
    h(
      'div',
      { class: 'bk-page-inner' },
      h(
        'header',
        { class: 'bk-page-head bk-search-head' },
        h('button', { type: 'button', class: 'bk-icon-btn', 'aria-label': 'Back', onclick: ctx.pages.back }, renderIcon('arrowLeft', { size: 20, stroke: 2.2 })),
        h('label', { class: 'bk-search-field' }, renderIcon('search', { size: 18, stroke: 2.2 }), input, clearBtn),
      ),
      results,
      cartBar(ctx, { onPage: true }),
    ),
  );
  paint();
  if (q) remember(q);
  setTimeout(() => input.focus(), 60);
}

/** A category's tile picture: its first product with a photo, or its icon. */
function categoryArt(ctx, key, className) {
  const withPhoto = ctx.products.find((p) => p.category === key && p.image_url);
  const fallback = () =>
    withPhoto
      ? productArt(withPhoto, className)
      : h('span', { class: `${className} bk-art-none` }, renderIcon(categoryOf(key).icon, { size: 26, stroke: 1.8 }));
  const art = categoryOf(key).art;
  if (!art) return fallback();
  const img = h('img', { class: className, src: `${STORE_ART}/${art}.webp`, alt: '', decoding: 'async', onerror: () => img.replaceWith(fallback()) });
  return img;
}

const SORTS = { relevance: 'Relevance', low: 'Price: low to high', high: 'Price: high to low', off: 'Biggest discount' };

function sortProducts(list, sort) {
  const lead = (p) => priceOf(p, leadVariant(p));
  if (sort === 'low') return [...list].sort((a, b) => lead(a).price - lead(b).price);
  if (sort === 'high') return [...list].sort((a, b) => lead(b).price - lead(a).price);
  if (sort === 'off') return [...list].sort((a, b) => offPct(lead(b).price, lead(b).mrp) - offPct(lead(a).price, lead(a).mrp));
  return list;
}

function openSortSheet(current, onPick) {
  openModal({
    title: 'Sort by',
    className: 'bk-sheet',
    body: h(
      'div',
      { class: 'bk-methods' },
      ...Object.entries(SORTS).map(([value, label]) =>
        h(
          'button',
          { type: 'button', class: `bk-method compact${current === value ? ' selected' : ''}`, onclick: () => { closeModal(); onPick(value); } },
          h('span', { class: 'bk-method-text' }, h('strong', {}, label)),
          h('span', { class: 'bk-radio', 'aria-hidden': 'true' }),
        ),
      ),
    ),
  });
}

function openCategoryPage(ctx, key) {
  let active = key;
  let sort = 'relevance';
  let brand = '';
  const present = Object.keys(CATEGORY).filter((k) => ctx.products.some((p) => p.category === k));
  const side = h('nav', { class: 'bk-cat-side', 'aria-label': 'Categories' });
  const main = h('div', { class: 'bk-cat-main' });
  const head = pageHead(ctx, categoryOf(active).label, {});
  const title = head.querySelector('.bk-page-title h2');

  function paintSide() {
    fill(
      side,
      ...present.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: `bk-cat-side-item${k === active ? ' active' : ''}`,
            'aria-current': k === active ? 'true' : null,
            onclick: () => {
              active = k;
              brand = '';
              paintSide();
              paintMain();
            },
          },
          h('span', { class: 'bk-cat-side-art', style: `background:${categoryOf(k).tint}` }, categoryArt(ctx, k, 'bk-cat-side-img')),
          h('span', {}, categoryOf(k).label),
        ),
      ),
    );
  }

  const openSort = () => openSortSheet(sort, (value) => {
    sort = value;
    paintMain();
  });

  function paintMain() {
    title.textContent = categoryOf(active).label;
    let list = ctx.products.filter((p) => p.category === active);
    const brands = [...new Set(list.map((p) => p.brand))];
    if (brand) list = list.filter((p) => p.brand === brand);
    list = sortProducts(list, sort);
    fill(
      main,
      h(
        'div',
        { class: 'bk-filters' },
        h(
          'button',
          { type: 'button', class: `bk-chip${sort !== 'relevance' ? ' on' : ''}`, onclick: openSort },
          renderIcon('sort', { size: 14 }),
          sort === 'relevance' ? 'Sort' : SORTS[sort],
          renderIcon('chevronDown', { size: 14 }),
        ),
        ...(brands.length > 1
          ? brands.map((b) => h('button', { type: 'button', class: `bk-chip${brand === b ? ' on' : ''}`, onclick: () => { brand = brand === b ? '' : b; paintMain(); } }, b))
          : []),
      ),
      list.length ? h('div', { class: 'bk-grid' }, ...list.map((p) => productCard(p, ctx))) : h('div', { class: 'bk-empty' }, h('p', {}, 'Nothing here yet.')),
    );
  }

  paintSide();
  paintMain();
  ctx.pages.push(h('div', { class: 'bk-page-inner' }, head, h('div', { class: 'bk-cat-layout' }, side, main), cartBar(ctx, { onPage: true })));
}

function openProductPage(ctx, product, initialVariant) {
  const variants = product.variants;
  let variant = initialVariant ?? leadVariant(product);
  let flavor = variant?.flavor ?? null;
  const match = (f, w) => variants.find((v) => (v.flavor ?? null) === f && (v.weight ?? null) === w) ?? null;

  /* Gallery: swipe between photos; dots follow. */
  const pics = product.images?.length ? product.images : [{ url: product.image_url }];
  const track = h('div', { class: 'bk-gallery-track' }, ...pics.map((img) => h('div', { class: 'bk-gallery-slide' }, productArt(product, 'bk-gallery-img', img.url))));
  const dots = h('div', { class: 'bk-dots' }, ...pics.map((_, i) => h('span', { class: i === 0 ? 'on' : '' })));
  track.addEventListener(
    'scroll',
    () => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      [...dots.children].forEach((d, j) => d.classList.toggle('on', i === j));
    },
    { passive: true },
  );

  const priceRow = h('div', { class: 'bk-pd-price' });
  const unitBlock = h('div', { class: 'bk-pd-units' });
  const buyBar = h('div', { class: 'bk-pd-buy' });

  function paint() {
    const { price, mrp } = priceOf(product, variant);
    fill(
      priceRow,
      h('strong', {}, money(price)),
      mrp > price ? h('span', { class: 'bk-pd-mrp' }, 'MRP ', h('s', {}, money(mrp))) : null,
      offPct(price, mrp) ? h('span', { class: 'bk-off inline' }, `${offPct(price, mrp)}% OFF`) : null,
      h('small', {}, '(Inclusive of all taxes)'),
    );

    const flavourChips =
      product.flavors.length > 1
        ? h(
            'div',
            { class: 'bk-pd-opt' },
            h('h4', {}, 'Flavour'),
            h(
              'div',
              { class: 'bk-chips' },
              ...product.flavors.map((f) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: `bk-chip${f === flavor ? ' on' : ''}${variants.some((v) => v.flavor === f && v.in_stock) ? '' : ' muted'}`,
                    onclick: () => {
                      flavor = f;
                      variant =
                        match(f, variant?.weight ?? null) ?? variants.find((v) => v.flavor === f && v.in_stock) ?? variants.find((v) => v.flavor === f);
                      paint();
                    },
                  },
                  f,
                ),
              ),
            ),
          )
        : null;

    // Unit cards: every size available in the chosen flavour, priced.
    const byFlavour = product.flavors.length > 1;
    const unitVariants = variants.filter((v) => (byFlavour ? (v.flavor ?? null) === flavor : true));
    const units =
      unitVariants.length > 1
        ? h(
            'div',
            { class: 'bk-pd-opt' },
            h('h4', {}, byFlavour ? 'Select unit' : 'Select option'),
            h(
              'div',
              { class: 'bk-unit-row' },
              ...unitVariants.map((v) => {
                const p = priceOf(product, v);
                return h(
                  'button',
                  {
                    type: 'button',
                    class: `bk-unit${v === variant ? ' selected' : ''}${v.in_stock ? '' : ' oos'}`,
                    onclick: () => {
                      variant = v;
                      flavor = v.flavor ?? flavor;
                      paint();
                    },
                  },
                  offPct(p.price, p.mrp) ? h('span', { class: 'bk-unit-off' }, `${offPct(p.price, p.mrp)}% OFF`) : null,
                  h('span', { class: 'bk-unit-label' }, byFlavour ? v.weight || v.label : v.label),
                  h('strong', {}, money(p.price)),
                  p.mrp > p.price ? h('s', {}, money(p.mrp)) : null,
                  v.in_stock ? null : h('small', {}, 'Out of stock'),
                );
              }),
            ),
          )
        : null;
    fill(unitBlock, flavourChips, units);

    fill(
      buyBar,
      h(
        'div',
        { class: 'bk-pd-buy-info' },
        h('small', {}, variant?.label || unitLabel(product)),
        h('span', {}, h('strong', {}, money(price)), mrp > price ? h('s', {}, money(mrp)) : null),
      ),
      variantAdd(product, variant, ctx, { size: 'lg', label: 'Add to cart' }),
    );
  }
  paint();

  const d = ctx.store.delivery;
  const nutrition = product.nutrition_facts ?? {};
  const facts = NUTRITION_ROWS.filter(([k]) => nutrition[k] !== undefined && nutrition[k] !== null);
  const similar = ctx.products.filter((p) => p.category === product.category && p.id !== product.id).slice(0, 10);
  const why = (icon, title, sub) =>
    h('div', { class: 'bk-why-row' }, h('span', { class: 'bk-why-icon' }, renderIcon(icon, { size: 20, stroke: 2 })), h('div', {}, h('strong', {}, title), h('small', {}, sub)));

  ctx.pages.push(
    h(
      'div',
      { class: 'bk-page-inner bk-pd' },
      pageHead(ctx, product.brand, {}),
      h('div', { class: 'bk-gallery' }, track, pics.length > 1 ? dots : null),
      h(
        'section',
        { class: 'bk-pd-info' },
        h('span', { class: 'bk-eta' }, renderIcon('clock', { size: 11, stroke: 2.6 }), ctx.etaShort()),
        h('h1', {}, product.title),
        badgeItems(product).length
          ? h('div', { class: 'bk-pd-tags' }, ...badgeItems(product).map((item) => badgePill(item, { large: true })))
          : null,
        h('button', { type: 'button', class: 'bk-pd-brand', onclick: () => ctx.openSearch(product.brand) }, `View all by ${product.brand}`, renderIcon('chevronRight', { size: 14, stroke: 2.6 })),
        priceRow,
        unitBlock,
      ),
      h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, 'Why shop from us?'),
        why('shield', '100% authentic', 'Sourced from brands and their authorised distributors'),
        product.lab_report_url ? why('verified', 'Lab tested', 'Independent purity and label-claim report below') : null,
        d.pickup_enabled
          ? why('building', 'Delivery or gym pickup', `${d.eta} · or collect at ${d.gym_name}`)
          : why('truck', 'Doorstep delivery', d.eta),
      ),
      h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, 'Product details'),
        h(
          'dl',
          { class: 'bk-details' },
          h('dt', {}, 'Brand'),
          h('dd', {}, product.brand),
          h('dt', {}, 'Category'),
          h('dd', {}, categoryOf(product.category).label),
          product.flavors.length ? [h('dt', {}, 'Flavours'), h('dd', {}, product.flavors.join(', '))] : null,
          product.weights.length ? [h('dt', {}, 'Sizes'), h('dd', {}, product.weights.join(', '))] : null,
        ),
        product.description ? h('p', { class: 'bk-desc' }, product.description) : null,
        facts.length
          ? h(
              'div',
              { class: 'bk-facts' },
              h('h4', {}, 'Nutrition facts', h('span', {}, ' · per serving')),
              h('dl', {}, ...facts.flatMap(([k, label, unit]) => [h('dt', {}, label), h('dd', {}, `${nutrition[k]}${unit}`)])),
            )
          : null,
        product.lab_report_url
          ? h(
              'a',
              { class: 'bk-lab', href: product.lab_report_url, target: '_blank', rel: 'noopener noreferrer' },
              renderIcon('fileText', { size: 20, stroke: 2 }),
              h('span', {}, h('strong', {}, 'View lab test report'), h('small', {}, 'Independent purity & label-claim test')),
              renderIcon('chevronRight', { size: 16, stroke: 2.4 }),
            )
          : null,
      ),
      rail('Similar products', similar, ctx),
      cartBar(ctx, { onPage: true }),
      buyBar,
    ),
  );
}

function orderTracker(order) {
  if (order.fulfillment_status === 'cancelled' || order.payment_status === 'refunded') {
    return h(
      'div',
      { class: 'bk-order-cancelled' },
      renderIcon('xCircle', { size: 16, stroke: 2.2 }),
      order.payment_status === 'refunded' ? 'Cancelled and refunded' : 'Cancelled — any refund goes back to your UPI account',
    );
  }
  const steps = STEPS[order.fulfillment_method] ?? STEPS.delivery;
  const reached = steps.findIndex(([key]) => key === order.fulfillment_status);
  return h(
    'ol',
    { class: 'bk-steps', style: `--n:${steps.length}`, 'aria-label': 'Order progress' },
    ...steps.map(([, label, icon], i) =>
      h(
        'li',
        { class: i <= reached ? 'done' : '', 'aria-current': i === reached ? 'step' : null },
        h('span', { class: 'bk-step-dot' }, renderIcon(icon, { size: 14, stroke: 2.4 })),
        h('span', {}, label),
      ),
    ),
  );
}

/* ── Orders: the list, one order's page, and the peek on Profile ──────── */

/** "11 Oct, 4:42 pm". The registry stamps times with SQLite's
 * datetime('now') — UTC with no zone marker — so one is added before parsing. */
function when(value, { time = true } = {}) {
  if (!value) return '';
  const raw = String(value).replace(' ', 'T');
  const parsed = new Date(/Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString(undefined, { day: 'numeric', month: 'short', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) });
}

export const orderClosed = (order) => order.payment_status === 'refunded' || ['delivered', 'cancelled'].includes(order.fulfillment_status);

/** Where an order stands, in the member's words, with the colour it wears. */
function orderStatus(order, gymName) {
  const pickup = order.fulfillment_method === 'pickup';
  if (order.payment_status === 'refunded') {
    return { tone: 'red', icon: 'xCircle', title: 'Cancelled & refunded', sub: 'The money is back in your UPI account' };
  }
  switch (order.fulfillment_status) {
    case 'cancelled':
      return { tone: 'red', icon: 'xCircle', title: 'Order cancelled', sub: 'Any refund goes back to your UPI account' };
    case 'packed':
      return { tone: 'blue', icon: 'package', title: 'Packed', sub: pickup ? `Heading to ${gymName} next` : 'Ready to hand to the courier' };
    case 'shipped':
      return {
        tone: 'amber',
        icon: 'truck',
        title: pickup ? `On its way to ${gymName}` : 'On the way',
        sub: order.courier_name ? `With ${order.courier_name}` : pickup ? 'We will tell you when it reaches the desk' : 'Your order has shipped',
      };
    case 'ready':
      return { tone: 'green', icon: 'building', title: 'Ready for pickup', sub: `Collect it at the ${gymName} front desk` };
    case 'delivered':
      return { tone: 'green', icon: 'checkCircle', title: pickup ? 'Collected' : 'Delivered', sub: when(order.updated_at, { time: false }) };
    default:
      return { tone: 'blue', icon: 'receipt', title: 'Order placed', sub: 'We are getting it packed' };
  }
}

function orderThumbs(order, max = 4) {
  const shown = order.items.slice(0, max);
  const more = order.items.length - shown.length;
  return h(
    'div',
    { class: 'bk-order-thumbs', 'aria-hidden': 'true' },
    ...shown.map((item) =>
      h('span', { class: 'bk-opt-thumb' }, item.image_url ? h('img', { class: 'bk-thumb', src: item.image_url, alt: '', loading: 'lazy' }) : renderIcon('bag', { size: 18 })),
    ),
    more > 0 ? h('span', { class: 'bk-opt-thumb bk-more' }, `+${more}`) : null,
  );
}

function trackLink(order, { block = false } = {}) {
  if (!order.tracking_url) return null;
  return h(
    'a',
    { class: `bk-track-btn${block ? ' block' : ''}`, href: order.tracking_url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() },
    renderIcon('truck', { size: 15, stroke: 2.2 }),
    'Track shipment',
  );
}

/** One order in the list, and the live card on Profile: where it stands,
 * what's in it, and a way into the full page. */
export function orderCard(order, { gymName, onOpen, compact = false }) {
  const status = orderStatus(order, gymName);
  const count = order.items.reduce((n, i) => n + i.quantity, 0);
  return h(
    'article',
    {
      class: `bk-order${compact ? ' compact' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${status.title}, order ${order.order_code}`,
      onclick: () => onOpen(order),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(order)),
    },
    h(
      'header',
      {},
      h('span', { class: `bk-order-icon tone-${status.tone}` }, renderIcon(status.icon, { size: 18, stroke: 2.2 })),
      h('div', {}, h('strong', {}, status.title), h('span', {}, status.sub)),
      renderIcon('chevronRight', { size: 18, stroke: 2.4 }),
    ),
    orderClosed(order) ? null : orderTracker(order),
    h(
      'footer',
      {},
      orderThumbs(order, compact ? 3 : 4),
      h(
        'div',
        { class: 'bk-order-meta' },
        h('strong', {}, money(order.total_amount)),
        h('span', {}, `${count} item${count === 1 ? '' : 's'} · ${when(order.paid_at || order.created_at, { time: false })}`),
      ),
    ),
    order.fulfillment_status === 'shipped' ? trackLink(order) : null,
  );
}

/** The steps top to bottom, Blinkit-style: done in green with the time we
 * know, the current one pulsing, the rest still to come. */
function orderTimeline(order) {
  const steps = STEPS[order.fulfillment_method] ?? STEPS.delivery;
  const reached = steps.findIndex(([key]) => key === order.fulfillment_status);
  return h(
    'ol',
    { class: 'bk-timeline', 'aria-label': 'Order progress' },
    ...steps.map(([key, label, icon, about], i) => {
      const stamp = i === 0 ? when(order.paid_at || order.created_at) : i === reached ? when(order.updated_at) : '';
      return h(
        'li',
        { class: i < reached ? 'done' : i === reached ? 'done now' : '', 'aria-current': i === reached ? 'step' : null },
        h('span', { class: 'bk-tl-dot' }, renderIcon(icon, { size: 14, stroke: 2.4 })),
        h(
          'div',
          {},
          h('strong', {}, key === 'delivered' && i === reached && order.fulfillment_method !== 'pickup' ? 'Delivered' : label),
          h('small', {}, about),
          stamp ? h('time', {}, stamp) : null,
        ),
      );
    }),
  );
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast(text);
  }
}

function openOrderPage(ctx, order) {
  const gymName = ctx.store.delivery.gym_name;
  const pickup = order.fulfillment_method === 'pickup';
  const status = orderStatus(order, gymName);
  const count = order.items.reduce((n, i) => n + i.quantity, 0);
  const saved = Math.max(0, order.mrp_total - order.total_amount);
  const address = [order.shipping_address, order.shipping_city, order.shipping_state, order.shipping_pincode].filter(Boolean).join(', ');
  const closed = orderClosed(order);

  const courier = order.tracking_id || order.tracking_url || order.courier_name
    ? h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, 'Shipment'),
        h(
          'div',
          { class: 'bk-od-row' },
          h('span', { class: 'bk-od-ico' }, renderIcon('truck', { size: 18 })),
          h('div', {}, h('strong', {}, order.courier_name || 'Courier'), order.tracking_id ? h('small', {}, `Tracking ID ${order.tracking_id}`) : null),
          order.tracking_id
            ? h('button', { type: 'button', class: 'bk-od-copy', 'aria-label': 'Copy tracking ID', onclick: () => copy(order.tracking_id, 'Tracking ID') }, renderIcon('copy', { size: 16 }))
            : null,
        ),
        trackLink(order, { block: true }),
      )
    : null;

  ctx.pages.push(
    h(
      'div',
      { class: 'bk-page-inner bk-od' },
      pageHead(ctx, 'Order details', { sub: order.order_code, search: false, cart: false }),
      h(
        'section',
        { class: `bk-od-hero tone-${status.tone}` },
        h('span', { class: 'bk-od-hero-icon' }, renderIcon(status.icon, { size: 26, stroke: 2.2 })),
        h('div', {}, h('h1', {}, status.title), h('p', {}, status.sub)),
      ),
      closed && order.fulfillment_status !== 'delivered' ? null : h('section', { class: 'bk-card-block' }, orderTimeline(order)),
      courier,
      h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, pickup ? 'Pickup at' : 'Delivering to'),
        h(
          'div',
          { class: 'bk-od-row' },
          h('span', { class: 'bk-od-ico' }, renderIcon(pickup ? 'building' : 'mapPin', { size: 18 })),
          h(
            'div',
            {},
            h('strong', {}, pickup ? `${gymName} front desk` : order.shipping_name),
            h('small', {}, pickup ? `For ${order.shipping_name} · ${order.shipping_phone}` : address),
            pickup ? null : h('small', {}, order.shipping_phone),
          ),
        ),
      ),
      h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, `${count} item${count === 1 ? '' : 's'} in this order`),
        ...order.items.map((item) =>
          h(
            'div',
            { class: 'bk-od-item' },
            h('span', { class: 'bk-opt-thumb' }, item.image_url ? h('img', { class: 'bk-thumb', src: item.image_url, alt: '', loading: 'lazy' }) : renderIcon('bag', { size: 18 })),
            h('div', {}, h('strong', {}, item.title), h('small', {}, [item.variant_label, `${item.quantity} × ${money(item.unit_price)}`].filter(Boolean).join(' · '))),
            h('span', { class: 'bk-od-price' }, item.unit_mrp > item.unit_price ? h('s', {}, money(item.unit_mrp * item.quantity)) : null, money(item.line_total)),
          ),
        ),
      ),
      h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, 'Bill summary'),
        h(
          'dl',
          { class: 'bk-bill' },
          h('dt', {}, 'Item total'),
          h('dd', {}, saved ? h('s', {}, money(order.mrp_total)) : null, money(order.subtotal)),
          h('dt', {}, pickup ? 'Gym pickup' : 'Delivery'),
          h('dd', { class: 'free' }, 'FREE'),
          h('dt', { class: 'grand' }, order.payment_status === 'refunded' ? 'Refunded' : 'Paid'),
          h('dd', { class: 'grand' }, money(order.total_amount)),
        ),
        saved ? h('p', { class: 'bk-saved' }, renderIcon('sparkle', { size: 15 }), `You saved ${money(saved)} on this order`) : null,
      ),
      h(
        'section',
        { class: 'bk-card-block bk-od-facts' },
        h('h3', {}, 'Order info'),
        h(
          'dl',
          {},
          h('dt', {}, 'Order ID'),
          h('dd', {}, order.order_code, h('button', { type: 'button', class: 'bk-od-copy', 'aria-label': 'Copy order ID', onclick: () => copy(order.order_code, 'Order ID') }, renderIcon('copy', { size: 14 }))),
          h('dt', {}, 'Placed on'),
          h('dd', {}, when(order.paid_at || order.created_at)),
          h('dt', {}, 'Payment'),
          h('dd', {}, order.payment_status === 'refunded' ? 'Refunded to UPI' : 'Paid online · UPI'),
          order.razorpay_payment_id ? [h('dt', {}, 'Payment ref'), h('dd', {}, order.razorpay_payment_id)] : null,
        ),
        h('p', { class: 'bk-od-help' }, renderIcon('building', { size: 15 }), `Need help? Show this order ID at the ${gymName} front desk.`),
      ),
      ctx.onShop
        ? h('div', { class: 'bk-placed-actions' }, h('button', { type: 'button', class: 'bk-btn-ghost', onclick: () => ctx.onShop() }, 'Shop again'))
        : null,
    ),
  );
}

async function openOrdersPage(ctx) {
  const gymName = ctx.store.delivery.gym_name;
  const body = h('div', { class: 'bk-orders' }, h('div', { class: 'bk-empty' }, h('p', {}, 'Loading your orders…')));
  ctx.pages.push(h('div', { class: 'bk-page-inner' }, pageHead(ctx, 'My orders', { search: false, cart: false }), body));
  try {
    const { items } = await api.portal.storeOrders();
    if (!items.length) {
      fill(
        body,
        h(
          'div',
          { class: 'bk-empty' },
          h('span', { class: 'bk-empty-icon' }, renderIcon('package', { size: 34, stroke: 1.6 })),
          h('strong', {}, 'No orders yet'),
          h('p', {}, 'Everything you buy shows up here with live status.'),
          ctx.onShop ? h('button', { type: 'button', class: 'bk-btn-green', onclick: () => ctx.onShop() }, 'Start shopping') : null,
        ),
      );
      return;
    }
    const open = items.filter((o) => !orderClosed(o));
    const past = items.filter(orderClosed);
    const card = (order) => orderCard(order, { gymName, onOpen: (o) => openOrderPage(ctx, o) });
    fill(
      body,
      open.length ? h('h3', { class: 'bk-orders-label' }, 'In progress') : null,
      ...open.map(card),
      past.length ? h('h3', { class: 'bk-orders-label' }, open.length ? 'Past orders' : 'Your orders') : null,
      ...past.map(card),
    );
  } catch (err) {
    fill(body, h('div', { class: 'bk-empty' }, h('p', {}, err.message || 'Could not load your orders')));
  }
}

/**
 * Orders from outside the shop — the Profile tab. Pages open over the app
 * exactly as they do from the Store, with the same back-gesture handling;
 * the shop's catalogue and cart are not needed for any of them.
 */
export function createOrdersNav(anchor, { gymName, onShop } = {}) {
  let ctx = null;
  // The pager is made on first use: it listens for the back gesture.
  const ready = () => {
    if (ctx) return ctx;
    ctx = {
      store: { delivery: { gym_name: gymName } },
      pages: createPager(anchor),
      watchers: new Set(),
      cart: { count: () => 0 },
      onShop: onShop
        ? () => {
            ctx.pages.closeAll();
            setTimeout(onShop, 250);
          }
        : null,
    };
    return ctx;
  };
  return {
    openList: () => openOrdersPage(ready()),
    openOrder: (order) => openOrderPage(ready(), order),
  };
}

function orderPlacedView(ctx, order) {
  const pickup = order.fulfillment_method === 'pickup';
  const d = ctx.store.delivery;
  return h(
    'div',
    { class: 'bk-page-inner bk-placed' },
    h(
      'div',
      { class: 'bk-placed-hero' },
      h('span', { class: 'bk-placed-check' }, renderIcon('check', { size: 44, stroke: 3 })),
      h('h2', {}, 'Order placed!'),
      h('p', {}, pickup ? `${d.pickup_eta}. We'll notify you when it reaches the desk.` : `${d.eta}. We'll notify you when it ships.`),
      h('span', { class: 'bk-placed-code' }, order.order_code),
    ),
    h(
      'div',
      { class: 'bk-card-block' },
      h('h3', {}, `${order.items.reduce((n, i) => n + i.quantity, 0)} items · ${money(order.total_amount)} paid`),
      ...order.items.map((i) => h('p', { class: 'bk-placed-line' }, `${i.quantity} × ${i.title}`, i.variant_label ? h('small', {}, ` · ${i.variant_label}`) : null)),
      order.mrp_total > order.total_amount
        ? h('p', { class: 'bk-saved' }, renderIcon('sparkle', { size: 15 }), `You saved ${money(order.mrp_total - order.total_amount)} on this order`)
        : null,
    ),
    h(
      'div',
      { class: 'bk-placed-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'bk-btn-green',
          onclick: () => {
            ctx.pages.closeAll();
            setTimeout(() => ctx.openOrders(), 250);
          },
        },
        'Track order',
      ),
      h('button', { type: 'button', class: 'bk-btn-ghost', onclick: () => ctx.pages.closeAll() }, 'Continue shopping'),
    ),
  );
}

function openCartPage(ctx) {
  let paying = false;
  const body = h('div', { class: 'bk-cart' });
  const payBar = h('div', { class: 'bk-paybar' });

  async function pay(lines) {
    const problem = shippingProblem(ctx.ship, ctx.method);
    if (problem) {
      openAddressSheet(ctx, { onSaved: paint });
      return;
    }
    paying = true;
    paint();
    try {
      const fields = ctx.method === 'pickup' ? ['name', 'phone'] : ['name', 'phone', 'address', 'city', 'state', 'pincode'];
      const shipping = Object.fromEntries(fields.map((k) => [k, String(ctx.ship[k] ?? '').trim()]));
      const { checkout } = await api.portal.storeCheckout({
        method: ctx.method,
        items: lines.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, quantity: l.quantity })),
        shipping,
      });
      const proof = await payWithRazorpay(checkout);
      const { order } = await api.portal.storeVerify(proof);
      placed = true;
      ctx.cart.clear();
      ctx.pages.replaceTop(orderPlacedView(ctx, order));
    } catch (err) {
      if (!err.cancelled || err.message !== 'Payment cancelled') toast(err.message || 'The payment did not go through', 'error');
      paying = false;
      paint();
    }
  }

  let placed = false;
  function paint() {
    // Once paid, the page shows "order placed" — the emptied cart must not
    // repaint over it.
    if (placed) return;
    const lines = ctx.cart.lines();
    if (!lines.length) {
      fill(
        body,
        h(
          'div',
          { class: 'bk-empty' },
          h('span', { class: 'bk-empty-icon' }, renderIcon('cart', { size: 34, stroke: 1.6 })),
          h('strong', {}, 'Your cart is empty'),
          h('p', {}, 'Add protein, creatine or gear to get started.'),
          h('button', { type: 'button', class: 'bk-btn-green', onclick: ctx.pages.back }, 'Start shopping'),
        ),
      );
      clear(payBar);
      return;
    }
    const d = ctx.store.delivery;
    const buyable = lines.filter((l) => l.available);
    const total = buyable.reduce((s, l) => s + l.total, 0);
    const mrpTotal = buyable.reduce((s, l) => s + l.mrp * l.quantity, 0);
    const saved = mrpTotal - total;
    const pickup = ctx.method === 'pickup';
    const inCart = new Set(lines.map((l) => l.product_id));
    const suggestions = ctx.products.filter((p) => !inCart.has(p.id) && !soldOutOf(p)).slice(0, 8);
    const missing = shippingProblem(ctx.ship, ctx.method);
    const count = ctx.cart.count();

    fill(
      body,
      saved > 0
        ? h('div', { class: 'bk-savings' }, renderIcon('sparkle', { size: 16 }), h('span', {}, 'You are saving ', h('strong', {}, money(saved)), ' on this order'))
        : null,
      h(
        'section',
        { class: 'bk-card-block bk-shipment' },
        h(
          'div',
          { class: 'bk-shipment-head' },
          h('span', { class: 'bk-shipment-icon' }, renderIcon(pickup ? 'building' : 'clock', { size: 20, stroke: 2.2 })),
          h('div', {}, h('strong', {}, pickup ? d.pickup_eta : d.eta), h('small', {}, `Shipment of ${count} item${count === 1 ? '' : 's'}`)),
        ),
        ...lines.map((line) =>
          h(
            'div',
            { class: `bk-line${line.available ? '' : ' oos'}` },
            h('span', { class: 'bk-line-thumb' }, productArt(line.product, 'bk-thumb')),
            h(
              'div',
              { class: 'bk-line-text' },
              h('strong', {}, line.product.title),
              h('small', {}, line.variant?.label || unitLabel(line.product)),
              line.available ? null : h('em', {}, 'No longer available — remove to continue'),
            ),
            h(
              'div',
              { class: 'bk-line-side' },
              stepper(line.quantity, {
                size: 'sm',
                onMinus: () => ctx.cart.set(line.product_id, line.variant_id, line.quantity - 1),
                onPlus: () => ctx.cart.set(line.product_id, line.variant_id, line.quantity + 1),
              }),
              h('div', { class: 'bk-price end' }, h('strong', {}, money(line.total)), line.mrp > line.price ? h('s', {}, money(line.mrp * line.quantity)) : null),
            ),
          ),
        ),
      ),
      rail('You might also like', suggestions, ctx),
      h(
        'section',
        { class: 'bk-card-block' },
        h('h3', {}, 'Bill details'),
        h(
          'dl',
          { class: 'bk-bill' },
          h('dt', {}, renderIcon('receipt', { size: 15 }), 'Items total', saved > 0 ? h('span', { class: 'bk-pill' }, `Saved ${money(saved)}`) : null),
          h('dd', {}, saved > 0 ? h('s', {}, money(mrpTotal)) : null, money(total)),
          h('dt', {}, renderIcon(pickup ? 'building' : 'truck', { size: 15 }), pickup ? 'Gym pickup' : 'Delivery charge'),
          h('dd', { class: 'free' }, 'FREE'),
          h('dt', { class: 'grand' }, 'Grand total'),
          h('dd', { class: 'grand' }, money(total)),
        ),
      ),
      d.pickup_enabled
        ? h(
            'section',
            { class: 'bk-card-block' },
            h('h3', {}, 'How do you want it?'),
            h(
              'div',
              { class: 'bk-method-pair' },
              ...[
                ['delivery', 'truck', 'Delivery', d.eta],
                ['pickup', 'building', 'Gym pickup', d.pickup_eta],
              ].map(([m, icon, label, sub]) =>
                h(
                  'button',
                  { type: 'button', class: `bk-method-tile${ctx.method === m ? ' selected' : ''}`, onclick: () => ctx.setMethod(m) },
                  renderIcon(icon, { size: 20, stroke: 2 }),
                  h('strong', {}, label),
                  h('small', {}, sub),
                ),
              ),
            ),
          )
        : null,
      h(
        'section',
        { class: 'bk-card-block bk-addr' },
        h('span', { class: 'bk-addr-icon' }, renderIcon(pickup ? 'building' : 'mapPin', { size: 20, stroke: 2.2 })),
        h(
          'div',
          {},
          missing
            ? h('strong', {}, pickup ? 'Add who will collect' : 'Add a delivery address')
            : pickup
              ? [h('strong', {}, `Pick up at ${d.gym_name}`), h('p', {}, `${ctx.ship.name} · ${ctx.ship.phone} — collect from the front desk`)]
              : [h('strong', {}, `Delivering to ${ctx.ship.name}`), h('p', {}, [ctx.ship.address, ctx.ship.city, ctx.ship.state, ctx.ship.pincode].filter(Boolean).join(', '))],
        ),
        h('button', { type: 'button', class: 'bk-link-btn', onclick: () => openAddressSheet(ctx, { onSaved: paint }) }, missing ? 'Add' : 'Change'),
      ),
      h(
        'section',
        { class: 'bk-card-block bk-policy' },
        h('h3', {}, 'Cancellation policy'),
        h('p', {}, 'Orders can be cancelled until they ship. If an order is cancelled, the full amount goes back to your UPI account.'),
      ),
    );

    const blocked = !ctx.store.payments_ready;
    fill(
      payBar,
      blocked ? h('p', { class: 'bk-paybar-note' }, 'In-app payments are being switched on — your cart will be here when they are.') : null,
      h(
        'div',
        { class: 'bk-paybar-row' },
        h('div', { class: 'bk-paybar-total' }, h('strong', {}, money(total)), h('small', {}, 'TOTAL')),
        h(
          'button',
          {
            type: 'button',
            class: 'bk-btn-green bk-paybar-btn',
            disabled: paying || blocked || !buyable.length || buyable.length !== lines.length,
            onclick: () => pay(buyable),
          },
          blocked ? 'Checkout opens soon' : paying ? 'Opening payment…' : missing ? (pickup ? 'Add contact to proceed' : 'Add address to proceed') : 'Pay with UPI',
          blocked || paying ? null : renderIcon('chevronRight', { size: 18, stroke: 2.6 }),
        ),
      ),
    );
  }

  ctx.cart.onChange(() => body.isConnected && paint());
  ctx.onMethodChange.add(() => body.isConnected && paint());
  ctx.pages.push(h('div', { class: 'bk-page-inner bk-cart-page' }, pageHead(ctx, 'My cart', { search: false, cart: false }), body, payBar));
  paint();
}

/* ── The tab ──────────────────────────────────────────────────────────── */

/** The hero's three promises. Keep them true: "Easy Returns" must match the
 * returns the operator actually honours. */
const HERO_TRUST = [
  ['shield', '100%', 'Original'],
  ['truck', 'Wide', 'Range'],
  ['package', 'Easy', 'Returns'],
];

/** The deepest discount in the catalogue — the hero's "UP TO x% OFF" tag. */
function bestDeal(products) {
  let best = 0;
  for (const p of products) {
    for (const v of p.variants.length ? p.variants.filter((x) => x.in_stock) : [null]) {
      const { price, mrp } = priceOf(p, v);
      best = Math.max(best, offPct(price, mrp));
    }
  }
  return best;
}

/** `store` is GET /api/portal/store. */
export function renderLiveStore({ store, memberId }) {
  const products = store.products;
  const root = h('div', { class: 'portal-tab-body bk bk-home' });
  const methodKey = `gymbook.store.method${scope(memberId)}`;
  const addressKey = `gymbook.store.address${scope(memberId)}`;
  const defaults = store.shipping
    ? { name: store.shipping.name ?? '', phone: store.shipping.phone ?? '', address: store.shipping.address ?? '' }
    : {};
  let filter = '';
  let sort = 'relevance';

  const ctx = {
    store,
    products,
    memberId,
    cart: createCart(products),
    pages: createPager(root),
    watchers: new Set(),
    onMethodChange: new Set(),
    wish: new Set((syncedWish.read() ?? []).filter((id) => products.some((p) => p.id === id))),
    method: store.delivery.pickup_enabled && loadJson(methodKey, 'delivery') === 'pickup' ? 'pickup' : 'delivery',
    ship: { name: '', phone: '', address: '', city: '', state: '', pincode: '', ...defaults, ...(loadJson(addressKey, null) ?? {}) },
    etaShort() {
      const text = this.method === 'pickup' ? store.delivery.pickup_eta : store.delivery.eta;
      return text.replace(/^(?:delivery|delivered|ready at your gym)\s+(?:in\s+)?/i, '');
    },
    setMethod(method) {
      this.method = method;
      saveJson(methodKey, method);
      for (const fn of this.onMethodChange) fn();
      // ETA chips on every card follow the method.
      for (const el of document.querySelectorAll('.bk-eta')) {
        const icon = el.firstChild;
        el.replaceChildren(icon, this.etaShort());
      }
    },
    saveShip(ship) {
      this.ship = { ...this.ship, ...ship };
      saveJson(addressKey, this.ship);
      for (const fn of this.onMethodChange) fn();
    },
    toggleWish(id) {
      const on = !this.wish.has(id);
      if (on) this.wish.add(id);
      else this.wish.delete(id);
      syncedWish.write([...this.wish]);
      for (const btn of document.querySelectorAll(`.bk-heart[data-product="${id}"]`)) {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      }
      toast(on ? 'Saved to your wishlist' : 'Removed from your wishlist');
      paintCats();
      if (filter === 'wish') paintGrid();
    },
    bestsellers: () => {
      const featured = products.filter((p) => p.featured);
      return (featured.length ? featured : products).slice(0, 10);
    },
  };
  ctx.openProduct = (product, variant) => openProductPage(ctx, product, variant);
  ctx.openCategory = (key) => openCategoryPage(ctx, key);
  ctx.openSearch = (q = '') => openSearchPage(ctx, q);
  ctx.openCart = () => openCartPage(ctx);
  ctx.openOrders = () => openOrdersPage(ctx);
  ctx.onShop = () => ctx.pages.closeAll();

  // One cart listener drives every Add button, stepper, badge and cart bar.
  ctx.cart.onChange(() => {
    for (const w of ctx.watchers) {
      if (w.el.isConnected) {
        w.seen = true;
        w.paint();
      } else if (w.seen) ctx.watchers.delete(w);
      else w.paint();
    }
  });

  /* Top row: where it's going, search, cart. */
  const where = h('button', { type: 'button', class: 'bk-where', onclick: () => openMethodSheet(ctx) });
  function paintWhere() {
    const pickup = ctx.method === 'pickup';
    const place = pickup
      ? store.delivery.gym_name
      : [ctx.ship.address, ctx.ship.city].filter(Boolean).join(', ') || 'Add your address';
    fill(
      where,
      h('span', { class: 'bk-where-pin' }, renderIcon(pickup ? 'building' : 'mapPin', { size: 20, stroke: 2.2 })),
      h('span', { class: 'bk-where-text' }, h('small', {}, pickup ? 'Pick up at' : 'Deliver to'), h('strong', {}, place)),
      renderIcon('chevronDown', { size: 16, stroke: 2.4 }),
    );
  }
  const badge = h('span', { class: 'bk-top-badge' });
  live(ctx, badge, () => {
    const n = ctx.cart.count();
    badge.textContent = String(n);
    badge.hidden = !n;
  });
  const top = h(
    'header',
    { class: 'bk-top' },
    where,
    h('button', { type: 'button', class: 'bk-top-btn', 'aria-label': 'Search', onclick: () => ctx.openSearch() }, renderIcon('search', { size: 19, stroke: 2.2 })),
    h('button', { type: 'button', class: 'bk-top-btn', 'aria-label': 'Cart', onclick: () => ctx.openCart() }, renderIcon('cart', { size: 19, stroke: 2.2 }), badge),
  );

  /* Hero: the delivery promise, three trust marks, and the product shot. */
  const hero = h('section', { class: 'bk-hero' });
  const deal = bestDeal(products);
  function paintHero() {
    const pickup = ctx.method === 'pickup';
    fill(
      hero,
      h(
        'div',
        { class: 'bk-hero-copy' },
        h('span', { class: 'bk-hero-chip' }, 'Fitness nutrition'),
        h('h2', {}, 'Supplements', h('br'), pickup ? 'at your gym in' : 'delivered in'),
        h('span', { class: 'bk-hero-pill' }, ctx.etaShort(), renderIcon('zap', { size: 18, stroke: 2.6 })),
        h(
          'div',
          { class: 'bk-hero-trust' },
          ...HERO_TRUST.map(([icon, a, b]) =>
            h('span', {}, renderIcon(icon, { size: 17, stroke: 1.9 }), h('span', {}, a, h('br'), b)),
          ),
        ),
      ),
      h('img', {
        class: 'bk-hero-art',
        src: `${STORE_ART}/hero.webp`,
        alt: '',
        decoding: 'async',
        onerror: (e) => {
          hero.classList.add('no-art');
          e.currentTarget.remove();
        },
      }),
      deal >= 10 ? h('span', { class: 'bk-hero-tag' }, h('small', {}, 'Up to'), h('b', {}, `${deal}%`), h('small', {}, 'Off')) : null,
    );
  }
  ctx.onMethodChange.add(() => {
    paintWhere();
    paintHero();
  });
  paintWhere();
  paintHero();

  /* The search box is a button: it opens the search page. Its hint cycles
     through what people come here for. */
  const hints = ['"pre-workout"', '"whey protein"', '"creatine"', ...[...new Set(products.map((p) => `"${p.brand}"`))].slice(0, 3)];
  const hint = h('span', { class: 'bk-search-hint' }, hints[0]);
  const searchBar = h(
    'button',
    { type: 'button', class: 'bk-searchbar', onclick: () => ctx.openSearch() },
    renderIcon('search', { size: 18, stroke: 2.2 }),
    h('span', {}, 'Search ', hint),
  );
  let hintIndex = 0;
  const hintTimer = setInterval(() => {
    if (!root.isConnected) return clearInterval(hintTimer);
    hintIndex = (hintIndex + 1) % hints.length;
    hint.classList.remove('roll');
    void hint.offsetWidth;
    hint.textContent = hints[hintIndex];
    hint.classList.add('roll');
  }, 2600);

  /* Categories: tapping one filters the grid below; "See all" opens the
     full category browser. A wishlist tile appears once something is saved. */
  const present = Object.keys(CATEGORY).filter((k) => products.some((p) => p.category === k));
  const catRow = h('div', { class: 'bk-cats', role: 'tablist', 'aria-label': 'Categories' });
  function paintCats() {
    const tile = (key, label, art) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(filter === key),
          class: `bk-cat${filter === key ? ' on' : ''}`,
          onclick: () => {
            filter = filter === key ? '' : key;
            paintCats();
            paintGrid();
            gridSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        h('span', { class: 'bk-cat-art' }, art),
        h('span', { class: 'bk-cat-label' }, label),
      );
    fill(
      catRow,
      ...present.map((k) => tile(k, categoryOf(k).label, categoryArt(ctx, k, 'bk-cat-img'))),
      ctx.wish.size ? tile('wish', 'Wishlist', h('span', { class: 'bk-cat-img bk-art-none bk-wish-art' }, renderIcon('heart', { size: 22, stroke: 2 }))) : null,
    );
  }
  paintCats();

  /* Banners: swipeable, auto-advancing until touched. */
  function bannersBlock() {
    if (!store.banners?.length) return null;
    const track = h(
      'div',
      { class: 'bk-banner-track' },
      ...store.banners.map((b) =>
        h(
          'button',
          {
            type: 'button',
            class: `bk-banner${b.image_url ? ' has-art' : ''}`,
            style: `--bn:${b.bg_color}`,
            onclick: () => {
              if (b.link_type === 'category' && b.link_value) ctx.openCategory(b.link_value);
              else if (b.link_type === 'product') {
                const p = products.find((x) => String(x.id) === String(b.link_value));
                if (p) ctx.openProduct(p);
              }
            },
          },
          h(
            'span',
            { class: 'bk-banner-text' },
            h('strong', {}, b.title),
            b.subtitle ? h('small', {}, b.subtitle) : null,
            b.link_type !== 'none' ? h('span', { class: 'bk-banner-cta' }, b.cta_label || 'Shop now') : null,
          ),
          b.image_url ? h('img', { class: 'bk-banner-art', src: b.image_url, alt: '', loading: 'lazy' }) : null,
        ),
      ),
    );
    const dots = h('div', { class: 'bk-dots' }, ...store.banners.map((_, i) => h('span', { class: i === 0 ? 'on' : '' })));
    const step = () => track.firstChild.offsetWidth + 10;
    const current = () => Math.round(track.scrollLeft / Math.max(1, step()));
    track.addEventListener('scroll', () => [...dots.children].forEach((d, j) => d.classList.toggle('on', j === current())), { passive: true });
    let touched = false;
    track.addEventListener('pointerdown', () => (touched = true), { passive: true });
    if (store.banners.length > 1) {
      const timer = setInterval(() => {
        if (!root.isConnected) return clearInterval(timer);
        if (touched || document.hidden || document.body.classList.contains('bk-page-open')) return;
        track.scrollTo({ left: ((current() + 1) % store.banners.length) * step(), behavior: 'smooth' });
      }, 4000);
    }
    return h('section', { class: 'bk-banners' }, track, store.banners.length > 1 ? dots : null);
  }

  /* All products (or the chosen category), with sorting. */
  const gridTitle = h('h3', {});
  const clearFilter = h('button', { type: 'button', class: 'bk-clear', 'aria-label': 'Show all products', onclick: () => { filter = ''; paintCats(); paintGrid(); } }, renderIcon('close', { size: 14, stroke: 2.6 }));
  const sortBtn = h('button', { type: 'button', class: 'bk-sort' });
  const grid = h('div', { class: 'bk-grid' });
  const gridSection = h(
    'section',
    { class: 'bk-section' },
    h('div', { class: 'bk-section-head' }, h('div', { class: 'bk-title-row' }, gridTitle, clearFilter), sortBtn),
    grid,
  );
  function paintGrid() {
    const list = sortProducts(
      filter === 'wish' ? products.filter((p) => ctx.wish.has(p.id)) : filter ? products.filter((p) => p.category === filter) : products,
      sort,
    );
    gridTitle.textContent = filter === 'wish' ? 'Wishlist' : filter ? categoryOf(filter).label : 'All products';
    clearFilter.hidden = !filter;
    fill(sortBtn, renderIcon('sort', { size: 15, stroke: 2.2 }), sort === 'relevance' ? 'Sort by' : SORTS[sort], renderIcon('chevronDown', { size: 14, stroke: 2.4 }));
    sortBtn.onclick = () => openSortSheet(sort, (value) => { sort = value; paintGrid(); });
    fill(
      grid,
      list.length
        ? list.map((p) => productCard(p, ctx))
        : h('div', { class: 'bk-empty' }, h('p', {}, filter === 'wish' ? 'Tap the heart on a product to save it here.' : 'Nothing here yet.')),
    );
  }
  paintGrid();

  fill(
    root,
    top,
    hero,
    searchBar,
    present.length
      ? h(
          'section',
          { class: 'bk-section' },
          h(
            'div',
            { class: 'bk-section-head' },
            h('h3', {}, 'Shop by category'),
            h('button', { type: 'button', class: 'bk-see-all', onclick: () => ctx.openCategory(present[0]) }, 'See all', renderIcon('chevronRight', { size: 15, stroke: 2.4 })),
          ),
          catRow,
        )
      : null,
    bannersBlock(),
    products.length ? gridSection : h('div', { class: 'bk-empty' }, h('strong', {}, 'New stock is on its way'), h('p', {}, 'Check back soon.')),
    h('footer', { class: 'bk-sign' }, h('strong', {}, 'Fuel your gains.'), h('span', {}, `${store.delivery.gym_name} store · 100% authentic · secure UPI`)),
    cartBar(ctx),
  );
  return root;
}
