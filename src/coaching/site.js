import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { all, get, getBusinessType, run, tenantStorage, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { IMAGE_MIMES, parseUploadDataUrl } from '../photo.js';
import { hasTenantLogo, tenantLogoUrl } from '../routes/platform.js';

/**
 * The institute website: the public page an institute's own domain opens on.
 *
 * Everything on it comes from two places — what the owner writes in the
 * editor (headline, results, testimonials, FAQs, contact details), stored as
 * one JSON document in site_settings, and what the institute already keeps in
 * CoachBook (its active courses with their lowest fee, its faculty). The
 * second half is read live, so a new course appears on the site the moment it
 * is created and an archived one disappears, with nobody editing the site.
 *
 * The page itself is drawn by the SPA (public/js/views/coaching/landingPage.js)
 * at "#/" on a custom domain. The server's part beyond the data is the <head>:
 * siteShellHtml() names the institute in index.html's title and share tags,
 * because WhatsApp and Google read those without running any JavaScript.
 */

export const SITE_SECTIONS = ['courses', 'results', 'faculty', 'testimonials', 'gallery', 'faq', 'enquiry'];

export const SITE_LIMITS = { highlights: 4, results: 24, testimonials: 12, faqs: 12, gallery: 12 };

/** A banner is shown wide, so it gets more room than an avatar. */
const MAX_IMAGE_BYTES = 1024 * 1024;

/* ── Validation ────────────────────────────────────────────────────────── */

const PHONE_RE = /^\+?[0-9][0-9\s()-]{5,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
/** One line: newlines folded, so a headline can never break the layout. */
const line = (value, max) => text(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, max);
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
const ids = (value) => [...new Set(list(value, 500).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/**
 * Cleans what the editor sent into the complete shape the site renders.
 *
 * Text is trimmed and capped rather than rejected — a long testimonial is
 * still a testimonial. Links, phone numbers and the email are the exception:
 * a wrong one would put a broken "Call" or "WhatsApp" button in front of every
 * parent, so those come back as field errors instead.
 */
export function normalizeSiteContent(input = {}) {
  const errors = {};
  const src = input && typeof input === 'object' ? input : {};
  const hero = src.hero ?? {};
  const about = src.about ?? {};
  const contact = src.contact ?? {};
  const social = src.social ?? {};
  const seo = src.seo ?? {};
  const sections = src.sections ?? {};

  const link = (value, field) => {
    let raw = line(value, 400);
    if (!raw) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // fall through to the error below
    }
    errors[field] = 'Enter a full web address, like https://…';
    return '';
  };
  const phone = (value, field) => {
    const raw = line(value, 24);
    if (raw && !PHONE_RE.test(raw)) errors[field] = 'Enter a phone number with digits only, like +91 98765 43210';
    return raw;
  };

  const content = {
    hero: {
      headline: line(hero.headline, 120),
      subheadline: text(hero.subheadline, 300),
      cta_label: line(hero.cta_label, 40) || 'Enquire now',
    },
    highlights: list(src.highlights, SITE_LIMITS.highlights)
      .map((item) => ({ value: line(item?.value, 16), label: line(item?.label, 48) }))
      .filter((item) => item.value || item.label),
    about: { title: line(about.title, 80), body: text(about.body, 3000) },
    // Faculty is the one section off unless asked for: it publishes staff
    // names, which the owner should choose to do rather than discover.
    sections: Object.fromEntries(
      SITE_SECTIONS.map((key) => [key, sections[key] === undefined ? key !== 'faculty' : Boolean(sections[key])]),
    ),
    show_fees: Boolean(src.show_fees),
    hidden_course_ids: ids(src.hidden_course_ids),
    hidden_faculty_ids: ids(src.hidden_faculty_ids),
    results: list(src.results, SITE_LIMITS.results)
      .map((item) => ({ name: line(item?.name, 80), achievement: line(item?.achievement, 80), year: line(item?.year, 12) }))
      .filter((item) => item.name),
    testimonials: list(src.testimonials, SITE_LIMITS.testimonials)
      .map((item) => ({ name: line(item?.name, 80), role: line(item?.role, 80), quote: text(item?.quote, 600) }))
      .filter((item) => item.name && item.quote),
    faqs: list(src.faqs, SITE_LIMITS.faqs)
      .map((item) => ({ q: line(item?.q, 200), a: text(item?.a, 1500) }))
      .filter((item) => item.q && item.a),
    contact: {
      phone: phone(contact.phone, 'contact.phone'),
      whatsapp: phone(contact.whatsapp, 'contact.whatsapp'),
      email: line(contact.email, 120),
      address: text(contact.address, 400),
      maps_url: link(contact.maps_url, 'contact.maps_url'),
      hours: line(contact.hours, 120),
    },
    social: {
      youtube: link(social.youtube, 'social.youtube'),
      instagram: link(social.instagram, 'social.instagram'),
      facebook: link(social.facebook, 'social.facebook'),
    },
    seo: { title: line(seo.title, 70), description: line(seo.description, 170) },
  };

  if (content.contact.email && !EMAIL_RE.test(content.contact.email)) errors['contact.email'] = 'Enter a valid email address';
  if (Object.keys(errors).length) throw badRequest('Some fields need attention', errors);
  return content;
}

/**
 * What a brand-new site starts with: the institute's own name and motto, and
 * the phone and address it already gave the WhatsApp assistant — so "Publish"
 * on an untouched editor still gives a page with a working Call button.
 */
export function defaultSiteContent(tenant) {
  const settings = get('SELECT institute_phone, director_phone, institute_address, maps_url FROM coaching_settings WHERE id = 1') ?? {};
  const name = tenant?.gym_name || tenant?.display_name || 'Our institute';
  const address = settings.institute_address || [tenant?.address_line, tenant?.city, tenant?.state, tenant?.pincode].filter(Boolean).join(', ');
  return normalizeSiteContent({
    hero: {
      headline: tenant?.tagline || `Welcome to ${name}`,
      subheadline: 'Expert faculty, regular tests and personal attention — in small batches that let every student keep up.',
    },
    sections: { faculty: false, results: true, testimonials: true, gallery: true, faq: true, courses: true, enquiry: true },
    contact: {
      phone: settings.institute_phone && PHONE_RE.test(settings.institute_phone) ? settings.institute_phone : '',
      whatsapp: settings.institute_phone && PHONE_RE.test(settings.institute_phone) ? settings.institute_phone : '',
      address,
      maps_url: /^https?:\/\//i.test(settings.maps_url || '') ? settings.maps_url : '',
    },
  });
}

/* ── Stored settings ───────────────────────────────────────────────────── */

function settingsRow() {
  return get('SELECT * FROM site_settings WHERE id = 1') ?? { enabled: 0, content: null };
}

/** Whether this institute's website is published. False for anything but CoachBook. */
export function siteEnabled() {
  if (getBusinessType() !== 'coaching') return false;
  return Boolean(settingsRow().enabled);
}

/** The saved content, or the defaults for a site nobody has edited yet. */
export function loadSiteContent(tenant) {
  const row = settingsRow();
  if (row.content) {
    try {
      // Re-normalised on the way out too: a field added since it was saved
      // comes back with its default rather than as undefined.
      return normalizeSiteContent(JSON.parse(row.content));
    } catch {
      // A row that no longer validates (a rule tightened since) still renders.
    }
  }
  return defaultSiteContent(tenant);
}

export function saveSite({ enabled, content }, user) {
  const row = settingsRow();
  const sets = ["updated_at = datetime('now')", 'updated_by = ?'];
  const params = [user?.id ?? null];
  if (content !== undefined) {
    sets.push('content = ?');
    params.push(JSON.stringify(normalizeSiteContent(content)));
  }
  if (enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(enabled ? 1 : 0);
    if (enabled && !row.enabled) sets.push("published_at = datetime('now')");
  }
  run(`UPDATE site_settings SET ${sets.join(', ')} WHERE id = 1`, params);
  return settingsRow();
}

export function siteStatus() {
  const row = settingsRow();
  return { enabled: Boolean(row.enabled), published_at: row.published_at ?? null, updated_at: row.updated_at ?? null };
}

/* ── Live data: courses and faculty ────────────────────────────────────── */

/** Every active course, with what the site needs to show for it. */
export function siteCourses() {
  return all(
    `SELECT c.id, c.name, c.code, c.target_exam, c.description,
            (SELECT MIN(f.total_fee) FROM fee_structures f WHERE f.course_id = c.id AND f.active = 1) AS fee_from,
            (SELECT COUNT(*) FROM academic_batches b WHERE b.course_id = c.id AND b.active = 1) AS batch_count
       FROM academic_courses c
      WHERE c.active = 1
      ORDER BY c.name COLLATE NOCASE`,
  );
}

/** Every active teacher. Only what a parent would read — never pay or contact details. */
export function siteFaculty() {
  return all(
    `SELECT id, name, qualification, specialization, bio
       FROM users
      WHERE role = 'trainer' AND active = 1
      ORDER BY name COLLATE NOCASE`,
  );
}

/* ── Pictures ──────────────────────────────────────────────────────────── */

function imageUrl(id) {
  const prefix = tenantStorage.getStore()?.pathPrefix ?? '';
  return `${prefix}/api/site/images/${id}`;
}

export function listSiteImages() {
  return all('SELECT id, kind, caption, sort_order, created_at FROM site_images ORDER BY kind, sort_order, id').map((image) => ({
    ...image,
    url: imageUrl(image.id),
  }));
}

/**
 * Stores a picture. The banner is one picture, so a new one replaces the old
 * in the same transaction; the gallery is capped.
 */
export function addSiteImage({ kind, data_url: dataUrl, caption }) {
  if (kind !== 'hero' && kind !== 'gallery') throw badRequest('Some fields need attention', { kind: 'must be hero or gallery' });
  const parsed = parseUploadDataUrl(dataUrl, { allowed: IMAGE_MIMES, maxBytes: MAX_IMAGE_BYTES, field: 'data_url' });
  if (!parsed) throw badRequest('Some fields need attention', { data_url: 'Choose a picture to upload' });

  return tx(() => {
    if (kind === 'hero') run("DELETE FROM site_images WHERE kind = 'hero'");
    else {
      const { n } = get("SELECT COUNT(*) AS n FROM site_images WHERE kind = 'gallery'");
      if (n >= SITE_LIMITS.gallery) throw conflict(`The gallery holds up to ${SITE_LIMITS.gallery} pictures — remove one first`);
    }
    const order = get('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM site_images WHERE kind = ?', [kind]).next;
    const info = run('INSERT INTO site_images (kind, mime, bytes, caption, sort_order) VALUES (?, ?, ?, ?, ?)', [
      kind,
      parsed.mime,
      parsed.bytes,
      line(caption, 120) || null,
      order,
    ]);
    const image = get('SELECT id, kind, caption, sort_order, created_at FROM site_images WHERE id = ?', [info.lastInsertRowid]);
    return { ...image, url: imageUrl(image.id) };
  });
}

export function removeSiteImage(id) {
  if (!run('DELETE FROM site_images WHERE id = ?', [id]).changes) throw notFound('No such picture');
}

export function getSiteImage(id) {
  return get('SELECT mime, bytes FROM site_images WHERE id = ?', [id]);
}

/* ── What the page draws ───────────────────────────────────────────────── */

/** The institute's own identity, as the page header shows it. */
export function siteInstitute(tenant) {
  return {
    name: tenant.gym_name || tenant.display_name,
    tagline: tenant.tagline || null,
    logo_url: hasTenantLogo(tenant) ? tenantLogoUrl(tenant.slug, tenant.logo_version || 1) : null,
    city: tenant.city || null,
  };
}

/**
 * Everything the public page needs, in one response: the institute, the
 * owner's content, and the live courses and faculty it chose to show.
 */
export function sitePayload(tenant) {
  const content = loadSiteContent(tenant);
  const hiddenCourses = new Set(content.hidden_course_ids);
  const hiddenFaculty = new Set(content.hidden_faculty_ids);
  const images = listSiteImages();

  return {
    institute: siteInstitute(tenant),
    content,
    courses: content.sections.courses
      ? siteCourses()
          .filter((course) => !hiddenCourses.has(course.id))
          .map(({ fee_from: feeFrom, ...course }) => ({ ...course, fee_from: content.show_fees ? feeFrom : null }))
      : [],
    faculty: content.sections.faculty
      ? siteFaculty()
          .filter((teacher) => !hiddenFaculty.has(teacher.id))
          .map(({ id, ...teacher }) => teacher)
      : [],
    hero_image_url: images.find((image) => image.kind === 'hero')?.url ?? null,
    gallery: content.sections.gallery
      ? images.filter((image) => image.kind === 'gallery').map(({ url, caption }) => ({ url, caption }))
      : [],
    currency: tenant.currency || 'INR',
  };
}

/* ── The HTML shell's <head> ───────────────────────────────────────────── */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let shellCache = null;

/** index.html, read once in production and on every call elsewhere so editing it needs no restart. */
function baseShell() {
  if (shellCache && process.env.NODE_ENV === 'production') return shellCache;
  shellCache = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  return shellCache;
}

/**
 * index.html with the institute's own title, description and share tags.
 *
 * A link to the institute pasted into WhatsApp, or found by Google, is read
 * from these tags without the page's JavaScript ever running — left alone,
 * every institute's site would preview as "GymBook — Gym Management".
 *
 * @param {object} tenant The registry row.
 * @param {object} options
 * @param {string} options.origin  "https://www.apex.com" — for absolute image URLs.
 * @param {string|null} options.canonical The address the site should be indexed under.
 */
export function siteShellHtml(tenant, { origin, canonical = null }) {
  const content = loadSiteContent(tenant);
  const name = tenant.gym_name || tenant.display_name;
  const title = content.seo.title || (content.hero.headline && content.hero.headline !== name ? `${name} — ${content.hero.headline}` : name);
  const description =
    content.seo.description || content.hero.subheadline || tenant.tagline || `${name}${tenant.city ? `, ${tenant.city}` : ''}`;
  const hero = get("SELECT id FROM site_images WHERE kind = 'hero' ORDER BY id DESC LIMIT 1");
  const prefix = tenantStorage.getStore()?.pathPrefix ?? '';
  const image = hero
    ? `${origin}${prefix}/api/site/images/${hero.id}`
    : hasTenantLogo(tenant)
      ? `${origin}${tenantLogoUrl(tenant.slug, tenant.logo_version || 1)}`
      : null;

  // Schema.org markup: what lets a search result show the institute's
  // address and phone directly under its name.
  const org = {
    '@context': 'https://schema.org',
    '@type': 'EducationalOrganization',
    name,
    description,
    ...(canonical ? { url: canonical } : {}),
    ...(image ? { image } : {}),
    ...(content.contact.phone ? { telephone: content.contact.phone } : {}),
    ...(content.contact.email ? { email: content.contact.email } : {}),
    ...(content.contact.address ? { address: content.contact.address } : {}),
    ...(() => {
      const sameAs = Object.values(content.social).filter(Boolean);
      return sameAs.length ? { sameAs } : {};
    })(),
  };

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(name)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : '',
    canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}" />` : '',
    canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}" />` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    // "<" escaped so no text an owner typed can close the script element.
    `<script type="application/ld+json">${JSON.stringify(org).replace(/</g, '\\u003c')}</script>`,
  ]
    .filter(Boolean)
    .join('\n    ');

  return baseShell()
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/>/, `<meta name="apple-mobile-web-app-title" content="${escapeHtml(name)}" />`)
    .replace('</head>', `    ${tags}\n  </head>`);
}
