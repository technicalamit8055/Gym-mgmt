const TOKEN_KEY = 'gymbook.token';
const USER_KEY = 'gymbook.user';

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

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && !path.startsWith('/auth/login')) {
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
  exportUrl: (entity) => `/api/reports/export/${entity}`,
  download: async (entity) => {
    const res = await fetch(`/api/reports/export/${entity}`, {
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
};
