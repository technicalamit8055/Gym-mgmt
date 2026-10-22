import {
  ApiError,
  api,
  chooseGym,
  coachBookApp,
  isNativeApp,
  landingBrand,
  nativeAppName,
  recentGyms,
  removeRecentGym,
  serverUrl,
  selectedGym,
} from '../api.js';
import { startQrScan } from '../barcodeScanner.js';
import { append, clear, h, renderIcon } from '../ui.js';

/**
 * "Find your gym" — the first screen of the store-listed member app, which
 * serves every gym and so must know which one before anyone can sign in.
 * Three ways in: scan the QR on the desk poster, type the gym code printed
 * under it, or search by name or city. Whichever is used, the member confirms
 * the gym on a card with its logo and address before the app switches to it.
 *
 * Also reachable on the web at #/portal/find-gym on the platform's root
 * address, where choosing a gym goes to that gym's own member portal.
 *
 * Shares the sign-in screen's dark-and-gold shell, so the two read as one flow.
 */

/**
 * The CoachBook app (the students' app) finds coaching institutes and nothing
 * else; GymVym and the web find gyms, or study halls on SeatBook's site. Codes
 * and QRs work alike for every business — only the words and the search differ.
 */
const PLACE = coachBookApp ? 'institute' : 'gym';
const PLACE_CAP = coachBookApp ? 'Institute' : 'Gym';
const SEARCH_TYPE = coachBookApp ? 'coaching' : landingBrand === 'library' ? 'library' : 'gym';

/** Gym codes skip 0/O and 1/I/L — the same alphabet as src/tenants.js. */
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const cleanCode = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

const TABS = [
  { id: 'scan', label: 'Scan QR', icon: 'scan' },
  { id: 'code', label: `${PLACE_CAP} code`, icon: 'key' },
  { id: 'search', label: 'Search', icon: 'search' },
];

export function renderFindGym() {
  let tab = 'scan';
  /** The gym awaiting "this is my gym", or null while still looking. */
  let found = null;
  let error = '';
  let busy = false;
  let code = '';
  let searchText = '';
  let results = null; // null: nothing searched yet
  /** 'idle' until the first tap, 'live' while the camera runs, 'paused' after a read. */
  let scanState = 'idle';
  let stopCamera = null;
  let searchTimer = null;
  let searchSeq = 0;

  const card = h('div', { class: 'portal-login-card findgym-card' });

  function releaseCamera() {
    stopCamera?.();
    stopCamera = null;
  }

  function paint() {
    releaseCamera();
    clear(card);
    if (found) paintConfirm();
    else paintFinder();
  }

  function fail(err) {
    busy = false;
    // The server's "not found" answers speak of gyms.
    const notFound = coachBookApp && err instanceof ApiError && err.status === 404;
    error = notFound
      ? 'No institute found — check the code or QR on the poster at your institute.'
      : err instanceof ApiError || err instanceof Error
        ? err.message
        : String(err);
    paint();
  }

  /** Runs one lookup with the card busy; its answer is the gym to confirm. */
  async function lookUp(work) {
    if (busy) return;
    busy = true;
    error = '';
    paint();
    try {
      const { gym } = await work();
      if (coachBookApp && gym.business_type !== 'coaching') {
        throw new Error(`${gym.gym_name} is not a coaching institute — open it in the GymVym app instead.`);
      }
      busy = false;
      found = gym;
      paint();
    } catch (err) {
      fail(err);
    }
  }

  const errorLine = () => (error ? h('p', { class: 'portal-login-error', role: 'alert' }, error) : null);

  const gymLogo = (gym, size = 'sm') =>
    gym.logo_url
      ? h('img', { class: `findgym-logo findgym-logo-${size}`, src: serverUrl(gym.logo_url), alt: '' })
      : h('span', { class: `findgym-logo findgym-logo-${size}` }, renderIcon(coachBookApp ? 'graduation' : 'dumbbell', { size: size === 'lg' ? 34 : 20 }));

  /** One gym as a tappable row — a search result or a recently used gym. */
  const gymRow = (gym, onclick, aside) =>
    h(
      'div',
      { class: 'findgym-row-wrap' },
      h(
        'button',
        { class: 'findgym-row', type: 'button', onclick },
        gymLogo(gym),
        h(
          'span',
          { class: 'findgym-row-text' },
          h('strong', {}, gym.gym_name),
          gym.address_text ? h('span', {}, gym.address_text) : null,
        ),
        renderIcon('chevronRight', { size: 18 }),
      ),
      aside || null,
    );

  /* ── Looking ── */

  function paintFinder() {
    const tabs = h(
      'div',
      { class: 'findgym-tabs', role: 'tablist' },
      ...TABS.map((t) =>
        h(
          'button',
          {
            class: `findgym-tab${tab === t.id ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            'aria-selected': String(tab === t.id),
            onclick: () => {
              if (tab === t.id) return;
              tab = t.id;
              error = '';
              paint();
            },
          },
          renderIcon(t.icon, { size: 17 }),
          h('span', {}, t.label),
        ),
      ),
    );
    append(card, [tabs, ...{ scan: paintScan, code: paintCode, search: paintSearch }[tab](), errorLine(), recentList()]);
  }

  function paintScan() {
    const cameraReady = window.isSecureContext && navigator.mediaDevices?.getUserMedia;
    if (!cameraReady) {
      return [
        h('p', { class: 'portal-login-note' }, `This device cannot open the camera here. Enter the ${PLACE} code printed under the QR instead.`),
      ];
    }
    if (busy) return [h('p', { class: 'portal-login-note findgym-wait' }, `Finding your ${PLACE}…`)];
    // The camera only opens on a tap: no permission prompt the moment the app
    // starts, and a code that did not resolve is not re-read every frame.
    if (scanState !== 'live') {
      return [
        h(
          'button',
          { class: 'findgym-scan-start', type: 'button', onclick: () => { scanState = 'live'; error = ''; paint(); } },
          renderIcon('scan', { size: 44, stroke: 1.6 }),
          h('strong', {}, scanState === 'idle' ? 'Scan the QR code' : 'Scan again'),
          h('span', {}, `It’s on the poster at your ${PLACE}’s front desk`),
        ),
      ];
    }
    const video = h('video', { class: 'findgym-video', playsinline: '', muted: '' });
    const frame = h(
      'div',
      { class: 'findgym-viewfinder' },
      video,
      h('span', { class: 'findgym-corners', 'aria-hidden': 'true' }),
      h('span', { class: 'findgym-scan-hint' }, `Point at the QR on your ${PLACE}’s front desk`),
    );
    startQrScan(video, {
      onCode: (text) => {
        stopCamera = null;
        scanState = 'paused';
        lookUp(() => api.directory.resolve(text));
      },
    })
      .then((stop) => {
        // The card may have been repainted while the camera was starting.
        if (video.isConnected) stopCamera = stop;
        else stop();
      })
      .catch((err) => {
        if (!video.isConnected) return;
        scanState = 'paused';
        const denied = err?.name === 'NotAllowedError' || /denied|permission/i.test(err?.message || '');
        fail(
          denied
            ? `Camera permission is off. Allow it in your phone’s settings, or enter the ${PLACE} code instead.`
            : `Could not start the camera. Enter the ${PLACE} code instead.`,
        );
      });
    return [frame];
  }

  function paintCode() {
    const input = h('input', {
      class: 'portal-input findgym-code-input',
      type: 'text',
      inputmode: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      maxlength: '8',
      placeholder: 'e.g. IRN482',
      'aria-label': `${PLACE_CAP} code`,
      value: code,
    });
    const submit = () => {
      if (!CODE_RE.test(code)) {
        error = `A ${PLACE} code is 6 letters and numbers — it is printed under the QR at your ${PLACE}.`;
        paint();
        return;
      }
      lookUp(() => api.directory.byCode(code));
    };
    input.addEventListener('input', () => {
      const next = cleanCode(input.value);
      if (input.value !== next) input.value = next;
      code = next;
      // Six valid characters is a whole code: look it up without a tap.
      if (CODE_RE.test(code)) submit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    // After the card is in the page — focus does nothing before that.
    setTimeout(() => input.focus(), 0);
    return [
      h('p', { class: 'portal-login-sub findgym-lead' }, 'Ask at the front desk, or find it on the poster under the QR code.'),
      h('label', { class: 'portal-field portal-login-field' }, renderIcon('key', { size: 20 }), input),
      h(
        'button',
        { class: 'portal-login-cta', type: 'button', disabled: busy, onclick: submit },
        h('span', {}, busy ? 'Finding…' : `Find my ${PLACE}`),
        renderIcon('arrowRight', { size: 22, stroke: 2 }),
      ),
    ];
  }

  function paintSearch() {
    const input = h('input', {
      class: 'portal-input',
      type: 'search',
      enterkeyhint: 'search',
      autocomplete: 'off',
      placeholder: `${PLACE_CAP} name, city or PIN code`,
      'aria-label': `Search ${PLACE}s by name, city or PIN code`,
      value: searchText,
    });
    const list = h('div', { class: 'findgym-results', 'aria-live': 'polite' });

    const show = () => {
      clear(list);
      if (results === null) return;
      if (!results.length) {
        list.append(
          h('p', { class: 'portal-login-note' }, `No ${PLACE}s found. Try the city, or ask your ${PLACE} for its code — not every ${PLACE} is listed.`),
        );
        return;
      }
      list.append(...results.map((gym) => gymRow(gym, () => { found = gym; error = ''; paint(); })));
    };

    const run = async () => {
      const q = searchText.trim();
      const seq = ++searchSeq;
      if (q.length < 2) {
        results = null;
        show();
        return;
      }
      try {
        const { items } = await api.directory.search(q, SEARCH_TYPE);
        if (seq !== searchSeq) return; // a newer keystroke's answer wins
        results = items;
        error = '';
      } catch (err) {
        if (seq !== searchSeq) return;
        results = [];
        error = err.message;
      }
      show();
    };

    input.addEventListener('input', () => {
      searchText = input.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(run, 300);
    });
    // After the card is in the page — focus does nothing before that.
    setTimeout(() => input.focus(), 0);
    show();
    return [h('label', { class: 'portal-field portal-login-field' }, renderIcon('search', { size: 20 }), input), list];
  }

  /** Gyms this phone has opened before — one tap, no confirming again. */
  function recentList() {
    if (!isNativeApp) return null;
    const recent = recentGyms().filter((gym) => gym.slug !== selectedGym?.slug);
    if (!recent.length) return null;
    return h(
      'div',
      { class: 'findgym-recent' },
      h('h3', { class: 'findgym-section' }, `Your ${PLACE}s`),
      ...recent.map((gym) =>
        gymRow(
          gym,
          () => chooseGym(gym),
          h(
            'button',
            {
              class: 'findgym-forget',
              type: 'button',
              title: 'Remove from this list',
              'aria-label': `Remove ${gym.gym_name} from this list`,
              onclick: () => {
                removeRecentGym(gym.slug);
                paint();
              },
            },
            renderIcon('close', { size: 16 }),
          ),
        ),
      ),
    );
  }

  /* ── Confirming ── */

  function lookAgain() {
    found = null;
    error = '';
    if (tab === 'scan') scanState = 'live';
    paint();
  }

  function paintConfirm() {
    const gym = found;
    const choose = () => {
      if (isNativeApp) chooseGym(gym);
      else window.location.assign(`${gym.url}/#/portal`);
    };
    append(card, [
      h(
        'button',
        { class: 'portal-back-link', type: 'button', onclick: lookAgain },
        '← Back',
      ),
      h(
        'div',
        { class: 'findgym-found' },
        gymLogo(gym, 'lg'),
        h('h2', { class: 'portal-login-title' }, gym.gym_name),
        gym.address_text
          ? h('p', { class: 'findgym-address' }, renderIcon('mapPin', { size: 16 }), h('span', {}, gym.address_text))
          : null,
        gym.gym_code ? h('span', { class: 'findgym-code-chip' }, 'Code ', h('strong', {}, gym.gym_code)) : null,
      ),
      h(
        'button',
        { class: 'portal-login-cta', type: 'button', onclick: choose },
        h('span', {}, `This is my ${PLACE}`),
        renderIcon('arrowRight', { size: 22, stroke: 2 }),
      ),
      h(
        'button',
        { class: 'portal-login-link findgym-not', type: 'button', onclick: lookAgain },
        `Not your ${PLACE}? Look again`,
      ),
    ]);
  }

  paint();

  return h(
    'div',
    // The gym photo is gym art: CoachBook's finder keeps the plain backdrop,
    // like an institute's own sign-in screen.
    { class: `portal-login${coachBookApp ? '' : ' has-art'} findgym` },
    h(
      'div',
      { class: 'portal-login-stage findgym-stage' },
      h('span', { class: 'portal-login-stripe portal-login-stripe-tl', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'portal-login-brand' },
        h('img', {
          class: `findgym-brand${coachBookApp ? ' findgym-brand-coachbook' : ''}`,
          src: coachBookApp ? '/icons/coaching/icon-192.png' : '/images/brand/gymvym-icon.webp',
          alt: nativeAppName,
        }),
        h('h1', { class: 'portal-login-gymname' }, 'Find your ', h('em', {}, PLACE)),
        h('p', { class: 'findgym-tagline' }, `Scan the QR at your ${PLACE}’s front desk, enter its code, or search by name.`),
      ),
      h('div', { class: 'portal-login-card-wrap' }, card),
    ),
  );
}
