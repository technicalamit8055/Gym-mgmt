import { Router } from 'express';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { verticalFor } from '../verticals.js';
import { hasTenantIcon, hasTenantLogo, tenantIconUrl, tenantLogoUrl } from './platform.js';

export const pwaRoutes = Router();

/** The app's own dark palette (see :root in public/css/app.css). Used for the
 * Android splash screen and the system UI tint around an installed window.
 * Deliberately the same for both verticals — see the in-app theming
 * trade-off note in vertical.js; only the icon and copy switch. */
const THEME_COLOR = '#0d1117';

/**
 * short_name is what fits under a home-screen icon — about 12 characters
 * before Android and iOS start eliding. Cut on a word so "Powerhouse Fitness"
 * becomes "Powerhouse" rather than "Powerhouse F".
 */
function shortName(name) {
  if (name.length <= 12) return name;
  const cut = name.slice(0, 12);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 3 ? cut.slice(0, lastSpace) : cut).trim();
}

const icon = (src, sizes, purpose, type = 'image/png') => ({
  src,
  sizes,
  type,
  ...(purpose ? { purpose } : {}),
});

/** Each vertical's own mark, for the root domain and for any tenant that
 * has not uploaded a logo — GymBook's barbell or SeatBook's book, generated
 * by scripts/gen-icons.js and gen-icons-library.js respectively. */
function defaultIcons(iconDir) {
  return [
    icon(`${iconDir}/icon-192.png`, '192x192'),
    icon(`${iconDir}/icon-512.png`, '512x512'),
    // Android crops icons to the launcher's own shape; the maskable pair
    // keeps the mark inside the safe zone when it does.
    icon(`${iconDir}/maskable-192.png`, '192x192', 'maskable'),
    icon(`${iconDir}/maskable-512.png`, '512x512', 'maskable'),
  ];
}

/**
 * The icons this tenant installs with — its own logo wherever it has one.
 *
 * `sizes: "any"` rather than a declared pixel size: these are uploaded images,
 * and a browser that finds the bitmap is not the size the manifest claimed
 * discards the icon and falls back. "any" is both honest and unconditionally
 * accepted, and browsers still check the real bitmap meets their minimum.
 */
function tenantIcons(tenant, vertical) {
  if (!tenant) return defaultIcons(vertical.iconDir);
  const version = tenant.logo_version || 1;

  if (hasTenantIcon(tenant)) {
    const src = tenantIconUrl(tenant.slug, version);
    return [
      icon(src, 'any', undefined, tenant.icon_mime),
      // Safe as maskable because makeAppIcon() drew it with the launcher's
      // safe-zone padding already in place.
      icon(src, 'any', 'maskable', tenant.icon_mime),
    ];
  }

  if (hasTenantLogo(tenant)) {
    // Uploaded before app icons existed: usable on a home screen as-is, but
    // deliberately not offered as maskable — it has no safe-zone padding, so
    // an Android launcher would crop into the logo itself. Saving the logo
    // again produces a proper icon.
    return [icon(tenantLogoUrl(tenant.slug, version), 'any', undefined, tenant.logo_mime)];
  }

  return defaultIcons(vertical.iconDir);
}

/**
 * Builds the manifest for whichever gym this request resolved to.
 *
 * Generated per request rather than served as a static file because a gym is
 * identified by address: two gyms on the same origin (/g/acme/, /g/pulse/)
 * would otherwise install as the same app, with the same name, and both would
 * launch into whichever one the static start_url named.
 */
const DESCRIPTIONS = {
  gym: 'Members, memberships, billing, check-ins, classes, trainers and equipment for your gym.',
  library: 'Seats, shifts, passes, lockers, expenses and student records for your study hall.',
};

/** For the member-facing manifest — written for the person carrying the
 * phone, not the gym running it. */
const PORTAL_DESCRIPTIONS = {
  gym: 'Your digital membership pass, class schedule, payments and check-ins.',
  library: 'Your digital seat pass, shifts, payments and attendance.',
};

const CATEGORIES = {
  gym: ['business', 'productivity', 'health', 'fitness'],
  library: ['business', 'productivity', 'education'],
};

/** Long-press the home-screen icon on Android to reach these — the three
 * screens each vertical's owner opens most often. */
function shortcutLinks(vertical, prefix, icons) {
  if (vertical.key === 'library') {
    return [
      { name: 'Seat map', url: `${prefix}/#/seats` },
      { name: 'Students', url: `${prefix}/#/members` },
      { name: 'Fees', short_name: 'Fees', url: `${prefix}/#/billing` },
    ].map((s) => ({ ...s, icons }));
  }
  return [
    { name: 'Check-in desk', short_name: 'Check-in', url: `${prefix}/#/check-in` },
    { name: 'Members', url: `${prefix}/#/members` },
    { name: 'Memberships & billing', short_name: 'Billing', url: `${prefix}/#/billing` },
  ].map((s) => ({ ...s, icons }));
}

function buildManifest(req) {
  // resolveTenant strips this prefix off req.url before we see it, so it is
  // the only remaining record of how this gym was addressed.
  const prefix = req.tenantPathPrefix || '';
  const tenant = req.tenant?.slug === DEFAULT_TENANT_SLUG ? null : req.tenant;
  // 'gym' for the root domain and the dev/single-tenant install, same
  // fallback getBusinessType() itself uses — there is no real tenant here to
  // ask.
  const vertical = verticalFor(tenant?.business_type);
  const gymName = tenant?.gym_name || tenant?.display_name || config.gymName || vertical.brand;
  const icons = tenantIcons(tenant, vertical);
  // One icon per shortcut is all a launcher shows; the maskable duplicate would
  // only be a second copy of the same URL.
  const shortcutIcon = [icons.find((i) => i.purpose !== 'maskable') || icons[0]];

  return {
    // Per-gym, so installing a second gym on this origin adds a second app
    // rather than overwriting the first.
    id: `${prefix}/`,
    name: tenant ? `${gymName} — ${vertical.brand}` : `${vertical.brand} — ${vertical.tagline}`,
    short_name: shortName(gymName),
    description: DESCRIPTIONS[vertical.key] ?? DESCRIPTIONS.gym,
    // Straight to the dashboard for a real gym; the root domain has no gym to
    // show, so its install lands on the landing page instead.
    start_url: tenant ? `${prefix}/#/dashboard` : `${prefix}/`,
    scope: `${prefix}/`,
    display: 'standalone',
    // Ordered fallbacks for browsers that decline standalone; the last entry
    // keeps an install working rather than failing outright.
    display_override: ['standalone', 'minimal-ui', 'browser'],
    orientation: 'any',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    lang: 'en',
    dir: 'ltr',
    categories: CATEGORIES[vertical.key] ?? CATEGORIES.gym,
    icons,
    shortcuts: shortcutLinks(vertical, prefix, shortcutIcon),
  };
}

/**
 * Builds the manifest a *member* installs from the self-service portal.
 *
 * Deliberately its own manifest rather than reusing buildManifest(): the two
 * personas need different start_urls (a member opening their home-screen icon
 * must land on /#/portal, never the staff /#/dashboard, which would show them
 * a staff login screen they have no credentials for) and a distinct `id` so a
 * gym owner can install both the staff app and hand this one to members
 * without the second install overwriting the first. Everything that should
 * match — icons, theme — is shared via the same tenantIcons() the staff
 * manifest uses, so a member's icon is the same logo the gym uploaded.
 */
function buildPortalManifest(req) {
  const prefix = req.tenantPathPrefix || '';
  const tenant = req.tenant?.slug === DEFAULT_TENANT_SLUG ? null : req.tenant;
  const vertical = verticalFor(tenant?.business_type);
  const gymName = tenant?.gym_name || tenant?.display_name || config.gymName || vertical.brand;
  const name = `${gymName} Member`;
  const icons = tenantIcons(tenant, vertical);

  return {
    id: `${prefix}/portal`,
    name,
    short_name: shortName(name),
    description: PORTAL_DESCRIPTIONS[vertical.key] ?? PORTAL_DESCRIPTIONS.gym,
    start_url: `${prefix}/#/portal`,
    // Same scope (and so the same service worker) as the staff manifest —
    // only the id/start_url/name differ, which is what the manifest spec
    // uses to tell two related installable apps apart on one origin.
    scope: `${prefix}/`,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui', 'browser'],
    orientation: 'any',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    lang: 'en',
    dir: 'ltr',
    categories: CATEGORIES[vertical.key] ?? CATEGORIES.gym,
    icons,
  };
}

/**
 * Mounted ahead of the /api subscription gate on purpose: a gym whose trial
 * lapsed still needs its installed icon to open the page that takes payment.
 */
pwaRoutes.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  // Renaming a gym, or changing which address it is served at, has to reach an
  // already-installed app on its next launch rather than a week later.
  res.set('Cache-Control', 'no-cache');
  res.json(buildManifest(req));
});

pwaRoutes.get('/portal-manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'no-cache');
  res.json(buildPortalManifest(req));
});
