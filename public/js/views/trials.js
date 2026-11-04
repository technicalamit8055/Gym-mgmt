import { api, session } from '../api.js';
import { buildForm, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, stat, time, toast, today } from '../ui.js';
import { fill, pillTabs } from './coaching/common.js';
import { openChatDrawer, planCard, planLine } from './whatsappChat.js';

/**
 * Trials & leads: everyone who might join — written in on WhatsApp (and
 * answered there by the AI front desk), walked in or called — and the free
 * trial pass that brings them through the door. Ordered by what needs doing
 * next; "Join as member" turns a lead into a member, whose page then sells
 * the plan. The server side is src/routes/trials.js.
 */

const STAGE = {
  lead: { label: 'New lead', tone: 'blue' },
  booked: { label: 'Trial booked', tone: 'violet' },
  visited: { label: 'Visited', tone: 'green' },
  no_show: { label: 'No-show', tone: 'amber' },
  converted: { label: 'Joined', tone: 'green' },
  lost: { label: 'Lost', tone: 'grey' },
};

const SOURCE = {
  whatsapp: 'WhatsApp',
  walk_in: 'Walk-in',
  phone: 'Phone call',
  referral: 'Referral',
  social: 'Social media',
  other: 'Other',
};

const PASS_STATE = {
  upcoming: { label: 'Starts later', tone: 'blue' },
  active: { label: 'Active', tone: 'green' },
  used: { label: 'All visits used', tone: 'grey' },
  expired: { label: 'Expired', tone: 'grey' },
  revoked: { label: 'Cancelled', tone: 'red' },
};

/** Rules the desk may knowingly break — see OVERRIDABLE in src/trialPasses.js. */
const OVERRIDABLE = new Set(['member', 'cooldown', 'full', 'too_far']);

const badge = (map, key) => h('span', { class: `badge dot ${map[key]?.tone || 'grey'}` }, map[key]?.label || key);
const leadName = (lead) => lead.name || 'Name not shared yet';
const passDays = (p) => (p.valid_from === p.valid_until ? date(p.valid_from) : `${date(p.valid_from)} – ${date(p.valid_until)}`);

/* ── Forms ───────────────────────────────────────────────────────────── */

function openLeadForm({ lead, plans, onSaved }) {
  const editing = Boolean(lead);
  openModal({
    title: editing ? `Edit · ${leadName(lead)}` : 'New lead',
    subtitle: editing ? null : 'A walk-in or a call — note them down, and hand them a free trial pass if they want one.',
    icon: 'userPlus',
    wide: true,
    body: buildForm(
      [
        { name: 'name', label: 'Name', required: true, value: lead?.name },
        { name: 'phone', label: 'Mobile (WhatsApp)', required: true, value: lead?.phone, placeholder: '98765 43210' },
        { name: 'goal', label: 'Fitness goal', value: lead?.goal, placeholder: 'Weight loss, muscle gain…' },
        { name: 'preferred_time', label: 'Prefers to train', value: lead?.preferred_time, placeholder: 'Early mornings, after 7 PM…' },
        {
          name: 'plan_id',
          label: 'Interested in',
          type: 'select',
          value: lead?.plan_id ?? '',
          options: [{ value: '', label: 'Not decided yet' }, ...plans.map((p) => ({ value: p.id, label: p.name }))],
        },
        {
          name: 'source',
          label: 'How they found us',
          type: 'select',
          value: lead?.source || 'walk_in',
          options: Object.entries(SOURCE).map(([value, label]) => ({ value, label })),
        },
        { name: 'follow_up_on', label: 'Follow up on', type: 'date', value: lead?.follow_up_on },
        editing
          ? null
          : {
              name: 'give_pass',
              label: 'Free trial pass',
              type: 'select',
              value: '1',
              options: [
                { value: '1', label: 'Issue one now and send it on WhatsApp' },
                { value: '0', label: 'Not now' },
              ],
            },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true, value: lead?.notes, placeholder: 'Knee injury last year; wants a trainer for the first week' },
      ].filter(Boolean),
      {
        submitLabel: editing ? 'Save' : 'Add lead',
        onSubmit: async ({ give_pass: givePass, ...values }) => {
          if (editing) {
            await api.updateTrialLead(lead.id, values);
            closeModal();
            toast('Lead saved');
            await onSaved?.();
            return;
          }
          const created = await api.createTrialLead(values);
          closeModal();
          toast('Lead added');
          await onSaved?.();
          if (givePass === '1') openIssuePass(created, { onDone: onSaved });
        },
      },
    ),
  });
}

/**
 * Issues a pass: the start day, the time they said they would come, and
 * whether to send it on WhatsApp. A refusal under the one-trial rules can
 * be overridden by the desk, after a confirmation that says why.
 */
function openIssuePass(lead, { onDone }) {
  const issue = async (values, override = false) => {
    try {
      const pass = await api.issueTrialPass(lead.id, {
        start_on: values.start_on || undefined,
        arrival_time: values.arrival_time || undefined,
        send: values.send === '1',
        override,
      });
      closeModal();
      toast(
        pass.already_issued
          ? `${leadName(lead)} already has a pass`
          : pass.sent
            ? `Trial pass sent to ${leadName(lead)} on WhatsApp`
            : pass.sent === false
              ? 'Pass issued — WhatsApp did not take it; show or resend it'
              : 'Trial pass issued',
        pass.sent === false ? 'error' : undefined,
      );
      await onDone?.();
      openPassModal(pass.id, { onChange: onDone });
    } catch (err) {
      if (err.status === 409 && OVERRIDABLE.has(err.details?.code) && !override) {
        confirmDialog({
          title: 'Issue the pass anyway?',
          message: err.message,
          confirmLabel: 'Issue anyway',
          onConfirm: () => issue(values, true),
        });
        return;
      }
      // The rule's code is not a form field; just say why.
      throw new Error(err.message);
    }
  };
  openModal({
    title: `Free trial · ${leadName(lead)}`,
    subtitle: 'A QR pass they show at the front desk. Each visit is counted when it is scanned.',
    icon: 'ticket',
    body: buildForm(
      [
        { name: 'start_on', label: 'Starts on', type: 'date', value: today() },
        { name: 'arrival_time', label: 'Coming around (optional)', type: 'time' },
        {
          name: 'send',
          label: 'Send the pass',
          type: 'select',
          value: '1',
          full: true,
          options: [
            { value: '1', label: `On WhatsApp to ${lead.phone}` },
            { value: '0', label: 'Don’t send — I’ll show or print it' },
          ],
        },
      ],
      { submitLabel: 'Issue pass', onSubmit: (values) => issue(values) },
    ),
  });
}

/** The pass: its QR to show or print, the details, and resend or cancel. */
async function openPassModal(passId, { onChange } = {}) {
  let pass;
  try {
    pass = await api.trialPass(passId);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const lead = pass.lead;
  const usable = ['upcoming', 'active'].includes(pass.state);
  const resend = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        resend.disabled = true;
        try {
          await api.sendTrialPass(pass.id);
          toast('Pass sent on WhatsApp');
          await onChange?.();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          resend.disabled = false;
        }
      },
    },
    renderIcon('whatsapp', { size: 15 }),
    pass.sent_at ? 'Send again' : 'Send on WhatsApp',
  );
  const card = h(
    'div',
    { class: 'trial-pass-card' },
    h('div', { class: 'trial-pass-qr', html: pass.svg }),
    h(
      'div',
      { class: 'trial-pass-info' },
      h('div', { class: 'cb-strong', style: 'font-size:17px' }, leadName(lead)),
      h('div', { class: 'muted cb-small' }, lead.phone),
      h('div', { class: 'trial-pass-code' }, pass.code),
      h('div', {}, badge(PASS_STATE, pass.state)),
      h('div', { class: 'cb-small' }, renderIcon('calendar', { size: 14 }), ` ${passDays(pass)}`),
      h('div', { class: 'cb-small' }, renderIcon('checkin', { size: 14 }), ` ${pass.visits_used} of ${pass.visits_allowed} visits used`),
      pass.arrival_time ? h('div', { class: 'cb-small' }, renderIcon('clock', { size: 14 }), ` Expected around ${time(pass.arrival_time)}`) : null,
      h('div', { class: 'muted cb-small' }, `${pass.issued_by === 'ai' ? 'Booked by the AI front desk' : 'Issued at the desk'}${pass.sent_at ? ' · sent on WhatsApp' : ''}`),
    ),
  );
  openModal({
    title: 'Free trial pass',
    subtitle: 'Scan it at the check-in desk, or type the code into the check-in box.',
    icon: 'ticket',
    body: h('div', {}, card),
    footer: h(
      'div',
      { class: 'row', style: 'gap:8px;flex-wrap:wrap;width:100%' },
      usable ? resend : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => printPass(pass) }, renderIcon('print', { size: 15 }), 'Print'),
      h('div', { class: 'spacer' }),
      usable
        ? h(
            'button',
            {
              class: 'btn ghost danger',
              type: 'button',
              onclick: () =>
                confirmDialog({
                  title: 'Cancel this trial pass?',
                  message: 'It stops checking in at once, and the number can be given a new trial.',
                  confirmLabel: 'Cancel pass',
                  danger: true,
                  onConfirm: async () => {
                    await api.revokeTrialPass(pass.id);
                    toast('Trial pass cancelled');
                    await onChange?.();
                  },
                }),
            },
            'Cancel pass',
          )
        : null,
    ),
  });
}

/** A one-page printout of the pass, for a walk-in without a smartphone. */
function printPass(pass) {
  const win = window.open('', '_blank', 'width=420,height=600');
  if (!win) {
    toast('Allow pop-ups to print the pass', 'error');
    return;
  }
  const doc = win.document;
  doc.title = `Trial pass ${pass.code}`;
  const style = doc.createElement('style');
  style.textContent =
    'body{font-family:system-ui,sans-serif;text-align:center;padding:24px;color:#111}svg{width:240px;height:240px}h1{font-size:20px;margin:8px 0}.code{font:700 22px monospace;letter-spacing:3px;margin:8px 0}p{margin:4px 0}';
  doc.head.append(style);
  const wrap = doc.createElement('div');
  wrap.innerHTML = pass.svg;
  const line = (tag, text, cls) => {
    const el = doc.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  doc.body.append(
    line('p', 'FREE TRIAL PASS'),
    line('h1', leadName(pass.lead)),
    wrap,
    line('div', pass.code, 'code'),
    line('p', passDays(pass)),
    line('p', `${pass.visits_allowed} visit${pass.visits_allowed === 1 ? '' : 's'}`),
  );
  win.focus();
  win.print();
}

/** Lead → member, with the name split for the member record. */
function openConvert(lead, { onDone, navigate }) {
  const [first, ...rest] = String(lead.name || '').trim().split(/\s+/);
  openModal({
    title: `${leadName(lead)} is joining`,
    subtitle: 'Creates their member profile with the next member code. Sell the plan from their page next.',
    icon: 'userPlus',
    body: buildForm(
      [
        { name: 'first_name', label: 'First name', required: true, value: first || '' },
        { name: 'last_name', label: 'Last name', value: rest.join(' ') },
        { name: 'phone', label: 'Mobile', value: String(lead.phone || '').startsWith('WhatsApp') ? '' : lead.phone },
        { name: 'email', label: 'Email', type: 'email' },
        {
          name: 'gender',
          label: 'Gender',
          type: 'select',
          value: '',
          options: [
            { value: '', label: '—' },
            { value: 'female', label: 'Female' },
            { value: 'male', label: 'Male' },
            { value: 'other', label: 'Other' },
          ],
        },
      ],
      {
        submitLabel: 'Create member',
        onSubmit: async (values) => {
          const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
          const res = await api.convertTrialLead(lead.id, body);
          closeModal();
          toast(`${body.first_name} is a member now — pick their plan`);
          await onDone?.();
          navigate(`/members/${res.member_id}`);
        },
      },
    ),
  });
}

/* ── A lead ──────────────────────────────────────────────────────────── */

function leadCard(lead, { plans, repaint, navigate }) {
  const openChat = () =>
    openChatDrawer({
      title: leadName(lead),
      subtitle: [lead.phone, lead.goal].filter(Boolean).join(' · '),
      org: 'gym',
      load: (params) => api.trialLeadChat(lead.id, params),
      reply: (text) => api.replyTrialLeadChat(lead.id, text),
      setPaused: (paused) => api.pauseTrialLeadAssistant(lead.id, paused),
      onChange: repaint,
    });
  const pass = lead.pass;
  const open = !['converted', 'lost'].includes(lead.stage);
  const due = open && lead.follow_up_on && lead.follow_up_on <= today();
  const usablePass = pass && ['upcoming', 'active'].includes(pass.state);

  const primary =
    lead.stage === 'converted'
      ? lead.member_id
        ? h('a', { class: 'btn sm', href: `#/members/${lead.member_id}` }, renderIcon('user', { size: 14 }), `Member ${lead.member_code || ''}`)
        : null
      : lead.stage === 'lost'
        ? h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: async () => {
                await api.updateTrialLead(lead.id, { status: 'new' });
                toast(`${leadName(lead)} is back on the list`);
                await repaint();
              },
            },
            'Reopen',
          )
        : lead.stage === 'lead' || (!usablePass && lead.stage === 'no_show')
          ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => openIssuePass(lead, { onDone: repaint }) }, renderIcon('ticket', { size: 14 }), 'Give free trial')
          : h('button', { class: 'btn sm primary', type: 'button', onclick: () => openConvert(lead, { onDone: repaint, navigate }) }, renderIcon('check', { size: 14 }), 'Join as member');

  return h(
    'div',
    { class: `card cb-lead${due ? ' is-due' : ''}${lead.wa_needs_staff ? ' needs-reply' : ''}` },
    h(
      'div',
      { class: 'cb-lead-top' },
      h(
        'div',
        { class: 'cb-grow' },
        h('div', { class: 'cb-strong cb-lead-name' }, leadName(lead)),
        h('div', { class: 'muted cb-small' }, [lead.goal, lead.preferred_time ? `Prefers ${lead.preferred_time}` : null].filter(Boolean).join(' · ')),
        lead.ai_captured || lead.wa_needs_staff
          ? h(
              'div',
              { class: 'cb-lead-flags' },
              lead.ai_captured ? h('span', { class: 'cb-ai-badge', title: 'Captured on WhatsApp by the AI front desk' }, renderIcon('sparkle', { size: 12 }), 'AI Captured') : null,
              lead.wa_needs_staff ? h('button', { class: 'cb-reply-badge', type: 'button', onclick: openChat }, renderIcon('bell', { size: 12 }), 'Needs your reply') : null,
            )
          : null,
      ),
      badge(STAGE, lead.stage),
    ),
    h(
      'div',
      { class: 'cb-lead-meta' },
      h('span', {}, renderIcon('phone', { size: 14 }), h('a', { href: `tel:${lead.phone}` }, lead.phone)),
      h('span', {}, renderIcon('barbell', { size: 14 }), lead.plan_name || 'Plan not decided'),
      h('span', {}, renderIcon('mapPin', { size: 14 }), SOURCE[lead.source] || lead.source),
      lead.follow_up_on && open ? h('span', { class: due ? 'cb-red' : '' }, renderIcon('calendar', { size: 14 }), `Follow up ${date(lead.follow_up_on)}`) : null,
    ),
    pass
      ? h(
          'button',
          { class: 'trial-pass-strip', type: 'button', onclick: () => openPassModal(pass.id, { onChange: repaint }), title: 'Show the pass' },
          renderIcon('ticket', { size: 15 }),
          h('strong', {}, pass.code),
          h('span', {}, passDays(pass)),
          h('span', {}, `${pass.visits_used}/${pass.visits_allowed} visits`),
          badge(PASS_STATE, pass.state),
        )
      : null,
    lead.notes ? h('p', { class: 'cb-small cb-lead-notes' }, lead.notes) : null,
    h(
      'div',
      { class: 'cb-lead-actions' },
      primary,
      h(
        'button',
        { class: `btn sm ${lead.wa_last_message_at ? '' : 'ghost'}`, type: 'button', onclick: openChat, title: 'WhatsApp chat', 'aria-label': `WhatsApp chat with ${leadName(lead)}` },
        renderIcon('whatsapp', { size: 14 }),
        lead.wa_last_message_at ? 'Chat' : null,
        lead.wa_paused ? h('span', { class: 'cb-chat-paused-dot', title: 'Assistant paused in this chat' }) : null,
      ),
      h('div', { class: 'spacer' }),
      open
        ? h(
            'button',
            {
              class: 'btn sm ghost',
              type: 'button',
              onclick: async () => {
                await api.updateTrialLead(lead.id, { status: 'lost' });
                toast(`${leadName(lead)} marked as lost`);
                await repaint();
              },
            },
            'Lost',
          )
        : null,
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openLeadForm({ lead, plans, onSaved: repaint }) }, 'Edit'),
      session.managesBilling
        ? h(
            'button',
            {
              class: 'btn sm ghost',
              title: 'Delete',
              'aria-label': `Delete ${leadName(lead)}`,
              onclick: () =>
                confirmDialog({
                  title: `Delete ${leadName(lead)}?`,
                  message: 'The lead and its trial passes are removed. A member made from it keeps their profile.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: async () => {
                    await api.deleteTrialLead(lead.id);
                    await repaint();
                  },
                }),
            },
            renderIcon('trash', { size: 14 }),
          )
        : null,
    ),
  );
}

/* ── Settings ────────────────────────────────────────────────────────── */

const onOff = (name, label, value, hint) => ({
  name,
  label,
  type: 'select',
  value: String(value ?? 0),
  hint,
  options: [
    { value: '1', label: 'On' },
    { value: '0', label: 'Off' },
  ],
});

const DAY_PRESETS = [
  { value: '1,2,3,4,5,6', label: 'Monday to Saturday' },
  { value: '0,1,2,3,4,5,6', label: 'Every day' },
  { value: '1,2,3,4,5', label: 'Monday to Friday' },
];

const BOOLEAN_FIELDS = ['ai_receptionist', 'hot_lead_alerts', 'trial_enabled', 'trial_followups'];
const NUMBER_FIELDS = ['ai_pause_minutes', 'trial_days', 'trial_visits', 'trial_cooldown_days', 'trial_daily_cap', 'trial_booking_days'];

/** The front desk's and the trials' settings in one modal, with the AI
 * receptionist plan on top. */
export async function openDeskSettings({ onSaved } = {}) {
  let payload = await api.trialSettings();
  const s = payload.settings;
  const planHost = h('div', {});
  const renderPlan = () =>
    fill(
      planHost,
      payload.plan
        ? planCard(payload.plan, {
            checkout: api.trialAssistantCheckout,
            verify: api.trialAssistantVerify,
            brand: 'GymBook',
            onPaid: async (fresh) => {
              payload = fresh;
              renderPlan();
              await onSaved?.();
            },
          })
        : null,
    );
  renderPlan();
  const status = h(
    'div',
    { class: 'cb-assist-status' },
    h('span', { class: `badge dot ${payload.whatsapp_connected ? 'green' : 'red'}` }, payload.whatsapp_connected ? 'WhatsApp linked' : 'WhatsApp not linked'),
    h('span', { class: `badge dot ${payload.ai_configured ? 'green' : 'amber'}` }, payload.ai_configured ? 'AI ready' : 'AI not set up on this server'),
    !payload.whatsapp_connected ? h('a', { href: '#/whatsapp', class: 'cb-small', onclick: () => closeModal() }, 'Link WhatsApp →') : null,
  );
  const dayOptions = DAY_PRESETS.some((p) => p.value === s.office_days) ? DAY_PRESETS : [...DAY_PRESETS, { value: s.office_days, label: `Custom (${s.office_days})` }];

  const form = buildForm(
    [
      onOff('ai_receptionist', 'Answer on WhatsApp with AI', s.ai_receptionist, 'Replies from your live plans, prices, classes and hours, and books free trials.'),
      { name: 'ai_persona_name', label: 'Assistant’s name (optional)', value: s.ai_persona_name || '', placeholder: 'Zoya' },
      { name: 'opening_hours', label: 'Opening hours', value: s.opening_hours || '', full: true, placeholder: 'Mon–Sat 5:30 AM – 10:30 PM, Sun 7 AM – 12 PM' },
      {
        name: 'ai_persona_notes',
        label: 'What else it may tell people',
        type: 'textarea',
        full: true,
        value: s.ai_persona_notes || '',
        placeholder: 'AC gym, steam room, free lockers. Couples get 10% off the Quarterly plan. Personal training ₹4,000/month.',
        hint: 'Facilities, offers, trainer credentials. The assistant only states facts from your plans, classes and this box.',
      },
      {
        name: 'ai_reply_mode',
        label: 'When it answers',
        type: 'select',
        value: s.ai_reply_mode,
        options: [
          { value: 'always', label: 'Always — day and night' },
          { value: 'after_hours', label: 'Only when the desk is closed' },
        ],
      },
      { name: 'office_days', label: 'Desk days', type: 'select', value: s.office_days, options: dayOptions },
      { name: 'office_open', label: 'Desk opens', type: 'time', value: s.office_open },
      { name: 'office_close', label: 'Desk closes', type: 'time', value: s.office_close },
      { name: 'ai_pause_minutes', label: 'Pause after a staff reply (minutes)', type: 'number', min: 5, max: 10080, value: s.ai_pause_minutes },
      { name: 'gym_phone', label: 'Gym phone', value: s.gym_phone || '', placeholder: '+91 98765 43210' },
      { name: 'gym_address', label: 'Address', value: s.gym_address || '', full: true, placeholder: '1st floor, Galaxy Mall, Sector 18' },
      { name: 'landmark_directions', label: 'Landmark directions', value: s.landmark_directions || '', full: true, placeholder: 'Above Domino’s, lift on the left' },
      {
        name: 'maps_url',
        label: 'Google Maps link',
        value: s.maps_url || '',
        full: true,
        hint: 'Paste the link from your browser’s address bar and the pin is filled in for you.',
      },
      { name: 'latitude', label: 'Latitude', type: 'number', step: 'any', value: s.latitude ?? '' },
      { name: 'longitude', label: 'Longitude', type: 'number', step: 'any', value: s.longitude ?? '' },
      { name: 'owner_phone', label: 'Owner’s WhatsApp (hot-lead alerts)', value: s.owner_phone || '', placeholder: '98765 43210', hint: 'Gets “🔥 HOT LEAD” the moment the assistant books a trial.' },
      onOff('hot_lead_alerts', 'Hot-lead alerts', s.hot_lead_alerts),
      onOff('trial_enabled', 'Assistant offers free trials', s.trial_enabled, 'The desk can always issue a pass by hand.'),
      { name: 'trial_days', label: 'Trial length (days)', type: 'number', min: 1, max: 30, value: s.trial_days },
      { name: 'trial_visits', label: 'Visits on a trial', type: 'number', min: 1, max: 30, value: s.trial_visits, hint: 'At most one a day.' },
      { name: 'trial_cooldown_days', label: 'One trial per number every (days)', type: 'number', min: 0, max: 3650, value: s.trial_cooldown_days },
      { name: 'trial_booking_days', label: 'Bookable up to (days ahead)', type: 'number', min: 0, max: 30, value: s.trial_booking_days },
      { name: 'trial_daily_cap', label: 'Most trials starting a day', type: 'number', min: 0, max: 500, value: s.trial_daily_cap, hint: '0 = no limit.' },
      onOff('trial_followups', 'Automatic follow-ups', s.trial_followups, 'Sent between 9 AM and 8 PM: a no-show nudge, “how was it?” after the first visit, and on the last day.'),
      { name: 'noshow_template', label: 'No-show message', type: 'textarea', full: true, value: s.noshow_template },
      { name: 'visited_template', label: 'After the first visit', type: 'textarea', full: true, value: s.visited_template },
      {
        name: 'expiry_template',
        label: 'On the trial’s last day',
        type: 'textarea',
        full: true,
        value: s.expiry_template,
        hint: 'Placeholders: {{first_name}}, {{gym_name}}, {{valid_until}}, {{visits_left}}, {{pass_code}}.',
      },
    ],
    {
      submitLabel: 'Save settings',
      wide: true,
      onSubmit: async (values) => {
        const body = { ...values };
        for (const key of BOOLEAN_FIELDS) body[key] = values[key] === '1';
        for (const key of NUMBER_FIELDS) body[key] = Number(values[key]);
        // A changed map link re-derives the pin, unless the numbers were typed too.
        if (values.maps_url && values.maps_url !== (s.maps_url || '') && String(values.latitude) === String(s.latitude ?? '') && String(values.longitude) === String(s.longitude ?? '')) {
          delete body.latitude;
          delete body.longitude;
        }
        const saved = await api.updateTrialSettings(body);
        closeModal();
        toast(
          saved.trial_started
            ? `Your ${saved.plan.trial_days}-day free trial has started — the assistant is answering on WhatsApp`
            : saved.settings.ai_receptionist
              ? 'Saved — the assistant is answering on WhatsApp'
              : 'Settings saved',
        );
        await onSaved?.();
      },
    },
  );

  openModal({
    title: 'WhatsApp front desk & free trials',
    subtitle: 'Answers enquiries from your live plans and timings, books free trial passes, and follows up until they join.',
    icon: 'sparkle',
    wide: true,
    body: h('div', { class: 'cb-assist' }, planHost, status, form),
  });
}

/* ── The page ────────────────────────────────────────────────────────── */

export async function renderTrials({ setActions, navigate }) {
  const plans = (await api.plans()).items?.filter((p) => p.active) ?? [];
  const state = { stage: 'open', q: '' };
  const bannerHost = h('div', {});
  const statsHost = h('div', {});
  const tabsHost = h('div', {});
  const listHost = h('div', {});
  let timer;
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search by name, phone or goal…',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = e.target.value.trim();
        repaint();
      }, 300);
    },
  });

  function banner(data) {
    const { ai } = data;
    const settings = session.managesBilling ? () => openDeskSettings({ onSaved: repaint }) : null;
    const plan = planLine(ai.plan);
    const lapsed = ai.plan?.status === 'expired';
    if (!ai.on || lapsed) {
      return h(
        'div',
        { class: `card cb-assist-banner is-off${lapsed ? ' is-lapsed' : ''}` },
        h('span', { class: 'cb-assist-icon' }, renderIcon(lapsed ? 'alert' : 'sparkle', { size: 20 })),
        h(
          'div',
          { class: 'cb-grow' },
          h('div', { class: 'cb-strong' }, lapsed ? 'Your AI front desk has stopped answering' : 'Answer every WhatsApp enquiry in seconds, 24/7'),
          h(
            'div',
            { class: 'muted cb-small' },
            lapsed
              ? 'The plan ended, so WhatsApp enquiries are waiting for your team again. Renew to switch it back on.'
              : 'An AI front desk replies from your live plans, prices, classes and timings — at 11 PM too — books a free trial and sends the QR pass.',
          ),
          plan && !lapsed ? h('span', { class: `badge dot ${plan.tone} cb-assist-plan` }, plan.text) : null,
        ),
        settings ? h('button', { class: 'btn primary', type: 'button', onclick: settings }, lapsed ? 'Renew' : ai.plan?.trial_available ? 'Start free trial' : 'Set it up') : null,
      );
    }
    return h(
      'div',
      { class: 'card cb-assist-banner' },
      h('span', { class: 'cb-assist-icon is-live' }, renderIcon('sparkle', { size: 20 })),
      h(
        'div',
        { class: 'cb-grow' },
        h('div', { class: 'cb-strong' }, 'AI front desk is answering on WhatsApp'),
        plan ? h('span', { class: `badge dot ${plan.tone} cb-assist-plan` }, plan.text) : null,
        h(
          'div',
          { class: 'muted cb-small' },
          `${ai.captured_this_month} lead${ai.captured_this_month === 1 ? '' : 's'} captured this month`,
          ' · ',
          data.counts.needs_reply
            ? h(
                'button',
                {
                  class: 'cb-link cb-red',
                  type: 'button',
                  onclick: () => {
                    state.stage = 'needs_reply';
                    repaint();
                  },
                },
                `${data.counts.needs_reply} waiting for your reply`,
              )
            : 'nothing waiting for your team',
        ),
      ),
      settings ? h('button', { class: 'btn sm', type: 'button', onclick: settings }, renderIcon('settings', { size: 14 }), 'Settings') : null,
    );
  }

  async function repaint() {
    const data = await api.trials({ stage: state.stage, q: state.q || undefined });
    fill(bannerHost, banner(data));
    const open = data.counts.lead + data.counts.booked + data.counts.visited + data.counts.no_show;
    const conversion = data.month.trials ? Math.round((data.month.converted / data.month.trials) * 100) : null;
    fill(
      statsHost,
      h(
        'div',
        { class: 'grid cols-4' },
        stat('Open leads', open, `${data.counts.booked} trial${data.counts.booked === 1 ? '' : 's'} booked`, { icon: 'userPlus' }),
        stat('Trial visitors today', data.in_today, 'Checked in on a free pass', { icon: 'checkin' }),
        stat('Trials this month', data.month.trials, `${data.month.visited} came in`, { icon: 'ticket' }),
        stat('Conversion', conversion === null ? '—' : `${conversion}%`, `${data.month.converted} joined this month`, { icon: 'target', accent: true }),
      ),
    );
    fill(
      tabsHost,
      h(
        'div',
        { class: 'toolbar' },
        pillTabs(
          [
            { key: 'open', label: 'Open', count: open },
            { key: 'needs_reply', label: 'Needs reply', count: data.counts.needs_reply },
            ...Object.entries(STAGE).map(([key, s]) => ({ key, label: s.label, count: data.counts[key] || 0 })),
          ],
          state.stage,
          (key) => {
            state.stage = key;
            repaint();
          },
        ),
      ),
    );
    fill(
      listHost,
      data.items.length
        ? h('div', { class: 'grid cols-2 top' }, ...data.items.map((lead) => leadCard(lead, { plans, repaint, navigate })))
        : emptyState(state.q ? 'No lead matches.' : 'No leads here yet.', {
            icon: 'userPlus',
            action: h('button', { class: 'btn sm primary', onclick: () => openLeadForm({ plans, onSaved: repaint }) }, 'Add a lead'),
          }),
    );
  }

  setActions(h('button', { class: 'btn primary', onclick: () => openLeadForm({ plans, onSaved: repaint }) }, renderIcon('plus', { size: 16 }), 'New lead'));
  await repaint();
  return h('div', { class: 'cb-page grid', style: 'gap:16px' }, bannerHost, statsHost, h('div', { class: 'toolbar' }, search), tabsHost, listHost);
}

/** The desk's view of a scanned or typed trial pass, for the check-in
 * screen (views/checkin.js). */
export function trialResult(trial, { action } = {}) {
  // A repeat scan, or a look before checking in — not the visit just made.
  const already = action === 'trial_already_in' || (!action && trial.visited_today);
  return h(
    'div',
    { class: `checkin-result ${trial.can_check_in === false ? 'bad' : 'ok'}` },
    h(
      'div',
      { class: 'row', style: 'gap:12px;align-items:flex-start' },
      h('div', { class: 'avatar lg trial-avatar' }, renderIcon('ticket', { size: 22 })),
      h(
        'div',
        { style: 'min-width:0' },
        h('div', { style: 'font-size:17px;font-weight:700' }, leadName(trial)),
        h('div', { class: 'muted', style: 'font-size:12px' }, `Free trial · ${trial.code}`),
        h(
          'div',
          { class: 'row', style: 'gap:6px;margin-top:8px;flex-wrap:wrap' },
          h('span', { class: 'badge violet' }, 'Trial visitor'),
          h('span', { class: 'badge blue' }, `${trial.visits_used} of ${trial.visits_allowed} visits`),
          h('span', { class: 'badge green' }, `Valid to ${date(trial.valid_until)}`),
          trial.goal ? h('span', { class: 'badge' }, trial.goal) : null,
          already ? h('span', { class: 'badge violet' }, 'Already in today') : null,
          action === 'trial_checked_in' && trial.first_visit ? h('span', { class: 'badge amber' }, 'First visit — say hello!') : null,
        ),
        trial.blocked_reason ? h('div', { class: 'muted', style: 'margin-top:6px' }, trial.blocked_reason) : null,
      ),
    ),
  );
}
