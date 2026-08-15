/**
 * GymBook service worker — what makes the app installable on Android and iOS.
 *
 * Two rules carry most of the behaviour:
 *
 *   1. Nothing under /api is ever written to a cache. Every one of those
 *      responses is tenant- and session-scoped, and a cached member list or
 *      dashboard would be both stale and readable by the next person to open
 *      the app on a shared front-desk device. They fail closed instead, with a
 *      JSON 503 the front end already knows how to render.
 *   2. Everything else is the app shell — static files that are identical for
 *      every gym — so it is cached and served shell-first. That is what lets an
 *      installed icon open instantly, and open at all with no network.
 *
 * Bump VERSION whenever a shell file changes in a way that must not wait for
 * revalidation; installs then re-run and the old caches are dropped.
 */
const VERSION = 'v3';
const SHELL_CACHE = `gymbook-shell-${VERSION}`;
const RUNTIME_CACHE = `gymbook-runtime-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, RUNTIME_CACHE]);

/**
 * The minimum needed to boot offline. Deliberately not the whole of /js: app.js
 * statically imports every view, so the runtime cache below picks all of them
 * up on the first online load — listing them here as well would just be a
 * second copy of that list to keep in step.
 */
const SHELL_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

/** Mirrors the server's /g/<slug> tenant prefix (see src/tenant.js) so path-
 * addressed gyms are classified the same as subdomain-addressed ones. */
const TENANT_PREFIX = /^\/g\/[a-z][a-z0-9-]{2,39}(?=\/|$)/;

const appPath = (pathname) => pathname.replace(TENANT_PREFIX, '') || '/';

const isApi = (pathname) => {
  const p = appPath(pathname);
  return p === '/api' || p.startsWith('/api/') || p.startsWith('/iclock');
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, not addAll: one 404 (a renamed icon, say) would other-
      // wise reject the whole install and leave the app with no worker at all.
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {}),
        ),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Sent by js/pwa.js when the user accepts the "new version" prompt. */
self.addEventListener('message', (event) => {
  if (event.data === 'gymbook:skip-waiting') self.skipWaiting();
});

const offlineJson = () =>
  new Response(
    JSON.stringify({ error: "You're offline — reconnect to load the latest data.", code: 'offline' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );

/** Shell-first, with a background refresh so a deploy lands on the next open. */
async function staleWhileRevalidate(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      // `basic` excludes opaque cross-origin and error responses; caching a 404
      // or a redirect here would pin the failure until the next VERSION bump.
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // The refresh has to outlive the response we return, or the browser is free
  // to kill the worker the moment the cached copy is handed over and no update
  // ever completes.
  event.waitUntil(network);

  if (cached) return cached;
  return (await network) || Response.error();
}

/**
 * Every in-app URL resolves to the same index.html — the server's own SPA
 * fallback does this too, including for unknown and cancelled gyms, so serving
 * the cached shell for any navigation cannot show the wrong page.
 */
async function handleNavigation(event) {
  const shell = await caches.open(SHELL_CACHE);

  const fresh = fetch(event.request)
    .then((response) => {
      // A redirected response cannot legally satisfy a navigation out of the
      // cache later, so it must not be stored as the shell in the first place.
      if (response.ok && response.type === 'basic' && !response.redirected) {
        shell.put('/index.html', response.clone());
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(fresh);

  const cached = await shell.match('/index.html');
  if (cached) return cached;

  return (
    (await fresh) ||
    (await shell.match('/offline.html')) ||
    // Only reachable if even the offline page failed to precache. Still HTML,
    // because this is answering a navigation.
    new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><p>GymBook is offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (isApi(url.pathname)) {
    // Network-only, but answered rather than left to reject: a thrown
    // "Failed to fetch" surfaces as a blank view, while this 503 goes through
    // the app's normal ApiError path and says why.
    event.respondWith(fetch(request).catch(() => offlineJson()));
    return;
  }

  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  const isShell = SHELL_URLS.includes(appPath(url.pathname));
  event.respondWith(staleWhileRevalidate(event, isShell ? SHELL_CACHE : RUNTIME_CACHE));
});
