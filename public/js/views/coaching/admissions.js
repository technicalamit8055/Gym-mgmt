import { coaching } from '../../coachingApi.js';
import { buildForm, clear, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, stat, toast, today } from '../../ui.js';
import { fill, INQUIRY_SOURCE, INQUIRY_STATUS, pillTabs, tone } from './common.js';
import { openEnrollModal } from './enrollForm.js';

/**
 * Admissions: every inquiry from first call to admission. Leads are ordered
 * by what needs doing next (today's demo, an overdue follow-up), and
 * "Admit" turns one into a student — profile, roll number and fee plan — in
 * the same form the batch page uses.
 */

const OPEN_STATUSES = ['inquiry', 'demo_scheduled', 'demo_attended', 'follow_up'];

/** wa.me wants digits with a country code; a bare 10-digit number is Indian. */
const waLink = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits ? `https://wa.me/${digits.length <= 10 ? `91${digits}` : digits}` : null;
};

function openInquiryForm({ inquiry, courses, onSaved }) {
  const editing = Boolean(inquiry);
  openModal({
    title: editing ? `Edit · ${inquiry.student_name}` : 'New inquiry',
    subtitle: editing ? null : 'A walk-in, a call or a referral — capture it before it goes cold.',
    icon: 'userPlus',
    wide: true,
    body: buildForm(
      [
        { name: 'student_name', label: 'Student name', required: true, value: inquiry?.student_name },
        { name: 'guardian_name', label: 'Parent / guardian', value: inquiry?.guardian_name },
        { name: 'phone', label: 'Phone (WhatsApp)', required: true, value: inquiry?.phone, placeholder: '98765 43210' },
        { name: 'email', label: 'Email', type: 'email', value: inquiry?.email },
        {
          name: 'course_id',
          label: 'Interested in',
          type: 'select',
          value: inquiry?.course_id ?? '',
          options: [{ value: '', label: 'Not decided yet' }, ...courses.map((c) => ({ value: c.id, label: c.name }))],
        },
        { name: 'target_class', label: 'Class / target exam', value: inquiry?.target_class, placeholder: 'Class 11 · JEE 2028' },
        { name: 'school_name', label: 'School / college', value: inquiry?.school_name },
        {
          name: 'source',
          label: 'How they heard of us',
          type: 'select',
          value: inquiry?.source || 'walk_in',
          options: Object.entries(INQUIRY_SOURCE).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'status',
          label: 'Stage',
          type: 'select',
          value: inquiry?.status && inquiry.status !== 'admitted' ? inquiry.status : 'inquiry',
          options: Object.entries(INQUIRY_STATUS)
            .filter(([key]) => key !== 'admitted')
            .map(([value, s]) => ({ value, label: s.label })),
        },
        { name: 'demo_on', label: 'Demo class on', type: 'date', value: inquiry?.demo_on },
        { name: 'follow_up_on', label: 'Follow up on', type: 'date', value: inquiry?.follow_up_on },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true, value: inquiry?.notes, placeholder: 'Scored 82% in class 10; wants the evening batch' },
      ],
      {
        submitLabel: editing ? 'Save' : 'Add inquiry',
        onSubmit: async (values) => {
          if (editing) await coaching.updateInquiry(inquiry.id, values);
          else await coaching.createInquiry(values);
          closeModal();
          toast(editing ? 'Inquiry saved' : 'Inquiry added');
          await onSaved?.();
        },
      },
    ),
  });
}

function leadCard(lead, { courses, repaint, navigate }) {
  const nextDate = lead.status === 'demo_scheduled' && lead.demo_on ? { label: 'Demo', on: lead.demo_on } : lead.follow_up_on ? { label: 'Follow up', on: lead.follow_up_on } : null;
  const due = nextDate && nextDate.on <= today() && OPEN_STATUSES.includes(lead.status);
  const wa = waLink(lead.phone);
  const stageSelect = h(
    'select',
    {
      class: 'cb-stage-select',
      'aria-label': `Stage for ${lead.student_name}`,
      onchange: async (e) => {
        try {
          await coaching.updateInquiry(lead.id, { status: e.target.value });
          toast(`${lead.student_name}: ${INQUIRY_STATUS[e.target.value].label}`);
          await repaint();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    ...Object.entries(INQUIRY_STATUS)
      .filter(([key]) => key !== 'admitted')
      .map(([value, s]) => h('option', { value, selected: value === lead.status }, s.label)),
  );
  return h(
    'div',
    { class: `card cb-lead${due ? ' is-due' : ''}` },
    h(
      'div',
      { class: 'cb-lead-top' },
      h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong cb-lead-name' }, lead.student_name), h('div', { class: 'muted cb-small' }, [lead.guardian_name ? `Guardian ${lead.guardian_name}` : null, lead.target_class, lead.school_name].filter(Boolean).join(' · '))),
      tone(INQUIRY_STATUS, lead.status),
    ),
    h(
      'div',
      { class: 'cb-lead-meta' },
      h('span', {}, renderIcon('graduation', { size: 14 }), lead.course_name || 'Course not decided'),
      h('span', {}, renderIcon('phone', { size: 14 }), h('a', { href: `tel:${lead.phone}` }, lead.phone)),
      h('span', {}, renderIcon('mapPin', { size: 14 }), INQUIRY_SOURCE[lead.source] || lead.source),
      nextDate ? h('span', { class: due ? 'cb-red' : '' }, renderIcon('calendar', { size: 14 }), `${nextDate.label} ${date(nextDate.on)}`) : null,
    ),
    lead.notes ? h('p', { class: 'cb-small cb-lead-notes' }, lead.notes) : null,
    h(
      'div',
      { class: 'cb-lead-actions' },
      lead.status === 'admitted'
        ? h('a', { class: 'btn sm', href: `#/members/${lead.member_id}` }, renderIcon('user', { size: 14 }), `Student ${lead.member_code || ''}`)
        : h(
            'button',
            { class: 'btn sm primary', onclick: () => openEnrollModal({ inquiry: lead, onDone: async (res) => { await repaint(); navigate(`/members/${res.member.id}`); } }) },
            renderIcon('check', { size: 14 }),
            'Admit',
          ),
      lead.status !== 'admitted' ? stageSelect : null,
      wa ? h('a', { class: 'btn sm ghost', href: wa, target: '_blank', rel: 'noopener', title: 'Open a WhatsApp chat', 'aria-label': 'WhatsApp' }, renderIcon('whatsapp', { size: 14 })) : null,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', onclick: () => openInquiryForm({ inquiry: lead, courses, onSaved: repaint }) }, 'Edit'),
      h(
        'button',
        {
          class: 'btn sm ghost',
          title: 'Delete',
          'aria-label': `Delete ${lead.student_name}`,
          onclick: () =>
            confirmDialog({
              title: `Delete ${lead.student_name}?`,
              message: 'The inquiry is removed. An admitted student keeps their profile.',
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: async () => {
                await coaching.deleteInquiry(lead.id);
                await repaint();
              },
            }),
        },
        renderIcon('trash', { size: 14 }),
      ),
    ),
  );
}

export async function renderAdmissions({ setActions, navigate }) {
  const { items: courses } = await coaching.courses();
  const state = { status: 'open', q: '', due: false };
  const statsHost = h('div', {});
  const tabsHost = h('div', {});
  const listHost = h('div', {});
  let timer;
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search by name, phone or school…',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = e.target.value.trim();
        repaint();
      }, 300);
    },
  });

  const dueToggle = h('input', {
    type: 'checkbox',
    onchange: (e) => {
      state.due = e.target.checked;
      repaint();
    },
  });

  async function repaint() {
    const data = await coaching.inquiries({
      status: state.status === 'open' ? undefined : state.status,
      q: state.q || undefined,
      due: state.due ? '1' : undefined,
    });
    const openCount = OPEN_STATUSES.reduce((acc, s) => acc + (data.counts[s] || 0), 0);
    const items = state.status === 'open' ? data.items.filter((i) => OPEN_STATUSES.includes(i.status)) : data.items;
    const conversion = data.month.leads ? Math.round((data.month.admitted / data.month.leads) * 100) : null;
    fill(statsHost, 
      h(
        'div',
        { class: 'grid cols-4' },
        stat('Open leads', openCount, `${data.counts.demo_scheduled || 0} demos scheduled`, { icon: 'userPlus' }),
        stat('Follow-ups due', data.follow_ups_due, data.follow_ups_due ? 'Call them today' : 'All caught up', {
          icon: 'phone',
          trend: data.follow_ups_due ? { positive: 'warn', text: 'Due' } : null,
          onClick: () => { state.due = !state.due; repaint(); },
        }),
        stat('New this month', data.month.leads, `${data.month.admitted} admitted`, { icon: 'trendUp' }),
        stat('Conversion', conversion === null ? '—' : `${conversion}%`, 'Inquiries this month that joined', { icon: 'target', accent: true }),
      ),
    );
    fill(tabsHost, 
      h(
        'div',
        { class: 'toolbar' },
        pillTabs(
          [
            { key: 'open', label: 'Open', count: openCount },
            ...Object.entries(INQUIRY_STATUS).map(([key, s]) => ({ key, label: s.label, count: data.counts[key] || 0 })),
          ],
          state.status,
          (key) => {
            state.status = key;
            repaint();
          },
        ),
      ),
    );
    dueToggle.checked = state.due;
    fill(listHost, 
      items.length
        ? h('div', { class: 'grid cols-2 top' }, ...items.map((lead) => leadCard(lead, { courses, repaint, navigate })))
        : emptyState(state.q ? 'No inquiry matches.' : 'No inquiries here yet.', {
            icon: 'userPlus',
            action: h('button', { class: 'btn sm primary', onclick: () => openInquiryForm({ courses, onSaved: repaint }) }, 'Add an inquiry'),
          }),
    );
  }

  setActions(h('button', { class: 'btn primary', onclick: () => openInquiryForm({ courses, onSaved: repaint }) }, renderIcon('plus', { size: 16 }), 'New inquiry'));
  await repaint();
  // Outside the repainted parts, so typing in the search keeps its focus.
  const searchBar = h('div', { class: 'toolbar' }, search, h('label', { class: 'cb-check' }, dueToggle, 'Due today only'));
  return h('div', { class: 'cb-page grid', style: 'gap:16px' }, statsHost, searchBar, tabsHost, listHost);
}
