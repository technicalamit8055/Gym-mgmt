/**
 * The "/g/<slug>" prefix this page was loaded under, or '' on a subdomain or
 * the root domain. Read once from the document URL — hash navigation never
 * changes the path, so this cannot go stale.
 */
export const pathPrefix = (/^\/g\/[a-z][a-z0-9-]{2,39}(?=\/|$)/.exec(window.location.pathname) || [''])[0];

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

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }
}

async function request(method, path, body, { token, anonymous = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const bearer = token ?? (anonymous ? null : session.token);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(`${pathPrefix}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // An explicit token means this call is not the gym session's — tearing that
  // session down over someone else's 401 would sign the user out of a gym
  // they are still validly signed in to.
  const ownsGymSession = !token && !anonymous;
  if (res.status === 401 && ownsGymSession && !path.startsWith('/auth/login')) {
    session.clear();
    window.dispatchEvent(new CustomEvent('gymbook:signed-out'));
    throw new ApiError(401, 'Your session expired — please sign in again');
  }

  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, payload.error || res.statusText, payload.details);
  return payload;
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
  billingStatus: () => request('GET', '/platform/billing/status'),
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
  platformUpdateTenant: (slug, payload) =>
    request('PATCH', `/platform/admin/tenants/${slug}`, payload, { token: platformSession.token }),
  platformDeleteTenant: (slug, payload) =>
    request('DELETE', `/platform/admin/tenants/${slug}`, payload, { token: platformSession.token }),
  platformIssuePasswordReset: (slug, payload) =>
    request('POST', `/platform/admin/tenants/${slug}/password-reset`, payload, {
      token: platformSession.token,
    }),
  platformAnalytics: () =>
    request('GET', '/platform/admin/analytics', undefined, { token: platformSession.token }),
  platformBackups: () =>
    request('GET', '/platform/admin/backups', undefined, { token: platformSession.token }),
  platformRunBackup: () =>
    request('POST', '/platform/admin/backups/run', {}, { token: platformSession.token }),

  dashboard: () => request('GET', '/dashboard'),

  members: (params) => request('GET', `/members${query(params)}`),
  member: (id) => request('GET', `/members/${id}`),
  createMember: (payload) => request('POST', '/members', payload),
  updateMember: (id, payload) => request('PATCH', `/members/${id}`, payload),
  deleteMember: (id) => request('DELETE', `/members/${id}`),

  plans: (params) => request('GET', `/plans${query(params)}`),
  createPlan: (payload) => request('POST', '/plans', payload),
  updatePlan: (id, payload) => request('PATCH', `/plans/${id}`, payload),
  deletePlan: (id) => request('DELETE', `/plans/${id}`),

  subscriptions: (params) => request('GET', `/subscriptions${query(params)}`),
  createSubscription: (payload) => request('POST', '/subscriptions', payload),
  freezeSubscription: (id) => request('POST', `/subscriptions/${id}/freeze`),
  resumeSubscription: (id) => request('POST', `/subscriptions/${id}/resume`),
  cancelSubscription: (id) => request('POST', `/subscriptions/${id}/cancel`),

  payments: (params) => request('GET', `/payments${query(params)}`),
  createPayment: (payload) => request('POST', '/payments', payload),
  paymentReceipt: (id) => request('GET', `/payments/${id}/receipt`),
  deletePayment: (id) => request('DELETE', `/payments/${id}`),

  attendance: (params) => request('GET', `/attendance${query(params)}`),
  checkIn: (payload) => request('POST', '/attendance/check-in', payload),
  checkOut: (payload) => request('POST', '/attendance/check-out', payload),

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
  exportUrl: (entity) => `${pathPrefix}/api/reports/export/${entity}`,
  download: async (entity) => {
    const res = await fetch(`${pathPrefix}/api/reports/export/${entity}`, {
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
  createSeat: (payload) => request('POST', '/seats', payload),
  bulkCreateSeats: (payload) => request('POST', '/seats/bulk', payload),
  updateSeat: (id, payload) => request('PATCH', `/seats/${id}`, payload),
  deleteSeat: (id) => request('DELETE', `/seats/${id}`),
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
  sendWhatsAppTest: (payload) => request('POST', '/whatsapp/send-test', payload),
  whatsappLogs: (params) => request('GET', `/whatsapp/logs${query(params)}`),
};
