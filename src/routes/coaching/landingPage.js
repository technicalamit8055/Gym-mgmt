import { Router } from 'express';
import { requireRole } from '../../auth.js';
import {
  addSiteImage,
  listSiteImages,
  loadSiteContent,
  removeSiteImage,
  saveSite,
  siteCourses,
  siteFaculty,
  siteInstitute,
  sitePayload,
  siteStatus,
} from '../../coaching/site.js';
import { DEFAULT_TENANT_SLUG } from '../../config.js';
import { listDomainsForTenant, serializeDomain, setupInfo } from '../../customDomains.js';
import { tenantPlatformUrl } from '../../tenant.js';
import { requireModule } from '../../verticals.js';
import { idParam } from './shared.js';

/**
 * The website editor's API, under /api/coaching/website (requireAuth comes
 * from the coaching router). Admins and managers only: what is published here
 * is the institute's public face.
 *
 * Publishing changes what the institute's custom domain opens on — the staff
 * sign-in moves to #/login there — so the response always carries the domain
 * state for the editor to explain exactly that.
 */
export const coachingLandingRoutes = Router();
coachingLandingRoutes.use('/website', requireModule('batches'), requireRole('admin', 'manager'));

function domainState(req) {
  const slug = req.tenant?.slug;
  const domains = slug && slug !== DEFAULT_TENANT_SLUG ? listDomainsForTenant(slug).map(serializeDomain) : [];
  return {
    custom_domains_available: setupInfo().enabled,
    domains,
    active_domain: domains.find((domain) => domain.status === 'active')?.hostname ?? null,
    platform_url: slug && slug !== DEFAULT_TENANT_SLUG ? tenantPlatformUrl(req, slug) : null,
  };
}

function editorState(req) {
  return {
    ...siteStatus(),
    // For the editor's preview, which draws the page from the unsaved draft.
    institute: siteInstitute(req.tenant),
    currency: req.tenant.currency || 'INR',
    content: loadSiteContent(req.tenant),
    images: listSiteImages(),
    // Every active course and teacher, hidden or not — the editor ticks them.
    courses: siteCourses(),
    faculty: siteFaculty().map(({ id, name, qualification, specialization }) => ({ id, name, qualification, specialization })),
    ...domainState(req),
  };
}

coachingLandingRoutes.get('/website', (req, res) => {
  res.json(editorState(req));
});

/** Saves the content and/or the published switch. Either may be sent alone. */
coachingLandingRoutes.put('/website', (req, res) => {
  const { enabled, content } = req.body ?? {};
  saveSite({ enabled: enabled === undefined ? undefined : Boolean(enabled), content }, req.user);
  console.warn(
    `[site] "${req.tenant?.slug}" website ${enabled === undefined ? 'saved' : enabled ? 'published' : 'unpublished'} by ${req.user.email}`,
  );
  res.json(editorState(req));
});

/** Exactly what the public page would get, whether or not it is published yet. */
coachingLandingRoutes.get('/website/preview', (req, res) => {
  res.json(sitePayload(req.tenant));
});

coachingLandingRoutes.post('/website/images', (req, res) => {
  res.status(201).json(addSiteImage(req.body ?? {}));
});

coachingLandingRoutes.delete('/website/images/:id', (req, res) => {
  removeSiteImage(idParam(req));
  res.json({ ok: true });
});
