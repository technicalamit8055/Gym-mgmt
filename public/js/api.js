/**
 * Whether this page is running inside the Capacitor member app (android/).
 * Capacitor injects window.Capacitor before any page script runs.
 */
export const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());

/**
 * The native app serves its bundled copy of public/ from https://localhost,
 * which has no API behind it — so it reads which server and gym to talk to
 * from native-config.json, written into the bundle by scripts/android.js.
 * Which store app it is comes from native-app.json, which only the CoachBook
 * build flavor bundles (android/app/src/coachbook/assets/public) — so a
 * release built in Android Studio cannot pick up the other app's identity.
 */
const nativeConfig = isNativeApp ? await loadNativeConfig() : null;

async function readBundled(file) {
  try {
    const res = await fetch(file);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function loadNativeConfig() {
  const [config, app] = await Promise.all([readBundled('/native-config.json'), readBundled('/native-app.json')]);
  return { ...config, app: app.app };
}

const nativeServer = String(nativeConfig?.serverUrl || '').replace(/\/+$/, '');

/** Whether the app was built with Firebase (android/app/google-services.json),
 * which push notifications need — scripts/android.js records it. */
export const nativePushConfigured = isNativeApp && nativeConfig?.push !== false;

/** True in the CoachBook app: the students' app, which finds coaching
 * institutes only. False in GymVym, which serves every gym, and on the web. */
export const coachBookApp = isNativeApp && nativeConfig?.app === 'coachbook';

/** The store app's own name, for "Settings › Apps › …" and the like. */
export const nativeAppName = coachBookApp ? 'CoachBook' : 'GymVym';

const SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

/**
 * Which gym the native app is for. The store build serves every gym, so the
 * member picks theirs on the "find your gym" screen and it is remembered on
 * the phone. A gym's own white-label build has `gymSlug` in its config
 * instead, and never offers the finder.
 */
export const gymLocked = isNativeApp && SLUG_RE.test(nativeConfig?.gymSlug || '');

const SELECTED_GYM_KEY = 'gymbook.app.gym';
const RECENT_GYMS_KEY = 'gymbook.app.recentGyms';

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

const validGym = (gym) => Boolean(gym && typeof gym === 'object' && SLUG_RE.test(gym.slug));

/** The gym this app is pointed at: { slug, gym_name, gym_code, logo_url,
 * address_text } as the finder last saw it, or null before one is chosen. */
export const selectedGym = !isNativeApp
  ? null
  : gymLocked
    ? { slug: nativeConfig.gymSlug }
    : validGym(readJson(SELECTED_GYM_KEY))
      ? readJson(SELECTED_GYM_KEY)
      : null;

/** True while the store app has no gym yet — everything but the finder waits. */
export const needsGymChoice = isNativeApp && !selectedGym;

/**
 * The "/g/<slug>" prefix this page was loaded under, or '' on a subdomain or
 * the root domain. Read once from the document URL — hash navigation never
 * changes the path, so this cannot go stale. In the native app the gym comes
 * from the one chosen (or built in) instead, and is always addressed by path.
 */
export const pathPrefix = isNativeApp
  ? selectedGym
    ? `/g/${selectedGym.slug}`
    : ''
  : (/^\/g\/[a-z][a-z0-9-]{2,39}(?=\/|$)/.exec(window.location.pathname) || [''])[0];

/** Gyms this phone has opened before, newest first, for one-tap switching. */
export function recentGyms() {
  const list = readJson(RECENT_GYMS_KEY);
  return Array.isArray(list) ? list.filter(validGym) : [];
}

/**
 * Points the app at another gym. A reload rather than a re-render: the path
 * prefix, the per-gym session keys and every module that captured them are
 * read once at load, and a fresh start is the one way they all agree.
 */
export function chooseGym(gym) {
  const entry = {
    slug: gym.slug,
    gym_name: gym.gym_name,
    gym_code: gym.gym_code || null,
    logo_url: gym.logo_url || null,
    address_text: gym.address_text || null,
  };
  localStorage.setItem(SELECTED_GYM_KEY, JSON.stringify(entry));
  const recent = [entry, ...recentGyms().filter((g) => g.slug !== entry.slug)].slice(0, 5);
  localStorage.setItem(RECENT_GYMS_KEY, JSON.stringify(recent));
  reloadAt('/portal');
}

/** Back to the gym finder. The old gym's member session stays on the phone,
 * so coming back to it later does not mean signing in again. */
export function forgetGym() {
  localStorage.removeItem(SELECTED_GYM_KEY);
  reloadAt('/portal/find-gym');
}

/** Drops a gym from the recent list — one that has closed, say. */
export function removeRecentGym(slug) {
  localStorage.setItem(RECENT_GYMS_KEY, JSON.stringify(recentGyms().filter((g) => g.slug !== slug)));
}

function reloadAt(path) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${path}`);
  window.location.reload();
}

/**
 * Makes a server-relative URL ("/api/...", "/g/<slug>/api/...") absolute in
 * the native app, where relative URLs resolve against the bundled pages
 * instead of the server. Anything else — bundled assets, data: and blob:
 * URLs, and every URL on the web — is returned as is.
 */
export function serverUrl(url) {
  return nativeServer && typeof url === 'string' && /^\/(api|g)\//.test(url) ? nativeServer + url : url;
}

/**
 * The crossOrigin value for an image or video that gets drawn onto a canvas:
 * 'anonymous' when serverUrl() sends it cross-origin, or the canvas would be
 * tainted and refuse to export; null (no attribute) everywhere else.
 */
export const serverOrigin = (url) => (serverUrl(url) !== url ? 'anonymous' : null);

const blobBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Hands a fetched file (a PDF receipt, a study material) to the user. A
 * browser downloads it. The app's WebView ignores <a download>, so there the
 * file is written into Documents/GymVym through the Filesystem plugin, or —
 * on an Android that keeps Documents behind a storage permission — handed to
 * the share sheet, whose "Save to…" targets need none. Resolves to a line for
 * a toast saying where the file went, or null when there is nothing to say.
 */
export async function saveFile(blob, filename) {
  if (!isNativeApp) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return null;
  }
  const native = (plugin, method, options) => window.Capacitor.nativePromise(plugin, method, options);
  const data = await blobBase64(blob);
  try {
    await native('Filesystem', 'writeFile', { path: `GymVym/${filename}`, data, directory: 'DOCUMENTS', recursive: true });
    return `Saved to Documents/GymVym/${filename}`;
  } catch {
    const { uri } = await native('Filesystem', 'writeFile', { path: `share/${filename}`, data, directory: 'CACHE', recursive: true });
    try {
      await native('Share', 'share', { title: filename, files: [uri], dialogTitle: 'Save or open' });
    } catch (err) {
      if (!/cancel/i.test(String(err?.message ?? err))) throw err;
    }
    return null;
  }
}

/** The gym slug from the path prefix, or null when addressed by subdomain. */
export const pathSlug = pathPrefix ? pathPrefix.slice(3) : null;

/**
 * Which marketing site an unauthenticated root-domain visitor sees: SeatBook
 * at /library (and, once a domain exists, seatbook.*), GymBook everywhere
 * else. Read once from the real URL, not the hash — hash navigation never
 * changes it, so it cannot go stale mid-session; and it must be the real path
 * because the hash router only ever sees `''` on first load here.
 */
export const landingBrand =
  /^\/library(\/|$)/.test(window.location.pathname) || /^(www\.)?seatbook\./.test(window.location.host)
    ? 'library'
    : 'gym';

/** Absolute URL of a gym addressed by path, for links out of the landing page. */
export const gymPathUrl = (slug) => `${window.location.origin}/g/${slug}/`;

// Two gyms addressed by path share one origin, and therefore one localStorage.
// Without a per-gym suffix, opening /g/pulse/ would send Acme's token, the
// server would reject it as a cross-tenant replay, and the owner would appear
// to have been silently signed out of a gym they never left.
const SCOPE = pathSlug ? `.${pathSlug}` : '';
const TOKEN_KEY = `gymbook.token${SCOPE}`;
const USER_KEY = `gymbook.user${SCOPE}`;

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  get user() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY));
    } catch {
      return null;
    }
  },
  save(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
  can(...roles) {
    const user = this.user;
    return Boolean(user && roles.includes(user.role));
  },
  get managesBilling() {
    return this.can('admin', 'manager');
  },
};

/**
 * Writes a session into another gym's storage slot on this same origin.
 *
 * Signup happens on the root domain but provisions a gym that lives at
 * /g/<slug>/, which reads a different, slug-scoped key — so `session.save()`
 * here would drop the owner's brand-new token into the root's bucket, where
 * that gym will never look for it. Same-origin path mode only: a subdomain is
 * a separate origin with a separate localStorage, and the owner signs in there
 * once instead.
 */
export function saveSessionFor(slug, token, user) {
  localStorage.setItem(`gymbook.token.${slug}`, token);
  localStorage.setItem(`gymbook.user.${slug}`, JSON.stringify(user));
}

/**
 * A member's own portal session — a different person from whoever is signed
 * into the staff app on this same device, so it gets its own storage slot
 * (scoped by gym the same way `session` is) rather than sharing `session`'s.
 * A staff session and a member session can be signed in side by side without
 * either clobbering the other.
 */
const MEMBER_TOKEN_KEY = `gymbook.member.token${SCOPE}`;
const MEMBER_USER_KEY = `gymbook.member.user${SCOPE}`;

export const memberSession = {
  get token() {
    return localStorage.getItem(MEMBER_TOKEN_KEY);
  },
  get member() {
    try {
      return JSON.parse(localStorage.getItem(MEMBER_USER_KEY));
    } catch {
      return null;
    }
  },
  save(token, member) {
    localStorage.setItem(MEMBER_TOKEN_KEY, token);
    localStorage.setItem(MEMBER_USER_KEY, JSON.stringify(member));
  },
  clear() {
    localStorage.removeItem(MEMBER_TOKEN_KEY);
    localStorage.removeItem(MEMBER_USER_KEY);
  },
};

/**
 * The operator console's own credentials, kept apart from every gym session.
 *
 * A platform token and a gym token are different shapes that the server
 * refuses to accept for each other's routes, so mixing them into one slot
 * would only ever produce confusing 401s. Unscoped by path on purpose: the
 * console belongs to the platform, not to whichever gym you were last looking
 * at.
 */
const PLATFORM_TOKEN_KEY = 'gymbook.platform.token';

export const platformSession = {
  get token() {
    return localStorage.getItem(PLATFORM_TOKEN_KEY);
  },
  save(token) {
    localStorage.setItem(PLATFORM_TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(PLATFORM_TOKEN_KEY);
  },
};

/**
 * A partner shop's Shop panel session — the third credential that is nobody's
 * gym session. Unscoped by path for the same reason as the console's: a shop
 * belongs to no one gym.
 */
const SELLER_TOKEN_KEY = 'gymbook.seller.token';

export const sellerSession = {
  get token() {
    return localStorage.getItem(SELLER_TOKEN_KEY);
  },
  save(token) {
    localStorage.setItem(SELLER_TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(SELLER_TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }
}

/** Uploads a file as the raw request body — no JSON/base64 wrapping, so a
 * multi-megabyte GIF costs what it weighs. */
async function uploadFile(path, file, { token, method = 'PUT' } = {}) {
  const res = await fetch(serverUrl(`${pathPrefix}/api${path}`), {
    method,
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, payload.error || res.statusText, payload.details);
  return payload;
}

/**
 * `root` sends the call to the server's root address rather than this gym's
 * /g/<slug> one — for the platform-wide gym directory, which must keep
 * working when the remembered gym has since closed and its prefix 404s.
 */
async function request(method, path, body, { token, anonymous = false, member = false, root = false, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const bearer = token ?? (member ? memberSession.token : anonymous ? null : session.token);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(serverUrl(`${root ? '' : pathPrefix}/api${path}`), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  // An explicit token means this call is not the calling session's own —
  // tearing that session down over someone else's 401 would sign someone out
  // of a session they are still validly signed in to.
  const ownsGymSession = !token && !anonymous && !member;
  if (res.status === 401 && ownsGymSession && !path.startsWith('/auth/login')) {
    session.clear();
    window.dispatchEvent(new CustomEvent('gymbook:signed-out'));
    throw new ApiError(401, 'Your session expired — please sign in again');
  }
  const ownsMemberSession = !token && member;
  if (res.status === 401 && ownsMemberSession && !path.startsWith('/portal/login')) {
    memberSession.clear();
    window.dispatchEvent(new CustomEvent('gymbook:member-signed-out'));
    throw new ApiError(401, 'Your session expired — please sign in again');
  }

  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, payload.error || res.statusText, payload.details);
  // Food, water, a workout or a target saved: the phone's home-screen
  // widgets (widgets.js) show those.
  if (member && method !== 'GET' && FITNESS_PATH.test(path)) {
    window.dispatchEvent(new CustomEvent('gymbook:fitness-changed'));
  }
  return payload;
}

const FITNESS_PATH = /^\/portal\/(diets|workouts|nutrition|activities|wearables)(\/|$)/;

/**
 * A member POST answered as Server-Sent Events: every event is handed to
 * onEvent(name, data) as it arrives, and the promise resolves once the stream
 * ends. When the server answers with plain JSON instead — a refusal before it
 * started streaming, or the service worker's offline reply — that payload is
 * returned, or thrown as an ApiError, just as request() would. `signal`
 * stops it part way; the server then stops the answer and does not count it.
 */
async function streamRequest(path, body, onEvent, { signal } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (memberSession.token) headers.Authorization = `Bearer ${memberSession.token}`;
  const res = await fetch(serverUrl(`${pathPrefix}/api${path}`), { method: 'POST', headers, body: JSON.stringify(body), signal });

  if (res.status === 401) {
    memberSession.clear();
    window.dispatchEvent(new CustomEvent('gymbook:member-signed-out'));
    throw new ApiError(401, 'Your session expired — please sign in again');
  }
  if (!res.body || !String(res.headers.get('Content-Type')).startsWith('text/event-stream')) {
    const text = await res.text();
    const payload = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, payload.error || res.statusText, payload.details);
    return payload;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buffer += value.replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, JSON.parse(data.join('\n')));
    }
  }
}

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
};

export const api = {
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  me: () => request('GET', '/auth/me'),
  changePassword: (payload) => request('POST', '/auth/change-password', payload),

  // Redeeming a reset link. `anonymous`: the whole point is that whoever is
  // holding the link cannot sign in, and any stale token must not interfere.
  checkPasswordReset: (token) =>
    request('POST', '/auth/password-reset/check', { token }, { anonymous: true }),
  resetPassword: (token, newPassword) =>
    request('POST', '/auth/password-reset', { token, new_password: newPassword }, { anonymous: true }),

  // Platform: onboarding and the gym's own account. `anonymous` on the three
  // public ones so a stale token from a previous gym can't turn a signed-out
  // page into a 401 redirect loop.
  tenantContext: () => request('GET', '/platform/tenant', undefined, { anonymous: true }),
  slugAvailable: (slug) => request('GET', `/platform/slug-available${query({ slug })}`, undefined, { anonymous: true }),
  signup: (payload) => request('POST', '/platform/signup', payload, { anonymous: true }),
  updateGym: (payload) => request('PATCH', '/platform/tenant', payload),

  // The member app's "find your gym" — platform-wide, so always on the root.
  directory: {
    byCode: (code) => request('GET', `/platform/directory/code/${encodeURIComponent(code)}`, undefined, { anonymous: true, root: true }),
    search: (q, type) =>
      request('GET', `/platform/directory/search${query({ q, type })}`, undefined, { anonymous: true, root: true }),
    resolve: (text) =>
      request('GET', `/platform/directory/resolve${query({ text })}`, undefined, { anonymous: true, root: true }),
  },
  billingStatus: () => request('GET', '/platform/billing/status'),
  customDomains: () => request('GET', '/platform/domains'),
  inspectDomain: (hostname) => request('GET', `/platform/domains/inspect${query({ hostname })}`),
  addCustomDomain: (hostname) => request('POST', '/platform/domains', { hostname }),
  checkCustomDomain: (id) => request('POST', `/platform/domains/${id}/check`, {}),
  removeCustomDomain: (id) => request('DELETE', `/platform/domains/${id}`),
  subscribe: () => request('POST', '/platform/billing/subscribe'),

  // Operator console — platform token, never the gym session's.
  platformLogin: (email, password) =>
    request('POST', '/platform/admin/login', { email, password }, { anonymous: true }),
  platformTenants: (params) =>
    request('GET', `/platform/admin/tenants${query(params)}`, undefined, { token: platformSession.token }),
  platformTenant: (slug) =>
    request('GET', `/platform/admin/tenants/${slug}`, undefined, { token: platformSession.token }),
  platformSetStatus: (slug, payload) =>
    request('POST', `/platform/admin/tenants/${slug}/status`, payload, { token: platformSession.token }),
  platformSetMemberApp: (slug, allowed) =>
    request('POST', `/platform/admin/tenants/${slug}/member-app`, { allowed }, { token: platformSession.token }),
  platformSetBusinessType: (slug, payload) =>
    request('POST', `/platform/admin/tenants/${slug}/business-type`, payload, { token: platformSession.token }),
  platformUpdateTenant: (slug, payload) =>
    request('PATCH', `/platform/admin/tenants/${slug}`, payload, { token: platformSession.token }),
  platformDeleteTenant: (slug, payload) =>
    request('DELETE', `/platform/admin/tenants/${slug}`, payload, { token: platformSession.token }),
  platformIssuePasswordReset: (slug, payload) =>
    request('POST', `/platform/admin/tenants/${slug}/password-reset`, payload, {
      token: platformSession.token,
    }),
  platformDomains: () =>
    request('GET', '/platform/admin/domains', undefined, { token: platformSession.token }),
  platformAddDomain: (slug, payload) =>
    request('POST', `/platform/admin/tenants/${slug}/domains`, payload, { token: platformSession.token }),
  platformCheckDomain: (id) =>
    request('POST', `/platform/admin/domains/${id}/check`, {}, { token: platformSession.token }),
  platformUpdateDomain: (id, payload) =>
    request('PATCH', `/platform/admin/domains/${id}`, payload, { token: platformSession.token }),
  platformRemoveDomain: (id) =>
    request('DELETE', `/platform/admin/domains/${id}`, undefined, { token: platformSession.token }),
  platformAnalytics: () =>
    request('GET', '/platform/admin/analytics', undefined, { token: platformSession.token }),
  platformBackups: () =>
    request('GET', '/platform/admin/backups', undefined, { token: platformSession.token }),
  platformRunBackup: () =>
    request('POST', '/platform/admin/backups/run', {}, { token: platformSession.token }),

  // Platform-wide exercise catalogue, with demo images / GIFs / clips.
  platformCatalog: (params) =>
    request('GET', `/platform/admin/catalog/exercises${query(params)}`, undefined, { token: platformSession.token }),
  platformCreateExercise: (payload) =>
    request('POST', '/platform/admin/catalog/exercises', payload, { token: platformSession.token }),
  platformUpdateExercise: (id, payload) =>
    request('PATCH', `/platform/admin/catalog/exercises/${id}`, payload, { token: platformSession.token }),
  platformDeleteExercise: (id) =>
    request('DELETE', `/platform/admin/catalog/exercises/${id}`, undefined, { token: platformSession.token }),
  platformUploadExerciseMedia: (id, file) =>
    uploadFile(`/platform/admin/catalog/exercises/${id}/media`, file, { token: platformSession.token }),
  platformExerciseMediaFromUrl: (id, url) =>
    request('POST', `/platform/admin/catalog/exercises/${id}/media-url`, { url }, { token: platformSession.token }),
  platformClearExerciseMedia: (id) =>
    request('DELETE', `/platform/admin/catalog/exercises/${id}/media`, undefined, { token: platformSession.token }),
  platformImportExercises: (rows) =>
    request('POST', '/platform/admin/catalog/import', { rows }, { token: platformSession.token }),
  // One highlighted-body picture per muscle group, for the member's filter sheet.
  platformMuscles: () =>
    request('GET', '/platform/admin/catalog/muscles', undefined, { token: platformSession.token }),
  platformUploadMuscleMedia: (group, file) =>
    uploadFile(`/platform/admin/catalog/muscles/${group}/media`, file, { token: platformSession.token }),
  platformClearMuscleMedia: (group) =>
    request('DELETE', `/platform/admin/catalog/muscles/${group}/media`, undefined, { token: platformSession.token }),

  // Platform-wide food catalogue, synced into every gym's food library.
  platformFoods: (params) =>
    request('GET', `/platform/admin/catalog/foods${query(params)}`, undefined, { token: platformSession.token }),
  platformCreateFood: (payload) =>
    request('POST', '/platform/admin/catalog/foods', payload, { token: platformSession.token }),
  platformUpdateFood: (id, payload) =>
    request('PATCH', `/platform/admin/catalog/foods/${id}`, payload, { token: platformSession.token }),
  platformDeleteFood: (id) =>
    request('DELETE', `/platform/admin/catalog/foods/${id}`, undefined, { token: platformSession.token }),
  platformImportFoods: (rows, { verified = false } = {}) =>
    request('POST', '/platform/admin/catalog/foods/import', { rows, verified }, { token: platformSession.token }),
  platformBulkFoods: (ids, action) =>
    request('POST', '/platform/admin/catalog/foods/bulk', { ids, action }, { token: platformSession.token }),

  // Store & monetization: switches, the central supplement catalogue, member
  // delivery orders and what each gym is owed.
  platformMonetization: () => request('GET', '/platform/admin/monetization', undefined, { token: platformSession.token }),
  platformUpdateMonetization: (payload) => request('PUT', '/platform/admin/monetization', payload, { token: platformSession.token }),
  // CoachBook's AI receptionist: its price, and each institute's plan
  platformReceptionist: () => request('GET', '/platform/admin/receptionist', undefined, { token: platformSession.token }),
  platformUpdateReceptionistPricing: (payload) => request('PUT', '/platform/admin/receptionist/settings', payload, { token: platformSession.token }),
  platformRecordReceptionistPayment: (slug, payload) =>
    request('POST', `/platform/admin/receptionist/${encodeURIComponent(slug)}/payments`, payload, { token: platformSession.token }),
  platformAdjustReceptionist: (slug, payload) =>
    request('PATCH', `/platform/admin/receptionist/${encodeURIComponent(slug)}`, payload, { token: platformSession.token }),
  platformStoreProducts: (params) =>
    request('GET', `/platform/admin/store/products${query(params)}`, undefined, { token: platformSession.token }),
  // A scanned pack: the catalogue's own product, or details for a new one.
  // `params.vertical` picks the store's catalogue (a book's ISBN for coaching).
  platformStoreBarcode: (code, params) =>
    request('GET', `/platform/admin/store/barcode/${encodeURIComponent(code)}${query(params)}`, undefined, { token: platformSession.token }),
  platformCreateStoreProduct: (payload) => request('POST', '/platform/admin/store/products', payload, { token: platformSession.token }),
  platformUpdateStoreProduct: (id, payload) =>
    request('PATCH', `/platform/admin/store/products/${id}`, payload, { token: platformSession.token }),
  platformDeleteStoreProduct: (id) => request('DELETE', `/platform/admin/store/products/${id}`, undefined, { token: platformSession.token }),
  platformStoreOrders: (params) => request('GET', `/platform/admin/store/orders${query(params)}`, undefined, { token: platformSession.token }),
  platformUpdateStoreOrder: (id, payload) => request('PATCH', `/platform/admin/store/orders/${id}`, payload, { token: platformSession.token }),
  platformCommissions: () => request('GET', '/platform/admin/commissions', undefined, { token: platformSession.token }),
  platformAddProductImage: (id, file) =>
    uploadFile(`/platform/admin/store/products/${id}/images`, file, { token: platformSession.token, method: 'POST' }),
  platformDeleteProductImage: (id, imageId) =>
    request('DELETE', `/platform/admin/store/products/${id}/images/${imageId}`, undefined, { token: platformSession.token }),
  platformPrimaryProductImage: (id, imageId) =>
    request('POST', `/platform/admin/store/products/${id}/images/${imageId}/primary`, {}, { token: platformSession.token }),
  platformBanners: (params) => request('GET', `/platform/admin/store/banners${query(params)}`, undefined, { token: platformSession.token }),
  platformCreateBanner: (payload) => request('POST', '/platform/admin/store/banners', payload, { token: platformSession.token }),
  platformUpdateBanner: (id, payload) => request('PATCH', `/platform/admin/store/banners/${id}`, payload, { token: platformSession.token }),
  platformBannerImage: (id, file) => uploadFile(`/platform/admin/store/banners/${id}/image`, file, { token: platformSession.token }),
  platformClearBannerImage: (id) => request('DELETE', `/platform/admin/store/banners/${id}/image`, undefined, { token: platformSession.token }),
  platformDeleteBanner: (id) => request('DELETE', `/platform/admin/store/banners/${id}`, undefined, { token: platformSession.token }),
  platformBadges: () => request('GET', '/platform/admin/store/badges', undefined, { token: platformSession.token }),
  platformCreateBadge: (payload) => request('POST', '/platform/admin/store/badges', payload, { token: platformSession.token }),
  platformUpdateBadge: (id, payload) => request('PATCH', `/platform/admin/store/badges/${id}`, payload, { token: platformSession.token }),
  platformBadgeImage: (id, file) => uploadFile(`/platform/admin/store/badges/${id}/image`, file, { token: platformSession.token }),
  platformDeleteBadge: (id) => request('DELETE', `/platform/admin/store/badges/${id}`, undefined, { token: platformSession.token }),
  // Badges on the member app's bottom tabs.
  platformNavBadges: () => request('GET', '/platform/admin/nav-badges', undefined, { token: platformSession.token }),
  platformSetNavBadge: (tab, payload) => request('PUT', `/platform/admin/nav-badges/${tab}`, payload, { token: platformSession.token }),
  platformClearNavBadge: (tab) => request('DELETE', `/platform/admin/nav-badges/${tab}`, undefined, { token: platformSession.token }),
  platformNavBadgeImage: (tab, file) => uploadFile(`/platform/admin/nav-badges/${tab}/image`, file, { token: platformSession.token }),
  platformClearNavBadgeImage: (tab) =>
    request('DELETE', `/platform/admin/nav-badges/${tab}/image`, undefined, { token: platformSession.token }),
  platformRecordPayout: (slug, payload) =>
    request('POST', `/platform/admin/commissions/${slug}/payout`, payload, { token: platformSession.token }),
  // Partner shops: their accounts, the gyms each one serves, their payouts.
  platformSellers: () => request('GET', '/platform/admin/sellers', undefined, { token: platformSession.token }),
  platformCreateSeller: (payload) => request('POST', '/platform/admin/sellers', payload, { token: platformSession.token }),
  platformUpdateSeller: (id, payload) => request('PATCH', `/platform/admin/sellers/${id}`, payload, { token: platformSession.token }),
  platformDeleteSeller: (id) => request('DELETE', `/platform/admin/sellers/${id}`, undefined, { token: platformSession.token }),
  platformResetSellerPassword: (id) =>
    request('POST', `/platform/admin/sellers/${id}/reset-password`, {}, { token: platformSession.token }),
  platformSellerPayout: (id, payload) => request('POST', `/platform/admin/sellers/${id}/payout`, payload, { token: platformSession.token }),
  platformSellerProducts: (id) =>
    request('GET', `/platform/admin/store/products${query({ seller: id })}`, undefined, { token: platformSession.token }),

  // The Shop panel — a partner shop's own token, never a gym's or the console's.
  sellerLogin: (email, password) => request('POST', '/seller/login', { email, password }, { anonymous: true }),
  sellerMe: () => request('GET', '/seller/me', undefined, { token: sellerSession.token }),
  sellerUpdateMe: (payload) => request('PATCH', '/seller/me', payload, { token: sellerSession.token }),
  sellerChangePassword: (payload) => request('POST', '/seller/me/password', payload, { token: sellerSession.token }),
  sellerProducts: (params) => request('GET', `/seller/products${query(params)}`, undefined, { token: sellerSession.token }),
  sellerBarcode: (code) => request('GET', `/seller/barcode/${encodeURIComponent(code)}`, undefined, { token: sellerSession.token }),
  sellerCreateProduct: (payload) => request('POST', '/seller/products', payload, { token: sellerSession.token }),
  sellerUpdateProduct: (id, payload) => request('PATCH', `/seller/products/${id}`, payload, { token: sellerSession.token }),
  sellerDeleteProduct: (id) => request('DELETE', `/seller/products/${id}`, undefined, { token: sellerSession.token }),
  sellerAddProductImage: (id, file) => uploadFile(`/seller/products/${id}/images`, file, { token: sellerSession.token, method: 'POST' }),
  sellerDeleteProductImage: (id, imageId) =>
    request('DELETE', `/seller/products/${id}/images/${imageId}`, undefined, { token: sellerSession.token }),
  sellerPrimaryProductImage: (id, imageId) =>
    request('POST', `/seller/products/${id}/images/${imageId}/primary`, {}, { token: sellerSession.token }),
  sellerOrders: (params) => request('GET', `/seller/orders${query(params)}`, undefined, { token: sellerSession.token }),
  sellerUpdateOrder: (id, payload) => request('PATCH', `/seller/orders/${id}`, payload, { token: sellerSession.token }),

  dashboard: () => request('GET', '/dashboard'),

  members: (params) => request('GET', `/members${query(params)}`),
  member: (id) => request('GET', `/members/${id}`),
  createMember: (payload) => request('POST', '/members', payload),
  updateMember: (id, payload) => request('PATCH', `/members/${id}`, payload),
  deleteMember: (id) => request('DELETE', `/members/${id}`),
  // A temporary member-app password: 'whatsapp' sends it, 'show' returns it once.
  issueAppLogin: (id, deliver) => request('POST', `/members/${id}/app-login`, { deliver }),

  plans: (params) => request('GET', `/plans${query(params)}`),
  createPlan: (payload) => request('POST', '/plans', payload),
  updatePlan: (id, payload) => request('PATCH', `/plans/${id}`, payload),
  deletePlan: (id) => request('DELETE', `/plans/${id}`),

  subscriptions: (params) => request('GET', `/subscriptions${query(params)}`),
  createSubscription: (payload) => request('POST', '/subscriptions', payload),
  freezeSubscription: (id) => request('POST', `/subscriptions/${id}/freeze`),
  resumeSubscription: (id) => request('POST', `/subscriptions/${id}/resume`),
  cancelSubscription: (id) => request('POST', `/subscriptions/${id}/cancel`),
  updateSubscriptionDates: (id, payload) => request('PATCH', `/subscriptions/${id}/dates`, payload),

  payments: (params) => request('GET', `/payments${query(params)}`),
  createPayment: (payload) => request('POST', '/payments', payload),
  paymentReceipt: (id) => request('GET', `/payments/${id}/receipt`),
  deletePayment: (id) => request('DELETE', `/payments/${id}`),

  attendance: (params) => request('GET', `/attendance${query(params)}`),
  checkIn: (payload) => request('POST', '/attendance/check-in', payload),
  checkOut: (payload) => request('POST', '/attendance/check-out', payload),
  attendanceSettings: () => request('GET', '/attendance/settings'),
  updateAttendanceSettings: (payload) => request('PUT', '/attendance/settings', payload),

  sessions: (params) => request('GET', `/sessions${query(params)}`),
  createSession: (payload) => request('POST', '/sessions', payload),
  updateSession: (id, payload) => request('PATCH', `/sessions/${id}`, payload),
  deleteSession: (id) => request('DELETE', `/sessions/${id}`),

  biometricRegisterOptions: (payload) => request('POST', '/biometric/register/options', payload),
  biometricRegisterVerify: (payload) => request('POST', '/biometric/register/verify', payload),
  biometricAuthOptions: () => request('POST', '/biometric/authenticate/options'),
  biometricAuthVerify: (payload) => request('POST', '/biometric/authenticate/verify', payload),
  biometricCredentials: (memberId) => request('GET', `/biometric/${memberId}/credentials`),
  biometricDeleteCredential: (memberId, id) => request('DELETE', `/biometric/${memberId}/credentials/${id}`),

  qrCard: (memberId) => request('GET', `/qr/member/${memberId}`),
  qrReissue: (memberId) => request('POST', `/qr/member/${memberId}/reissue`),
  qrCards: (ids) => request('GET', `/qr/cards${query({ ids: ids.join(',') })}`),
  qrLookup: (code) => request('POST', '/qr/lookup', { code }),
  // The desk poster that opens the member app — see routes/qr.js.
  appQr: () => request('GET', '/qr/app'),
  qrCheckIn: (code) => request('POST', '/qr/check-in', { code }),

  classes: (params) => request('GET', `/classes${query(params)}`),
  schedule: (params) => request('GET', `/classes/schedule${query(params)}`),
  createClass: (payload) => request('POST', '/classes', payload),
  updateClass: (id, payload) => request('PATCH', `/classes/${id}`, payload),
  deleteClass: (id) => request('DELETE', `/classes/${id}`),

  bookings: (params) => request('GET', `/bookings${query(params)}`),
  createBooking: (payload) => request('POST', '/bookings', payload),
  updateBooking: (id, payload) => request('PATCH', `/bookings/${id}`, payload),

  equipment: (params) => request('GET', `/equipment${query(params)}`),
  createEquipment: (payload) => request('POST', '/equipment', payload),
  updateEquipment: (id, payload) => request('PATCH', `/equipment/${id}`, payload),
  deleteEquipment: (id) => request('DELETE', `/equipment/${id}`),

  staff: (params) => request('GET', `/staff${query(params)}`),
  createStaff: (payload) => request('POST', '/staff', payload),
  updateStaff: (id, payload) => request('PATCH', `/staff/${id}`, payload),

  devices: () => request('GET', '/devices'),
  createDevice: (payload) => request('POST', '/devices', payload),
  deleteDevice: (serial) => request('DELETE', `/devices/${encodeURIComponent(serial)}`),

  revenueReport: (params) => request('GET', `/reports/revenue${query(params)}`),
  attendanceReport: (params) => request('GET', `/reports/attendance${query(params)}`),
  growthReport: () => request('GET', '/reports/growth'),
  occupancyReport: (params) => request('GET', `/reports/occupancy${query(params)}`),
  pnlReport: (params) => request('GET', `/reports/pnl${query(params)}`),
  exportUrl: (entity) => serverUrl(`${pathPrefix}/api/reports/export/${entity}`),
  download: async (entity) => {
    const res = await fetch(serverUrl(`${pathPrefix}/api/reports/export/${entity}`), {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) throw new ApiError(res.status, 'Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${entity}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  },

  seats: (params) => request('GET', `/seats${query(params)}`),
  seatMap: (params) => request('GET', `/seats/map${query(params)}`),
  seatVacancy: (params) => request('GET', `/seats/vacancy${query(params)}`),
  liveSeatMap: () => request('GET', '/seats/live'),
  createSeat: (payload) => request('POST', '/seats', payload),
  bulkCreateSeats: (payload) => request('POST', '/seats/bulk', payload),
  updateSeat: (id, payload) => request('PATCH', `/seats/${id}`, payload),
  deleteSeat: (id) => request('DELETE', `/seats/${id}`),
  bulkDeleteSeats: (seatIds) => request('DELETE', '/seats/bulk', { seat_ids: seatIds }),
  allocateSeat: (id, payload) => request('POST', `/seats/${id}/allocate`, payload),
  releaseSeat: (id, payload) => request('POST', `/seats/${id}/release`, payload),
  transferSeat: (id, payload) => request('POST', `/seats/${id}/transfer`, payload),

  seatZones: () => request('GET', '/seats/zones'),
  createSeatZone: (payload) => request('POST', '/seats/zones', payload),
  updateSeatZone: (id, payload) => request('PATCH', `/seats/zones/${id}`, payload),
  deleteSeatZone: (id) => request('DELETE', `/seats/zones/${id}`),

  seatWaitlist: (params) => request('GET', `/seats/waitlist${query(params)}`),
  createWaitlistEntry: (payload) => request('POST', '/seats/waitlist', payload),
  updateWaitlistEntry: (id, payload) => request('PATCH', `/seats/waitlist/${id}`, payload),
  deleteWaitlistEntry: (id) => request('DELETE', `/seats/waitlist/${id}`),
  convertWaitlistEntry: (id, payload) => request('POST', `/seats/waitlist/${id}/convert`, payload),

  lockers: (params) => request('GET', `/lockers${query(params)}`),
  createLocker: (payload) => request('POST', '/lockers', payload),
  updateLocker: (id, payload) => request('PATCH', `/lockers/${id}`, payload),
  deleteLocker: (id) => request('DELETE', `/lockers/${id}`),
  allocateLocker: (id, payload) => request('POST', `/lockers/${id}/allocate`, payload),
  releaseLocker: (id) => request('POST', `/lockers/${id}/release`),

  expenses: (params) => request('GET', `/expenses${query(params)}`),
  expenseSummary: (params) => request('GET', `/expenses/summary${query(params)}`),
  createExpense: (payload) => request('POST', '/expenses', payload),
  updateExpense: (id, payload) => request('PATCH', `/expenses/${id}`, payload),
  deleteExpense: (id) => request('DELETE', `/expenses/${id}`),

  memberDocuments: (params) => request('GET', `/member-documents${query(params)}`),
  createMemberDocument: (payload) => request('POST', '/member-documents', payload),
  verifyMemberDocument: (id) => request('POST', `/member-documents/${id}/verify`),
  deleteMemberDocument: (id) => request('DELETE', `/member-documents/${id}`),

  whatsappStatus: () => request('GET', '/whatsapp/status'),
  whatsappConnect: () => request('POST', '/whatsapp/connect'),
  whatsappLogout: () => request('POST', '/whatsapp/logout'),
  whatsappSettings: () => request('GET', '/whatsapp/settings'),
  updateWhatsAppSettings: (payload) => request('PUT', '/whatsapp/settings', payload),
  sendWhatsAppReceipt: (paymentId, pdfBase64) =>
    request('POST', '/whatsapp/send-receipt', { payment_id: paymentId, pdf_base64: pdfBase64 }),
  sendWhatsAppIdCard: (memberId, imageBase64) =>
    request('POST', '/whatsapp/send-id-card', { member_id: memberId, image_base64: imageBase64 }),
  sendWhatsAppReminder: (payload) => request('POST', '/whatsapp/send-reminder', payload),
  sendWhatsAppBirthday: (memberId) => request('POST', '/whatsapp/send-birthday', { member_id: memberId }),
  sendWhatsAppTest: (payload) => request('POST', '/whatsapp/send-test', payload),
  whatsappLogs: (params) => request('GET', `/whatsapp/logs${query(params)}`),

  pushSettings: () => request('GET', '/notifications/settings'),
  updatePushSettings: (payload) => request('PUT', '/notifications/settings', payload),
  announcements: (params) => request('GET', `/notifications/announcements${query(params)}`),
  sendAnnouncement: (payload) => request('POST', '/notifications/announcements', payload),

  // Diet & workout programming, from the staff side. Templates use PUT rather
  // than PATCH because a routine is edited as a whole document — the day tree
  // that comes back replaces the one that was there.
  workoutTemplates: () => request('GET', '/workouts/templates'),
  workoutTemplate: (id) => request('GET', `/workouts/templates/${id}`),
  createWorkoutTemplate: (payload) => request('POST', '/workouts/templates', payload),
  updateWorkoutTemplate: (id, payload) => request('PUT', `/workouts/templates/${id}`, payload),
  deleteWorkoutTemplate: (id) => request('DELETE', `/workouts/templates/${id}`),
  assignWorkoutPlan: (payload) => request('POST', '/workouts/assign', payload),
  unassignWorkoutPlan: (memberId) => request('POST', `/workouts/unassign/${memberId}`),
  memberWorkouts: (memberId, params) => request('GET', `/workouts/members/${memberId}${query(params)}`),
  workoutLog: (id) => request('GET', `/workouts/logs/${id}`),
  exercises: (params) => request('GET', `/workouts/exercises${query(params)}`),
  // The AI coach in the template builder (src/routes/workouts.js).
  workoutCoachStatus: () => request('GET', '/workouts/coach/status'),
  workoutCoachReview: (payload, { signal } = {}) => request('POST', '/workouts/coach/review', payload, { signal }),
  createExercise: (payload) => request('POST', '/workouts/exercises', payload),
  deleteExercise: (id) => request('DELETE', `/workouts/exercises/${id}`),

  dietTemplates: () => request('GET', '/diets/templates'),
  dietTemplate: (id) => request('GET', `/diets/templates/${id}`),
  createDietTemplate: (payload) => request('POST', '/diets/templates', payload),
  updateDietTemplate: (id, payload) => request('PUT', `/diets/templates/${id}`, payload),
  deleteDietTemplate: (id) => request('DELETE', `/diets/templates/${id}`),
  assignDietPlan: (payload) => request('POST', '/diets/assign', payload),
  unassignDietPlan: (memberId) => request('POST', `/diets/unassign/${memberId}`),
  memberDiet: (memberId, params) => request('GET', `/diets/members/${memberId}${query(params)}`),
  memberDietDay: (memberId, date) => request('GET', `/diets/members/${memberId}/day${query({ date })}`),
  foods: (params) => request('GET', `/diets/foods${query(params)}`),
  createFood: (payload) => request('POST', '/diets/foods', payload),
  deleteFood: (id) => request('DELETE', `/diets/foods/${id}`),
  foodSearch: (params) => request('GET', `/diets/food-search${query(params)}`),
  selectFood: (ref) => request('POST', '/diets/food-search/select', { ref }),

  fitnessAddonSettings: () => request('GET', '/fitness-addons/settings'),
  updateFitnessAddonSettings: (payload) => request('PUT', '/fitness-addons/settings', payload),
  fitnessAddons: (params) => request('GET', `/fitness-addons${query(params)}`),
  memberFitnessAddon: (memberId) => request('GET', `/fitness-addons/members/${memberId}`),
  sellFitnessAddon: (payload) => request('POST', '/fitness-addons/subscribe', payload),
  cancelFitnessAddon: (id) => request('POST', `/fitness-addons/cancel/${id}`),
  setFitnessTrialCancelled: (memberId, cancelled) =>
    request('POST', `/fitness-addons/members/${memberId}/trial`, { cancelled }),

  // Store & Commissions: the platform's commission statement for this gym,
  // and the gym's own products sold at the desk.
  storeHub: {
    summary: () => request('GET', '/store-hub/summary'),
    commissions: (params) => request('GET', `/store-hub/commissions${query(params)}`),
    products: (params) => request('GET', `/store-hub/products${query(params)}`),
    barcode: (code) => request('GET', `/store-hub/barcode/${encodeURIComponent(code)}`),
    createProduct: (payload) => request('POST', '/store-hub/products', payload),
    updateProduct: (id, payload) => request('PATCH', `/store-hub/products/${id}`, payload),
    restock: (id, quantity) => request('POST', `/store-hub/products/${id}/restock`, { quantity }),
    deleteProduct: (id) => request('DELETE', `/store-hub/products/${id}`),
    sales: (params) => request('GET', `/store-hub/sales${query(params)}`),
    sell: (payload) => request('POST', '/store-hub/sales', payload),
    pickups: () => request('GET', '/store-hub/pickups'),
    pickupReceived: (id) => request('POST', `/store-hub/pickups/${id}/received`, {}),
    pickupCollected: (id) => request('POST', `/store-hub/pickups/${id}/collected`, {}),
  },

  // Member self-service portal. `anonymous` on login: a stale member token
  // from a previous member on this device must not turn a fresh sign-in
  // attempt into a 401 redirect loop. Every other call is `member: true`,
  // which reads memberSession.token instead of the staff session's.
  portal: {
    login: (identifier, password) => request('POST', '/portal/login', { identifier, password }, { anonymous: true }),
    // Email-code password setup / reset, before signing in.
    forgotPassword: (identifier) => request('POST', '/portal/password/forgot', { identifier }, { anonymous: true }),
    resetPassword: (payload) => request('POST', '/portal/password/reset', payload, { anonymous: true }),
    // A temporary password sent from the gym's WhatsApp — once a day.
    whatsappLogin: (identifier) => request('POST', '/portal/password/whatsapp', { identifier }, { anonymous: true }),
    // `token` lets the sign-in screen replace a temporary password before the
    // session is saved on this device.
    changePassword: (payload, { token } = {}) => request('POST', '/portal/password', payload, token ? { token } : { member: true }),
    me: () => request('GET', '/portal/me', undefined, { member: true }),
    updateMe: (payload) => request('PATCH', '/portal/me', payload, { member: true }),
    setPhoto: (photo) => request('PUT', '/portal/photo', { photo }, { member: true }),
    // Signed-in devices (Profile → Devices). `endSession('current')` is this one.
    sessions: () => request('GET', '/portal/sessions', undefined, { member: true }),
    endSession: (id) => request('DELETE', `/portal/sessions/${encodeURIComponent(id)}`, undefined, { member: true }),
    endOtherSessions: () => request('POST', '/portal/sessions/sign-out-others', {}, { member: true }),
    // Device-side state mirrored to the account (see memberSync.js).
    appState: (key) => request('GET', `/portal/state/${key}`, undefined, { member: true }),
    saveAppState: (key, value) => request('PUT', `/portal/state/${key}`, { value }, { member: true }),
    seat: () => request('GET', '/portal/seat', undefined, { member: true }),
    pass: () => request('GET', '/portal/pass', undefined, { member: true }),
    classes: (params) => request('GET', `/portal/classes${query(params)}`, undefined, { member: true }),
    bookClass: (id, payload) => request('POST', `/portal/classes/${id}/book`, payload, { member: true }),
    cancelBooking: (id) => request('DELETE', `/portal/classes/bookings/${id}`, undefined, { member: true }),
    payments: (params) => request('GET', `/portal/payments${query(params)}`, undefined, { member: true }),
    attendance: (params) => request('GET', `/portal/attendance${query(params)}`, undefined, { member: true }),
    plans: () => request('GET', '/portal/plans', undefined, { member: true }),

    // Diet & workout tracking. fitnessStatus() is the only one of these that
    // answers for a member without the add-on — every other call 402s, which
    // is what the Workout and Diet tabs check before painting anything.
    fitnessStatus: () => request('GET', '/portal/fitness/status', undefined, { member: true }),
    currentWorkout: () => request('GET', '/portal/workouts/current', undefined, { member: true }),
    saveWorkoutLog: (payload) => request('POST', '/portal/workouts/logs', payload, { member: true }),
    workoutLogs: (params) => request('GET', `/portal/workouts/logs${query(params)}`, undefined, { member: true }),
    workoutLog: (id) => request('GET', `/portal/workouts/logs/${id}`, undefined, { member: true }),
    updateWorkoutLog: (id, payload) => request('PUT', `/portal/workouts/logs/${id}`, payload, { member: true }),
    deleteWorkoutLog: (id) => request('DELETE', `/portal/workouts/logs/${id}`, undefined, { member: true }),
    personalRecords: () => request('GET', '/portal/workouts/prs', undefined, { member: true }),
    exercises: (params) => request('GET', `/portal/workouts/exercises${query(params)}`, undefined, { member: true }),
    exerciseHistory: (name) => request('GET', `/portal/workouts/exercise-history${query({ name })}`, undefined, { member: true }),
    // Ask Coach (public/js/coach.js): whether this gym has it and how many
    // questions are left today, and one question with the live session.
    coachStatus: () => request('GET', '/portal/coach/status', undefined, { member: true }),
    // Streamed: onEvent gets step / thought / answer / done / error as the
    // coach works (see the route in src/routes/portal.js).
    coachAskStream: (payload, onEvent, options) => streamRequest('/portal/coach/ask', payload, onEvent, options),
    // A spoken question as text, for the composer: { audio (base64), mime_type, screen }.
    coachTranscribe: (payload) => request('POST', '/portal/coach/transcribe', payload, { member: true }),
    // The AI workout generator: a draft plan to open in the plan builder.
    coachPlan: (payload) => request('POST', '/portal/coach/plan', payload, { member: true }),
    // The coach inside the plan editor: rates the draft, suggests exercises.
    coachPlanReview: (payload) => request('POST', '/portal/coach/plan-review', payload, { member: true }),
    // The same, streamed like coachAskStream, for the Ask Coach sheet.
    coachPlanReviewStream: (payload, onEvent, options) => streamRequest('/portal/coach/plan-review', payload, onEvent, options),
    // The member's own plans, and which plan (theirs or the trainer's) the
    // Workout tab follows. setActivePlan(null) goes back to the trainer's.
    routines: () => request('GET', '/portal/workouts/routines', undefined, { member: true }),
    routine: (id) => request('GET', `/portal/workouts/routines/${id}`, undefined, { member: true }),
    createRoutine: (payload) => request('POST', '/portal/workouts/routines', payload, { member: true }),
    copyRoutine: (payload) => request('POST', '/portal/workouts/routines/copy', payload, { member: true }),
    updateRoutine: (id, payload) => request('PUT', `/portal/workouts/routines/${id}`, payload, { member: true }),
    deleteRoutine: (id) => request('DELETE', `/portal/workouts/routines/${id}`, undefined, { member: true }),
    setActivePlan: (planId) => request('PUT', '/portal/workouts/active', { plan_id: planId }, { member: true }),
    // Plans passed between members: send one of your own by phone or member
    // ID; incoming ones arrive in routines().shared to preview, save or dismiss.
    shareRoutine: (id, recipient) => request('POST', `/portal/workouts/routines/${id}/share`, { recipient }, { member: true }),
    sharedRoutine: (shareId) => request('GET', `/portal/workouts/shared/${shareId}`, undefined, { member: true }),
    acceptSharedRoutine: (shareId, payload = {}) =>
      request('POST', `/portal/workouts/shared/${shareId}/accept`, payload, { member: true }),
    declineSharedRoutine: (shareId) => request('DELETE', `/portal/workouts/shared/${shareId}`, undefined, { member: true }),
    currentDiet: () => request('GET', '/portal/diets/current', undefined, { member: true }),
    dietDay: (date) => request('GET', `/portal/diets/daily${query({ date })}`, undefined, { member: true }),
    dietSummary: (params) => request('GET', `/portal/diets/summary${query(params)}`, undefined, { member: true }),
    addFoodEntry: (payload) => request('POST', '/portal/diets/entries', payload, { member: true }),
    deleteFoodEntry: (id) => request('DELETE', `/portal/diets/entries/${id}`, undefined, { member: true }),
    logWater: (payload) => request('POST', '/portal/diets/water', payload, { member: true }),
    foods: (params) => request('GET', `/portal/diets/foods${query(params)}`, undefined, { member: true }),
    foodSearch: (params) => request('GET', `/portal/diets/food-search${query(params)}`, undefined, { member: true }),
    selectFood: (ref) => request('POST', '/portal/diets/food-search/select', { ref }, { member: true }),
    barcodeFood: (code) => request('GET', `/portal/diets/barcode/${encodeURIComponent(code)}`, undefined, { member: true }),
    addBarcodeFood: (payload) => request('POST', '/portal/diets/barcode-foods', payload, { member: true }),
    addFavoriteFood: (payload) => request('POST', '/portal/diets/favorites', payload, { member: true }),
    removeFavoriteFood: (id) => request('DELETE', `/portal/diets/favorites/${id}`, undefined, { member: true }),
    // Meal plans saved from the coach, tracked food by food in Quick track.
    mealPlans: () => request('GET', '/portal/diets/meal-plans', undefined, { member: true }),
    saveMealPlan: (payload) => request('POST', '/portal/diets/meal-plans', payload, { member: true }),
    deleteMealPlan: (id) => request('DELETE', `/portal/diets/meal-plans/${id}`, undefined, { member: true }),
    // Own targets, the calculator, weigh-ins and activities outside the logger.
    nutrition: () => request('GET', '/portal/nutrition', undefined, { member: true }),
    saveNutrition: (payload) => request('PUT', '/portal/nutrition', payload, { member: true }),
    suggestNutrition: (payload) => request('POST', '/portal/nutrition/suggest', payload, { member: true }),
    weightLog: (params) => request('GET', `/portal/weight${query(params)}`, undefined, { member: true }),
    logWeight: (payload) => request('POST', '/portal/weight', payload, { member: true }),
    deleteWeight: (id) => request('DELETE', `/portal/weight/${id}`, undefined, { member: true }),
    activityTypes: () => request('GET', '/portal/activities/types', undefined, { member: true }),
    logActivity: (payload) => request('POST', '/portal/activities', payload, { member: true }),
    deleteActivity: (id) => request('DELETE', `/portal/activities/${id}`, undefined, { member: true }),
    // Wearables (healthConnect.js does the phone side). Each answers with the
    // whole summary: connections and the last week's days.
    wearables: () => request('GET', '/portal/wearables', undefined, { member: true }),
    connectWearable: (provider) => request('POST', `/portal/wearables/${provider}/connect`, undefined, { member: true }),
    syncWearable: (provider, days) => request('POST', `/portal/wearables/${provider}/sync`, { days }, { member: true }),
    disconnectWearable: (provider) => request('DELETE', `/portal/wearables/${provider}`, undefined, { member: true }),
    wearableExport: (provider) => request('GET', `/portal/wearables/${provider}/export`, undefined, { member: true }),

    // In-app payments: the add-on's online tiers and the store. Each checkout
    // returns the Razorpay order to open; each verify hands back what
    // Checkout reported so the server can check its signature.
    fitnessCheckout: (tier) => request('POST', '/portal/fitness/checkout', { tier }, { member: true }),
    fitnessVerify: (payload) => request('POST', '/portal/fitness/verify', payload, { member: true }),
    store: () => request('GET', '/portal/store', undefined, { member: true }),
    storeCheckout: (payload) => request('POST', '/portal/store/checkout', payload, { member: true }),
    storeVerify: (payload) => request('POST', '/portal/store/verify', payload, { member: true }),
    storeOrders: () => request('GET', '/portal/store/orders', undefined, { member: true }),

    // Push notifications and the notification center (see public/js/push.js).
    notifications: {
      config: () => request('GET', '/portal/notifications/config', undefined, { member: true }),
      subscribe: (subscription) => request('POST', '/portal/notifications/subscriptions', subscription, { member: true }),
      unsubscribe: (endpoint) => request('DELETE', '/portal/notifications/subscriptions', { endpoint }, { member: true }),
      // The Android app's FCM token, in place of a Web Push subscription.
      registerDevice: (body) => request('POST', '/portal/notifications/devices', body, { member: true }),
      unregisterDevice: (token) => request('DELETE', '/portal/notifications/devices', { token }, { member: true }),
      savePreferences: (prefs) => request('PUT', '/portal/notifications/preferences', prefs, { member: true }),
      list: (params) => request('GET', `/portal/notifications${query(params)}`, undefined, { member: true }),
      markRead: (ids) => request('POST', '/portal/notifications/read', ids ? { ids } : {}, { member: true }),
      test: () => request('POST', '/portal/notifications/test', {}, { member: true }),
      workoutStarted: (payload) => request('PUT', '/portal/notifications/active-workout', payload, { member: true }),
      workoutEnded: () => request('DELETE', '/portal/notifications/active-workout', undefined, { member: true }),
    },
    downloadReceipt: async (id) => {
      const res = await fetch(serverUrl(`${pathPrefix}/api/portal/payments/${id}/receipt`), {
        headers: { Authorization: `Bearer ${memberSession.token}` },
      });
      if (!res.ok) throw new ApiError(res.status, 'Could not download the receipt');
      return saveFile(await res.blob(), `Receipt_PAY-${String(id).padStart(5, '0')}.pdf`);
    },
  },
};

/** For a feature that keeps its own endpoint list beside this one (CoachBook's
 * coachingApi.js), so it shares the same auth, 401 and error handling. */
export { request as apiRequest, query as apiQuery };
