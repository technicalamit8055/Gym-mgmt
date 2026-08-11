import { Router } from 'express';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { hasTenantIcon, hasTenantLogo, tenantIconUrl, tenantLogoUrl } from './platform.js';

export const pwaRoutes = Router();

/** The app's own dark palette (see :root in public/css/app.css). Used for the
 * Android splash screen and the system UI tint around an installed window. */
const THEME_COLOR = '#0d1117';
const BRAND_NAME = 'GymBook';

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

/** GymBook's own mark, for the root domain and for gyms that have not uploaded
 * a logo. */
const DEFAULT_ICONS = [
  icon('/icons/icon-192.png', '192x192'),
  icon('/icons/icon-512.png', '512x512'),
  // Android crops icons to the launcher's own shape; the maskable pair keeps
  // the barbell inside the safe zone when it does.
  icon('/icons/maskable-192.png', '192x192', 'maskable'),
  icon('/icons/maskable-512.png', '512x512', 'maskable'),
];

/**
 * The icons this gym installs with — its own logo wherever it has one.
 *
 * `sizes: "any"` rather than a declared pixel size: these are uploaded images,
 * and a browser that finds the bitmap is not the size the manifest claimed
 * discards the icon and falls back. "any" is both honest and unconditionally
 * accepted, and browsers still check the real bitmap meets their minimum.
 */
function tenantIcons(tenant) {
  if (!tenant) return DEFAULT_ICONS;
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

  return DEFAULT_ICONS;
}

/**
 * Builds the manifest for whichever gym this request resolved to.
 *
 * Generated per request rather than served as a static file because a gym is
 * identified by address: two gyms on the same origin (/g/acme/, /g/pulse/)
 * would otherwise install as the same app, with the same name, and both would
 * launch into whichever one the static start_url named.
 */
function buildManifest(req) {
  // resolveTenant strips this prefix off req.url before we see it, so it is
  // the only remaining record of how this gym was addressed.
  const prefix = req.tenantPathPrefix || '';
  const tenant = req.tenant?.slug === DEFAULT_TENANT_SLUG ? null : req.tenant;
  const gymName = tenant?.gym_name || tenant?.display_name || config.gymName || BRAND_NAME;
  const icons = tenantIcons(tenant);
  // One icon per shortcut is all a launcher shows; the maskable duplicate would
  // only be a second copy of the same URL.
  const shortcutIcon = [icons.find((i) => i.purpose !== 'maskable') || icons[0]];

  return {
    // Per-gym, so installing a second gym on this origin adds a second app
    // rather than overwriting the first.
    id: `${prefix}/`,
    name: tenant ? `${gymName} — ${BRAND_NAME}` : `${BRAND_NAME} — Gym Management`,
    short_name: shortName(gymName),
    description:
      'Members, memberships, billing, check-ins, classes, trainers and equipment for your gym.',
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
    categories: ['business', 'productivity', 'health', 'fitness'],
    icons,
    // Long-press the home-screen icon on Android to reach these.
    shortcuts: [
      {
        name: 'Check-in desk',
        short_name: 'Check-in',
        url: `${prefix}/#/check-in`,
        icons: shortcutIcon,
      },
      {
        name: 'Members',
        url: `${prefix}/#/members`,
        icons: shortcutIcon,
      },
      {
        name: 'Memberships & billing',
        short_name: 'Billing',
        url: `${prefix}/#/billing`,
        icons: shortcutIcon,
      },
    ],
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
