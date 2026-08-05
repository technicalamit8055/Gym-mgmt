import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { conflict, notFound } from '../errors.js';
import { findTenantSlugByDeviceSerial, listDevicesForTenant, registerDevice, removeDevice } from '../tenants.js';
import { parse } from '../validate.js';

export const deviceRoutes = Router();
deviceRoutes.use(requireAuth);

deviceRoutes.get('/', (req, res) => {
  res.json({ items: listDevicesForTenant(req.tenant.slug) });
});

deviceRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    serial: { type: 'string', required: true, min: 3, max: 60 },
    label: { type: 'string', max: 80 },
  });

  if (findTenantSlugByDeviceSerial(body.serial)) {
    throw conflict('That device serial is already registered');
  }

  registerDevice(req.tenant.slug, { serial: body.serial, label: body.label });
  res.status(201).json({ ok: true });
});

deviceRoutes.delete('/:serial', requireRole(...MANAGES_BILLING), (req, res) => {
  const changes = removeDevice(req.tenant.slug, req.params.serial);
  if (!changes) throw notFound('Device not found');
  res.json({ ok: true });
});
