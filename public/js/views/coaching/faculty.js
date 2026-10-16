import { session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { buildForm, closeModal, emptyState, h, initials, money, openModal, renderIcon, toast } from '../../ui.js';

/**
 * Faculty: every staff account with what they teach (faculty allocations),
 * their weekly load from the timetable, and this month's logged lectures —
 * and from those, what a per-lecture or hourly teacher has earned so far.
 * Accounts themselves are created on Staff accounts (role "Trainer" is a
 * teacher here); this page holds the teaching profile and pay.
 */

const PAY_LABEL = { salary: 'Monthly salary', per_lecture: 'Per lecture', hourly: 'Per hour' };

function openProfile(person, onSaved) {
  openModal({
    title: `${person.name} · teaching profile`,
    icon: 'user',
    body: buildForm(
      [
        { name: 'specialization', label: 'Subjects / specialization', full: true, value: person.specialization, placeholder: 'Physics (Mechanics, Electrostatics)' },
        { name: 'qualification', label: 'Qualification', full: true, value: person.qualification, placeholder: 'M.Sc. Physics, IIT Delhi' },
        {
          name: 'pay_type',
          label: 'Paid by',
          type: 'select',
          value: person.pay_type || '',
          options: [{ value: '', label: 'Not set' }, ...Object.entries(PAY_LABEL).map(([value, label]) => ({ value, label }))],
        },
        { name: 'pay_rate', label: 'Rate / salary', type: 'number', min: 0, value: person.pay_rate ?? '' },
        { name: 'bio', label: 'Bio (shown to students)', type: 'textarea', full: true, value: person.bio },
      ],
      {
        submitLabel: 'Save profile',
        onSubmit: async (values) => {
          await coaching.updateFaculty(person.id, { ...values, pay_type: values.pay_type || undefined });
          closeModal();
          toast('Profile saved');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderFaculty({ reload, setActions }) {
  const { items } = await coaching.faculty();
  const canManage = session.managesBilling;
  setActions(session.can('admin') ? h('a', { class: 'btn primary', href: '#/staff' }, renderIcon('userPlus', { size: 16 }), 'Add a teacher') : null);
  const teachers = items.filter((p) => p.role === 'trainer' || p.subjects.length || p.weekly_lectures);
  const others = items.filter((p) => !teachers.includes(p));

  const card = (p) =>
    h(
      'div',
      { class: 'card cb-faculty' },
      h(
        'div',
        { class: 'cb-faculty-top' },
        h('div', { class: 'avatar' }, initials(...p.name.split(' '))),
        h(
          'div',
          { class: 'cb-grow' },
          h('div', { class: 'cb-strong' }, p.name),
          h('div', { class: 'muted cb-small' }, [p.specialization, p.qualification].filter(Boolean).join(' · ') || (p.role === 'trainer' ? 'Teacher' : p.role)),
        ),
        canManage ? h('button', { class: 'btn sm ghost', onclick: () => openProfile(p, reload) }, 'Edit') : null,
      ),
      h(
        'div',
        { class: 'cb-faculty-stats' },
        h('div', {}, h('strong', {}, p.weekly_lectures), h('span', { class: 'muted cb-small' }, 'lectures / week')),
        h('div', {}, h('strong', {}, p.weekly_hours), h('span', { class: 'muted cb-small' }, 'hours / week')),
        h('div', {}, h('strong', {}, p.month_lectures), h('span', { class: 'muted cb-small' }, 'taught this month')),
        canManage
          ? h('div', {}, h('strong', {}, p.month_earned === null ? '—' : money(p.month_earned)), h('span', { class: 'muted cb-small' }, p.pay_type ? `${PAY_LABEL[p.pay_type]}${p.pay_rate ? ` · ${money(p.pay_rate)}` : ''}` : 'Pay not set'))
          : null,
      ),
      p.subjects.length
        ? h('div', { class: 'pill-row' }, ...p.subjects.map((s) => h('a', { class: 'cb-chip', href: `#/batches/${s.batch_id}` }, `${s.subject_name} · ${s.batch_name}`)))
        : h('p', { class: 'muted cb-small' }, 'Not assigned to a batch yet — assign from a batch’s page.'),
    );

  return h(
    'div',
    { class: 'cb-page grid', style: 'gap:16px' },
    teachers.length
      ? h('div', { class: 'grid cols-2 top' }, ...teachers.map(card))
      : emptyState('No teachers yet. Add a staff account with the Trainer role, then assign them to a batch.', { icon: 'users' }),
    others.length ? h('div', { class: 'cb-subhead' }, 'Other staff') : null,
    others.length ? h('div', { class: 'grid cols-2 top' }, ...others.map(card)) : null,
  );
}
