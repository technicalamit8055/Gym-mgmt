/**
 * Install, update and offline plumbing for the installed app.
 *
 * Loaded ahead of app.js (see index.html) because the first thing it does is
 * repoint the manifest link at *this gym's* manifest — a browser that has
 * already read the generic one would install "GymBook" pointing at the root
 * domain instead of the gym the owner is actually looking at.
 */
import { pathPrefix } from './api.js';
import { h, openModal, renderIcon, toast } from './ui.js';
import { isLibrary } from './vertical.js';

const DISMISSED_KEY = 'gymbook.install.dismissed';
/** Mirrors the banner's presence onto <body>, which is how app.css lifts the
 * toasts clear of it — the two share the bottom edge of the screen. */
const BANNER_FLAG = 'has-install-banner';

/* ---------------------------------------------------------------- manifest */

/**
 * Points <link rel="manifest"> at the tenant-scoped manifest.
 *
 * Two gyms addressed by path (/g/acme/, /g/pulse/) share one origin, so a
 * single static manifest would give both installs the same name, icon and
 * start_url. The server generates the manifest per gym; this picks the right
 * URL for the address this tab was opened at.
 */
function applyManifestLink() {
  const link = document.querySelector('link[rel="manifest"]');
  if (link && pathPrefix) link.href = `${pathPrefix}/manifest.webmanifest`;
}

/* ------------------------------------------------------------- gym branding */

/** index.html hardcodes GymBook's own icons — the only markup a browser has
 * before the tenant's vertical is known. Held so a gym that clears its logo
 * can be put back without a reload. */
const DEFAULT_APPLE_ICON = document.querySelector('link[rel="apple-touch-icon"]')?.href;
const DEFAULT_FAVICONS = [...document.querySelectorAll('link[rel="icon"]')];

/** SeatBook's own mark, mirroring the iconDir split in src/verticals.js —
 * a library tenant with no uploaded logo installs with the book, not the
 * barbell index.html happens to declare. */
const LIBRARY_APPLE_ICON = '/icons/library/apple-touch-icon.png';
const LIBRARY_FAVICONS = [
  { href: '/icons/library/favicon-32.png', sizes: '32x32' },
  { href: '/icons/library/icon-192.png', sizes: '192x192' },
];

/**
 * Swaps in the gym's own logo as the home-screen and tab icon.
 *
 * iOS ignores the manifest entirely for "Add to Home Screen" and reads
 * <link rel="apple-touch-icon"> off the live document at the moment you tap it
 * — so pointing it at this gym once the tenant is known is all iPhones need,
 * even though that happens after first paint. Browsers re-read the favicon
 * link the same way.
 *
 * @param {string|null|undefined} iconUrl `app_icon_url` from
 *   /api/platform/tenant. Null (no logo, or one just removed) restores this
 *   vertical's own default icon — GymBook's barbell, or SeatBook's book for a
 *   library tenant, rather than always falling back to whatever index.html
 *   happened to declare.
 */
export function applyGymIcons(iconUrl) {
  const defaultAppleIcon = isLibrary() ? LIBRARY_APPLE_ICON : DEFAULT_APPLE_ICON;
  const defaultFavicons = isLibrary()
    ? LIBRARY_FAVICONS.map((f) => h('link', { rel: 'icon', type: 'image/png', ...f }))
    : DEFAULT_FAVICONS;

  for (const link of document.querySelectorAll('link[rel="apple-touch-icon"]')) {
    if (iconUrl || defaultAppleIcon) link.href = iconUrl || defaultAppleIcon;
  }

  // Replaced rather than repointed: the markup declares two favicon sizes, and
  // a gym's icon is not either of the sizes they claim.
  for (const link of document.querySelectorAll('link[rel="icon"]')) link.remove();
  if (iconUrl) {
    document.head.append(h('link', { rel: 'icon', href: iconUrl }));
  } else {
    document.head.append(...defaultFavicons);
  }
}

/* -------------------------------------------------------------- detection */

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  // iOS never implemented beforeinstallprompt or, until recently, the
  // display-mode query — this non-standard flag is how Safari reports it.
  window.navigator.standalone === true;

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------------------------------------------------------------- install */

/** Chrome's deferred beforeinstallprompt event, or null if it hasn't fired. */
let installEvent = null;
const listeners = new Set();

/** Whether offering "Install app" would lead anywhere on this browser. */
export const canInstall = () =>
  !isStandalone() && (Boolean(installEvent) || (isIos() && !isStandalone()));

/** Notified whenever canInstall() changes, so the shell can show or hide its
 * install button without polling. */
export function onInstallChange(callback) {
  listeners.add(callback);
  callback(canInstall());
  return () => listeners.delete(callback);
}

const notify = () => listeners.forEach((cb) => cb(canInstall()));

window.addEventListener('beforeinstallprompt', (event) => {
  // Without this Chrome shows its own mini-infobar and the event is spent, so
  // the sidebar button would have nothing left to trigger.
  event.preventDefault();
  installEvent = event;
  notify();
  maybeShowBanner();
});

window.addEventListener('appinstalled', () => {
  installEvent = null;
  localStorage.setItem(DISMISSED_KEY, 'installed');
  document.querySelector('.install-banner')?.remove();
  document.body.classList.remove(BANNER_FLAG);
  notify();
  toast('GymBook is installed — open it from your home screen');
});

/** iOS has no programmatic install, so the only honest thing to offer is the
 * exact sequence of taps, naming the buttons as Safari labels them. */
function showIosInstructions() {
  openModal({
    title: 'Add GymBook to your home screen',
    body: h(
      'div',
      { class: 'install-steps' },
      h('p', { class: 'muted' }, 'iPhone and iPad install web apps from Safari itself:'),
      h(
        'ol',
        {},
        h('li', {}, 'Open this page in ', h('strong', {}, 'Safari'), ' (Chrome on iOS cannot install apps).'),
        h('li', {}, 'Tap the ', h('strong', {}, 'Share'), ' button — the square with an arrow, at the bottom of the screen.'),
        h('li', {}, 'Scroll down and tap ', h('strong', {}, 'Add to Home Screen'), '.'),
        h('li', {}, 'Tap ', h('strong', {}, 'Add'), '. GymBook then opens full-screen, without the browser bars.'),
      ),
    ),
  });
}

/**
 * Runs the install flow this browser actually supports.
 * @returns {Promise<boolean>} true once an install was accepted.
 */
export async function promptInstall() {
  if (installEvent) {
    const event = installEvent;
    // A beforeinstallprompt event is single-use: whether the user accepts or
    // dismisses, holding on to it would only produce an "already used" error.
    installEvent = null;
    notify();
    event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome !== 'accepted') toast('You can install later from the sidebar', 'info');
    return outcome === 'accepted';
  }

  if (isIos()) {
    showIosInstructions();
    return false;
  }

  openModal({
    title: 'Install GymBook',
    body: h(
      'div',
      { class: 'install-steps' },
      h(
        'p',
        { class: 'muted' },
        'Your browser installs apps from its own menu. Look for “Install app”, “Add to Home screen” or an install icon in the address bar.',
      ),
      h('p', { class: 'muted' }, 'Chrome, Edge and Samsung Internet on Android all support it; on iPhone and iPad, use Safari.'),
    ),
  });
  return false;
}

/* ----------------------------------------------------------------- banner */

/** A one-time nudge, and only where it can be acted on. Dismissing it is
 * remembered — a front-desk PC that will never be installed should not be
 * asked twice. */
function maybeShowBanner() {
  if (!canInstall() || isStandalone()) return;
  if (localStorage.getItem(DISMISSED_KEY)) return;
  if (document.querySelector('.install-banner')) return;

  const dismiss = () => {
    banner.remove();
    document.body.classList.remove(BANNER_FLAG);
  };

  const banner = h(
    'div',
    { class: 'install-banner', role: 'region', 'aria-label': 'Install GymBook' },
    h('span', { class: 'install-icon' }, renderIcon('download', { size: 20 })),
    h(
      'div',
      { class: 'install-copy' },
      h('strong', {}, 'Install GymBook'),
      h('span', { class: 'muted' }, 'Full screen, opens from your home screen, works offline.'),
    ),
    h(
      'button',
      {
        class: 'btn primary sm',
        onclick: () => {
          // Either the browser takes over with its own prompt, or a modal
          // explains how — the banner has said all it can say either way.
          dismiss();
          promptInstall();
        },
      },
      'Install',
    ),
    h(
      'button',
      {
        class: 'btn ghost sm',
        'aria-label': 'Dismiss',
        onclick: () => {
          localStorage.setItem(DISMISSED_KEY, String(Date.now()));
          dismiss();
        },
      },
      '✕',
    ),
  );
  document.body.append(banner);
  document.body.classList.add(BANNER_FLAG);
}

/* --------------------------------------------------------------- updates */

/** Offers the waiting worker rather than swapping it in silently: a reload
 * mid-shift would discard whatever half-filled form is on screen. */
function offerUpdate(registration) {
  if (document.querySelector('.toast-update')) return;

  const node = h(
    'div',
    { class: 'toast info toast-update' },
    h('span', {}, 'A new version of GymBook is ready.'),
    h(
      'button',
      {
        class: 'btn sm primary',
        onclick: () => {
          // The reload comes from controllerchange, once the new worker has
          // actually taken over — reloading here would just re-run the old one.
          reloadOnControllerChange = true;
          registration.waiting?.postMessage('gymbook:skip-waiting');
          node.remove();
        },
      },
      'Reload',
    ),
    h('button', { class: 'btn sm ghost', onclick: () => node.remove() }, 'Later'),
  );
  document.getElementById('toasts').append(node);
}

/** How often a long-lived window re-checks for a deploy. A check-in desk is
 * left open for days at a time, and a browser only looks for a new worker on
 * navigation — which such a tab never does. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

function watchForUpdates(registration) {
  if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration);

  setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS);

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // No controller means this is the very first install, not an update —
      // there is nothing for the user to reload into.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        offerUpdate(registration);
      }
    });
  });
}

/** Set only by the update prompt's Reload button. The worker calls claim() as
 * soon as it activates, which fires controllerchange on the very first visit
 * too — reloading on that one would yank the page out from under someone who
 * is mid-way through typing their password. */
let reloadOnControllerChange = false;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service workers need a secure context. localhost counts; a plain-http LAN
  // address (a front-desk PC hitting 192.168.x.x) does not, and registering
  // there only throws.
  if (!window.isSecureContext) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadOnControllerChange) return;
    reloadOnControllerChange = false;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      // Scope '/' so one worker serves the root domain and every /g/<slug> gym
      // on this origin; /sw.js sits at the root, which is what permits it.
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      watchForUpdates(registration);
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });
}

/* -------------------------------------------------------------- connection */

/** Standalone apps have no browser reload button and no network error page of
 * their own, so losing connectivity has to be visible in-app. */
function watchConnection() {
  window.addEventListener('offline', () => {
    document.body.classList.add('is-offline');
    toast("You're offline — check-ins and edits won't save until you reconnect", 'error');
  });
  window.addEventListener('online', () => {
    document.body.classList.remove('is-offline');
    toast('Back online');
  });
  if (!navigator.onLine) document.body.classList.add('is-offline');
}

applyManifestLink();
registerServiceWorker();
watchConnection();
if (isStandalone()) document.body.classList.add('is-installed');
// Safari fires no beforeinstallprompt, so the iOS nudge has to be offered on
// its own — after first paint, so it never competes with the login screen.
if (isIos()) window.addEventListener('load', () => setTimeout(maybeShowBanner, 1200));
