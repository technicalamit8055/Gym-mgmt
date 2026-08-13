import { ApiError, api, gymPathUrl, pathSlug, session } from '../api.js';
import { buildForm, date, h, isFullscreen, relativeDays, setCurrency, toast, toggleFullscreen } from '../ui.js';
import { cropAndResizeImage, makeAppIcon } from '../photo.js';
import { getAppTheme, isLibrary, setAppTheme, tl } from '../vertical.js';

/**
 * The gym's own account page: identity, regional settings and subscription.
 *
 * Everything here lives in the platform registry rather than the gym's own
 * database, so it goes through /api/platform/tenant, not the gym API.
 */

const CURRENCIES = [
  { value: 'INR', label: '₹ Indian rupee (INR)' },
  { value: 'USD', label: '$ US dollar (USD)' },
  { value: 'EUR', label: '€ Euro (EUR)' },
  { value: 'GBP', label: '£ Pound sterling (GBP)' },
  { value: 'AED', label: 'د.إ UAE dirham (AED)' },
  { value: 'SGD', label: 'S$ Singapore dollar (SGD)' },
  { value: 'AUD', label: 'A$ Australian dollar (AUD)' },
  { value: 'CAD', label: 'C$ Canadian dollar (CAD)' },
  { value: 'ZAR', label: 'R South African rand (ZAR)' },
];

const STATUS_TONE = { active: 'green', trial: 'blue', suspended: 'red', cancelled: 'grey' };

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
    tenant.status === 'suspended' ? 'Reactivate my gym' : 'Subscribe',
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
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h3', {}, 'Subscription'),
      h('span', { class: `badge ${STATUS_TONE[tenant.status] || 'grey'}` }, tenant.status),
    ),
    h('p', { class: 'muted', style: 'margin:0 0 14px' }, line()),
    h(
      'div',
      { class: 'kv' },
      h('div', {}, 'Trial ends'),
      h('div', {}, tenant.trial_ends_on ? date(tenant.trial_ends_on) : '—'),
      h('div', {}, 'Razorpay subscription'),
      h('div', {}, billing?.razorpay_subscription_id || '—'),
    ),
    isAdmin && tenant.status !== 'active' && tenant.status !== 'cancelled'
      ? h('div', { style: 'margin-top:14px' }, subscribe)
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
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn sm ghost', onclick: reload }, 'Refresh')),
  );
}

export async function renderSettings({ reload }) {
  const isAdmin = session.can('admin');

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
  let billing = null;
  try {
    billing = await api.billingStatus();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
  }

  const url = pathSlug ? gymPathUrl(tenant.slug) : window.location.origin;

  let pendingLogoData = undefined;
  // The square home-screen icon drawn from the same file. Kept beside the logo
  // rather than derived on the server, which has no image decoder.
  let pendingIconData = undefined;
  let currentLogoUrl = tenant.logo_url;

  const logoPreviewImg = h('img', {
    src: currentLogoUrl || '',
    alt: 'Gym logo',
    style: currentLogoUrl ? '' : 'display:none',
  });
  const logoPlaceholder = h('span', {
    style: currentLogoUrl ? 'display:none' : '',
  }, '🏋️');

  const logoPreviewContainer = h(
    'div',
    { class: 'settings-logo-preview' },
    logoPreviewImg,
    logoPlaceholder,
  );

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    style: 'display:none',
  });

  const removeBtn = h(
    'button',
    {
      class: 'btn sm ghost danger',
      type: 'button',
      style: currentLogoUrl ? '' : 'display:none',
    },
    'Remove logo',
  );

  const uploadBtn = h(
    'button',
    { class: 'btn sm ghost', type: 'button' },
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

  uploadBtn.addEventListener('click', () => {
    if (isAdmin) fileInput.click();
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
    { class: 'settings-logo-container' },
    logoPreviewContainer,
    h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:4px' },
      h('strong', {}, 'Gym Logo'),
      h(
        'span',
        { class: 'muted', style: 'font-size:13px' },
        'Displayed in the sidebar and on your sign-in page, and used as the app icon when someone installs GymBook to their home screen. JPEG, PNG or WebP up to 512 KB.',
      ),
      isAdmin
        ? h('div', { class: 'row', style: 'gap:8px;margin-top:6px' }, uploadBtn, removeBtn, fileInput)
        : null,
    ),
  );

  const profileForm = buildForm(
    [
      { name: 'gym_name', label: 'Gym name', required: true, value: tenant.gym_name, full: true, hint: 'Shown in the sidebar, on printed ID cards and on your staff sign-in page.' },
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
        toast('Gym settings saved');
        await reload();
      },
    },
  );
  profileForm.querySelector('.modal-foot').remove();
  profileForm.append(h('button', { class: 'btn primary', type: 'submit' }, 'Save changes'));

  if (!isAdmin) {
    for (const control of profileForm.querySelectorAll('input, select, button')) control.disabled = true;
  }

  return h(
    'div',
    { class: 'grid cols-2', style: 'gap:16px;align-items:start' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Gym details')),
      isAdmin
        ? null
        : h('p', { class: 'muted', style: 'margin:0 0 12px;font-size:13px' }, 'Only an admin can change these.'),
      logoSection,
      profileForm,
    ),

    h(
      'div',
      { class: 'grid', style: 'gap:16px' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Aesthetic Theme Palette')),
        h('p', { class: 'muted', style: 'margin:0 0 14px' }, `Pick a custom color palette for your ${isLibrary() ? 'library' : 'gym'} interface.`),
        h(
          'div',
          { style: 'display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:10px' },
          (isLibrary()
            ? [
                { id: 'emerald', name: 'Emerald Lounge', color: '#10b981', bg: '#081017' },
                { id: 'sapphire', name: 'Sapphire Night', color: '#38bdf8', bg: '#070c18' },
                { id: 'violet', name: 'Nordic Violet', color: '#a78bfa', bg: '#0d0a18' },
                { id: 'mocha', name: 'Mocha Academic', color: '#f59e0b', bg: '#140d0a' },
              ]
            : [
                { id: 'flame', name: 'Flame Orange', color: '#f97316', bg: '#0d1117' },
                { id: 'crimson', name: 'Crimson Power', color: '#ef4444', bg: '#120909' },
                { id: 'cyber', name: 'Cyber Volt Lime', color: '#84cc16', bg: '#0a1207' },
                { id: 'ultramarine', name: 'Ultramarine Blue', color: '#3b82f6', bg: '#090e1a' },
              ]
          ).map((t) => {
            const active = (getAppTheme() || (isLibrary() ? 'emerald' : 'flame')) === t.id;
            return h(
              'button',
              {
                class: `btn ${active ? 'primary' : 'ghost'}`,
                type: 'button',
                style: `justify-content:flex-start;padding:10px;border-color:${active ? t.color : 'var(--border)'};background:${t.bg}`,
                onclick: async () => {
                  setAppTheme(t.id);
                  toast(`Switched to ${t.name} theme`);
                  await reload();
                },
              },
              h('span', { style: `width:12px;height:12px;border-radius:50%;background:${t.color};display:inline-block;flex-shrink:0` }),
              h('span', { style: 'font-size:13px' }, t.name),
            );
          }),
        ),
      ),
      subscriptionCard(tenant, billing, reload),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Your address')),
        h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Where your staff sign in. Bookmark it on the front-desk machine.'),
        h('code', { class: 'onboard-url-inline' }, url),
        h(
          'div',
          { class: 'row', style: 'margin-top:12px' },
          h(
            'button',
            {
              class: 'btn sm ghost',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast('Link copied');
                } catch {
                  toast('Could not copy — select the link and copy it manually', 'error');
                }
              },
            },
            'Copy link',
          ),
        ),
        h(
          'div',
          { class: 'kv', style: 'margin-top:14px' },
          h('div', {}, 'Gym address'),
          h('div', {}, tenant.slug),
          h('div', {}, 'Data'),
          h('div', {}, 'Its own database file'),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Display & Kiosk Mode')),
        h('p', { class: 'muted', style: 'margin:0 0 14px' }, 'Toggle full screen mode to run GymBook in clean kiosk mode on your check-in desk or tablet.'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => toggleFullscreen(),
          },
          isFullscreen() ? '🗗 Exit Fullscreen' : '⛶ Enter Fullscreen Mode',
        ),
      ),
    ),
  );
}
