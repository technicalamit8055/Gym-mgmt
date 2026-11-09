import { ApiError, session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { fitImage } from '../../photo.js';
import { confirmDialog, h, openModal, renderIcon, toast } from '../../ui.js';
import { isCoaching } from '../../vertical.js';
import { fill, section } from './common.js';
import { buildSite } from './sitePage.js';

// The public page lives in sitePage.js; app.js routes to it through here.
export { renderInstituteSite } from './sitePage.js';

/**
 * The institute website, and the editor that builds it.
 *
 * The website is what an institute's own domain opens on once it is published
 * (src/coaching/site.js): a single page with its courses, results, faculty,
 * testimonials, gallery, FAQs and an enquiry form that lands in Admissions.
 * The staff app moves to #/login on that domain, and students keep #/portal.
 *
 * buildSite() draws the page from one payload and is shared by both halves:
 * the public route feeds it GET /api/site, the editor's preview feeds it the
 * unsaved draft — so what the owner previews is exactly what parents see.
 */

const SECTION_LABELS = {
  courses: 'Courses',
  results: 'Results',
  faculty: 'Faculty',
  testimonials: 'Testimonials',
  gallery: 'Gallery',
  faq: 'FAQs',
  enquiry: 'Enquiry form',
};

/* ══════════════════════════════════════════════════════════ the editor ═══ */

/** Which error key the server uses for which control, for the toast. */
const ERROR_LABELS = {
  'contact.phone': 'Phone',
  'contact.whatsapp': 'WhatsApp number',
  'contact.email': 'Email',
  'contact.maps_url': 'Google Maps link',
  'social.youtube': 'YouTube link',
  'social.instagram': 'Instagram link',
  'social.facebook': 'Facebook link',
};

/**
 * "#/website" in the staff app: everything on the site, one card per section,
 * a sticky bar to save, publish and preview.
 */
export async function renderInstituteLandingManagement({ setActions }) {
  let data = await coaching.website();
  let draft = structuredClone(data.content);
  let dirty = false;

  const root = h('div', { class: 'grid site-editor' });
  // One in the page header, one in the sticky bar at the bottom — a node can
  // only sit in one place, so each gets its own and they move together.
  const saveButtons = [];
  const saveButton = () => {
    const button = h('button', { class: 'btn primary', type: 'button', disabled: !dirty, onclick: () => save() }, renderIcon('save', { size: 16 }), 'Save changes');
    saveButtons.push(button);
    return button;
  };
  const setSaveEnabled = (on) => {
    for (const button of saveButtons) button.disabled = !on;
  };
  const markDirty = () => {
    dirty = true;
    setSaveEnabled(true);
  };

  // Leaving with unsaved edits loses them; say so, the way a document editor would.
  const beforeUnload = (event) => {
    if (dirty && document.body.contains(root)) event.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);

  setActions(
    h('button', { class: 'btn ghost', type: 'button', onclick: () => openPreview() }, renderIcon('eye', { size: 16 }), 'Preview'),
    saveButton(),
  );

  async function save({ enabled } = {}) {
    setSaveEnabled(false);
    try {
      data = await coaching.saveWebsite({ content: draft, ...(enabled === undefined ? {} : { enabled }) });
      draft = structuredClone(data.content);
      dirty = false;
      toast(enabled === true ? 'Website published' : enabled === false ? 'Website unpublished' : 'Website saved');
      paint();
      return true;
    } catch (err) {
      setSaveEnabled(dirty);
      const first = err instanceof ApiError ? Object.entries(err.details || {})[0] : null;
      toast(first ? `${ERROR_LABELS[first[0]] || first[0]}: ${first[1]}` : err.message || 'Could not save', 'error');
      return false;
    }
  }

  /** The site as it would look with the unsaved draft, without saving it. */
  function draftPayload() {
    const hiddenCourses = new Set(draft.hidden_course_ids);
    const hiddenFaculty = new Set(draft.hidden_faculty_ids);
    return {
      institute: data.institute,
      content: draft,
      courses: draft.sections.courses
        ? data.courses.filter((c) => !hiddenCourses.has(c.id)).map((c) => ({ ...c, fee_from: draft.show_fees ? c.fee_from : null }))
        : [],
      faculty: draft.sections.faculty ? data.faculty.filter((f) => !hiddenFaculty.has(f.id)) : [],
      hero_image_url: data.images.find((i) => i.kind === 'hero')?.url ?? null,
      gallery: draft.sections.gallery ? data.images.filter((i) => i.kind === 'gallery') : [],
      currency: data.currency,
    };
  }

  function openPreview() {
    const frame = h('div', { class: 'site-preview-frame' }, buildSite(draftPayload(), { preview: true }));
    openModal({
      title: 'Website preview',
      subtitle: dirty ? 'Includes your unsaved changes' : 'What visitors see',
      icon: 'eye',
      className: 'site-preview-modal',
      wide: true,
      body: frame,
    });
    // openModal focuses the first input it finds — here the enquiry form at
    // the bottom of the page. Start the preview at the top instead.
    const input = document.activeElement;
    if (input && frame.contains(input)) input.blur();
    frame.scrollTop = 0;
  }

  /* ── Small form helpers, all writing straight into `draft` ── */

  const input = (obj, key, { placeholder = '', max = 200, type = 'text' } = {}) =>
    h('input', {
      type,
      value: obj[key] ?? '',
      placeholder,
      maxlength: max,
      oninput: (e) => {
        obj[key] = e.target.value;
        markDirty();
      },
    });
  const textarea = (obj, key, { placeholder = '', max = 1000, rows = 3 } = {}) =>
    h(
      'textarea',
      {
        placeholder,
        maxlength: max,
        rows,
        oninput: (e) => {
          obj[key] = e.target.value;
          markDirty();
        },
      },
      obj[key] ?? '',
    );
  const field = (label, control, { full = false, hint = null } = {}) =>
    h('label', { class: `field${full ? ' full' : ''}` }, h('span', {}, label), control, hint ? h('div', { class: 'muted site-hint' }, hint) : null);
  const check = (label, checked, onchange) =>
    h(
      'label',
      { class: 'cb-check' },
      h('input', {
        type: 'checkbox',
        checked,
        onchange: (e) => {
          onchange(e.target.checked);
          markDirty();
        },
      }),
      label,
    );
  const sectionToggle = (key) => check(`Show ${SECTION_LABELS[key].toLowerCase()} on the website`, draft.sections[key], (on) => (draft.sections[key] = on));

  /** Rows of small inputs — results, testimonials, FAQs, highlights. */
  function repeater(list, columns, { max, addLabel, emptyText, blank }) {
    const box = h('div', { class: 'site-repeater' });
    const repaint = () => {
      fill(
        box,
        list.length ? null : h('p', { class: 'muted site-hint' }, emptyText),
        ...list.map((item, index) =>
          h(
            'div',
            { class: 'site-repeater-row' },
            ...columns.map((col) =>
              col.textarea
                ? h('div', { class: `site-rep-col ${col.class || ''}` }, textarea(item, col.key, { placeholder: col.placeholder, max: col.max, rows: 2 }))
                : h('div', { class: `site-rep-col ${col.class || ''}` }, input(item, col.key, { placeholder: col.placeholder, max: col.max })),
            ),
            h(
              'button',
              {
                class: 'btn sm ghost icon-only',
                type: 'button',
                title: 'Remove',
                'aria-label': 'Remove',
                onclick: () => {
                  list.splice(index, 1);
                  markDirty();
                  repaint();
                },
              },
              renderIcon('trash', { size: 15 }),
            ),
          ),
        ),
        list.length < max
          ? h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  list.push({ ...blank });
                  markDirty();
                  repaint();
                  box.querySelector('.site-repeater-row:last-of-type input, .site-repeater-row:last-of-type textarea')?.focus();
                },
              },
              renderIcon('plus', { size: 15 }),
              addLabel,
            )
          : h('p', { class: 'muted site-hint' }, `That is the most this section holds (${max}).`),
      );
    };
    repaint();
    return box;
  }

  /** A banner or gallery picture, scaled down in the browser before upload. */
  function pickImage(kind) {
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await fitImage(file, { maxSide: kind === 'hero' ? 1920 : 1400, maxChars: 1_300_000 });
        const image = await coaching.addWebsiteImage({ kind, data_url: dataUrl });
        data.images = kind === 'hero' ? [...data.images.filter((i) => i.kind !== 'hero'), image] : [...data.images, image];
        toast(kind === 'hero' ? 'Banner picture updated' : 'Picture added');
        paint();
      } catch (err) {
        toast(err.message || 'Could not upload that picture', 'error');
      }
    });
    document.body.append(fileInput);
    fileInput.click();
    setTimeout(() => fileInput.remove(), 60_000);
  }

  function removeImage(image) {
    confirmDialog({
      title: 'Remove this picture?',
      message: 'It disappears from the website straight away.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        await coaching.removeWebsiteImage(image.id);
        data.images = data.images.filter((i) => i.id !== image.id);
        paint();
      },
    });
  }

  /* ── The cards ── */

  function statusCard() {
    const live = data.enabled;
    const domain = data.active_domain;
    const pending = data.domains.find((d) => d.status !== 'active');
    const siteUrl = domain ? `https://${domain}/` : data.platform_url ? `${data.platform_url}/#/site` : null;

    let where;
    if (domain) {
      where = h(
        'p',
        { class: 'site-status-text' },
        live ? 'Live at ' : 'Will open at ',
        h('a', { href: `https://${domain}/`, target: '_blank', rel: 'noopener' }, domain),
        '. Staff sign in at ',
        h('code', {}, `${domain}/#/login`),
        ' and students at ',
        h('code', {}, `${domain}/#/portal`),
        '.',
      );
    } else if (pending) {
      where = h(
        'p',
        { class: 'site-status-text' },
        h('strong', {}, pending.hostname),
        ' is waiting for its DNS records. Finish connecting it in ',
        h('a', { href: '#/settings' }, 'Settings → Custom domain'),
        '. Until then the website is at ',
        h('code', {}, siteUrl),
        '.',
      );
    } else {
      where = h(
        'p',
        { class: 'site-status-text' },
        data.custom_domains_available
          ? ['Connect your own domain (like ', h('strong', {}, 'www.yourinstitute.com'), ') in ', h('a', { href: '#/settings' }, 'Settings → Custom domain'), ' and the website opens there. ']
          : 'Custom domains are not switched on for this deployment yet. ',
        siteUrl ? ['Meanwhile you can share ', h('code', {}, siteUrl), '.'] : null,
      );
    }

    const toggle = h(
      'button',
      {
        class: `btn ${live ? 'ghost' : 'primary'}`,
        type: 'button',
        onclick: () => {
          if (!live) return save({ enabled: true });
          return confirmDialog({
            title: 'Unpublish the website?',
            message: domain ? `${domain} will show the sign-in screen again instead of the website.` : 'Visitors will no longer see it.',
            confirmLabel: 'Unpublish',
            danger: true,
            onConfirm: () => save({ enabled: false }),
          });
        },
      },
      renderIcon(live ? 'eyeOff' : 'globe', { size: 16 }),
      live ? 'Unpublish' : dirty ? 'Save & publish' : 'Publish website',
    );

    return h(
      'div',
      { class: `card site-status${live ? ' is-live' : ''}` },
      h('span', { class: 'site-status-icon' }, renderIcon('globe', { size: 24, stroke: 2 })),
      h(
        'div',
        { class: 'site-status-body' },
        h('div', { class: 'row', style: 'gap:8px;align-items:center' }, h('h3', { style: 'margin:0' }, 'Institute website'), h('span', { class: `badge ${live ? 'green' : 'grey'}` }, live ? 'Published' : 'Not published')),
        where,
      ),
      h(
        'div',
        { class: 'site-status-actions' },
        live && siteUrl ? h('a', { class: 'btn ghost', href: siteUrl, target: '_blank', rel: 'noopener' }, renderIcon('link', { size: 16 }), 'Open') : null,
        toggle,
      ),
    );
  }

  function heroCard() {
    const banner = data.images.find((i) => i.kind === 'hero');
    return section(
      'Top of the page',
      h(
        'div',
        {},
        h(
          'div',
          { class: 'form-grid' },
          field('Headline', input(draft.hero, 'headline', { placeholder: 'e.g. Kota’s trusted coaching for JEE & NEET', max: 120 }), { full: true }),
          field('Introduction', textarea(draft.hero, 'subheadline', { placeholder: 'One or two lines on what makes the institute different', max: 300 }), { full: true }),
          field('Button text', input(draft.hero, 'cta_label', { placeholder: 'Enquire now', max: 40 })),
        ),
        h(
          'div',
          { class: 'site-banner-pick' },
          banner ? h('img', { src: banner.url, alt: 'Banner picture' }) : h('div', { class: 'site-banner-empty' }, renderIcon('image', { size: 26 }), h('span', {}, 'No banner picture')),
          h(
            'div',
            {},
            h('p', { class: 'muted site-hint', style: 'margin-top:0' }, 'A wide photo of your classroom or building looks best. It is also the picture shown when the link is shared on WhatsApp.'),
            h(
              'div',
              { class: 'row', style: 'gap:8px' },
              h('button', { class: 'btn sm', type: 'button', onclick: () => pickImage('hero') }, renderIcon('upload', { size: 15 }), banner ? 'Replace picture' : 'Upload picture'),
              banner ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => removeImage(banner) }, 'Remove') : null,
            ),
          ),
        ),
        h('h4', { class: 'site-subhead' }, 'Highlights'),
        h('p', { class: 'muted site-hint' }, 'Up to four numbers shown under the banner, like “15+ years” or “1,200 selections”.'),
        repeater(draft.highlights, [
          { key: 'value', placeholder: '15+', max: 16, class: 'narrow' },
          { key: 'label', placeholder: 'Years of teaching', max: 48 },
        ], { max: 4, addLabel: 'Add a highlight', emptyText: 'No highlights yet.', blank: { value: '', label: '' } }),
      ),
      { icon: 'sparkle', subtitle: 'The first thing every visitor sees' },
    );
  }

  function aboutCard() {
    return section(
      'About the institute',
      h(
        'div',
        { class: 'form-grid' },
        field('Section title', input(draft.about, 'title', { placeholder: 'Why choose us', max: 80 }), { full: true }),
        field('About', textarea(draft.about, 'body', { placeholder: 'Your story, teaching approach, facilities…', max: 3000, rows: 6 }), { full: true, hint: 'Leave empty to leave this section out.' }),
      ),
      { icon: 'building' },
    );
  }

  function coursesCard() {
    const hidden = new Set(draft.hidden_course_ids);
    return section(
      'Courses',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('courses'), check('Show “fees from” on each course', draft.show_fees, (on) => (draft.show_fees = on))),
        data.courses.length
          ? h(
              'div',
              { class: 'site-pick-list' },
              ...data.courses.map((course) =>
                check(
                  [h('strong', {}, course.name), course.target_exam ? h('span', { class: 'muted' }, ` · ${course.target_exam}`) : null],
                  !hidden.has(course.id),
                  (on) => {
                    draft.hidden_course_ids = on ? draft.hidden_course_ids.filter((id) => id !== course.id) : [...draft.hidden_course_ids, course.id];
                  },
                ),
              ),
            )
          : h('p', { class: 'muted site-hint' }, 'No active courses yet. Add them in ', h('a', { href: '#/academics' }, 'Academics'), ' and they appear here.'),
      ),
      { icon: 'graduation', subtitle: 'Taken live from Academics — untick any you do not want listed' },
    );
  }

  function resultsCard() {
    return section(
      'Results',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('results')),
        repeater(draft.results, [
          { key: 'name', placeholder: 'Student name', max: 80 },
          { key: 'achievement', placeholder: 'AIR 312, JEE Advanced', max: 80 },
          { key: 'year', placeholder: '2026', max: 12, class: 'narrow' },
        ], { max: 24, addLabel: 'Add a result', emptyText: 'No results yet — toppers and selections build trust fast.', blank: { name: '', achievement: '', year: '' } }),
      ),
      { icon: 'trophy' },
    );
  }

  function facultyCard() {
    const hidden = new Set(draft.hidden_faculty_ids);
    return section(
      'Faculty',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('faculty')),
        data.faculty.length
          ? h(
              'div',
              { class: 'site-pick-list' },
              ...data.faculty.map((teacher) =>
                check(
                  [h('strong', {}, teacher.name), teacher.specialization ? h('span', { class: 'muted' }, ` · ${teacher.specialization}`) : null],
                  !hidden.has(teacher.id),
                  (on) => {
                    draft.hidden_faculty_ids = on ? draft.hidden_faculty_ids.filter((id) => id !== teacher.id) : [...draft.hidden_faculty_ids, teacher.id];
                  },
                ),
              ),
            )
          : h('p', { class: 'muted site-hint' }, 'No faculty yet. Add teachers in ', h('a', { href: '#/faculty' }, 'Faculty'), '.'),
        h('p', { class: 'muted site-hint' }, 'Shows name, subject, qualification and bio from each teacher’s profile — never their phone or pay.'),
      ),
      { icon: 'users', subtitle: 'Off by default — switch on once profiles are filled in' },
    );
  }

  function testimonialsCard() {
    return section(
      'Testimonials',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('testimonials')),
        repeater(draft.testimonials, [
          { key: 'name', placeholder: 'Name', max: 80, class: 'narrow-md' },
          { key: 'role', placeholder: 'Parent of a Class 12 student', max: 80, class: 'narrow-md' },
          { key: 'quote', placeholder: 'What they said', max: 600, textarea: true },
        ], { max: 12, addLabel: 'Add a testimonial', emptyText: 'No testimonials yet.', blank: { name: '', role: '', quote: '' } }),
      ),
      { icon: 'heart' },
    );
  }

  function galleryCard() {
    const pictures = data.images.filter((i) => i.kind === 'gallery');
    return section(
      'Gallery',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('gallery')),
        h(
          'div',
          { class: 'site-gallery-edit' },
          ...pictures.map((image) =>
            h(
              'div',
              { class: 'site-gallery-thumb' },
              h('img', { src: image.url, alt: '' }),
              h('button', { class: 'btn sm ghost icon-only', type: 'button', title: 'Remove', 'aria-label': 'Remove picture', onclick: () => removeImage(image) }, renderIcon('trash', { size: 14 })),
            ),
          ),
          pictures.length < 12
            ? h('button', { class: 'site-gallery-add', type: 'button', onclick: () => pickImage('gallery') }, renderIcon('plus', { size: 22 }), h('span', {}, 'Add picture'))
            : null,
        ),
        h('p', { class: 'muted site-hint' }, 'Classrooms, labs, library, events — up to 12 pictures. Pictures are saved as soon as you add them.'),
      ),
      { icon: 'image' },
    );
  }

  function faqCard() {
    return section(
      'Frequently asked questions',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('faq')),
        repeater(draft.faqs, [
          { key: 'q', placeholder: 'Question — e.g. Do you offer a free demo class?', max: 200 },
          { key: 'a', placeholder: 'Answer', max: 1500, textarea: true },
        ], { max: 12, addLabel: 'Add a question', emptyText: 'No questions yet.', blank: { q: '', a: '' } }),
      ),
      { icon: 'info' },
    );
  }

  function contactCard() {
    const c = draft.contact;
    const s = draft.social;
    return section(
      'Contact & enquiries',
      h(
        'div',
        {},
        h('div', { class: 'site-toggles' }, sectionToggle('enquiry')),
        h('p', { class: 'muted site-hint' }, 'Enquiries arrive in ', h('a', { href: '#/admissions' }, 'Admissions'), ' marked “Website”, and ring the staff bell.'),
        h(
          'div',
          { class: 'form-grid' },
          field('Phone', input(c, 'phone', { placeholder: '+91 98765 43210', max: 24, type: 'tel' })),
          field('WhatsApp number', input(c, 'whatsapp', { placeholder: '+91 98765 43210', max: 24, type: 'tel' })),
          field('Email', input(c, 'email', { placeholder: 'admissions@yourinstitute.com', max: 120, type: 'email' })),
          field('Office hours', input(c, 'hours', { placeholder: 'Mon–Sat, 9 AM – 7 PM', max: 120 })),
          field('Address', textarea(c, 'address', { max: 400, rows: 2 }), { full: true }),
          field('Google Maps link', input(c, 'maps_url', { placeholder: 'https://maps.app.goo.gl/…', max: 400 }), { full: true }),
          field('YouTube', input(s, 'youtube', { placeholder: 'https://youtube.com/@yourinstitute', max: 400 })),
          field('Instagram', input(s, 'instagram', { placeholder: 'https://instagram.com/yourinstitute', max: 400 })),
          field('Facebook', input(s, 'facebook', { placeholder: 'https://facebook.com/yourinstitute', max: 400 })),
        ),
      ),
      { icon: 'phone' },
    );
  }

  function seoCard() {
    return section(
      'Search & sharing',
      h(
        'div',
        { class: 'form-grid' },
        field('Page title', input(draft.seo, 'title', { placeholder: 'Apex Classes — JEE & NEET coaching in Kota', max: 70 }), {
          full: true,
          hint: 'Shown in Google results and the browser tab. Leave empty to use your name and headline.',
        }),
        field('Description', textarea(draft.seo, 'description', { placeholder: 'One sentence a parent would search for', max: 170, rows: 2 }), {
          full: true,
          hint: 'Shown under the title in Google and in WhatsApp link previews. Up to 170 characters.',
        }),
      ),
      { icon: 'search' },
    );
  }

  function paint() {
    // The footer's button is rebuilt below; keep only the header's.
    saveButtons.length = Math.min(saveButtons.length, 1);
    setSaveEnabled(dirty);
    fill(
      root,
      statusCard(),
      heroCard(),
      aboutCard(),
      coursesCard(),
      resultsCard(),
      facultyCard(),
      testimonialsCard(),
      galleryCard(),
      faqCard(),
      contactCard(),
      seoCard(),
      h('div', { class: 'site-editor-foot' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => openPreview() }, renderIcon('eye', { size: 16 }), 'Preview'), saveButton()),
    );
  }

  paint();
  return root;
}

/* ════════════════════════════════════════════════════ settings pointer ═══ */

/** On the Settings page, next to the custom domain card: where the website lives. */
export function instituteLandingSettingsCard(_tenant, domains, { isAdmin } = {}) {
  if (!isCoaching()) return null;
  const domain = domains?.items?.find((d) => d.status === 'active')?.hostname;
  return h(
    'div',
    { class: 'card stg-card' },
    h(
      'div',
      { class: 'stg-head' },
      h('span', { class: 'stg-head-icon tone-blue' }, renderIcon('globe', { size: 24, stroke: 2 })),
      h('div', { class: 'stg-head-text' }, h('h3', {}, 'Institute website')),
    ),
    h(
      'p',
      { class: 'muted', style: 'margin:0 0 14px' },
      domain
        ? ['Publish a website for parents and students at ', h('strong', {}, domain), ' — courses, results, faculty and an enquiry form that feeds Admissions.']
        : 'A website for parents and students — courses, results, faculty and an enquiry form that feeds Admissions. Connect a custom domain below and it opens there.',
    ),
    isAdmin || session.can('admin', 'manager')
      ? h('a', { class: 'btn', href: '#/website' }, renderIcon('edit', { size: 15 }), 'Edit website')
      : h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'Only an admin or manager can edit the website.'),
  );
}
