import { Router } from 'express';
import { ensureAdminAccount } from '../bootstrap.js';
import { config } from '../config.js';
import { tenantStorage } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { createTenant, findTenantBySlug, isValidSlug, tenantDbPath, RESERVED_SLUGS } from '../tenants.js';
import { addDays, parse, today } from '../validate.js';
import { billingRoutes } from './billing.js';

export const platformRoutes = Router();
platformRoutes.use('/billing', billingRoutes);

platformRoutes.post('/signup', (req, res) => {
  const body = parse(req.body, {
    slug: { type: 'string', required: true, min: 3, max: 40 },
    gym_name: { type: 'string', required: true, min: 2, max: 120 },
    admin_name: { type: 'string', required: true, min: 2, max: 80 },
    admin_email: { type: 'email', required: true },
    admin_password: { type: 'string', required: true, min: 8 },
    currency: { type: 'string', max: 8, default: 'INR' },
  });

  const slug = body.slug.toLowerCase();
  if (!isValidSlug(slug) || RESERVED_SLUGS.has(slug)) {
    throw badRequest('Choose a different gym address', { slug: 'not available' });
  }
  if (findTenantBySlug(slug)) throw conflict('That gym address is already taken');

  const tenant = createTenant({
    slug,
    displayName: body.gym_name,
    currency: body.currency,
    trialEndsOn: addDays(today(), config.trialDays),
  });

  const created = tenantStorage.run({ slug: tenant.slug, dbFile: tenantDbPath(tenant.slug) }, () =>
    ensureAdminAccount({ email: body.admin_email, password: body.admin_password, name: body.admin_name }),
  );

  res.status(201).json({
    slug: tenant.slug,
    admin_email: created?.email ?? body.admin_email,
  });
});
