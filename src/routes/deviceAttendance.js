import express, { Router } from 'express';
import { performCheckIn } from '../checkin.js';
import { get, tenantStorage } from '../db.js';
import {
  findTenantBySlug,
  findTenantSlugByDeviceSerial,
  tenantDbPath,
  touchDeviceLastSeen,
} from '../tenants.js';

/**
 * Raw wire protocol for eSSL/Realtime/ZKTeco-family fingerprint terminals
 * ("ADMS"/push protocol). Not officially published by any vendor — this is
 * a best-effort implementation of the commonly-observed shape. Every
 * request is logged in full before anything else, specifically so real
 * device traffic can be inspected and any mismatch fixed quickly; this is
 * expected to need at least one round of adjustment against real hardware.
 *
 * Mounted directly on the app at /iclock (see app.js), before resolveTenant:
 * the device's server-address setting may only accept a raw IP, so tenant
 * routing here goes through a registered device serial number (SN), not
 * the Host header.
 */
export const deviceAttendanceRoutes = Router();

// Body is plain text (tab-separated attendance lines), not JSON — parsed
// unconditionally since this router is mounted before the global
// express.json() and these devices don't reliably set Content-Type.
deviceAttendanceRoutes.use(express.text({ type: () => true, limit: '2mb' }));

function logDeviceRequest(label, req) {
  console.log(
    `[iclock] ${label} SN=${req.query.SN ?? '?'} query=${JSON.stringify(req.query)} ` +
      `body=${typeof req.body === 'string' ? req.body.slice(0, 2000) : ''}`,
  );
}

/** Resolves a device serial to its tenant, marking it as seen. Returns the
 * slug, or undefined for an unregistered device. */
function resolveDeviceTenant(serial) {
  const slug = findTenantSlugByDeviceSerial(serial);
  if (!slug) return undefined;
  touchDeviceLastSeen(serial);
  return slug;
}

/** Handshake/registration — the device's first call on connecting. */
deviceAttendanceRoutes.get('/cdata', (req, res) => {
  logDeviceRequest('GET /cdata (handshake)', req);
  const serial = String(req.query.SN || '');

  const slug = resolveDeviceTenant(serial);
  if (!slug) {
    // Unregistered device: ack plainly rather than erroring, to avoid a
    // retry storm — but this device won't be able to check anyone in until
    // its serial is registered via POST /api/devices.
    return res.type('text/plain').send('OK');
  }

  res.type('text/plain').send(
    [
      `GET OPTION FROM: ${serial}`,
      'Stamp=9999',
      'OpStamp=0',
      'ErrorDelay=60',
      'Delay=30',
      'TransFlag=TransData AttLog',
      'Realtime=1',
      'Encrypt=None',
    ].join('\n'),
  );
});

/** Heartbeat / command queue poll. We never queue commands in this pass. */
deviceAttendanceRoutes.get('/getrequest', (req, res) => {
  logDeviceRequest('GET /getrequest (heartbeat)', req);
  resolveDeviceTenant(String(req.query.SN || ''));
  res.type('text/plain').send('OK');
});

/** Attendance (and other table) uploads. */
deviceAttendanceRoutes.post('/cdata', (req, res) => {
  logDeviceRequest(`POST /cdata table=${req.query.table ?? '?'}`, req);
  const serial = String(req.query.SN || '');
  const slug = resolveDeviceTenant(serial);

  if (!slug) {
    console.log(`[iclock] upload from unregistered device SN=${serial}`);
    return res.type('text/plain').send('OK');
  }

  if (req.query.table !== 'ATTLOG') {
    // OPLOG/OPERLOG/etc. — not processed in this pass, just acked.
    return res.type('text/plain').send('OK');
  }

  // The full registry row, not just the slug: a punch is an attendance write,
  // and performCheckIn -> today() has to resolve in the gym's own timezone, not
  // the server's. Falls back safely for a device whose registry row has gone.
  const tenant = findTenantBySlug(slug);

  tenantStorage.run(
    {
      slug,
      dbFile: tenantDbPath(slug),
      timezone: tenant?.timezone || undefined,
      businessType: tenant?.business_type || 'gym',
    },
    () => {
      const lines = String(req.body || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        const fields = line.split('\t');
        const pin = Number(fields[0]);
        if (!Number.isInteger(pin)) continue;

        const member = get('SELECT * FROM members WHERE device_pin = ?', [pin]);
        if (!member) {
          console.log(`[iclock] no member enrolled with device_pin=${pin} (SN=${serial})`);
          continue;
        }
        try {
          performCheckIn(member, 'device');
        } catch (err) {
          // A member punching while frozen/expired etc. is an expected
          // outcome, not a protocol error — log and keep processing the
          // rest of the batch rather than failing the whole upload.
          console.log(`[iclock] check-in skipped for device_pin=${pin}: ${err.message}`);
        }
      }
    },
  );

  res.type('text/plain').send('OK');
});
