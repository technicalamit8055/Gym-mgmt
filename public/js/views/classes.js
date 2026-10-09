import { api, session } from '../api.js';
import {
  addDays,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  date,
  dateField,
  dayMonth,
  emptyState,
  fullName,
  h,
  openModal,
  renderIcon,
  statusBadge,
  table,
  time,
  toast,
  today,
} from '../ui.js';
import { openBookingForm } from './forms.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function openClassForm({ klass, weekday, onSaved }) {
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
          value: klass?.weekday ?? weekday ?? 1,
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

const PAGE_SIZE = 10;

/** The Monday on or before an ISO date — the timetable always starts there. */
const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00`).getDay() + 6) % 7));

/** A glyph that hints at the kind of class; the calendar when nothing fits. */
function classIcon(name = '') {
  const n = name.toLowerCase();
  if (/yoga|pilates|stretch|medit/.test(n)) return 'yoga';
  if (/zumba|danc|aerobic/.test(n)) return 'music';
  if (/spin|cycl|cardio|hiit|run/.test(n)) return 'heartPulse';
  if (/box|kick|mma|martial/.test(n)) return 'target';
  if (/strength|weight|lift|pump|crossfit/.test(n)) return 'weight';
  return 'calendar';
}

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

const seatTone = (left) => (left <= 0 ? 'red' : left <= 3 ? 'amber' : 'green');
const seatLabel = (left) => (left <= 0 ? 'Full' : `${left} left`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;

/** Page numbers with gaps: 1 … 4 5 6 … 12. */
function pageList(page, pages) {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((n, i) => {
    if (i && n - sorted[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

export async function renderClasses({ setActions, reload }) {
  // Start the timetable on the Monday of the current week.
  const monday = mondayOf(today());
  const state = { weekStart: monday, query: '', status: 'all', page: 1 };
  const canEdit = session.managesBilling;

  const body = h('div', { class: 'cl-page' });

  setActions(
    h(
      'button',
      { class: 'btn cl-head-btn', onclick: () => openBookingForm({ classes: state.classes || [], onSaved: render }) },
      renderIcon('userPlus', { size: 18 }),
      'Book a member',
    ),
    canEdit
      ? h(
          'button',
          { class: 'btn primary cl-head-btn cl-new', onclick: () => openClassForm({ onSaved: reload }) },
          renderIcon('plus', { size: 18, stroke: 2.4 }),
          'New class',
        )
      : null,
  );

  function goToWeek(weekStart) {
    state.weekStart = weekStart;
    render();
  }

  function weekBar() {
    const picker = dateField({
      value: state.weekStart,
      onchange: (event) => {
        if (event.target.value) goToWeek(mondayOf(event.target.value));
      },
    });
    return h(
      'div',
      { class: 'cl-weekbar' },
      h(
        'button',
        { class: 'btn cl-step', onclick: () => goToWeek(addDays(state.weekStart, -7)) },
        h('span', { class: 'cl-step-icon' }, renderIcon('chevronLeft', { size: 18, stroke: 2.2 })),
        h('span', { class: 'cl-step-label' }, 'Previous week'),
      ),
      h(
        'div',
        { class: 'btn cl-week-pick' },
        renderIcon('calendar', { size: 18 }),
        h('strong', {}, `Week of ${date(state.weekStart)}`),
        renderIcon('chevronDown', { size: 16, stroke: 2.2 }),
        picker,
      ),
      h(
        'button',
        { class: 'btn cl-step', onclick: () => goToWeek(addDays(state.weekStart, 7)) },
        h('span', { class: 'cl-step-label' }, 'Next week'),
        h('span', { class: 'cl-step-icon' }, renderIcon('chevronRight', { size: 18, stroke: 2.2 })),
      ),
      h('div', { class: 'spacer' }),
      h(
        'button',
        { class: 'btn cl-this-week', disabled: state.weekStart === monday, onclick: () => goToWeek(monday) },
        renderIcon('calendar', { size: 18 }),
        'This week',
      ),
    );
  }

  function slotCard(slot) {
    const left = slot.seats_left;
    return h(
      'article',
      { class: 'cl-slot' },
      h(
        'div',
        { class: 'cl-slot-body' },
        h('span', { class: 'cl-time' }, time(slot.start_time)),
        h('div', { class: 'cl-slot-name' }, slot.name),
        h('div', { class: 'cl-slot-sub' }, slot.trainer_name || 'Unassigned', slot.room ? ` · ${slot.room}` : ''),
      ),
      h(
        'div',
        { class: 'cl-slot-foot' },
        h(
          'span',
          { class: `cl-seats tone-${seatTone(left)}` },
          renderIcon(left <= 0 ? 'xCircle' : 'checkCircle', { size: 15, stroke: 2.2 }),
          seatLabel(left),
        ),
        h(
          'button',
          { class: 'cl-roster', title: 'View bookings', onclick: () => openClassRoster(slot) },
          renderIcon('users', { size: 16 }),
          `${slot.booked}/${slot.capacity}`,
        ),
      ),
    );
  }

  function dayColumn(day, slots) {
    const weekday = new Date(`${day}T00:00:00`).getDay();
    const inDay = slots.filter((slot) => slot.class_date === day);
    const classes = ['cl-day'];
    if (inDay.length) classes.push('has-classes');
    if (day === today()) classes.push('today');
    return h(
      'section',
      { class: classes.join(' '), 'aria-label': `${WEEKDAYS[weekday]} ${date(day)}` },
      h(
        'header',
        { class: 'cl-day-head' },
        h('span', { class: 'cl-day-name' }, WEEKDAYS[weekday].slice(0, 3).toUpperCase()),
        h('span', { class: 'cl-count' }, plural(inDay.length, 'class')),
        h('span', { class: 'cl-day-date' }, dayMonth(day)),
      ),
      inDay.length
        ? h('div', { class: 'cl-day-list' }, ...inDay.map(slotCard))
        : h(
            'div',
            { class: 'cl-day-empty' },
            h('span', { class: 'cl-day-empty-icon' }, renderIcon('calendar', { size: 22 })),
            h('strong', {}, 'No classes'),
            canEdit
              ? h('button', { class: 'cl-day-add', onclick: () => openClassForm({ weekday, onSaved: reload }) }, 'Add a class to this day')
              : h('span', {}, 'Nothing scheduled'),
          ),
    );
  }

  function classRow(klass, slotByClass) {
    // Bookings are per date, so capacity reads against the week on screen.
    const booked = slotByClass.get(klass.id)?.booked ?? 0;
    const left = klass.capacity - booked;
    const pct = Math.min(100, Math.round((booked / klass.capacity) * 100));
    const tone = seatTone(left);
    return h(
      'tr',
      {},
      h(
        'td',
        {},
        h(
          'div',
          { class: 'cl-cell-class' },
          h('span', { class: 'cl-class-icon' }, renderIcon(classIcon(klass.name), { size: 22, stroke: 2 })),
          h('div', { class: 'cl-cell-text' }, h('strong', {}, klass.name), klass.description ? h('span', {}, klass.description) : null),
        ),
      ),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'cl-cell-when' },
          renderIcon('calendar', { size: 20 }),
          h('div', {}, h('div', {}, klass.weekday_name), h('div', {}, time(klass.start_time))),
        ),
      ),
      h('td', {}, h('div', { class: 'cl-cell-inline' }, renderIcon('clock', { size: 19 }), `${klass.duration_min} min`)),
      h(
        'td',
        {},
        klass.trainer_name
          ? h('div', { class: 'cl-cell-inline' }, h('span', { class: 'cl-avatar' }, initials(klass.trainer_name)), h('span', { class: 'cl-trainer' }, klass.trainer_name))
          : h('span', { class: 'muted' }, 'Unassigned'),
      ),
      h('td', {}, klass.room || h('span', { class: 'cl-dash' }, '—')),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'cl-cap' },
          h('div', { class: 'cl-cap-count' }, renderIcon('users', { size: 18 }), `${booked} / ${klass.capacity}`),
          h(
            'div',
            {
              class: `cl-cap-bar tone-${tone}`,
              role: 'progressbar',
              'aria-label': 'Seats booked this week',
              'aria-valuemin': '0',
              'aria-valuemax': String(klass.capacity),
              'aria-valuenow': String(booked),
            },
            h('span', { style: `width:${pct}%` }),
          ),
          h('div', { class: `cl-cap-left tone-${tone}` }, seatLabel(left)),
        ),
      ),
      h(
        'td',
        {},
        klass.active
          ? h('span', { class: 'cl-status running' }, renderIcon('play', { size: 14 }), 'Running')
          : h('span', { class: 'cl-status paused' }, renderIcon('pause', { size: 14 }), 'Paused'),
      ),
      canEdit
        ? h(
            'td',
            {},
            h(
              'div',
              { class: 'cl-actions' },
              h('button', { class: 'btn cl-act', onclick: () => openClassForm({ klass, onSaved: reload }) }, renderIcon('edit', { size: 17 }), 'Edit'),
              h(
                'button',
                {
                  class: 'btn danger cl-act',
                  onclick: () =>
                    confirmDialog({
                      title: `Delete ${klass.name}?`,
                      message: 'All bookings for this class will be removed.',
                      confirmLabel: 'Delete class',
                      danger: true,
                      onConfirm: async () => {
                        await api.deleteClass(klass.id);
                        toast('Class deleted');
                        await reload();
                      },
                    }),
                },
                renderIcon('trash', { size: 17 }),
                'Delete',
              ),
            ),
          )
        : null,
    );
  }

  function allClassesCard(allClasses, slots) {
    const slotByClass = new Map(slots.map((slot) => [slot.id, slot]));
    const results = h('div', {});

    function draw() {
      const q = state.query.trim().toLowerCase();
      const filtered = allClasses.filter(
        (klass) =>
          (state.status === 'all' || (state.status === 'running') === Boolean(klass.active)) &&
          (!q ||
            [klass.name, klass.description, klass.trainer_name, klass.room, klass.weekday_name].some(
              (value) => value && String(value).toLowerCase().includes(q),
            )),
      );
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      state.page = Math.min(state.page, pages);
      const rows = filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

      if (!filtered.length) {
        clear(results).append(
          emptyState(allClasses.length ? 'No classes match your search' : 'No classes on the timetable yet', { icon: 'calendar' }),
        );
        return;
      }

      const goTo = (page) => {
        state.page = page;
        draw();
      };
      const headings = ['Class', 'When', 'Duration', 'Trainer', 'Room', 'Capacity', 'Status', canEdit ? 'Actions' : null];

      clear(results).append(
        h(
          'div',
          { class: 'table-wrap cl-table-wrap' },
          h(
            'table',
            { class: 'cl-table' },
            h('thead', {}, h('tr', {}, ...headings.filter(Boolean).map((label) => h('th', {}, label)))),
            h('tbody', {}, ...rows.map((klass) => classRow(klass, slotByClass))),
          ),
        ),
        h(
          'div',
          { class: 'cl-foot' },
          h('span', {}, `Showing ${rows.length} of ${plural(filtered.length, 'class')}`),
          h(
            'nav',
            { class: 'cl-pager', 'aria-label': 'Pages' },
            h(
              'button',
              { class: 'cl-page-btn', 'aria-label': 'Previous page', disabled: state.page <= 1, onclick: () => goTo(state.page - 1) },
              renderIcon('chevronLeft', { size: 18, stroke: 2.2 }),
            ),
            ...pageList(state.page, pages).map((n) =>
              n === '…'
                ? h('span', { class: 'cl-page-gap' }, '…')
                : h(
                    'button',
                    {
                      class: `cl-page-btn${n === state.page ? ' active' : ''}`,
                      'aria-current': n === state.page ? 'page' : null,
                      onclick: () => goTo(n),
                    },
                    String(n),
                  ),
            ),
            h(
              'button',
              { class: 'cl-page-btn', 'aria-label': 'Next page', disabled: state.page >= pages, onclick: () => goTo(state.page + 1) },
              renderIcon('chevronRight', { size: 18, stroke: 2.2 }),
            ),
          ),
        ),
      );
    }

    const search = h('input', {
      type: 'search',
      class: 'cl-search',
      placeholder: 'Search classes...',
      'aria-label': 'Search classes',
      value: state.query,
      oninput: (event) => {
        state.query = event.target.value;
        state.page = 1;
        draw();
      },
    });
    const status = h(
      'select',
      {
        class: 'cl-filter',
        'aria-label': 'Filter by status',
        onchange: (event) => {
          state.status = event.target.value;
          state.page = 1;
          draw();
        },
      },
      h('option', { value: 'all' }, 'All status'),
      h('option', { value: 'running' }, 'Running'),
      h('option', { value: 'paused' }, 'Paused'),
    );
    status.value = state.status;

    draw();
    return h(
      'div',
      { class: 'card cl-all' },
      h(
        'div',
        { class: 'cl-all-head' },
        h('span', { class: 'cl-all-icon' }, renderIcon('calendar', { size: 26, stroke: 2 })),
        h(
          'div',
          { class: 'cl-all-title' },
          h('h3', {}, 'All classes'),
          h('p', {}, 'Complete list of classes with schedule, trainer and capacity details.'),
        ),
        h('div', { class: 'cl-all-tools' }, search, status),
      ),
      results,
    );
  }

  async function renderTimetable() {
    const [{ items: slots }, { items: allClasses }] = await Promise.all([
      api.schedule({ week_start: state.weekStart }),
      api.classes({}),
    ]);
    state.classes = allClasses;

    const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
    return h(
      'div',
      { class: 'grid cl-grid' },
      weekBar(),
      h('div', { class: 'cl-week-scroll' }, h('div', { class: 'cl-week' }, ...days.map((day) => dayColumn(day, slots)))),
      allClassesCard(allClasses, slots),
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
            renderIcon('plus', { size: 15 }), 'Add member',
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
    // Keep the current week on screen, dimmed, while the next one loads.
    if (body.childElementCount) body.classList.add('is-loading');
    else body.append(h('div', { class: 'empty' }, 'Loading…'));
    try {
      clear(body).append(await renderTimetable());
    } finally {
      body.classList.remove('is-loading');
    }
  }

  await render();
  return body;
}
