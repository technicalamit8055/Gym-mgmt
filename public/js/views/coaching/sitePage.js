import { api, ApiError, session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { h, money, renderIcon, toast } from '../../ui.js';

/**
 * The institute website itself — what a parent sees on the institute's own
 * domain (see src/coaching/site.js for where the data comes from, and
 * landingPage.js for the editor that writes it).
 *
 * Every graphic here is drawn from the institute's real data: the floating
 * cards in the hero quote its actual top result and course count, the
 * numbers that count up are the owner's own highlights. Nothing is invented
 * — a parent reading "AIR 312" must be reading the institute's claim, not
 * ours.
 *
 * Motion is decoration only: every animation is off under the visitor's
 * "reduce motion" setting, and the page reads the same without it.
 *
 * In-page links scroll instead of using "#id" anchors — the hash is the
 * app's router, and "#courses" would navigate away from the page.
 */

const digits = (value) => String(value || '').replace(/\D/g, '');

/** wa.me wants the country code; a bare 10-digit Indian mobile gets +91. */
function whatsappLink(number, currency, text) {
  let n = digits(number);
  if (n.length === 10 && (currency || 'INR') === 'INR') n = `91${n}`;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

const initialsOf = (name) =>
  String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

const WAVE =
  '<svg viewBox="0 0 1440 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0,52 C180,88 360,92 560,62 C760,32 900,6 1080,22 C1240,36 1340,64 1440,58 L1440,90 L0,90 Z" fill="currentColor"/></svg>';
const QUOTE =
  '<svg viewBox="0 0 48 36" aria-hidden="true"><path fill="currentColor" d="M0 36V22.6C0 9.9 6.4 2.4 19.1 0l1.8 4.2C14.3 6 11 9.8 10.6 15.6H19V36H0zm28.9 0V22.6C28.9 9.9 35.3 2.4 48 0l1.8 4.2c-6.6 1.8-9.9 5.6-10.3 11.4H48V36H28.9z"/></svg>';

/** "1,200+" → 0 → 1,200+, keeping whatever surrounds the number. */
function countUp(node, value, duration = 1400) {
  const match = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(value);
  if (!match || reducedMotion()) return;
  const [, before, numberText, after] = match;
  const target = Number(numberText.replace(/,/g, ''));
  const decimals = (numberText.split('.')[1] || '').length;
  const grouped = numberText.includes(',');
  const format = (n) =>
    grouped ? n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : n.toFixed(decimals);
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = `${before}${format(target * eased)}${after}`;
    if (t < 1) requestAnimationFrame(tick);
  };
  node.textContent = `${before}${format(0)}${after}`;
  requestAnimationFrame(tick);
}

/* ═══════════════════════════════════════════════════════════ the page ═══ */

/**
 * The website from a GET /api/site-shaped payload.
 *
 * @param {object} data
 * @param {object} options
 * @param {boolean} [options.preview] The editor's preview: inside a modal, and the form does not send.
 * @param {boolean} [options.draft] Not published yet: full page, but the form does not send.
 * @param {Node} [options.banner] Shown above the header (the "not published yet" note).
 */
export function buildSite(data, { preview = false, draft = false, banner = null } = {}) {
  const { institute, content } = data;
  const { contact } = content;
  const name = institute.name;
  const motion = !reducedMotion();
  const page = h('div', { class: `site${preview ? ' is-preview' : ' has-overlay-header'}${motion ? ' has-motion' : ''}` });

  /* ── Lifecycle: observers, timers and listeners, all undone together ── */
  const cleanups = [];
  const teardown = () => {
    while (cleanups.length) cleanups.pop()();
  };
  // The public page lives until the route changes; the preview until its
  // modal closes, which timers notice by the page leaving the document.
  if (!preview) {
    window.addEventListener('hashchange', teardown, { once: true });
    cleanups.push(() => window.removeEventListener('hashchange', teardown));
  }
  let seen = false;
  const gone = () => {
    if (page.isConnected) seen = true;
    else if (seen) teardown();
    return !page.isConnected;
  };

  const revealer =
    motion && 'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              entry.target.classList.add('in');
              revealer.unobserve(entry.target);
            }
          },
          { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
        )
      : null;
  if (revealer) cleanups.push(() => revealer.disconnect());
  /** Fades and lifts `node` into view the first time it scrolls in; `i` staggers siblings. */
  const rv = (node, i = 0) => {
    if (!node) return node;
    node.classList.add('rv');
    node.style.setProperty('--d', `${Math.min(i, 8) * 80}ms`);
    if (revealer) revealer.observe(node);
    else node.classList.add('in');
    return node;
  };

  const has = {
    courses: content.sections.courses && data.courses.length > 0,
    results: content.sections.results && content.results.length > 0,
    faculty: content.sections.faculty && data.faculty.length > 0,
    testimonials: content.sections.testimonials && content.testimonials.length > 0,
    gallery: content.sections.gallery && data.gallery.length > 0,
    faq: content.sections.faq && content.faqs.length > 0,
    enquiry: content.sections.enquiry,
  };
  const go = (id) => page.querySelector(`[data-site-section="${id}"]`)?.scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'start' });
  const wa = contact.whatsapp ? whatsappLink(contact.whatsapp, data.currency, `Hi ${name}, I would like to know more about your courses.`) : null;
  const enquire = () => go('contact');
  const exams = [...new Set(data.courses.map((c) => c.target_exam).filter(Boolean))];

  /* ── Header ── */
  const navItems = [
    content.about.body && ['about', 'About'],
    has.courses && ['courses', 'Courses'],
    has.results && ['results', 'Results'],
    has.faculty && ['faculty', 'Faculty'],
    has.gallery && ['gallery', 'Gallery'],
    has.faq && ['faq', 'FAQs'],
    ['contact', 'Contact'],
  ].filter(Boolean);

  const progress = h('div', { class: 'site-progress', 'aria-hidden': 'true' });
  const navLinks = navItems.map(([id, label]) => h('button', { type: 'button', class: 'site-nav-link', 'data-for': id, onclick: () => go(id) }, label));
  const mobileNav = h(
    'div',
    { class: 'site-mobile-nav', id: 'site-mobile-nav' },
    ...navItems.map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            header.classList.remove('open');
            menuBtn.setAttribute('aria-expanded', 'false');
            go(id);
          },
        },
        label,
        renderIcon('chevronRight', { size: 16 }),
      ),
    ),
    h('a', { class: 'site-btn ghost block', href: '#/portal' }, renderIcon('user', { size: 16 }), 'Student & parent login'),
    has.enquiry
      ? h(
          'button',
          {
            class: 'site-btn block',
            type: 'button',
            onclick: () => {
              header.classList.remove('open');
              enquire();
            },
          },
          content.hero.cta_label,
        )
      : null,
  );
  const menuBtn = h(
    'button',
    {
      class: 'site-menu-btn',
      type: 'button',
      'aria-label': 'Menu',
      'aria-expanded': 'false',
      'aria-controls': 'site-mobile-nav',
      onclick: () => {
        const open = header.classList.toggle('open');
        menuBtn.setAttribute('aria-expanded', String(open));
      },
    },
    h('span', { class: 'site-menu-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
  );
  const header = h(
    'header',
    { class: 'site-header' },
    h(
      'div',
      { class: 'site-wrap site-header-inner' },
      h(
        'button',
        { class: 'site-brand', type: 'button', onclick: () => page.scrollIntoView({ behavior: motion ? 'smooth' : 'auto' }) },
        institute.logo_url
          ? h('img', { class: 'site-logo', src: institute.logo_url, alt: '' })
          : h('span', { class: 'site-logo site-logo-mark' }, renderIcon('graduation', { size: 20 })),
        h('span', { class: 'site-brand-name' }, name),
      ),
      h('nav', { class: 'site-nav', 'aria-label': 'Sections' }, ...navLinks),
      h(
        'div',
        { class: 'site-header-actions' },
        h('a', { class: 'site-btn ghost sm site-hide-sm', href: '#/portal' }, renderIcon('user', { size: 15 }), 'Student login'),
        has.enquiry ? h('button', { class: 'site-btn sm site-hide-sm', type: 'button', onclick: enquire }, content.hero.cta_label) : null,
        menuBtn,
      ),
    ),
    mobileNav,
    progress,
  );

  /* ── Hero ── */
  const words = (content.hero.headline || name).split(/\s+/).filter(Boolean);
  const headline = h(
    'h1',
    { 'aria-label': content.hero.headline || name },
    ...words.map((word, i) => [h('span', { class: 'site-word', 'aria-hidden': 'true', style: `--d:${120 + i * 70}ms` }, word), ' ']),
  );

  const topResult = content.results[0];
  const floatCards = [
    topResult
      ? h(
          'div',
          { class: 'site-float-card c1' },
          h('span', { class: 'site-float-icon gold' }, renderIcon('trophy', { size: 18 })),
          h('div', {}, h('strong', {}, topResult.achievement || topResult.name), h('span', {}, topResult.achievement ? topResult.name : 'Our achiever')),
        )
      : content.highlights[0]
        ? h(
            'div',
            { class: 'site-float-card c1' },
            h('span', { class: 'site-float-icon gold' }, renderIcon('sparkle', { size: 18 })),
            h('div', {}, h('strong', {}, content.highlights[0].value), h('span', {}, content.highlights[0].label)),
          )
        : null,
    data.courses.length
      ? h(
          'div',
          { class: 'site-float-card c2' },
          h('span', { class: 'site-float-icon' }, renderIcon('graduation', { size: 18 })),
          h(
            'div',
            {},
            h('strong', {}, `${data.courses.length} program${data.courses.length === 1 ? '' : 's'}`),
            h('span', {}, exams.length ? exams.slice(0, 3).join(' · ') : 'Enrolling now'),
          ),
        )
      : null,
    contact.hours
      ? h('div', { class: 'site-float-card c3 pill' }, h('span', { class: 'site-live-dot' }), h('span', {}, contact.hours))
      : null,
  ];

  const orbitIcons = ['book', 'calculator', 'pencil', 'target', 'lamp', 'trophy'];
  const heroArt = data.hero_image_url
    ? h(
        'div',
        { class: 'site-hero-art has-photo' },
        h('div', { class: 'site-photo-frame' }, h('img', { src: data.hero_image_url, alt: `${name} campus` })),
        h('div', { class: 'site-photo-dots', 'aria-hidden': 'true' }),
        ...floatCards,
      )
    : h(
        'div',
        { class: 'site-hero-art', 'aria-hidden': 'true' },
        h('div', { class: 'site-ring r1' }),
        h('div', { class: 'site-ring r2' }),
        h(
          'div',
          { class: 'site-orbit' },
          ...orbitIcons.map((icon, i) => h('span', { class: 'site-orbit-chip', style: `--a:${(360 / orbitIcons.length) * i}deg` }, h('span', {}, renderIcon(icon, { size: 20 })))),
        ),
        h('div', { class: 'site-core' }, institute.logo_url ? h('img', { src: institute.logo_url, alt: '' }) : renderIcon('graduation', { size: 64, stroke: 1.6 })),
        ...floatCards,
      );

  const hero = h(
    'section',
    { class: 'site-hero' },
    h('div', { class: 'site-hero-bg', 'aria-hidden': 'true' }, h('span', { class: 'blob b1' }), h('span', { class: 'blob b2' }), h('span', { class: 'blob b3' }), h('span', { class: 'site-grid-dots' })),
    h(
      'div',
      { class: 'site-wrap site-hero-inner' },
      h(
        'div',
        { class: 'site-hero-copy' },
        h(
          'p',
          { class: 'site-eyebrow site-rise', style: '--d:0ms' },
          h('span', { class: 'site-live-dot' }),
          has.enquiry ? 'Admissions open' : name,
          institute.city ? h('span', { class: 'site-eyebrow-sep' }, institute.city) : null,
        ),
        headline,
        content.hero.subheadline ? h('p', { class: 'site-hero-sub site-rise', style: `--d:${200 + words.length * 70}ms` }, content.hero.subheadline) : null,
        h(
          'div',
          { class: 'site-hero-cta site-rise', style: `--d:${320 + words.length * 70}ms` },
          has.enquiry ? h('button', { class: 'site-btn lg white', type: 'button', onclick: enquire }, content.hero.cta_label, renderIcon('arrowRight', { size: 18 })) : null,
          contact.phone ? h('a', { class: 'site-btn lg glass', href: `tel:${digits(contact.phone)}` }, renderIcon('phone', { size: 17 }), 'Call us') : null,
          wa ? h('a', { class: 'site-btn lg glass', href: wa, target: '_blank', rel: 'noopener' }, renderIcon('whatsapp', { size: 17 }), 'WhatsApp') : null,
        ),
        exams.length
          ? h(
              'div',
              { class: 'site-hero-tags site-rise', style: `--d:${440 + words.length * 70}ms` },
              h('span', {}, 'Preparing students for'),
              ...exams.slice(0, 5).map((exam) => h('span', { class: 'site-hero-tag' }, exam)),
            )
          : null,
      ),
      heroArt,
    ),
    h('div', { class: 'site-wave', html: WAVE }),
  );

  /* ── Highlights, counting up when they come into view ── */
  let highlights = null;
  if (content.highlights.length) {
    const numbers = [];
    highlights = h(
      'div',
      { class: 'site-wrap site-highlights-wrap' },
      h(
        'div',
        { class: 'site-highlights' },
        ...content.highlights.map((item, i) => {
          const value = h('strong', {}, item.value);
          numbers.push([value, item.value]);
          return rv(h('div', { class: 'site-highlight' }, value, h('span', {}, item.label)), i);
        }),
      ),
    );
    if (motion && 'IntersectionObserver' in window) {
      const counter = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        counter.disconnect();
        for (const [node, value] of numbers) countUp(node, value);
      }, { threshold: 0.4 });
      counter.observe(highlights);
      cleanups.push(() => counter.disconnect());
    }
  }

  const block = (id, kicker, title, lead, ...children) =>
    h(
      'section',
      { class: `site-section site-section-${id}`, 'data-site-section': id },
      h(
        'div',
        { class: 'site-wrap' },
        rv(h('div', { class: 'site-head' }, h('p', { class: 'site-kicker' }, kicker), h('h2', {}, title), lead ? h('p', { class: 'site-lead' }, lead) : null)),
        ...children,
      ),
    );

  /* ── About: the prose, beside facts taken from the institute's own data ── */
  const aboutFacts = [
    data.courses.length && ['graduation', `${data.courses.length} program${data.courses.length === 1 ? '' : 's'}`, exams.length ? exams.slice(0, 3).join(', ') : 'Open for admission'],
    has.results && ['trophy', `${content.results.length} achiever${content.results.length === 1 ? '' : 's'} featured`, 'See our results below'],
    has.faculty && ['users', `${data.faculty.length} teacher${data.faculty.length === 1 ? '' : 's'}`, 'Meet our faculty below'],
    institute.city && ['mapPin', `Based in ${institute.city}`, contact.hours || 'Come and see the campus'],
  ].filter(Boolean);
  const about = content.about.body
    ? block(
        'about',
        'About us',
        content.about.title || `Why ${name}`,
        null,
        h(
          'div',
          { class: 'site-about' },
          rv(h('p', { class: 'site-prose' }, content.about.body)),
          aboutFacts.length
            ? rv(
                h(
                  'div',
                  { class: 'site-about-points' },
                  ...aboutFacts.map(([icon, title, text]) =>
                    h('div', { class: 'site-point' }, h('span', { class: 'site-point-icon' }, renderIcon(icon, { size: 20 })), h('div', {}, h('strong', {}, title), h('span', {}, text))),
                  ),
                ),
                1,
              )
            : null,
        ),
      )
    : null;

  /* ── Courses, filterable by exam ── */
  let courses = null;
  if (has.courses) {
    const cards = data.courses.map((course, i) => {
      const card = h(
        'article',
        { class: 'site-card site-course', 'data-exam': course.target_exam || '' },
        h(
          'div',
          { class: 'site-course-top' },
          h('span', { class: 'site-course-icon' }, renderIcon(['graduation', 'book', 'target', 'calculator', 'lamp'][i % 5], { size: 22 })),
          course.target_exam ? h('span', { class: 'site-tag' }, course.target_exam) : null,
        ),
        h('h3', {}, course.name),
        course.description ? h('p', { class: 'site-muted' }, course.description) : h('p', { class: 'site-muted' }, 'Ask us for the syllabus, timings and batch details.'),
        h(
          'div',
          { class: 'site-course-foot' },
          course.fee_from != null
            ? h('span', { class: 'site-fee' }, 'Fees from ', h('strong', {}, money(course.fee_from)))
            : course.monthly_fee_from != null
              ? h('span', { class: 'site-fee' }, 'From ', h('strong', {}, money(course.monthly_fee_from)), ' / month')
              : null,
          course.batch_count ? h('span', { class: 'site-chip-soft' }, renderIcon('users', { size: 13 }), `${course.batch_count} batch${course.batch_count === 1 ? '' : 'es'} running`) : null,
        ),
        has.enquiry
          ? h(
              'button',
              {
                class: 'site-link-btn',
                type: 'button',
                onclick: () => {
                  const select = page.querySelector('select[name="course_id"]');
                  if (select) select.value = String(course.id);
                  enquire();
                },
              },
              'Enquire about this course',
              renderIcon('arrowRight', { size: 16 }),
            )
          : null,
      );
      return rv(card, i);
    });
    const grid = h('div', { class: 'site-grid' }, ...cards);
    let filters = null;
    if (exams.length > 1) {
      const chips = ['All', ...exams].map((exam) =>
        h(
          'button',
          {
            type: 'button',
            class: `site-filter${exam === 'All' ? ' active' : ''}`,
            'aria-pressed': exam === 'All' ? 'true' : 'false',
            onclick: (e) => {
              for (const chip of chips) {
                const on = chip === e.currentTarget;
                chip.classList.toggle('active', on);
                chip.setAttribute('aria-pressed', String(on));
              }
              for (const card of cards) card.hidden = exam !== 'All' && card.dataset.exam !== exam;
            },
          },
          exam,
        ),
      );
      filters = rv(h('div', { class: 'site-filters', role: 'group', 'aria-label': 'Filter courses' }, ...chips));
    }
    courses = block('courses', 'Courses', 'Programs we offer', 'Find the program that fits your goal.', filters, grid);
  }

  /* ── How admission works ── */
  const journey = has.enquiry
    ? h(
        'section',
        { class: 'site-section site-section-journey' },
        h(
          'div',
          { class: 'site-wrap' },
          rv(h('div', { class: 'site-head center' }, h('p', { class: 'site-kicker' }, 'Admissions'), h('h2', {}, 'Joining is simple'))),
          rv(
            h(
              'ol',
              { class: 'site-steps' },
              h('span', { class: 'site-steps-line', 'aria-hidden': 'true' }),
              ...[
                ['send', 'Send an enquiry', 'Fill the form or message us on WhatsApp'],
                ['phone', 'Talk to a counsellor', 'We call back to understand your goals'],
                ['building', 'Visit the institute', 'See the classrooms and meet the teachers'],
                ['graduation', 'Join your batch', 'Pick a batch and start learning'],
              ].map(([icon, title, text], i) =>
                h('li', { class: 'site-step', style: `--d:${i * 160}ms` }, h('span', { class: 'site-step-icon' }, renderIcon(icon, { size: 22 }), h('em', {}, String(i + 1))), h('strong', {}, title), h('span', {}, text)),
              ),
            ),
          ),
        ),
      )
    : null;

  /* ── Results: a moving wall of achievers when there are enough of them ── */
  let results = null;
  if (has.results) {
    const resultCard = (item, i) =>
      h(
        'article',
        { class: 'site-result' },
        h('span', { class: `site-medal m${(i % 3) + 1}` }, renderIcon('trophy', { size: 20 })),
        h('span', { class: 'site-result-avatar' }, initialsOf(item.name)),
        h('h3', {}, item.name),
        item.achievement ? h('p', { class: 'site-result-what' }, item.achievement) : null,
        item.year ? h('span', { class: 'site-result-year' }, item.year) : null,
      );
    const marquee = motion && content.results.length >= 5;
    results = block(
      'results',
      'Results',
      'Our achievers',
      'Students whose hard work we were proud to be part of.',
      marquee
        ? rv(
            h(
              'div',
              { class: 'site-marquee', style: `--dur:${content.results.length * 4}s` },
              h(
                'div',
                { class: 'site-marquee-track' },
                ...content.results.map(resultCard),
                // A second copy, hidden from assistive tech, makes the loop seamless.
                ...content.results.map((item, i) => {
                  const copy = resultCard(item, i);
                  copy.setAttribute('aria-hidden', 'true');
                  return copy;
                }),
              ),
            ),
          )
        : h('div', { class: 'site-grid site-grid-sm' }, ...content.results.map((item, i) => rv(resultCard(item, i), i))),
    );
  }

  /* ── Faculty ── */
  const faculty = has.faculty
    ? block(
        'faculty',
        'Faculty',
        'Learn from experienced teachers',
        null,
        h(
          'div',
          { class: 'site-grid' },
          ...data.faculty.map((teacher, i) =>
            rv(
              h(
                'article',
                { class: 'site-card site-teacher' },
                h('span', { class: 'site-avatar' }, initialsOf(teacher.name)),
                h('div', {}, h('h3', {}, teacher.name), teacher.specialization ? h('p', { class: 'site-teacher-subject' }, teacher.specialization) : null),
                teacher.qualification ? h('p', { class: 'site-teacher-qual' }, renderIcon('graduation', { size: 15 }), teacher.qualification) : null,
                teacher.bio ? h('p', { class: 'site-muted site-teacher-bio' }, teacher.bio) : null,
              ),
              i,
            ),
          ),
        ),
      )
    : null;

  /* ── Testimonials: a swipeable carousel ── */
  const testimonials = has.testimonials ? block('testimonials', 'Testimonials', 'What students and parents say', null, rv(carousel(content.testimonials))) : null;

  function carousel(items) {
    let index = 0;
    let timer = null;
    // Hovered or focused: autoplay waits, even after an arrow or dot is used.
    let held = false;
    const slides = items.map((item, i) =>
      h(
        'figure',
        { class: 'site-slide', role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${items.length}` },
        h('span', { class: 'site-quote-mark', html: QUOTE }),
        h('blockquote', {}, item.quote),
        h('figcaption', {}, h('span', { class: 'site-avatar sm' }, initialsOf(item.name)), h('span', {}, h('strong', {}, item.name), item.role ? h('span', { class: 'site-muted' }, item.role) : null)),
      ),
    );
    const track = h('div', { class: 'site-carousel-track' }, ...slides);
    const dots = items.map((_, i) => h('button', { type: 'button', class: 'site-dot', 'aria-label': `Show testimonial ${i + 1}`, onclick: () => show(i, true) }));
    const show = (i, byUser = false) => {
      index = (i + items.length) % items.length;
      track.style.transform = `translateX(${-index * 100}%)`;
      slides.forEach((slide, n) => slide.setAttribute('aria-hidden', String(n !== index)));
      dots.forEach((dot, n) => dot.classList.toggle('active', n === index));
      if (byUser) restart();
    };
    const stop = () => {
      clearInterval(timer);
      timer = null;
    };
    const restart = () => {
      stop();
      if (!motion || items.length < 2 || held) return;
      timer = setInterval(() => {
        if (gone()) return stop();
        show(index + 1);
      }, 7000);
    };
    cleanups.push(stop);

    const many = items.length > 1;
    const box = h(
      'div',
      {
        class: 'site-carousel',
        'aria-roledescription': 'carousel',
        'aria-label': 'Testimonials',
        onmouseenter: () => ((held = true), stop()),
        onmouseleave: () => ((held = false), restart()),
        onfocusin: () => ((held = true), stop()),
        onfocusout: () => ((held = false), restart()),
      },
      h('div', { class: 'site-carousel-viewport' }, track),
      many
        ? h(
            'div',
            { class: 'site-carousel-controls' },
            h('button', { type: 'button', class: 'site-round-btn', 'aria-label': 'Previous', onclick: () => show(index - 1, true) }, renderIcon('chevronLeft', { size: 20 })),
            h('div', { class: 'site-dots' }, ...dots),
            h('button', { type: 'button', class: 'site-round-btn', 'aria-label': 'Next', onclick: () => show(index + 1, true) }, renderIcon('chevronRight', { size: 20 })),
          )
        : null,
    );

    // Swipe on touch screens.
    let startX = null;
    box.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
    });
    box.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1), true);
    });
    show(0);
    restart();
    return box;
  }

  /* ── Gallery with a lightbox ── */
  const gallery = has.gallery
    ? block(
        'gallery',
        'Gallery',
        'Life at the institute',
        null,
        h(
          'div',
          { class: 'site-gallery' },
          ...data.gallery.map((image, i) =>
            rv(
              h(
                'button',
                { type: 'button', class: 'site-gallery-item', 'aria-label': image.caption ? `Open photo: ${image.caption}` : `Open photo ${i + 1}`, onclick: () => lightbox(data.gallery, i) },
                h('img', { src: image.url, alt: image.caption || '', loading: 'lazy' }),
                h('span', { class: 'site-gallery-zoom', 'aria-hidden': 'true' }, renderIcon('maximize', { size: 18 })),
                image.caption ? h('span', { class: 'site-gallery-cap' }, image.caption) : null,
              ),
              i,
            ),
          ),
        ),
      )
    : null;

  /* ── FAQ: an accordion that animates open ── */
  const faq = has.faq
    ? block(
        'faq',
        'FAQs',
        'Questions parents ask',
        null,
        h(
          'div',
          { class: 'site-faq' },
          ...content.faqs.map((item, i) => {
            const id = `site-faq-${i}`;
            const panel = h('div', { class: 'site-faq-panel', id, role: 'region' }, h('div', {}, h('p', {}, item.a)));
            const button = h(
              'button',
              {
                type: 'button',
                'aria-expanded': 'false',
                'aria-controls': id,
                onclick: () => {
                  const open = button.getAttribute('aria-expanded') !== 'true';
                  button.setAttribute('aria-expanded', String(open));
                  wrap.classList.toggle('open', open);
                },
              },
              h('span', {}, item.q),
              h('span', { class: 'site-faq-plus', 'aria-hidden': 'true' }),
            );
            const wrap = rv(h('div', { class: 'site-faq-item' }, button, panel), i);
            return wrap;
          }),
        ),
      )
    : null;

  /* ── Call to action ── */
  const cta = has.enquiry
    ? h(
        'section',
        { class: 'site-cta-wrap' },
        h(
          'div',
          { class: 'site-wrap' },
          rv(
            h(
              'div',
              { class: 'site-cta' },
              h('div', { class: 'site-cta-shine', 'aria-hidden': 'true' }),
              h('div', {}, h('h2', {}, 'Your next step starts here'), h('p', {}, `Talk to the ${name} admissions team about courses, batches and fees.`)),
              h(
                'div',
                { class: 'site-cta-actions' },
                h('button', { class: 'site-btn lg white', type: 'button', onclick: enquire }, content.hero.cta_label, renderIcon('arrowRight', { size: 18 })),
                contact.phone ? h('a', { class: 'site-btn lg glass', href: `tel:${digits(contact.phone)}` }, renderIcon('phone', { size: 17 }), contact.phone) : null,
              ),
            ),
          ),
        ),
      )
    : null;

  /* ── Enquiry + contact ── */
  const contactRows = [
    contact.phone && ['phone', 'Call', h('a', { href: `tel:${digits(contact.phone)}` }, contact.phone)],
    contact.whatsapp && ['whatsapp', 'WhatsApp', h('a', { href: wa, target: '_blank', rel: 'noopener' }, contact.whatsapp)],
    contact.email && ['mail', 'Email', h('a', { href: `mailto:${contact.email}` }, contact.email)],
    contact.address && ['mapPin', 'Address', h('span', {}, contact.address)],
    contact.hours && ['clock', 'Office hours', h('span', {}, contact.hours)],
  ].filter(Boolean);
  const socials = [
    content.social.youtube && ['youtube', 'YouTube', content.social.youtube],
    content.social.instagram && ['camera', 'Instagram', content.social.instagram],
    content.social.facebook && ['users', 'Facebook', content.social.facebook],
  ].filter(Boolean);

  const mapArt = h(
    contact.maps_url ? 'a' : 'div',
    { class: 'site-map-art', ...(contact.maps_url ? { href: contact.maps_url, target: '_blank', rel: 'noopener', 'aria-label': 'Open in Google Maps' } : { 'aria-hidden': 'true' }) },
    h('span', { class: 'site-map-road r1' }),
    h('span', { class: 'site-map-road r2' }),
    h('span', { class: 'site-map-road r3' }),
    h('span', { class: 'site-map-pin' }, renderIcon('mapPin', { size: 26, stroke: 2 })),
    h('span', { class: 'site-map-pulse' }),
    contact.maps_url ? h('span', { class: 'site-map-label' }, renderIcon('mapPin', { size: 14 }), 'Get directions') : null,
  );

  const contactCard = rv(
    h(
      'div',
      { class: 'site-card site-contact' },
      mapArt,
      h('h3', {}, 'Visit or reach us'),
      ...contactRows.map(([icon, label, value]) =>
        h('div', { class: 'site-contact-row' }, h('span', { class: 'site-contact-icon' }, renderIcon(icon, { size: 17 })), h('div', {}, h('span', { class: 'site-contact-label' }, label), value)),
      ),
      socials.length
        ? h('div', { class: 'site-socials' }, ...socials.map(([icon, label, href]) => h('a', { class: 'site-social', href, target: '_blank', rel: 'noopener', 'aria-label': label, title: label }, renderIcon(icon, { size: 18 }))))
        : null,
    ),
    1,
  );

  const contactSection = block(
    'contact',
    'Contact',
    has.enquiry ? 'Talk to our admissions team' : 'Get in touch',
    has.enquiry ? 'Leave your details and our team will call you back.' : null,
    h('div', { class: `site-contact-grid${has.enquiry ? '' : ' single'}` }, has.enquiry ? rv(enquiryForm(data, { preview: preview || draft })) : null, contactCard),
  );

  /* ── Footer ── */
  const footer = h(
    'footer',
    { class: 'site-footer' },
    h(
      'div',
      { class: 'site-wrap site-footer-grid' },
      h(
        'div',
        { class: 'site-footer-brand' },
        h(
          'div',
          { class: 'site-brand' },
          institute.logo_url ? h('img', { class: 'site-logo', src: institute.logo_url, alt: '' }) : h('span', { class: 'site-logo site-logo-mark' }, renderIcon('graduation', { size: 20 })),
          h('span', { class: 'site-brand-name' }, name),
        ),
        h('p', {}, institute.tagline || content.hero.subheadline || ''),
        socials.length ? h('div', { class: 'site-socials' }, ...socials.map(([icon, label, href]) => h('a', { class: 'site-social', href, target: '_blank', rel: 'noopener', 'aria-label': label }, renderIcon(icon, { size: 17 })))) : null,
      ),
      h('div', { class: 'site-footer-col' }, h('h4', {}, 'Explore'), ...navItems.map(([id, label]) => h('button', { type: 'button', onclick: () => go(id) }, label))),
      h(
        'div',
        { class: 'site-footer-col' },
        h('h4', {}, 'Contact'),
        contact.phone ? h('a', { href: `tel:${digits(contact.phone)}` }, contact.phone) : null,
        contact.email ? h('a', { href: `mailto:${contact.email}` }, contact.email) : null,
        contact.address ? h('span', {}, contact.address) : null,
      ),
    ),
    h(
      'div',
      { class: 'site-wrap site-footer-bottom' },
      h('span', {}, `© ${new Date().getFullYear()} ${name}. All rights reserved.`),
      h('span', { class: 'site-footer-links' }, h('a', { href: '#/portal' }, 'Student & parent login'), h('a', { href: '#/login' }, 'Staff login')),
    ),
  );

  /* ── Floating buttons ── */
  const toTop = h(
    'button',
    { class: 'site-to-top', type: 'button', 'aria-label': 'Back to top', onclick: () => page.scrollIntoView({ behavior: motion ? 'smooth' : 'auto' }) },
    renderIcon('arrowUp', { size: 20 }),
  );
  const floatingWa = wa ? h('a', { class: 'site-wa-float', href: wa, target: '_blank', rel: 'noopener', 'aria-label': 'Chat on WhatsApp' }, renderIcon('whatsapp', { size: 26 })) : null;

  page.append(
    ...[banner, header, hero, highlights, about, courses, journey, results, faculty, testimonials, gallery, faq, cta, contactSection, footer, floatingWa, toTop].filter(Boolean),
  );

  /* ── Scroll: header state, progress bar, back-to-top, current section ── */
  if (!preview) {
    const onScroll = () => {
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      header.classList.toggle('is-top', y < 24);
      // Above the first section, no nav item is "current".
      if (y < 200) for (const link of navLinks) link.classList.remove('active');
      progress.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
      toTop.classList.toggle('show', y > 900);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    cleanups.push(() => window.removeEventListener('scroll', onScroll));
    requestAnimationFrame(onScroll);
  }
  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.dataset.siteSection;
          for (const link of navLinks) link.classList.toggle('active', link.dataset.for === id);
        }
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const section of page.querySelectorAll('[data-site-section]')) spy.observe(section);
    cleanups.push(() => spy.disconnect());
  }

  return page;
}

/* ── Lightbox ── */
function lightbox(images, start) {
  let i = start;
  const img = h('img', { alt: '' });
  const caption = h('p', { class: 'site-lb-cap' });
  const counter = h('span', { class: 'site-lb-count' });
  const show = () => {
    img.src = images[i].url;
    img.alt = images[i].caption || '';
    caption.textContent = images[i].caption || '';
    counter.textContent = `${i + 1} / ${images.length}`;
  };
  const step = (by) => {
    i = (i + by + images.length) % images.length;
    show();
  };
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
    previous?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      // Captured first, so the editor's preview modal behind stays open.
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  };
  const previous = document.activeElement;
  const many = images.length > 1;
  const closeBtn = h('button', { type: 'button', class: 'site-lb-btn close', 'aria-label': 'Close', onclick: close }, renderIcon('close', { size: 22 }));
  const box = h(
    'div',
    {
      class: 'site-lightbox',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Photo viewer',
      onclick: (e) => {
        if (e.target === box) close();
      },
    },
    closeBtn,
    many ? h('button', { type: 'button', class: 'site-lb-btn prev', 'aria-label': 'Previous photo', onclick: () => step(-1) }, renderIcon('chevronLeft', { size: 26 })) : null,
    h('figure', {}, img, h('figcaption', {}, caption, many ? counter : null)),
    many ? h('button', { type: 'button', class: 'site-lb-btn next', 'aria-label': 'Next photo', onclick: () => step(1) }, renderIcon('chevronRight', { size: 26 })) : null,
  );
  show();
  document.body.append(box);
  document.addEventListener('keydown', onKey, true);
  closeBtn.focus();
}

/* ── The enquiry form ── */
function enquiryForm(data, { preview }) {
  const errors = new Map();
  const field = (label, icon, control, { full = false, required = false } = {}) => {
    const error = h('div', { class: 'site-field-error', hidden: true });
    errors.set(control.name, error);
    return h(
      'label',
      { class: `site-field${full ? ' full' : ''}` },
      h('span', {}, label, required ? h('em', {}, ' *') : null),
      h('span', { class: 'site-input' }, icon ? renderIcon(icon, { size: 17 }) : null, control),
      error,
    );
  };

  const submit = h('button', { class: 'site-btn lg block', type: 'submit' }, h('span', {}, 'Request a call back'), renderIcon('send', { size: 16 }));
  const form = h(
    'form',
    { class: 'site-card site-form', novalidate: true },
    h('div', { class: 'site-form-head' }, h('span', { class: 'site-form-icon' }, renderIcon('send', { size: 20 })), h('div', {}, h('h3', {}, 'Send us your details'), h('p', { class: 'site-muted' }, 'We usually call back within a working day.'))),
    h(
      'div',
      { class: 'site-form-grid' },
      field('Student name', 'user', h('input', { name: 'student_name', required: true, autocomplete: 'name', maxlength: 100, placeholder: 'Full name' }), { required: true }),
      field('Mobile number', 'phone', h('input', { name: 'phone', type: 'tel', required: true, autocomplete: 'tel', inputmode: 'tel', maxlength: 20, placeholder: '10-digit mobile' }), { required: true }),
      field('Parent / guardian name', 'users', h('input', { name: 'guardian_name', maxlength: 100, placeholder: 'Optional' })),
      field('Class', 'book', h('input', { name: 'target_class', placeholder: 'e.g. Class 11', maxlength: 40 })),
      data.courses.length
        ? field(
            'Interested in',
            'graduation',
            h('select', { name: 'course_id' }, h('option', { value: '' }, 'Not sure yet'), ...data.courses.map((c) => h('option', { value: c.id }, c.name))),
            { full: true },
          )
        : null,
      field('Message', null, h('textarea', { name: 'message', rows: 3, maxlength: 1000, placeholder: 'Anything you would like to ask (optional)' }), { full: true }),
    ),
    // Hidden from people (and from the accessibility tree); bots fill it in.
    h('input', { class: 'site-hp', name: 'company', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    submit,
    h('p', { class: 'site-form-note' }, renderIcon('lock', { size: 13 }), 'Your details are only shared with our admissions team.'),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    for (const node of errors.values()) node.hidden = true;
    if (preview) {
      toast('This is a preview — enquiries are sent only from the published site', 'error');
      return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    const local = {};
    if ((values.student_name || '').trim().length < 2) local.student_name = 'Enter the student’s name';
    if (digits(values.phone).length < 10) local.phone = 'Enter a 10-digit mobile number';
    if (Object.keys(local).length) return showErrors(local);

    submit.disabled = true;
    submit.classList.add('is-loading');
    try {
      await api.siteEnquiry({ ...values, course_id: values.course_id ? Number(values.course_id) : undefined });
      form.replaceWith(
        h(
          'div',
          { class: 'site-card site-form site-thanks', role: 'status' },
          h('span', { class: 'site-check', html: '<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none"/><path fill="none" d="M15 27l7 7 15-16"/></svg>' }),
          h('h3', {}, 'Thank you! We have your details.'),
          h('p', { class: 'site-muted' }, 'Our admissions team will call you shortly.'),
        ),
      );
    } catch (err) {
      submit.disabled = false;
      submit.classList.remove('is-loading');
      if (err instanceof ApiError && err.status === 400 && err.details && Object.keys(err.details).length) showErrors(err.details);
      else toast(err.message || 'Could not send — please try again', 'error');
    }
  });

  function showErrors(map) {
    for (const [fieldName, message] of Object.entries(map)) {
      const node = errors.get(fieldName);
      if (!node) continue;
      node.textContent = String(message).replace(/^is /, 'This field is ');
      node.hidden = false;
    }
    form.querySelector('.site-field-error:not([hidden])')?.closest('label')?.querySelector('input,select,textarea')?.focus();
  }

  return form;
}

/**
 * The public route: "#/" on the institute's own domain, "#/site" anywhere.
 *
 * An admin or manager signed in on this browser gets the unpublished draft
 * with a note saying so, which is how a site is checked before it goes live.
 */
export async function renderInstituteSite({ context } = {}) {
  // A website is light whatever the visitor last chose in the staff app;
  // dispatch() puts their own mode back on the next route.
  document.body.dataset.mode = 'light';

  try {
    const data = await api.site();
    document.title = data.content.seo.title || data.institute.name;
    return buildSite(data);
  } catch (err) {
    const disabled = err instanceof ApiError && err.status === 404 && err.details?.code === 'site_disabled';
    if (!disabled) throw err;
  }

  if (session.token && session.can('admin', 'manager')) {
    try {
      const data = await coaching.websitePreview();
      const banner = h(
        'div',
        { class: 'site-draft-banner' },
        renderIcon('eye', { size: 16 }),
        h('span', {}, 'Preview — this website is not published yet. Only signed-in admins and managers can see it.'),
        h('a', { href: '#/website' }, 'Open the editor'),
      );
      return buildSite(data, { draft: true, banner });
    } catch {
      // Not allowed after all — fall through to the plain notice.
    }
  }

  return h(
    'div',
    { class: 'onboard' },
    h(
      'div',
      { class: 'onboard-card', style: 'text-align:center' },
      h('h1', {}, context?.tenant?.gym_name || 'Coming soon'),
      h('p', { class: 'sub' }, 'Our website is being set up. Students can still sign in to the app.'),
      h(
        'div',
        { class: 'row', style: 'justify-content:center;gap:8px' },
        h('a', { class: 'btn primary', href: '#/portal' }, 'Student login'),
        h('a', { class: 'btn ghost', href: '#/login' }, 'Staff login'),
      ),
    ),
  );
}
