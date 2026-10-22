import { coaching } from '../../coachingApi.js';
import { append, buildForm, clear, closeModal, date, h, money, openModal, renderIcon, time, toast } from '../../ui.js';

/** Bits every CoachBook screen shares. */

/**
 * Replaces a node's children. Use this rather than `clear(node).append(…)`:
 * the native append() prints a null child as the text "null", where the
 * app's own append() — like h() — skips it, which is what lets a screen
 * write `condition ? card : null`.
 */
export const fill = (node, ...children) => append(clear(node), children);

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday first, the way an Indian timetable is printed. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const TEST_TYPE_LABEL = { weekly: 'Weekly test', monthly: 'Monthly test', mock: 'Full mock', dpp: 'DPP quiz', other: 'Test' };
export const MATERIAL_KIND_LABEL = {
  notes: 'Notes',
  dpp: 'DPP',
  pyq: 'PYQ',
  assignment: 'Assignment',
  syllabus: 'Syllabus',
  solution: 'Solutions',
};
export const INQUIRY_STATUS = {
  inquiry: { label: 'New inquiry', tone: 'blue' },
  demo_scheduled: { label: 'Demo scheduled', tone: 'violet' },
  demo_attended: { label: 'Demo attended', tone: 'violet' },
  follow_up: { label: 'Follow-up', tone: 'amber' },
  admitted: { label: 'Admitted', tone: 'green' },
  declined: { label: 'Declined', tone: 'grey' },
};
export const INQUIRY_SOURCE = {
  walk_in: 'Walk-in',
  phone: 'Phone call',
  whatsapp: 'WhatsApp',
  referral: 'Referral',
  banner: 'Banner / hoarding',
  social: 'Social media',
  website: 'Website',
  school: 'School visit',
  other: 'Other',
};
export const INSTALLMENT_STATUS = {
  paid: { label: 'Paid', tone: 'green' },
  partially_paid: { label: 'Part paid', tone: 'amber' },
  pending: { label: 'Upcoming', tone: 'blue' },
  overdue: { label: 'Overdue', tone: 'red' },
};
export const PLAN_STATUS = {
  active: { label: 'Active', tone: 'blue' },
  paid: { label: 'Fully paid', tone: 'green' },
  overdue: { label: 'Overdue', tone: 'red' },
  defaulted: { label: 'Defaulted', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'grey' },
};
export const ATTENDANCE_STATUS = {
  present: { label: 'Present', short: 'P', tone: 'green' },
  absent: { label: 'Absent', short: 'A', tone: 'red' },
  late: { label: 'Late', short: 'L', tone: 'amber' },
  excused: { label: 'Excused', short: 'E', tone: 'grey' },
};

export const tone = (map, key) => h('span', { class: `badge dot ${map[key]?.tone || 'grey'}` }, map[key]?.label || String(key || '—').replace(/_/g, ' '));

export const fullName = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim();

export const timeRange = (start, end) => (start ? `${time(start)} – ${time(end)}` : 'Timing not set');

export const pct = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 10) / 10}%`);

/** Weekday string ('1,3,5') as "Mon, Wed, Fri". */
export const weekdayList = (value) => {
  const days = String(value || '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  if (!days.length) return 'Any day';
  if (days.length === 7) return 'Every day';
  return WEEK_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAYS[d]).join(', ');
};

/** A labelled <select>, for toolbars. `options` is [{ value, label }]. */
export function selectControl(options, value, onchange, { placeholder, name } = {}) {
  return h(
    'select',
    { name, onchange: (e) => onchange(e.target.value) },
    placeholder !== undefined ? h('option', { value: '' }, placeholder) : null,
    ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)),
  );
}

export const batchOptions = (batches) => batches.map((b) => ({ value: b.id, label: `${b.name}${b.course_name ? ` · ${b.course_name}` : ''}` }));

/** A filled bar for a percentage, red under the institute's threshold. */
export function percentBar(value, { threshold = 75 } = {}) {
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, value));
  const level = v === null ? 'none' : v < threshold ? 'low' : v < threshold + 10 ? 'mid' : 'good';
  return h(
    'div',
    { class: `cb-bar is-${level}`, title: v === null ? 'No attendance marked yet' : `${pct(v)}` },
    h('span', { class: 'cb-bar-fill', style: `width:${v ?? 0}%` }),
    h('span', { class: 'cb-bar-label' }, pct(v)),
  );
}

/** A quiet section card with a title row and optional actions. */
export function section(title, body, { actions = null, icon = null, subtitle = null } = {}) {
  return h(
    'div',
    { class: 'card cb-section' },
    h(
      'div',
      { class: 'card-head' },
      icon ? h('span', { class: 'cb-section-icon' }, renderIcon(icon, { size: 17 })) : null,
      h('div', {}, h('h3', {}, title), subtitle ? h('p', { class: 'muted cb-section-sub' }, subtitle) : null),
      h('div', { class: 'spacer' }),
      actions,
    ),
    body,
  );
}

/** Pill tabs for switching a page's panes without a route change. */
export function pillTabs(items, active, onchange) {
  return h(
    'div',
    { class: 'cb-tabs', role: 'tablist' },
    ...items.map((item) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: `cb-tab${item.key === active ? ' is-active' : ''}`,
          'aria-selected': String(item.key === active),
          onclick: () => onchange(item.key),
        },
        item.icon ? renderIcon(item.icon, { size: 15 }) : null,
        item.label,
        item.count !== undefined && item.count !== null ? h('span', { class: 'cb-tab-count' }, item.count) : null,
      ),
    ),
  );
}

/** What a send attempt did, said once in a toast. */
export function reportSend(result, { what = 'messages', none = null } = {}) {
  if (!result) return;
  if (result.connected === false) {
    toast('Saved — but WhatsApp is not linked, so no parent was messaged. Link it on the WhatsApp page.', 'info');
    return;
  }
  if (result.disabled) return;
  if (result.queued) {
    const skipped = result.skipped ? ` (${result.skipped} without a phone number)` : '';
    toast(`${result.queued} ${result.queued === 1 ? what.replace(/s$/, '') : what} going out on WhatsApp${skipped}`);
  } else if (result.skipped) {
    toast(`No ${what} sent — ${result.skipped} without a phone number on file`, 'info');
  } else if (none) {
    toast(none, 'info');
  }
}

export const moneyOrDash = (v) => (v === null || v === undefined ? '—' : money(v));
export const dateOrDash = (v) => (v ? date(v) : '—');

/**
 * The parent-alert settings (coaching_settings), one modal opened from the
 * attendance, fees and tests screens — `focus` picks which group of fields
 * leads, so each screen opens on what it is about.
 */
export async function openAlertSettings({ focus = 'attendance', onSaved } = {}) {
  const { settings, defaults, placeholders, whatsapp_connected: connected } = await coaching.settings();
  const yesNo = (name, label, value) => ({
    name,
    label,
    type: 'select',
    value: String(value ?? 0),
    options: [
      { value: '1', label: 'On' },
      { value: '0', label: 'Off' },
    ],
  });
  const tpl = (name, label) => ({
    name,
    label,
    type: 'textarea',
    full: true,
    value: settings[name],
    hint: `Placeholders: ${placeholders[name].map((p) => `{{${p}}}`).join(' ')}`,
  });
  const groups = {
    attendance: [
      yesNo('absence_alerts', 'Absentee alerts to parents', settings.absence_alerts),
      yesNo('late_alerts', 'Late-arrival alerts', settings.late_alerts),
      { name: 'low_attendance_threshold', label: 'Low-attendance line (%)', type: 'number', min: 1, max: 100, value: settings.low_attendance_threshold },
      { name: 'institute_phone', label: 'Institute phone (in alerts)', value: settings.institute_phone || '', placeholder: '+91 98765 43210' },
      tpl('absence_template', 'Absentee alert'),
      tpl('late_template', 'Late-arrival alert'),
      tpl('low_attendance_template', 'Low-attendance warning'),
    ],
    fees: [
      yesNo('fee_reminders', 'Automatic installment reminders', settings.fee_reminders),
      { name: 'fee_reminder_days_before', label: 'Remind this many days before', type: 'number', min: 0, max: 30, value: settings.fee_reminder_days_before },
      { name: 'overdue_reminder_days', label: 'Then re-remind every (days)', type: 'number', min: 1, max: 60, value: settings.overdue_reminder_days },
      yesNo('fee_receipts', 'Send receipt on payment', settings.fee_receipts),
      { name: 'gstin', label: 'GSTIN (printed on receipts)', value: settings.gstin || '', placeholder: '15-character GSTIN' },
      tpl('fee_due_template', 'Installment due soon'),
      tpl('fee_overdue_template', 'Installment overdue'),
      tpl('fee_receipt_template', 'Fee receipt'),
    ],
    tests: [tpl('scorecard_template', 'Test scorecard')],
  };
  const order = [focus, ...Object.keys(groups).filter((k) => k !== focus)];
  const fields = order.flatMap((key) => groups[key]);

  const form = buildForm(fields, {
    submitLabel: 'Save alert settings',
    onSubmit: async (values) => {
      const payload = { ...values };
      for (const key of ['absence_alerts', 'late_alerts', 'fee_reminders', 'fee_receipts']) payload[key] = values[key] === '1';
      for (const [key, text] of Object.entries(payload)) if (typeof text === 'string' && key.endsWith('_template') && !text.trim()) payload[key] = defaults[key];
      await coaching.updateSettings(payload);
      closeModal();
      toast('Alert settings saved');
      await onSaved?.();
    },
  });
  openModal({
    title: 'Parent alerts on WhatsApp',
    subtitle: connected
      ? 'Sent from your institute’s linked WhatsApp number, to the guardian’s number on file.'
      : 'WhatsApp is not linked yet — alerts will start once you link it on the WhatsApp page.',
    icon: 'whatsapp',
    wide: true,
    body: form,
  });
}
