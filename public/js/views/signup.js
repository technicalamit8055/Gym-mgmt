import { ApiError, api, gymPathUrl, landingBrand, saveSessionFor } from '../api.js';
import { h, renderIcon, toast } from '../ui.js';

/**
 * Gym onboarding: name the gym, claim an address, create the owner account.
 *
 * Hand-built rather than assembled from buildForm() because two of the fields
 * are not plain inputs — the address needs a prefix affix and live
 * availability checking, and the password needs a strength floor shown before
 * submit rather than as a server error afterwards.
 */

const CURRENCIES = [
  { value: 'INR', label: '₹ Indian rupee' },
  { value: 'USD', label: '$ US dollar' },
  { value: 'EUR', label: '€ Euro' },
  { value: 'GBP', label: '£ Pound sterling' },
  { value: 'AED', label: 'د.إ UAE dirham' },
  { value: 'SGD', label: 'S$ Singapore dollar' },
  { value: 'AUD', label: 'A$ Australian dollar' },
  { value: 'CAD', label: 'C$ Canadian dollar' },
  { value: 'ZAR', label: 'R South African rand' },
];

/**
 * Everything the business-type fork retitles. Chosen once, before any
 * account exists — there is no self-service switch afterwards (see
 * setTenantBusinessType in tenants.js), so this is the only place these
 * labels ever need to live on the client.
 */
const TYPE_COPY = {
  gym: {
    heading: 'Set up your gym',
    orgSection: 'Your gym',
    orgLabel: 'Gym name',
    orgPlaceholder: 'Iron House Fitness',
    orgHint: 'Shown to your staff and printed on member ID cards.',
    addressLabel: 'Gym address',
    livesAt: 'Your gym lives at',
    submitLabel: 'Create my gym',
  },
  library: {
    heading: 'Set up your library',
    orgSection: 'Your library',
    orgLabel: 'Library name',
    orgPlaceholder: 'Central Study Hall',
    orgHint: 'Shown to your staff and printed on student ID cards.',
    addressLabel: 'Library address',
    livesAt: 'Your library lives at',
    submitLabel: 'Create my hall',
  },
  coaching: {
    heading: 'Set up your institute',
    orgSection: 'Your institute',
    orgLabel: 'Institute name',
    orgPlaceholder: 'Apex Coaching Classes',
    orgHint: 'Shown to staff, on student ID cards, fee receipts and parent messages.',
    addressLabel: 'Institute address',
    livesAt: 'Your institute lives at',
    submitLabel: 'Create my institute',
  },
};

/** What the "done" screen says, per product. */
const DONE_COPY = {
  gym: {
    ready: 'Your gym is ready',
    starter: (n) => `${n} starter plans are ready to edit under Plans.`,
    next: 'Add your members, then print their QR cards from the check-in desk.',
    open: 'Open my gym',
  },
  library: {
    ready: 'Your library is ready',
    starter: (n) => `${n} starter passes are ready to edit under Passes.`,
    next: 'Map your seats — the seat map is where everything starts.',
    open: 'Open my library',
  },
  coaching: {
    ready: 'Your institute is ready',
    starter: () => 'A starter course, batch and 3-installment fee structure are ready to edit under Courses & batches.',
    next: 'Add your courses and batches, then admit students — parents get attendance and fee alerts on WhatsApp once you link it.',
    open: 'Open my institute',
  },
};

/**
 * "Iron House Fitness" -> "iron-house-fitness", within the server's slug rule
 * (/^[a-z][a-z0-9-]{2,39}$/). Suggested, never forced: the field stays
 * editable and stops auto-following the name the moment it is touched.
 */
function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length >= 3 ? slug : '';
}

function field(label, control, { hint, full = true } = {}) {
  const error = h('div', { class: 'field-error', style: 'display:none' });
  control.errorNode = error;
  return h(
    'label',
    { class: `field ${full ? 'full' : ''}` },
    h('span', {}, label),
    control,
    hint ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, hint) : null,
    error,
  );
}

/** The screen after a successful signup: the address, and the way in. */
function renderDone({ result }) {
  const url = result.app_url || gymPathUrl(result.slug);
  const type = TYPE_COPY[result.business_type] ? result.business_type : 'gym';
  const done = DONE_COPY[type];

  return h(
    'div',
    { class: 'onboard' },
    h(
      'div',
      { class: 'onboard-card onboard-done', 'data-brand': type === 'gym' ? undefined : type },
      h('div', { class: 'onboard-tick' }, renderIcon('check', { size: 26, stroke: 2.5 })),
      h('h1', {}, done.ready),
      h('p', { class: 'sub' }, `${result.gym_name} is set up and your ${result.trial_label} has started.`),

      h(
        'div',
        { class: 'onboard-url' },
        h('span', { class: 'muted' }, TYPE_COPY[type].livesAt),
        h('code', {}, url),
        h(
          'button',
          {
            class: 'btn sm ghost',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast('Link copied');
              } catch {
                toast('Could not copy — select the link and copy it manually', 'error');
              }
            },
          },
          'Copy',
        ),
      ),

      h(
        'ul',
        { class: 'onboard-next' },
        h(
          'li',
          {},
          result.signedInAlready
            ? `You are signed in as ${result.admin_email} — the owner of this ${TYPE_COPY[type].orgSection.replace('Your ', '')}.`
            : `Sign in as ${result.admin_email} with the password you just chose.`,
        ),
        result.starter_plans || type === 'coaching' ? h('li', {}, done.starter(result.starter_plans)) : null,
        h('li', {}, done.next),
        h('li', {}, 'Bookmark the link above — it is where your staff sign in.'),
      ),

      // A real navigation, not an in-SPA one: this page is on the root domain
      // and the gym is somewhere else — another path, or another origin
      // entirely under subdomain addressing.
      h('a', { class: 'btn primary block lg', href: url }, type === 'gym' ? 'Open my gym' : done.open),

      h(
        'p',
        { class: 'muted', style: 'font-size:12px;text-align:center;margin:14px 0 0' },
        'Save your password somewhere safe. Nothing is emailed — if you lose it, recovery goes through whoever runs this platform.',
      ),
    ),
  );
}

export function renderSignup({ context, navigate, rerender }) {
  const trialDays = context.trial_days ?? 7;

  // Decided once, here, before any account exists — chosen first and above
  // everything else because it retitles every field below it. Pre-selected
  // from how the visitor arrived (the SeatBook landing vs. GymBook's own),
  // but still just a starting point: either card can be picked.
  let currentType = landingBrand === 'library' ? 'library' : 'gym';
  const typeGym = h('input', { type: 'radio', name: 'business_type', value: 'gym' });
  const typeLibrary = h('input', { type: 'radio', name: 'business_type', value: 'library' });
  const typeCoaching = h('input', { type: 'radio', name: 'business_type', value: 'coaching' });
  typeGym.checked = currentType === 'gym';
  typeLibrary.checked = currentType === 'library';
  typeCoaching.checked = currentType === 'coaching';
  const typeChoice = h(
    'div',
    { class: 'type-choice has-3 full' },
    h(
      'label',
      { class: 'type-card' },
      typeGym,
      h('span', { class: 'icon' }, renderIcon('dumbbell', { size: 20 })),
      h('div', {}, h('strong', {}, 'Gym'), h('span', { class: 'muted' }, 'Memberships, check-ins, classes')),
    ),
    h(
      'label',
      { class: 'type-card' },
      typeLibrary,
      h('span', { class: 'icon' }, renderIcon('book', { size: 20 })),
      h('div', {}, h('strong', {}, 'Library / study hall'), h('span', { class: 'muted' }, 'Seats, shifts, passes')),
    ),
    h(
      'label',
      { class: 'type-card' },
      typeCoaching,
      h('span', { class: 'icon' }, renderIcon('graduation', { size: 20 })),
      h('div', {}, h('strong', {}, 'Coaching / Tuition Center'), h('span', { class: 'muted' }, 'Batches, fees, tests, parent alerts')),
    ),
  );

  const gymName = h('input', { name: 'gym_name', placeholder: 'Iron House Fitness', autocomplete: 'organization' });
  const slug = h('input', {
    name: 'slug',
    placeholder: 'iron-house',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
  });
  const adminName = h('input', { name: 'admin_name', placeholder: 'Amit Singh', autocomplete: 'name' });
  const adminEmail = h('input', {
    name: 'admin_email',
    type: 'email',
    placeholder: 'you@ironhouse.com',
    autocomplete: 'email',
  });
  const adminPassword = h('input', {
    name: 'admin_password',
    type: 'password',
    autocomplete: 'new-password',
  });
  const currency = h(
    'select',
    { name: 'currency' },
    CURRENCIES.map((option) => h('option', { value: option.value }, option.label)),
  );
  // Intl knows the browser's zone; the owner is almost always sitting in the
  // gym's own timezone when they sign up, so this guess is nearly always right.
  const guessedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const timezone = h('input', { name: 'timezone', value: guessedZone, placeholder: 'Asia/Kolkata' });

  // The address field stops chasing the gym name once the owner edits it, so
  // a deliberate choice is never overwritten by a later typo fix in the name.
  let slugTouched = false;
  slug.addEventListener('input', () => {
    slugTouched = true;
    slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    checkSlug();
  });
  gymName.addEventListener('input', () => {
    if (slugTouched) return;
    slug.value = slugify(gymName.value);
    checkSlug();
  });

  const availability = h('div', { class: 'onboard-availability muted' }, 'Letters, numbers and dashes.');
  // The address field is assembled by hand (it needs the affixes and the
  // availability line), so it does not get an errorNode from field() below.
  slug.errorNode = h('div', { class: 'field-error', style: 'display:none' });

  let checkSeq = 0;
  let debounce;
  function checkSlug() {
    clearTimeout(debounce);
    const value = slug.value.trim();
    if (!value) {
      availability.className = 'onboard-availability muted';
      availability.textContent = 'Letters, numbers and dashes.';
      return;
    }
    availability.className = 'onboard-availability muted';
    availability.textContent = 'Checking…';
    debounce = setTimeout(async () => {
      const seq = ++checkSeq;
      try {
        const res = await api.slugAvailable(value);
        if (seq !== checkSeq) return; // a later keystroke already won
        availability.className = `onboard-availability ${res.available ? 'ok' : 'bad'}`;
        availability.textContent = res.available ? `${value} is available` : res.reason;
      } catch {
        if (seq !== checkSeq) return;
        availability.className = 'onboard-availability muted';
        availability.textContent = '';
      }
    }, 300);
  }

  const submit = h('button', { class: 'btn primary block lg', type: 'submit' }, TYPE_COPY[currentType].submitLabel);
  const orgSectionHeading = h('div', { class: 'onboard-section full' }, TYPE_COPY[currentType].orgSection);
  const gymNameField = field(TYPE_COPY[currentType].orgLabel, gymName, { hint: TYPE_COPY[currentType].orgHint });
  gymName.placeholder = TYPE_COPY[currentType].orgPlaceholder;
  const addressLabelNode = h('span', {}, TYPE_COPY[currentType].addressLabel);

  const form = h(
    'form',
    {
      class: 'form-grid',
      onsubmit: async (event) => {
        event.preventDefault();
        for (const input of [gymName, slug, adminName, adminEmail, adminPassword, timezone]) {
          input.errorNode.style.display = 'none';
        }

        const payload = {
          gym_name: gymName.value.trim(),
          slug: slug.value.trim().toLowerCase(),
          admin_name: adminName.value.trim(),
          admin_email: adminEmail.value.trim(),
          admin_password: adminPassword.value,
          currency: currency.value,
          timezone: timezone.value.trim(),
          business_type: currentType,
        };

        submit.disabled = true;
        try {
          const created = await api.signup(payload);

          // The server signs the owner in as part of provisioning. Stashing
          // that token under the new gym's own key is what makes "Open my gym"
          // one click instead of retyping the password chosen a moment ago —
          // and it has to be the gym's key, not this page's, because signup
          // runs on the root domain and the gym reads a slug-scoped one.
          const signedInAlready = Boolean(created.token && created.user) && context.url_mode !== 'subdomain';
          if (signedInAlready) saveSessionFor(created.slug, created.token, created.user);

          rerender(
            renderDone({
              result: {
                ...created,
                gym_name: payload.gym_name,
                trial_label: `${trialDays}-day free trial`,
                signedInAlready,
              },
            }),
          );
        } catch (err) {
          const details = err instanceof ApiError ? err.details : {};
          const byField = {
            gym_name: gymName,
            slug,
            admin_name: adminName,
            admin_email: adminEmail,
            admin_password: adminPassword,
            timezone,
          };
          for (const [name, message] of Object.entries(details || {})) {
            const input = byField[name];
            if (!input) continue;
            input.errorNode.textContent = message;
            input.errorNode.style.display = 'block';
          }
          // 409 on the slug arrives as a plain message, not a field detail.
          if (err.status === 409) {
            slug.errorNode.textContent = err.message;
            slug.errorNode.style.display = 'block';
          }
          toast(err.message || 'Could not create your account', 'error');
        } finally {
          submit.disabled = false;
        }
      },
    },

    typeChoice,
    orgSectionHeading,
    gymNameField,
    h(
      'label',
      { class: 'field full' },
      addressLabelNode,
      h(
        'div',
        { class: 'onboard-slug' },
        context.url_mode === 'subdomain' ? null : h('span', { class: 'affix' }, `${window.location.host}/g/`),
        slug,
        context.url_mode === 'subdomain' ? h('span', { class: 'affix' }, `.${window.location.host}`) : null,
      ),
      availability,
      slug.errorNode,
    ),

    h('div', { class: 'onboard-section full' }, 'Owner account'),
    field('Your name', adminName),
    field('Email', adminEmail, { hint: 'This is how you sign in. It is not sent anywhere.' }),
    field('Password', adminPassword, { hint: 'At least 8 characters.' }),

    h('div', { class: 'onboard-section full' }, 'Regional'),
    field('Currency', currency, { full: false }),
    field('Timezone', timezone, { full: false, hint: 'Used to close shifts at the right local time.' }),

    h('div', { class: 'full' }, submit),
  );

  const heading = h('h1', {}, TYPE_COPY[currentType].heading);
  const onboardCard = h(
    'div',
    { class: 'onboard-card', 'data-brand': currentType === 'gym' ? undefined : currentType },
    h(
      'button',
      { class: 'btn sm ghost onboard-back', type: 'button', onclick: () => navigate('/') },
      renderIcon('arrowLeft', { size: 15 }), 'Back',
    ),
    heading,
    h('p', { class: 'sub' }, `${trialDays} days free. No card needed. About a minute.`),
    form,
  );

  /** Retitles the live form in place — the fork changes every label below it,
   * so picking a card has to visibly repaint the page, not just tag a hidden
   * field. */
  function syncType(type) {
    currentType = type;
    const copy = TYPE_COPY[type];
    heading.textContent = copy.heading;
    orgSectionHeading.textContent = copy.orgSection;
    gymNameField.querySelector('span').textContent = copy.orgLabel;
    gymNameField.querySelector('.muted').textContent = copy.orgHint;
    gymName.placeholder = copy.orgPlaceholder;
    addressLabelNode.textContent = copy.addressLabel;
    submit.textContent = copy.submitLabel;
    if (type === 'gym') onboardCard.removeAttribute('data-brand');
    else onboardCard.setAttribute('data-brand', type);
  }
  typeGym.addEventListener('change', () => syncType('gym'));
  typeLibrary.addEventListener('change', () => syncType('library'));
  typeCoaching.addEventListener('change', () => syncType('coaching'));

  return h('div', { class: 'onboard' }, onboardCard);
}
