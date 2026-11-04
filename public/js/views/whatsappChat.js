import { append, clear, date, emptyState, h, openModal, renderIcon, toast } from '../ui.js';

/**
 * The WhatsApp chat drawer and the AI receptionist's plan card, shared by
 * CoachBook's admissions desk (views/coaching/admissionsChat.js) and
 * GymBook's trials desk (views/trials.js). Each passes in the calls that
 * load, answer and pause its own lead's chat; the drawer itself — what the
 * contact wrote, what the AI assistant and the staff answered, the banners
 * and the reply box — is the same for both.
 */

const fill = (node, ...children) => append(clear(node), children);

const POLL_MS = 4000;

const TOOL_LABELS = {
  get_fee_details: 'Checked fees',
  get_demo_slots: 'Checked demo slots',
  book_demo: 'Booked a demo',
  get_trial_dates: 'Checked trial days',
  book_trial: 'Booked a free trial',
  save_lead: 'Saved lead details',
  send_location: 'Sent location',
  handoff_to_staff: 'Flagged for staff',
};

const FOLLOW_UPS = {
  noshow: 'Auto follow-up · no-show',
  visited: 'Auto follow-up · after visit',
  expiry: 'Auto follow-up · trial ending',
};

const PAUSED_BY = {
  staff_reply: 'a staff member replied from the phone',
  desk: 'paused from the desk',
  limit: 'it reached its reply limit for this chat',
};

/** A stored UTC "YYYY-MM-DD HH:MM:SS" as the viewer's local date and time. */
function when(utc, { withDay = true } = {}) {
  if (!utc) return '';
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!withDay || d.toDateString() === new Date().toDateString()) return clock;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock}`;
}

const pausedForever = (utc) => String(utc || '').startsWith('9999');

/** WhatsApp's *bold* and _italic_, and line breaks, as DOM — never as HTML. */
function waText(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (i) out.push(h('br'));
    for (const part of line.split(/(\*[^*\n]+\*|_[^_\n]+_)/)) {
      if (!part) continue;
      if (/^\*[^*]+\*$/.test(part)) out.push(h('strong', {}, part.slice(1, -1)));
      else if (/^_[^_]+_$/.test(part)) out.push(h('em', {}, part.slice(1, -1)));
      else out.push(part);
    }
  });
  return out;
}

function bubble(m) {
  if (m.kind === 'note') {
    return h('div', { class: 'cb-chat-note' }, h('span', {}, m.body), h('time', {}, when(m.created_at)));
  }
  const side = m.direction === 'out' ? 'is-out' : 'is-in';
  const who = m.meta?.followup
    ? h('span', { class: 'cb-chat-who' }, renderIcon('bell', { size: 12 }), FOLLOW_UPS[m.meta.followup] || 'Auto follow-up')
    : m.author === 'ai'
      ? h('span', { class: 'cb-chat-who is-ai' }, renderIcon('sparkle', { size: 12 }), 'AI assistant')
      : m.author === 'staff'
        ? h('span', { class: 'cb-chat-who' }, renderIcon('user', { size: 12 }), m.meta?.by ? `Staff · ${m.meta.by}` : 'Staff')
        : null;
  const tools = (m.meta?.tools || []).filter((t) => t.ok && TOOL_LABELS[t.name]);
  const body =
    m.kind === 'location'
      ? h('div', { class: 'cb-chat-location' }, renderIcon('mapPin', { size: 18 }), h('div', {}, h('strong', {}, 'Location pin'), h('div', {}, ...waText(m.body))))
      : m.meta?.trial_pass
        ? h('div', { class: 'cb-chat-location' }, renderIcon('ticket', { size: 18 }), h('div', {}, h('strong', {}, 'Trial pass QR'), h('div', {}, ...waText(m.body.replace(/^\[Trial pass QR\]\n/, '')))))
        : h('div', { class: 'cb-chat-text' }, ...waText(m.body));
  return h(
    'div',
    { class: `cb-chat-msg ${side} by-${m.author}${m.status === 'failed' ? ' is-failed' : ''}` },
    who,
    body,
    tools.length || m.meta?.guarded
      ? h(
          'div',
          { class: 'cb-chat-tools' },
          ...tools.map((t) => h('span', {}, TOOL_LABELS[t.name])),
          m.meta?.guarded ? h('span', { class: 'is-warn' }, 'Held back an unverified amount') : null,
        )
      : null,
    h(
      'div',
      { class: 'cb-chat-meta' },
      m.status === 'failed' ? h('span', { class: 'cb-red' }, `Not delivered${m.error ? ` — ${m.error}` : ''}`) : null,
      h('time', {}, when(m.created_at)),
    ),
  );
}

/**
 * The drawer: the whole chat with one lead, refreshed every few seconds
 * while open, and a box to reply from the business's number. A reply from
 * here pauses the assistant in this chat, the same as one typed on the phone.
 *
 * `load({ after })`, `reply(text)` and `setPaused(paused)` each resolve to
 * the transcript payload the server returns; `org` names the business in
 * the placeholder and banners ("institute", "gym").
 */
export function openChatDrawer({ title, subtitle, org, load, reply, setPaused, onChange }) {
  const banner = h('div', { class: 'cb-chat-banners' });
  const list = h('div', { class: 'cb-chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': `WhatsApp chat with ${title}` });
  const input = h('textarea', {
    class: 'cb-chat-input',
    rows: 2,
    maxlength: 2000,
    placeholder: `Reply on WhatsApp as the ${org}…`,
    'aria-label': 'Reply',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    },
  });
  const sendBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => send() }, renderIcon('send', { size: 15 }), 'Send');
  const hint = h('div', { class: 'muted cb-small cb-chat-hint' });

  let lastId = 0;
  let data = null;
  let timer = null;
  let closed = false;
  let changed = false;

  function renderBanners() {
    const conv = data.conversation;
    const parts = [];
    if (!data.whatsapp_connected) {
      parts.push(
        h('div', { class: 'cb-chat-banner is-red' }, renderIcon('alert', { size: 15 }), h('span', {}, 'WhatsApp is not linked, so nothing can be sent. '), h('a', { href: '#/whatsapp' }, 'Link it')),
      );
    }
    if (conv?.needs_staff) {
      parts.push(h('div', { class: 'cb-chat-banner is-amber' }, renderIcon('bell', { size: 15 }), h('span', {}, h('strong', {}, 'Needs a reply from the team. '), conv.handoff_reason || '')));
    }
    if (!data.receptionist_on) {
      parts.push(h('div', { class: 'cb-chat-banner' }, renderIcon('info', { size: 15 }), h('span', {}, `The AI assistant is switched off for the ${org}.`)));
    } else if (conv) {
      const toggle = h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: async () => {
            toggle.disabled = true;
            try {
              data = await setPaused(!conv.paused);
              changed = true;
              renderAll();
            } catch (err) {
              toast(err.message, 'error');
              toggle.disabled = false;
            }
          },
        },
        renderIcon(conv.paused ? 'play' : 'pause', { size: 14 }),
        conv.paused ? 'Resume assistant' : 'Pause assistant',
      );
      const text = conv.paused
        ? h(
            'span',
            {},
            h('strong', {}, 'Assistant paused'),
            ` — ${PAUSED_BY[conv.paused_by] || 'paused'}${pausedForever(conv.bot_paused_until) ? '' : `, until ${when(conv.bot_paused_until)}`}.`,
          )
        : h('span', {}, h('strong', {}, 'AI assistant is answering this chat.'), ' It pauses when anyone on your team replies.');
      parts.push(h('div', { class: `cb-chat-banner ${conv.paused ? 'is-paused' : 'is-live'}` }, renderIcon(conv.paused ? 'pause' : 'sparkle', { size: 15 }), text, h('div', { class: 'spacer' }), toggle));
    }
    fill(banner, ...parts);
    const hours = Math.round((data.pause_minutes || 720) / 60);
    hint.textContent = data.receptionist_on
      ? `Ctrl+Enter to send. Replying pauses the assistant here for ${hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${data.pause_minutes} minutes`}.`
      : 'Ctrl+Enter to send.';
  }

  function stickToBottom(fn) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    fn();
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function renderAll() {
    renderBanners();
    stickToBottom(() =>
      fill(
        list,
        ...(data.messages.length
          ? data.messages.map(bubble)
          : [emptyState(data.conversation ? 'No messages yet.' : 'No WhatsApp chat with this lead yet — send the first message below.', { icon: 'whatsapp' })]),
      ),
    );
    lastId = data.messages.at(-1)?.id ?? lastId;
    list.scrollTop = list.scrollHeight;
  }

  async function poll() {
    if (closed) return;
    try {
      const fresh = await load({ after: lastId || undefined });
      if (closed) return;
      const added = fresh.messages;
      data = { ...fresh, messages: [...(data?.messages || []), ...added] };
      renderBanners();
      if (added.length) {
        changed = true;
        stickToBottom(() => {
          if (list.querySelector('.empty')) fill(list);
          list.append(...added.map(bubble));
        });
        lastId = added.at(-1).id;
      }
    } catch {
      // A dropped poll is retried on the next tick.
    }
    timer = setTimeout(poll, POLL_MS);
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      data = await reply(text);
      input.value = '';
      changed = true;
      renderAll();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  openModal({
    title,
    subtitle,
    icon: 'whatsapp',
    className: 'cb-chat-drawer',
    body: h('div', { class: 'cb-chat' }, banner, list, h('div', { class: 'cb-chat-compose' }, input, sendBtn), hint),
    onClose: () => {
      closed = true;
      clearTimeout(timer);
      if (changed) onChange?.();
    },
  });

  fill(list, h('p', { class: 'muted cb-small', style: 'margin:auto' }, 'Loading the chat…'));
  load({})
    .then((fresh) => {
      if (closed) return;
      data = fresh;
      renderAll();
      timer = setTimeout(poll, POLL_MS);
    })
    .catch((err) => {
      fill(list, emptyState(err.message, { icon: 'alert' }));
    });
}

/* ── The plan ────────────────────────────────────────────────────────── */

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** One line on where the AI receptionist plan stands, for a banner and the
 * settings modal. Null on an install with no plans (single gym). */
export function planLine(plan) {
  if (!plan) return null;
  const left = `${plan.days_left} day${plan.days_left === 1 ? '' : 's'} left`;
  switch (plan.status) {
    case 'trial':
      return { tone: plan.days_left <= 3 ? 'amber' : 'blue', text: `Free trial · ${left} (until ${date(plan.ends_on)})` };
    case 'active':
      return { tone: plan.days_left <= 5 ? 'amber' : 'green', text: `Paid until ${date(plan.ends_on)} · ${left}` };
    case 'expired':
      return { tone: 'red', text: `Plan ended on ${date(plan.paid_until && plan.paid_until > (plan.trial_ends_on || '') ? plan.paid_until : plan.trial_ends_on)} — the assistant is not answering` };
    default:
      return plan.trial_available
        ? { tone: 'blue', text: `Free for ${plan.trial_days} days, then ${rupees(plan.price_monthly)}/month` }
        : { tone: 'grey', text: `${rupees(plan.price_monthly)}/month` };
  }
}

/**
 * The plan card at the top of the assistant's settings: where it stands,
 * and — for anyone past or near the end of a trial — the prepaid periods to
 * buy, paid through Razorpay (UPI first) at the price the platform set.
 * `checkout(months)` and `verify(payment)` are the vertical's own endpoints;
 * `brand` names the platform for "contact … support".
 */
export function planCard(plan, { checkout, verify, brand, onPaid }) {
  const line = planLine(plan);
  const offers = plan.offers || [];
  let picked = offers.find((o) => o.months === 3) || offers[0];
  const options = h('div', { class: 'cb-plan-offers', role: 'radiogroup', 'aria-label': 'Plan length' });
  const pay = h('button', { class: 'btn primary', type: 'button' });
  const paint = () => {
    fill(
      options,
      ...offers.map((o) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(o === picked),
            class: `cb-plan-offer${o === picked ? ' is-picked' : ''}`,
            onclick: () => {
              picked = o;
              paint();
            },
          },
          h('strong', {}, `${o.months} month${o.months === 1 ? '' : 's'}`),
          h('span', {}, rupees(o.price)),
          h('small', { class: 'muted' }, o.months === 1 ? 'per month' : `${rupees(o.per_month)}/month`),
          o.save_pct ? h('em', {}, `Save ${o.save_pct}%`) : null,
        ),
      ),
    );
    fill(pay, renderIcon('zap', { size: 15 }), `Pay ${rupees(picked?.price)}`);
  };
  pay.onclick = async () => {
    pay.disabled = true;
    try {
      const { checkout: order } = await checkout(picked.months);
      const { payWithRazorpay } = await import('../razorpayCheckout.js');
      const payment = await payWithRazorpay(order);
      const fresh = await verify(payment);
      toast(`Paid — the assistant is covered until ${date(fresh.plan.ends_on)}`);
      await onPaid?.(fresh);
    } catch (err) {
      if (!err.cancelled) toast(err.message, 'error');
    } finally {
      pay.disabled = false;
    }
  };
  paint();

  const canBuy = plan.sales_open && plan.online_payments && offers.length;
  return h(
    'div',
    { class: `cb-plan is-${plan.status}` },
    h(
      'div',
      { class: 'cb-plan-head' },
      h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, 'AI receptionist plan'), h('span', { class: `badge dot ${line.tone}` }, line.text)),
      plan.custom_price ? h('span', { class: 'muted cb-small' }, 'Your special price') : null,
    ),
    plan.status === 'none' && plan.trial_available
      ? h('p', { class: 'muted cb-small' }, `Switch the assistant on below to start your ${plan.trial_days}-day free trial. No payment needed to try it.`)
      : null,
    plan.status !== 'none' || !plan.trial_available
      ? canBuy
        ? h('div', {}, options, h('div', { class: 'cb-plan-pay' }, pay, h('span', { class: 'muted cb-small' }, plan.status === 'trial' ? 'Paid months start after your trial ends.' : 'Prepaid. Paid months add on to any time you have left.')))
        : h('p', { class: 'muted cb-small' }, plan.sales_open ? `To pay by UPI or bank transfer, contact ${brand} support.` : `Not available for purchase right now — contact ${brand} support.`)
      : null,
  );
}
