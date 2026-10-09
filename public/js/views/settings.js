import { ApiError, api, gymPathUrl, pathSlug, session } from '../api.js';
import { buildForm, date, h, isFullscreen, relativeDays, renderIcon, setCurrency, toast, toggleFullscreen } from '../ui.js';
import { cropAndResizeImage, makeAppIcon } from '../photo.js';
import { getAppMode, getAppTheme, isLibrary, setAppMode, setAppTheme, t, tl } from '../vertical.js';
import { customDomainCard } from './customDomains.js';

/**
 * The gym's own account page: identity, regional settings and subscription.
 *
 * Everything here lives in the platform registry rather than the gym's own
 * database, so it goes through /api/platform/tenant, not the gym API.
 */

const CURRENCIES = [
  { value: 'INR', symbol: '₹', label: '₹ Indian rupee (INR)' },
  { value: 'USD', symbol: '$', label: '$ US dollar (USD)' },
  { value: 'EUR', symbol: '€', label: '€ Euro (EUR)' },
  { value: 'GBP', symbol: '£', label: '£ Pound sterling (GBP)' },
  { value: 'AED', symbol: 'د.إ', label: 'د.إ UAE dirham (AED)' },
  { value: 'SGD', symbol: 'S$', label: 'S$ Singapore dollar (SGD)' },
  { value: 'AUD', symbol: 'A$', label: 'A$ Australian dollar (AUD)' },
  { value: 'CAD', symbol: 'C$', label: 'C$ Canadian dollar (CAD)' },
  { value: 'ZAR', symbol: 'R', label: 'R South African rand (ZAR)' },
];

const STATUS_TONE = { active: 'green', trial: 'blue', suspended: 'red', cancelled: 'grey' };

const ART = '/images/settings';

/** The picture and icon that stand for the business: a dumbbell for a gym, books for a library. */
const mark = () => (isLibrary() ? { icon: 'book', art: 'books.svg' } : { icon: 'dumbbell', art: 'dumbbell.svg' });

/** Only the zones a gym is plausibly in, plus whatever this browser reports —
 * a free-text IANA name is still accepted, this is just the shortcut. */
function timezoneOptions(current) {
  const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const common = [
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
    'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Africa/Johannesburg',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC',
  ];
  return [...new Set([current, guessed, ...common].filter(Boolean))];
}

/** Decoration only: each card's illustration sits behind its content. */
const art = (file, position) =>
  h('img', { class: `stg-art ${position}`, src: `${ART}/${file}`, alt: '', 'aria-hidden': 'true' });

/** Coloured icon, title and one-line description — the head of every card. */
function cardHead(icon, tone, title, text, aside) {
  return h(
    'div',
    { class: 'stg-head' },
    h('span', { class: `stg-head-icon tone-${tone}` }, renderIcon(icon, { size: 24, stroke: 2 })),
    h('div', { class: 'stg-head-text' }, h('h3', {}, title), text ? h('p', {}, text) : null),
    aside || null,
  );
}

/** A label/value list with an icon per row, on a tinted panel. */
function infoPanel(rows) {
  return h(
    'div',
    { class: 'stg-info' },
    ...rows.filter(Boolean).map(([icon, label, value]) =>
      h(
        'div',
        { class: 'stg-info-row' },
        renderIcon(icon, { size: 18 }),
        h('span', { class: 'stg-info-label' }, label),
        h('span', { class: 'stg-info-value' }, value),
      ),
    ),
  );
}

async function copyText(text, done = 'Link copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Could not copy — select the link and copy it manually', 'error');
  }
}

function subscriptionCard(tenant, billing, reload) {
  const isAdmin = session.can('admin');
  const daysLeft = tenant.trial_ends_on ? relativeDays(tenant.trial_ends_on) : null;

  const line = () => {
    if (tenant.status === 'active') return 'Your subscription is active. Thanks for being here.';
    if (tenant.status === 'trial') {
      if (daysLeft === null) return 'You are on a free trial.';
      if (daysLeft <= 0) return 'Your trial ends today. Subscribe to keep access after tonight.';
      return `Your free trial has ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`;
    }
    if (tenant.status === 'suspended') {
      return 'Access is paused because the trial or last payment lapsed. Subscribing restores everything — no data was deleted.';
    }
    return 'This account is closed. Contact support to reopen it.';
  };

  const subscribe = h(
    'button',
    { class: 'btn primary' },
    renderIcon('crown', { size: 17, stroke: 2 }),
    tenant.status === 'suspended' ? `Reactivate my ${isLibrary() ? 'library' : 'gym'}` : 'Subscribe',
  );
  subscribe.addEventListener('click', async () => {
    subscribe.disabled = true;
    try {
      const { checkout_url: url } = await api.subscribe();
      // Razorpay's hosted page, not ours — hand the browser over rather than
      // trying to host a payment form.
      window.location.href = url;
    } catch (err) {
      // Billing is optional: a self-hosted deployment with no Razorpay keys
      // should say so plainly, not show a broken button.
      toast(err.message || 'Could not start checkout', 'error');
      subscribe.disabled = false;
    }
  });

  return h(
    'div',
    { class: 'card stg-card' },
    art('subscription.svg', 'bottom-right stg-art-sub'),
    cardHead(
      'crown',
      'amber',
      'Subscription',
      null,
      h('span', { class: `badge stg-badge ${STATUS_TONE[tenant.status] || 'grey'}` }, tenant.status),
    ),
    h('p', { class: 'stg-lede' }, line()),
    h(
      'div',
      { class: 'stg-body-narrow' },
      infoPanel([
        ['calendar', 'Trial ends', tenant.trial_ends_on ? date(tenant.trial_ends_on) : '—'],
        ['card', 'Razorpay subscription', billing?.razorpay_subscription_id || '—'],
      ]),
      isAdmin && tenant.status !== 'active' && tenant.status !== 'cancelled'
        ? h('div', { style: 'margin-top:16px' }, subscribe)
        : null,
      !isAdmin && tenant.status !== 'active'
        ? h('div', { class: 'muted', style: 'margin-top:12px;font-size:13px' }, 'Only an admin can manage the subscription.')
        : null,
      billing?.checkout_url && tenant.status !== 'active'
        ? h(
          'div',
          { style: 'margin-top:10px' },
          h('a', { class: 'btn sm ghost', href: billing.checkout_url }, 'Open the existing checkout link'),
        )
        : null,
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn sm ghost stg-link-btn', onclick: reload }, renderIcon('refresh', { size: 16 }), 'Refresh'),
      ),
    ),
  );
}

export async function renderSettings({ reload }) {
  const isAdmin = session.can('admin');
  const noun = isLibrary() ? 'library' : 'gym';
  const Noun = isLibrary() ? 'Library' : 'Gym';

  const { tenant } = await api.tenantContext();
  if (!tenant) {
    return h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Not a platform gym'),
      h(
        'p',
        { class: 'muted' },
        'This install is running as a single gym against the fallback database, so there is no separate gym account to configure. Sign up through the landing page to create one.',
      ),
    );
  }

  // Billing status is admin-only server-side; managers still get the page.
  // Domains are best-effort too: a failure there must not cost the owner the
  // rest of their settings.
  const [billing, domains] = await Promise.all([
    api.billingStatus().catch((err) => {
      if (!(err instanceof ApiError)) throw err;
      return null;
    }),
    api.customDomains().catch((err) => {
      if (!(err instanceof ApiError)) throw err;
      return null;
    }),
  ]);

  // A live custom domain is the address to hand out; the platform address
  // stays as the fallback that works whatever happens to the gym's DNS.
  const liveDomain = domains?.items?.find((domain) => domain.status === 'active');
  const platformUrl = pathSlug ? gymPathUrl(tenant.slug) : domains?.platform_url || window.location.origin;
  const url = liveDomain ? liveDomain.url : platformUrl;

  let pendingLogoData = undefined;
  // The square home-screen icon drawn from the same file. Kept beside the logo
  // rather than derived on the server, which has no image decoder.
  let pendingIconData = undefined;
  let currentLogoUrl = tenant.logo_url;

  const logoPreviewImg = h('img', {
    src: currentLogoUrl || '',
    alt: `${Noun} logo`,
    style: currentLogoUrl ? '' : 'display:none',
  });
  const logoPlaceholder = h('span', {
    style: currentLogoUrl ? 'display:none' : '',
  }, renderIcon(mark().icon, { size: 36 }));

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    style: 'display:none',
  });

  const pickLogo = () => {
    if (isAdmin) fileInput.click();
  };

  const logoPreviewContainer = h(
    'div',
    { class: 'settings-logo-preview stg-logo-preview' },
    logoPreviewImg,
    logoPlaceholder,
    isAdmin
      ? h(
        'button',
        { class: 'stg-logo-edit', type: 'button', title: 'Change logo', 'aria-label': 'Change logo', onclick: pickLogo },
        renderIcon('edit', { size: 14, stroke: 2.2 }),
      )
      : null,
  );

  const removeBtn = h(
    'button',
    {
      class: 'btn danger stg-logo-btn',
      type: 'button',
      style: currentLogoUrl ? '' : 'display:none',
    },
    renderIcon('trash', { size: 17 }),
    'Remove logo',
  );

  const uploadBtn = h(
    'button',
    { class: 'btn stg-outline stg-logo-btn', type: 'button', onclick: pickLogo },
    renderIcon('upload', { size: 17 }),
    'Upload logo',
  );

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Both are drawn from the original file rather than one from the other:
      // the icon is four times the logo's width, and upscaling the 250px crop
      // would install a blurry home-screen icon.
      const [dataUrl, iconData] = await Promise.all([
        cropAndResizeImage(file, 250, 0.85),
        makeAppIcon(file),
      ]);
      pendingLogoData = dataUrl;
      pendingIconData = iconData;
      logoPreviewImg.src = dataUrl;
      logoPreviewImg.style.display = '';
      logoPlaceholder.style.display = 'none';
      removeBtn.style.display = '';
      toast('Logo ready — click Save changes below');
    } catch (err) {
      toast(err.message || 'Could not read logo image', 'error');
    }
    fileInput.value = '';
  });

  removeBtn.addEventListener('click', () => {
    pendingLogoData = null;
    pendingIconData = null;
    logoPreviewImg.src = '';
    logoPreviewImg.style.display = 'none';
    logoPlaceholder.style.display = '';
    removeBtn.style.display = 'none';
    toast('Logo removed — click Save changes below');
  });

  const logoSection = h(
    'div',
    { class: 'settings-logo-container stg-logo' },
    logoPreviewContainer,
    h(
      'div',
      { class: 'stg-logo-text' },
      h('strong', {}, `${Noun} Logo`),
      h(
        'span',
        { class: 'muted' },
        `Displayed in the sidebar and on your sign-in page, and used as the app icon when someone installs ${t('brand')} to their home screen. JPEG, PNG or WebP up to 512 KB.`,
      ),
      isAdmin
        ? h('div', { class: 'row stg-logo-actions' }, uploadBtn, removeBtn, fileInput)
        : null,
    ),
  );

  const profileForm = buildForm(
    [
      { name: 'gym_name', label: `${Noun} name`, required: true, value: tenant.gym_name, full: true, hint: 'Shown in the sidebar, on printed ID cards and on your staff sign-in page.' },
      { name: 'currency', label: 'Currency', type: 'select', value: tenant.currency, options: CURRENCIES },
      {
        name: 'timezone',
        label: 'Timezone',
        type: 'select',
        value: tenant.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        options: timezoneOptions(tenant.timezone).map((zone) => ({ value: zone, label: zone })),
        hint: `Decides when a ${tl('shift')} ends and open visits are auto-closed.`,
      },
    ],
    {
      submitLabel: 'Save changes',
      onSubmit: async (values) => {
        const payload = { ...values };
        if (pendingLogoData === null) {
          payload.clear_logo = true;
        } else if (typeof pendingLogoData === 'string') {
          payload.logo_data = pendingLogoData;
          payload.icon_data = pendingIconData;
        }

        const { tenant: updated } = await api.updateGym(payload);
        // Take effect now rather than on the next hard reload: money is
        // formatted from the currency, and the sidebar brand and tab title
        // are read from the name. The event is how app.js hears about it
        // without settings.js having to import from the module that imports
        // settings.js.
        setCurrency(updated.currency);
        window.dispatchEvent(new CustomEvent('gymbook:gym-updated', { detail: updated }));
        toast(`${Noun} settings saved`);
        await reload();
      },
    },
  );
  profileForm.querySelector('.modal-foot').remove();
  profileForm.classList.add('stg-form');

  // buildForm lays out plain fields; dress each one with the label chip and
  // the leading glyph inside the control, without forking the form builder.
  const currencySymbol = () =>
    CURRENCIES.find((c) => c.value === profileForm.elements.currency.value)?.symbol || '¤';
  const currencyLead = h('span', { class: 'stg-lead-text' }, currencySymbol());
  const decor = {
    gym_name: { chip: 'idCard', tone: 'blue', lead: renderIcon('building', { size: 18 }) },
    currency: { chip: 'edit', tone: 'green', lead: currencyLead },
    timezone: { chip: 'clock', tone: 'violet', lead: renderIcon('globe', { size: 18 }) },
  };
  for (const [name, { chip, tone, lead }] of Object.entries(decor)) {
    const control = profileForm.elements[name];
    const field = control.closest('label.field');
    field.classList.add('stg-field');
    field.querySelector(':scope > span').prepend(
      h('span', { class: `stg-chip tone-${tone}` }, renderIcon(chip, { size: 14, stroke: 2.2 })),
    );
    const wrap = h('span', { class: 'stg-control' }, h('span', { class: 'stg-lead' }, lead));
    control.replaceWith(wrap);
    wrap.append(control);
  }
  profileForm.elements.currency.addEventListener('change', () => {
    currencyLead.textContent = currencySymbol();
  });

  profileForm.append(
    h('button', { class: 'btn primary stg-save', type: 'submit' }, renderIcon('save', { size: 18 }), 'Save changes'),
  );

  if (!isAdmin) {
    for (const control of profileForm.querySelectorAll('input, select, button')) control.disabled = true;
  }

  const modeButton = (mode, icon, label) => {
    const active = (getAppMode() === 'light') === (mode === 'light');
    return h(
      'button',
      {
        class: `btn stg-option${active ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': String(active),
        onclick: async () => {
          setAppMode(mode);
          await reload();
        },
      },
      renderIcon(icon, { size: 18 }),
      label,
    );
  };

  const palettes = isLibrary()
    ? [
      { id: 'emerald', name: 'Emerald Lounge', color: '#10b981' },
      { id: 'sapphire', name: 'Sapphire Night', color: '#38bdf8' },
      { id: 'violet', name: 'Nordic Violet', color: '#a78bfa' },
      { id: 'mocha', name: 'Mocha Academic', color: '#f59e0b' },
    ]
    : [
      { id: 'flame', name: 'Flame Orange', color: '#f97316' },
      { id: 'crimson', name: 'Crimson Power', color: '#ef4444' },
      { id: 'cyber', name: 'Cyber Volt Lime', color: '#84cc16' },
      { id: 'ultramarine', name: 'Ultramarine Blue', color: '#3b82f6' },
    ];
  const currentTheme = getAppTheme() || (isLibrary() ? 'emerald' : 'flame');

  const grid = h(
    'div',
    { class: 'grid cols-2 stg-grid' },
    h(
      'div',
      { class: 'card stg-card stg-details' },
      art(mark().art, 'bottom-right stg-art-dumbbell'),
      h(
        'div',
        { class: 'stg-head stg-head-lg' },
        h('span', { class: 'stg-head-tile' }, renderIcon(mark().icon, { size: 30, stroke: 2 })),
        h(
          'div',
          { class: 'stg-head-text' },
          h('h3', {}, `${Noun} details`),
          h('p', {}, `Basic information about your ${noun} and how it appears to ${t('members').toLowerCase()}.`),
        ),
      ),
      isAdmin
        ? null
        : h('p', { class: 'muted', style: 'margin:0 0 12px;font-size:13px' }, 'Only an admin can change these.'),
      logoSection,
      profileForm,
    ),

    h(
      'div',
      { class: 'grid stg-stack' },
      h(
        'div',
        { class: 'card stg-card' },
        art('display-mode.svg', 'top-right stg-art-mode'),
        cardHead('monitor', 'violet', 'Display Mode', 'Switch between a dark and light interface.'),
        h('div', { class: 'row stg-options' }, modeButton('dark', 'moon', 'Dark'), modeButton('light', 'sun', 'Light')),
      ),
      h(
        'div',
        { class: 'card stg-card' },
        cardHead('palette', 'brand', 'Aesthetic Theme Palette', `Pick a custom color palette for your ${noun} interface.`),
        h(
          'div',
          { class: 'stg-swatches' },
          palettes.map((t) => {
            const active = currentTheme === t.id;
            // The active swatch is the live theme, so .btn.primary already has
            // the right label colour for it; the rest are tinted from their own
            // colour over the current surface, which reads in both modes.
            return h(
              'button',
              {
                class: `btn stg-swatch${active ? ' primary' : ''}`,
                type: 'button',
                style: `--swatch:${t.color}`,
                'aria-pressed': String(active),
                onclick: async () => {
                  setAppTheme(t.id);
                  toast(`Switched to ${t.name} theme`);
                  await reload();
                },
              },
              h('span', { class: 'stg-swatch-dot' }),
              h('span', {}, t.name),
            );
          }),
        ),
      ),
      subscriptionCard(tenant, billing, reload),
      h(
        'div',
        { class: 'card stg-card' },
        art('address-pin.svg', 'top-right stg-art-pin'),
        cardHead('mapPin', 'brand', 'Your address', 'Where your staff sign in. Bookmark it on the front-desk machine.'),
        h(
          'div',
          { class: 'stg-url' },
          h('span', { class: 'stg-url-lead' }, renderIcon('link', { size: 20, stroke: 2 })),
          h('code', {}, url),
          h(
            'button',
            { class: 'stg-url-copy', type: 'button', title: 'Copy link', 'aria-label': 'Copy link', onclick: () => copyText(url) },
            renderIcon('copy', { size: 18 }),
          ),
        ),
        h(
          'div',
          { class: 'row', style: 'margin-top:6px' },
          h('button', { class: 'btn sm ghost stg-link-btn', onclick: () => copyText(url) }, renderIcon('link', { size: 16 }), 'Copy link'),
        ),
        infoPanel([
          ['bank', `${Noun} address`, tenant.slug],
          liveDomain ? ['globe', 'Also at', h('code', {}, platformUrl)] : null,
          ['database', 'Data', 'Its own database file'],
        ]),
      ),
      h(
        'div',
        { class: 'card stg-card' },
        art('kiosk.svg', 'bottom-right stg-art-kiosk'),
        cardHead(
          'monitor',
          'violet',
          'Display & Kiosk Mode',
          `Toggle full screen mode to run ${t('brand')} in clean kiosk mode on your check-in desk or tablet.`,
        ),
        h(
          'button',
          {
            class: 'btn primary stg-kiosk-btn',
            onclick: () => toggleFullscreen(),
          },
          renderIcon(isFullscreen() ? 'minimize' : 'maximize', { size: 18 }),
          isFullscreen() ? 'Exit Fullscreen' : 'Enter Fullscreen Mode',
        ),
      ),
    ),
  );

  // Full width below the grid: the DNS records table needs the room.
  return h('div', { class: 'grid stg-page' }, grid, customDomainCard(domains, { reload }));
}
