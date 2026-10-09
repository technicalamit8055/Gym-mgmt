import { api, session } from '../api.js';
import { confirmDialog, date, h, renderIcon, toast } from '../ui.js';
import { isLibrary } from '../vertical.js';

/**
 * A gym's own domain (app.theirgym.com), connected from Gym settings.
 *
 * The pieces that describe a domain — its status badge, the records to create
 * and what the last DNS check found — are exported for the operator console,
 * so support sees exactly what the gym sees.
 */

/** Registry timestamps are SQLite `datetime('now')`: UTC, with no zone marker. */
const utc = (value) => (value && !String(value).includes('T') ? `${String(value).replace(' ', 'T')}Z` : value);

export function domainStatusBadge(domain) {
  return domain.status === 'active'
    ? h('span', { class: 'badge green' }, 'Live')
    : h('span', { class: 'badge amber' }, 'Waiting for DNS');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy — select the text and copy it manually', 'error');
  }
}

const copyButton = (text) =>
  h('button', { class: 'btn sm ghost', type: 'button', title: 'Copy', onclick: () => copy(text) }, 'Copy');

/** ✓ / ✗ for one record, from the last check — nothing until one has run. */
function recordState(record, check) {
  const part = check?.[record.purpose];
  if (!part) return null;
  return part.ok
    ? h('span', { class: 'domain-ok', title: part.message }, renderIcon('checkCircle', { size: 16 }))
    : h('span', { class: 'domain-bad', title: part.message }, renderIcon('xCircle', { size: 16 }));
}

/** The records to create, laid out the way a registrar's DNS form asks for them. */
export function dnsRecordsTable(domain) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'dns-records' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Name / Host'), h('th', {}, 'Value / Points to'), h('th', {}, ''))),
      h(
        'tbody',
        {},
        ...domain.dns_records.map((record) =>
          h(
            'tr',
            {},
            h('td', {}, h('span', { class: 'badge grey' }, record.type)),
            h(
              'td',
              {},
              h('code', {}, record.host),
              h('div', { class: 'muted dns-full-name' }, record.name),
            ),
            h(
              'td',
              {},
              h('code', {}, record.value),
              record.note ? h('div', { class: 'muted dns-full-name' }, record.note) : null,
            ),
            h(
              'td',
              { class: 'num' },
              h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end;flex-wrap:nowrap' }, recordState(record, domain.last_check), copyButton(record.value)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** What the last "Check DNS" found, record by record, in plain words. */
export function checkSummary(domain) {
  const check = domain.last_check;
  if (!check) return h('p', { class: 'muted domain-check-none' }, 'Not checked yet.');
  const line = (label, part) =>
    h(
      'div',
      { class: `domain-check-line ${part.ok ? 'ok' : 'bad'}` },
      renderIcon(part.ok ? 'checkCircle' : 'xCircle', { size: 16 }),
      h('div', {}, h('strong', {}, label), ' ', part.message),
    );
  const routingLabel = domain.kind === 'subdomain' ? 'Routing (CNAME):' : 'Routing (A record):';
  return h(
    'div',
    { class: 'domain-check' },
    line(routingLabel, check.routing),
    line('Ownership (TXT):', check.ownership),
    h('div', { class: 'muted', style: 'font-size:12px' }, `Last checked ${date(check.checked_at, { withTime: true })}`),
  );
}

/** Where the Name/Host field lives at the registrars gyms actually use. */
function registrarTips(setup) {
  const tip = (name, text) => h('li', {}, h('strong', {}, `${name}: `), text);
  return h(
    'details',
    { class: 'domain-tips' },
    h('summary', {}, 'Step-by-step for GoDaddy, Namecheap, Cloudflare, Hostinger and others'),
    h(
      'ul',
      {},
      tip('GoDaddy', 'My Products → your domain → DNS → Add New Record. Enter the Name exactly as shown in the "Name / Host" column — GoDaddy adds your domain on the end itself.'),
      tip('Namecheap', 'Domain List → Manage → Advanced DNS → Add New Record. Namecheap calls the name "Host".'),
      tip('Cloudflare', 'DNS → Records → Add record. Set Proxy status to "DNS only" (grey cloud) — the orange cloud hides where the record points, and the check below will fail. For a root domain, a CNAME on "@" works too: Cloudflare flattens it.'),
      tip('Hostinger', 'Domains → your domain → DNS / Nameservers → DNS records.'),
      tip('Squarespace (formerly Google Domains)', 'Domains → your domain → DNS → Custom records.'),
      tip('Wix, BigRock, GoDaddy-resellers and others', 'Look for "DNS", "Zone editor" or "Advanced DNS". The Name/Host is the part before your domain; "@" means the domain itself. If the form wants the full name, use the grey one under it.'),
    ),
    h(
      'p',
      { class: 'muted', style: 'font-size:13px;margin:8px 0 0' },
      'Delete any existing A, AAAA or CNAME record on the same name first — two records on one name send visitors to two places. ',
      setup.apex_ipv4?.length
        ? null
        : 'For a root domain, use your provider’s ALIAS / ANAME / CNAME-flattening record.',
    ),
  );
}

function domainItem(domain, data, { isAdmin, reload }) {
  const check = h('button', { class: 'btn sm primary', type: 'button' }, renderIcon('refresh', { size: 15 }), 'Check DNS');
  check.onclick = async () => {
    check.disabled = true;
    try {
      const { domain: updated, result, throttled } = await api.checkCustomDomain(domain.id);
      if (updated.status === 'active' && domain.status !== 'active') toast(`${updated.hostname} is live`);
      else if (throttled) toast('Checked a few seconds ago — showing that result', 'info');
      else if (result.ok) toast('All records look right');
      else toast('Not ready yet — see what is missing below', 'error');
      await reload();
    } catch (err) {
      toast(err.message || 'Could not check DNS', 'error');
      check.disabled = false;
    }
  };

  const onThisAddress = data.current_host === domain.hostname;
  const remove = h('button', { class: 'btn sm ghost danger', type: 'button' }, 'Remove');
  remove.onclick = () =>
    confirmDialog({
      title: `Disconnect ${domain.hostname}?`,
      message: onThisAddress
        ? `You are using this address right now. Once it is removed, sign in at ${data.platform_url} instead. Your DNS records can stay — they just stop doing anything.`
        : 'Visitors to this address will no longer reach your gym. Your gym stays reachable at its other addresses.',
      confirmLabel: 'Disconnect',
      danger: true,
      onConfirm: async () => {
        await api.removeCustomDomain(domain.id);
        toast(`${domain.hostname} disconnected`);
        if (onThisAddress) {
          window.location.href = data.platform_url;
          return;
        }
        await reload();
      },
    });

  const live = domain.status === 'active';
  const records = dnsRecordsTable(domain);

  return h(
    'div',
    { class: 'domain-item' },
    h(
      'div',
      { class: 'domain-item-head' },
      h(
        'div',
        {},
        h('div', { class: 'domain-name' }, domain.hostname),
        h(
          'div',
          { class: 'muted', style: 'font-size:12px' },
          domain.kind === 'apex' ? 'Root domain' : `Subdomain of ${domain.apex}`,
          live && domain.verified_at ? ` · live since ${date(utc(domain.verified_at))}` : '',
          onThisAddress ? ' · you are using this address now' : '',
        ),
      ),
      domainStatusBadge(domain),
    ),

    live
      ? h(
        'p',
        { class: 'muted', style: 'margin:0 0 10px;font-size:13px' },
        'Your gym opens at ',
        h('a', { href: domain.url, target: '_blank', rel: 'noopener' }, domain.url),
        '. Keep the DNS records below in place — removing them takes the address offline.',
      )
      : h(
        'ol',
        { class: 'domain-steps' },
        h('li', {}, `Sign in where you manage DNS for ${domain.apex} (usually where you bought the domain) and add these records:`),
        h('li', { class: 'domain-steps-records' }, records),
        h('li', {}, 'Click Check DNS. Changes usually show up within minutes, but can take up to 48 hours to reach everyone.'),
      ),

    live ? h('details', { class: 'domain-tips' }, h('summary', {}, 'DNS records'), records) : registrarTips(data),
    checkSummary(domain),

    h(
      'div',
      { class: 'row', style: 'gap:8px;margin-top:12px;flex-wrap:wrap' },
      isAdmin ? check : null,
      live ? h('a', { class: 'btn sm ghost', href: domain.url, target: '_blank', rel: 'noopener' }, 'Open') : null,
      isAdmin ? remove : null,
    ),
  );
}

function addDomainForm(data, { reload }) {
  const input = h('input', {
    class: 'input',
    placeholder: 'app.yourbrand.com',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const hint = h('div', { class: 'muted domain-hint' }, 'A subdomain such as app., portal. or members. is the usual choice.');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Connect domain');

  // Live classification, debounced and ordered so a slow answer for "app.ac"
  // never overwrites the one for "app.acme.com".
  let timer;
  let latest = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const value = input.value.trim();
    if (!value) {
      hint.className = 'muted domain-hint';
      hint.textContent = 'A subdomain such as app., portal. or members. is the usual choice.';
      return;
    }
    timer = setTimeout(async () => {
      const ticket = ++latest;
      try {
        const info = await api.inspectDomain(value);
        if (ticket !== latest) return;
        if (!info.valid) {
          hint.className = 'domain-hint bad';
          hint.textContent = info.error;
        } else if (info.kind === 'subdomain') {
          hint.className = 'domain-hint ok';
          hint.textContent = `Subdomain of ${info.apex} — ${info.apex} itself stays free for your website. You will add a CNAME record.`;
        } else {
          hint.className = 'domain-hint warn';
          hint.textContent = `Root domain — this replaces whatever website runs at ${info.hostname} today. Most gyms use a subdomain like app.${info.hostname} instead.`;
        }
      } catch {
        // Feedback only — the submit validates for real.
      }
    }, 300);
  });

  const form = h(
    'form',
    { class: 'domain-add' },
    h('label', { class: 'field full' }, h('span', {}, 'Your domain'), h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, input, submit)),
    hint,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const { domain } = await api.addCustomDomain(input.value.trim());
      toast(`${domain.hostname} added — now add the DNS records shown`);
      await reload();
    } catch (err) {
      toast(err.details?.hostname || err.message || 'Could not add that domain', 'error');
      submit.disabled = false;
    }
  });
  return form;
}

/**
 * The Gym settings card. `data` is GET /api/platform/domains; `reload`
 * re-renders the settings page, which re-reads it — the last check is stored
 * server-side, so nothing shown here is lost across that.
 */
export function customDomainCard(data, { reload }) {
  const isAdmin = session.can('admin');
  const head = h(
    'div',
    { class: 'stg-head' },
    h('span', { class: 'stg-head-icon tone-violet' }, renderIcon('globe', { size: 24, stroke: 2 })),
    h('div', { class: 'stg-head-text' }, h('h3', {}, 'Custom domain')),
  );

  if (!data) {
    return h('div', { class: 'card stg-card' }, head, h('p', { class: 'muted', style: 'margin:0' }, 'Could not load your domains.'));
  }

  if (!data.enabled) {
    return h(
      'div',
      { class: 'card stg-card stg-domain-off' },
      h('img', { class: 'stg-art bottom-right stg-art-domain', src: '/images/settings/domain.svg', alt: '', 'aria-hidden': 'true' }),
      head,
      h(
        'p',
        { class: 'muted stg-domain-text' },
        `Running your ${isLibrary() ? 'library' : 'gym'} on your own address (like app.yourbrand.com) is not switched on for this deployment yet. Until then your ${isLibrary() ? 'library' : 'gym'} lives at `,
        h('code', {}, data.platform_url),
        '.',
      ),
    );
  }

  const atLimit = data.items.length >= data.max_per_tenant;

  return h(
    'div',
    { class: 'card stg-card' },
    head,
    h(
      'p',
      { class: 'muted', style: 'margin:0 0 14px' },
      'Run this app at your own address. We recommend a subdomain such as ',
      h('strong', {}, 'app.yourbrand.com'),
      ', so yourbrand.com itself can keep your website (WordPress, Webflow, Wix…). Your current address ',
      h('code', {}, data.platform_url),
      ' keeps working either way.',
    ),
    ...data.items.map((domain) => domainItem(domain, data, { isAdmin, reload })),
    isAdmin && !atLimit ? addDomainForm(data, { reload }) : null,
    isAdmin && atLimit
      ? h('p', { class: 'muted', style: 'font-size:13px;margin:12px 0 0' }, `You can connect up to ${data.max_per_tenant} domains. Remove one to add another.`)
      : null,
    !isAdmin ? h('p', { class: 'muted', style: 'font-size:13px;margin:12px 0 0' }, 'Only an admin can connect or remove domains.') : null,
  );
}
