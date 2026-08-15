import { api, session } from '../api.js';
import {
  addDays,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  date,
  dayMonth,
  fullName,
  h,
  openModal,
  statusBadge,
  table,
  time,
  toast,
  today,
} from '../ui.js';
import { openBookingForm } from './forms.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function openClassForm({ klass, onSaved }) {
  const { items: staff } = await api.staff({ active: 'true' });
  const trainers = staff.filter((person) => ['trainer', 'admin', 'manager'].includes(person.role));
  const editing = Boolean(klass);

  openModal({
    title: editing ? `Edit ${klass.name}` : 'New class',
    wide: true,
    body: buildForm(
      [
        { name: 'name', label: 'Class name', required: true, value: klass?.name },
        {
          name: 'trainer_id',
          label: 'Trainer',
          type: 'select',
          value: klass?.trainer_id ?? '',
          options: [{ value: '', label: 'Unassigned' }, ...trainers.map((t) => ({ value: t.id, label: t.name }))],
        },
        {
          name: 'weekday',
          label: 'Day',
          type: 'select',
          required: true,
          value: klass?.weekday ?? 1,
          options: WEEKDAYS.map((label, value) => ({ value, label })),
        },
        { name: 'start_time', label: 'Start time', type: 'time', required: true, value: klass?.start_time ?? '18:00' },
        { name: 'duration_min', label: 'Duration (minutes)', type: 'number', min: 5, value: klass?.duration_min ?? 60 },
        { name: 'capacity', label: 'Capacity', type: 'number', min: 1, value: klass?.capacity ?? 20 },
        { name: 'room', label: 'Room', value: klass?.room },
        {
          name: 'active',
          label: 'Running',
          type: 'select',
          value: klass ? String(klass.active) : '1',
          options: [
            { value: '1', label: 'Yes' },
            { value: '0', label: 'Paused' },
          ],
        },
        { name: 'description', label: 'Description', type: 'textarea', full: true, value: klass?.description },
      ],
      {
        submitLabel: editing ? 'Save class' : 'Create class',
        onSubmit: async (values) => {
          const payload = { ...values, trainer_id: values.trainer_id === '' ? null : values.trainer_id };
          if (editing) await api.updateClass(klass.id, payload);
          else await api.createClass(payload);
          closeModal();
          toast(editing ? 'Class updated' : 'Class created');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderClasses({ setActions, reload }) {
  // Start the timetable on the Monday of the current week.
  const now = new Date();
  const monday = addDays(today(), -((now.getDay() + 6) % 7));
  const state = { weekStart: monday, tab: 'timetable' };

  const body = h('div', {});

  setActions(
    h('button', { class: 'btn', onclick: () => openBookingForm({ classes: state.classes || [], onSaved: render }) }, '＋ Book a member'),
    session.managesBilling ? h('button', { class: 'btn primary', onclick: () => openClassForm({ onSaved: reload }) }, '＋ New class') : null,
  );

  async function renderTimetable() {
    const [{ items: slots }, { items: allClasses }] = await Promise.all([
      api.schedule({ week_start: state.weekStart }),
      api.classes({}),
    ]);
    state.classes = allClasses;

    const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
    const columns = days.map((day) => {
      const dayName = WEEKDAYS[new Date(`${day}T00:00:00`).getDay()];
      const inDay = slots.filter((slot) => slot.class_date === day);
      return h(
        'div',
        { class: `day-col ${day === today() ? 'today' : ''}` },
        h('h4', {}, `${dayName.slice(0, 3)} ${dayMonth(day)}`),
        inDay.length
          ? h(
              'div',
              {},
              ...inDay.map((slot) =>
                h(
                  'div',
                  { class: 'class-card' },
                  h('div', { class: 'time' }, time(slot.start_time)),
                  h('div', { class: 'name' }, slot.name),
                  h('div', { class: 'sub' }, `${slot.trainer_name || 'Unassigned'} · ${slot.room || '—'}`),
                  h(
                    'div',
                    { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
                    h(
                      'span',
                      { class: `badge ${slot.seats_left <= 0 ? 'red' : slot.seats_left <= 3 ? 'amber' : 'green'}` },
                      slot.seats_left <= 0 ? 'Full' : `${slot.seats_left} left`,
                    ),
                    h(
                      'button',
                      {
                        class: 'btn sm ghost',
                        onclick: () => openClassRoster(slot),
                      },
                      `${slot.booked}/${slot.capacity}`,
                    ),
                  ),
                ),
              ),
            )
          : h('div', { class: 'muted', style: 'font-size:12px' }, 'No classes'),
      );
    });

    return h(
      'div',
      { class: 'grid', style: 'gap:16px' },
      h(
        'div',
        { class: 'toolbar' },
        h(
          'button',
          {
            class: 'btn sm',
            onclick: () => {
              state.weekStart = addDays(state.weekStart, -7);
              render();
            },
          },
          '‹ Previous week',
        ),
        h('strong', {}, `Week of ${date(state.weekStart)}`),
        h(
          'button',
          {
            class: 'btn sm',
            onclick: () => {
              state.weekStart = addDays(state.weekStart, 7);
              render();
            },
          },
          'Next week ›',
        ),
        h('div', { style: 'flex:1' }),
        h(
          'button',
          {
            class: 'btn sm ghost',
            onclick: () => {
              state.weekStart = monday;
              render();
            },
          },
          'This week',
        ),
      ),
      h('div', { style: 'overflow-x:auto' }, h('div', { class: 'timetable' }, ...columns)),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'All classes')),
        table(
          [
            { label: 'Class', render: (row) => h('div', {}, h('div', { style: 'font-weight:600' }, row.name), h('div', { class: 'muted', style: 'font-size:12px' }, row.description || '')) },
            { label: 'When', render: (row) => `${row.weekday_name} · ${time(row.start_time)}` },
            { label: 'Duration', render: (row) => `${row.duration_min} min` },
            { label: 'Trainer', render: (row) => row.trainer_name || h('span', { class: 'muted' }, 'Unassigned') },
            { label: 'Room', render: (row) => row.room || '—' },
            { label: 'Capacity', align: 'right', render: (row) => row.capacity },
            { label: 'Status', render: (row) => (row.active ? h('span', { class: 'badge green' }, 'Running') : h('span', { class: 'badge grey' }, 'Paused')) },
            {
              label: '',
              render: (row) =>
                session.managesBilling
                  ? h(
                      'div',
                      { class: 'row', style: 'gap:6px' },
                      h('button', { class: 'btn sm', onclick: () => openClassForm({ klass: row, onSaved: reload }) }, 'Edit'),
                      h(
                        'button',
                        {
                          class: 'btn sm danger',
                          onclick: () =>
                            confirmDialog({
                              title: `Delete ${row.name}?`,
                              message: 'All bookings for this class will be removed.',
                              confirmLabel: 'Delete class',
                              danger: true,
                              onConfirm: async () => {
                                await api.deleteClass(row.id);
                                toast('Class deleted');
                                await reload();
                              },
                            }),
                        },
                        'Delete',
                      ),
                    )
                  : null,
            },
          ],
          allClasses,
          { empty: 'No classes on the timetable yet' },
        ),
      ),
    );
  }

  async function openClassRoster(slot) {
    const { items } = await api.bookings({ class_id: slot.id, date: slot.class_date });
    openModal({
      title: `${slot.name} — ${date(slot.class_date)} ${time(slot.start_time)}`,
      wide: true,
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'row', style: 'margin-bottom:14px' },
          h('span', { class: 'muted' }, `${items.filter((b) => b.status !== 'cancelled').length} of ${slot.capacity} seats taken`),
          h('div', { style: 'flex:1' }),
          h(
            'button',
            {
              class: 'btn sm primary',
              onclick: () => {
                closeModal();
                openBookingForm({ klass: { ...slot, weekday_name: slot.weekday_name }, date: slot.class_date, onSaved: render });
              },
            },
            '＋ Add member',
          ),
        ),
        table(
          [
            { label: 'Member', render: (row) => h('a', { href: `#/members/${row.member_id}` }, fullName(row)) },
            { label: 'Code', render: (row) => h('span', { class: 'muted' }, row.member_code) },
            { label: 'Status', render: (row) => statusBadge(row.status) },
            {
              label: '',
              render: (row) =>
                h(
                  'div',
                  { class: 'row', style: 'gap:6px' },
                  ...['attended', 'no_show', 'cancelled'].map((status) =>
                    row.status === status
                      ? null
                      : h(
                          'button',
                          {
                            class: 'btn sm ghost',
                            onclick: async () => {
                              await api.updateBooking(row.id, { status });
                              toast('Booking updated');
                              closeModal();
                              render();
                            },
                          },
                          status === 'no_show' ? 'No show' : status.charAt(0).toUpperCase() + status.slice(1),
                        ),
                  ),
                ),
            },
          ],
          items,
          { empty: 'Nobody booked yet' },
        ),
      ),
    });
  }

  async function render() {
    clear(body).append(h('div', { class: 'empty' }, 'Loading…'));
    clear(body).append(await renderTimetable());
  }

  await render();
  return body;
}
