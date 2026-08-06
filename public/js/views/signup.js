import { ApiError, api, gymPathUrl, saveSessionFor } from '../api.js';
import { h, toast } from '../ui.js';

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

  return h(
    'div',
    { class: 'onboard' },
    h(
      'div',
      { class: 'onboard-card onboard-done' },
      h('div', { class: 'onboard-tick' }, '✓'),
      h('h1', {}, 'Your gym is ready'),
      h('p', { class: 'sub' }, `${result.gym_name} is set up and your ${result.trial_label} has started.`),

      h(
        'div',
        { class: 'onboard-url' },
        h('span', { class: 'muted' }, 'Your gym lives at'),
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
            ? `You are signed in as ${result.admin_email} — the owner of this gym.`
            : `Sign in as ${result.admin_email} with the password you just chose.`,
        ),
        result.starter_plans
          ? h('li', {}, `${result.starter_plans} starter plans are ready to edit under Plans.`)
          : null,
        h('li', {}, 'Add your members, then print their QR cards from the check-in desk.'),
        h('li', {}, 'Bookmark the link above — it is where your staff sign in.'),
      ),

      // A real navigation, not an in-SPA one: this page is on the root domain
      // and the gym is somewhere else — another path, or another origin
      // entirely under subdomain addressing.
      h('a', { class: 'btn primary block lg', href: url }, 'Open my gym'),

      h(
        'p',
        { class: 'muted', style: 'font-size:12px;text-align:center;margin:14px 0 0' },
        'Save your password somewhere safe. There is no email reset yet.',
      ),
    ),
  );
}

export function renderSignup({ context, navigate, rerender }) {
  const trialDays = context.trial_days ?? 7;

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

  const submit = h('button', { class: 'btn primary block lg', type: 'submit' }, `Create my gym`);

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
          toast(err.message || 'Could not create your gym', 'error');
        } finally {
          submit.disabled = false;
        }
      },
    },

    h('div', { class: 'onboard-section full' }, 'Your gym'),
    field('Gym name', gymName, { hint: 'Shown to your staff and printed on member ID cards.' }),
    h(
      'label',
      { class: 'field full' },
      h('span', {}, 'Gym address'),
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

  return h(
    'div',
    { class: 'onboard' },
    h(
      'div',
      { class: 'onboard-card' },
      h(
        'button',
        { class: 'btn sm ghost onboard-back', type: 'button', onclick: () => navigate('/') },
        '← Back',
      ),
      h('h1', {}, 'Set up your gym'),
      h('p', { class: 'sub' }, `${trialDays} days free. No card needed. About a minute.`),
      form,
    ),
  );
}
