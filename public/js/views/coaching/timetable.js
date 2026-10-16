import { session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { buildForm, clear, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, time, toast, today } from '../../ui.js';
import { batchOptions, fill, pillTabs, section, selectControl, WEEK_ORDER, WEEKDAYS, WEEKDAYS_LONG } from './common.js';

/**
 * The weekly master timetable: Monday-to-Sunday columns of lectures, filtered
 * by batch, teacher or room. Adding or moving a lecture is checked against
 * every other one as you type (POST /timetable/check), and a save that would
 * double-book a teacher, a room or a batch comes back 409 with the clashes —
 * the form then offers to save it anyway, for a planned combined class.
 */

const reasonText = { faculty: 'Teacher busy', room: 'Room taken', batch: 'Batch busy' };

function slotForm({ slot, batches, courses, faculty, onSaved }) {
  const editing = Boolean(slot?.id);
  const subjectsFor = (batchId) => courses.find((c) => c.id === batches.find((b) => b.id === Number(batchId))?.course_id)?.subjects || [];
  const firstBatch = slot?.batch_id ?? batches[0]?.id;
  const form = buildForm(
    [
      { name: 'batch_id', label: 'Batch', type: 'select', required: true, full: true, value: firstBatch, options: batchOptions(batches) },
      { name: 'subject_id', label: 'Subject', type: 'select', required: true, value: slot?.subject_id, options: subjectsFor(firstBatch).map((s) => ({ value: s.id, label: s.name })) },
      { name: 'faculty_id', label: 'Teacher', type: 'select', value: slot?.faculty_id ?? '', options: [{ value: '', label: 'Not assigned' }, ...faculty.map((f) => ({ value: f.id, label: f.name }))] },
      { name: 'weekday', label: 'Day', type: 'select', required: true, value: slot?.weekday ?? 1, options: WEEK_ORDER.map((d) => ({ value: d, label: WEEKDAYS_LONG[d] })) },
      { name: 'room', label: 'Room', value: slot?.room ?? '', placeholder: 'Defaults to the batch’s room' },
      { name: 'start_time', label: 'Starts', type: 'time', required: true, value: slot?.start_time ?? '16:00' },
      { name: 'end_time', label: 'Ends', type: 'time', required: true, value: slot?.end_time ?? '17:30' },
    ],
    {
      submitLabel: editing ? 'Save lecture' : 'Add lecture',
      onSubmit: async (values) => save(values, false),
    },
  );
  const warnings = h('div', { class: 'cb-slot-check' });
  form.insertBefore(warnings, form.querySelector('.modal-foot'));

  const field = (name) => form.querySelector(`[name="${name}"]`);
  const values = () => Object.fromEntries(['batch_id', 'subject_id', 'faculty_id', 'weekday', 'start_time', 'end_time', 'room'].map((n) => [n, field(n).value]));
  const payload = (v) => ({ ...v, faculty_id: v.faculty_id || undefined, room: v.room || undefined });

  field('batch_id').addEventListener('change', () => {
    clear(field('subject_id')).append(...subjectsFor(field('batch_id').value).map((s) => h('option', { value: s.id }, s.name)));
    check();
  });

  let checkTimer;
  async function check() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      const v = values();
      if (!v.subject_id || !v.start_time || !v.end_time) return clear(warnings);
      try {
        const res = await coaching.checkSlot({ ...payload(v), id: slot?.id });
        fill(warnings, 
          ...res.conflicts.map((c) => h('div', { class: 'cb-callout is-red' }, renderIcon('alert', { size: 15 }), h('span', {}, h('strong', {}, c.reasons.map((r) => reasonText[r]).join(' · ')), ` — ${c.text}`))),
          ...res.warnings.map((w) => h('div', { class: 'cb-callout is-amber' }, renderIcon('info', { size: 15 }), w)),
          !res.conflicts.length && !res.warnings.length ? h('div', { class: 'cb-callout is-green' }, renderIcon('checkCircle', { size: 15 }), 'No clashes with any other lecture') : null,
        );
      } catch {
        clear(warnings);
      }
    }, 250);
  }
  for (const name of ['subject_id', 'faculty_id', 'weekday', 'start_time', 'end_time', 'room']) {
    field(name).addEventListener('change', check);
    field(name).addEventListener('input', check);
  }
  check();

  async function save(v, override) {
    try {
      const body = { ...payload(v), override };
      const res = editing ? await coaching.updateSlot(slot.id, body) : await coaching.createSlot(body);
      closeModal();
      toast(editing ? 'Lecture saved' : 'Lecture added');
      for (const w of res.warnings || []) toast(w, 'info');
      await onSaved?.();
    } catch (err) {
      if (err.status === 409 && err.details?.code === 'timetable_conflict') {
        confirmDialog({
          title: 'This clashes with another lecture',
          message: err.details.conflicts.map((c) => c.text).join(' • '),
          confirmLabel: 'Save anyway',
          danger: true,
          onConfirm: async () => {
            closeModal();
            await save(v, true);
          },
        });
        return;
      }
      throw err;
    }
  }

  openModal({
    title: editing ? 'Edit lecture' : 'Add a lecture',
    icon: 'calendar',
    wide: true,
    body: form,
    footer: editing && session.managesBilling
      ? [
          h(
            'button',
            {
              class: 'btn danger',
              type: 'button',
              onclick: () =>
                confirmDialog({
                  title: 'Remove this lecture from the timetable?',
                  message: 'Attendance already taken for it stays.',
                  confirmLabel: 'Remove',
                  danger: true,
                  onConfirm: async () => {
                    await coaching.deleteSlot(slot.id);
                    closeModal();
                    toast('Lecture removed');
                    await onSaved?.();
                  },
                }),
            },
            'Remove lecture',
          ),
        ]
      : null,
  });
}

function weekGrid(slots, { onOpen }) {
  const byDay = new Map(WEEK_ORDER.map((d) => [d, []]));
  for (const slot of slots) byDay.get(slot.weekday)?.push(slot);
  const todayIdx = new Date().getDay();
  return h(
    'div',
    { class: 'cb-week' },
    ...WEEK_ORDER.map((d) =>
      h(
        'div',
        { class: `cb-week-day${d === todayIdx ? ' is-today' : ''}` },
        h('div', { class: 'cb-week-head' }, h('strong', {}, WEEKDAYS[d]), h('span', { class: 'muted cb-small' }, `${byDay.get(d).length || ''}`)),
        ...(byDay.get(d).length
          ? byDay.get(d).map((slot) =>
              h(
                'button',
                { type: 'button', class: `cb-slot${slot.has_conflict ? ' is-conflict' : ''}`, onclick: () => onOpen(slot) },
                h('div', { class: 'cb-slot-time' }, `${time(slot.start_time)} – ${time(slot.end_time)}`),
                h('div', { class: 'cb-strong' }, slot.subject_name),
                h('div', { class: 'cb-small' }, slot.batch_name),
                h('div', { class: 'muted cb-small' }, [slot.faculty_name, slot.effective_room].filter(Boolean).join(' · ') || 'No teacher or room'),
                slot.has_conflict ? h('span', { class: 'badge red' }, 'Clash') : null,
              ),
            )
          : [h('div', { class: 'cb-week-empty muted cb-small' }, '—')]),
      ),
    ),
  );
}

async function logPane(state, rerender, { batches, courses }) {
  const from = `${today().slice(0, 7)}-01`;
  const { items } = await coaching.lectureLogs({ from, to: today(), batch_id: state.batchId || undefined });
  const subjectsFor = (batchId) => courses.find((c) => c.id === batches.find((b) => b.id === Number(batchId))?.course_id)?.subjects || [];
  const openLogForm = () => {
    const first = state.batchId || batches[0]?.id;
    const form = buildForm(
      [
        { name: 'batch_id', label: 'Batch', type: 'select', required: true, full: true, value: first, options: batchOptions(batches) },
        { name: 'subject_id', label: 'Subject', type: 'select', options: subjectsFor(first).map((s) => ({ value: s.id, label: s.name })) },
        { name: 'lecture_date', label: 'Date', type: 'date', value: today() },
        { name: 'topic', label: 'Topic covered', required: true, full: true, placeholder: 'Kinematics: projectile motion derivations' },
        { name: 'notes', label: 'Notes / homework', type: 'textarea', full: true, placeholder: 'DPP #3 assigned' },
        { name: 'duration_min', label: 'Minutes (optional)', type: 'number', min: 1, hint: 'Defaults to the timetabled length' },
      ],
      {
        submitLabel: 'Log lecture',
        onSubmit: async (values) => {
          await coaching.logLecture(values);
          closeModal();
          toast('Lecture logged');
          await rerender();
        },
      },
    );
    form.querySelector('[name="batch_id"]').addEventListener('change', (e) => {
      clear(form.querySelector('[name="subject_id"]')).append(...subjectsFor(e.target.value).map((s) => h('option', { value: s.id }, s.name)));
    });
    openModal({ title: 'Log a lecture', subtitle: 'What was taught — the syllabus tracker, and what a per-lecture teacher is paid against.', icon: 'book', body: form });
  };

  return section(
    'Lecture log · this month',
    items.length
      ? h(
          'div',
          {},
          ...items.map((log) =>
            h(
              'div',
              { class: 'list-item' },
              h('div', { class: 'cb-log-date' }, h('strong', {}, date(log.lecture_date).slice(0, 5)), h('span', { class: 'muted cb-small' }, WEEKDAYS[new Date(`${log.lecture_date}T00:00:00`).getDay()])),
              h(
                'div',
                { class: 'cb-grow' },
                h('div', { class: 'cb-strong' }, log.topic),
                h('div', { class: 'muted cb-small' }, [log.subject_name, log.batch_name, log.faculty_name, log.duration_min ? `${log.duration_min} min` : null].filter(Boolean).join(' · ')),
                log.notes ? h('div', { class: 'cb-small' }, log.notes) : null,
              ),
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  title: 'Delete',
                  'aria-label': 'Delete this log entry',
                  onclick: () =>
                    confirmDialog({
                      title: 'Delete this lecture log?',
                      message: log.topic,
                      confirmLabel: 'Delete',
                      danger: true,
                      onConfirm: async () => {
                        await coaching.deleteLectureLog(log.id);
                        await rerender();
                      },
                    }),
                },
                renderIcon('trash', { size: 14 }),
              ),
            ),
          ),
        )
      : emptyState('No lectures logged this month.', { icon: 'book' }),
    { icon: 'book', actions: h('button', { class: 'btn sm primary', onclick: openLogForm }, renderIcon('plus', { size: 14 }), 'Log a lecture') },
  );
}

export async function renderTimetable({ setActions }) {
  const [{ items: batches }, { items: courses }, { items: faculty }] = await Promise.all([coaching.batches(), coaching.courses(), coaching.faculty()]);
  const state = { pane: 'week', by: 'batch', batchId: '', facultyId: '', room: '' };
  const canManage = session.managesBilling;
  const host = h('div', {});
  const tabsHost = h('div', {});

  async function rerender() {
    fill(tabsHost, 
      pillTabs(
        [
          { key: 'week', label: 'Weekly timetable', icon: 'calendar' },
          { key: 'log', label: 'Lecture log', icon: 'book' },
        ],
        state.pane,
        (key) => {
          state.pane = key;
          rerender();
        },
      ),
    );
    if (state.pane === 'log') {
      fill(host, await logPane(state, rerender, { batches, courses }));
      return;
    }
    const data = await coaching.timetable({ batch_id: state.batchId || undefined, faculty_id: state.facultyId || undefined, room: state.room || undefined });
    const rooms = [...new Set(data.items.map((s) => s.effective_room).filter(Boolean))].sort();
    const filters = h(
      'div',
      { class: 'toolbar' },
      selectControl(batchOptions(batches), state.batchId, (v) => {
        state.batchId = v;
        rerender();
      }, { placeholder: 'All batches' }),
      selectControl(faculty.map((f) => ({ value: f.id, label: f.name })), state.facultyId, (v) => {
        state.facultyId = v;
        rerender();
      }, { placeholder: 'All teachers' }),
      selectControl(rooms.map((r) => ({ value: r, label: r })), state.room, (v) => {
        state.room = v;
        rerender();
      }, { placeholder: 'All rooms' }),
    );
    const open = (slot) =>
      canManage ? slotForm({ slot, batches, courses, faculty, onSaved: rerender }) : toast(`${slot.subject_name} · ${slot.batch_name}`, 'info');
    fill(host, 
      h(
        'div',
        { class: 'grid', style: 'gap:16px' },
        filters,
        data.conflicts.length
          ? h(
              'div',
              { class: 'cb-callout is-red' },
              renderIcon('alert', { size: 16 }),
              h('div', {}, h('strong', {}, `${data.conflicts.length} clash${data.conflicts.length === 1 ? '' : 'es'} this week`), ...data.conflicts.slice(0, 5).map((c) => h('div', { class: 'cb-small' }, `${c.with} ↔ ${c.text}`))),
            )
          : null,
        data.items.length
          ? weekGrid(data.items, { onOpen: open })
          : emptyState(batches.length ? 'No lectures planned yet.' : 'Create a batch first, on Courses & batches.', { icon: 'calendar' }),
      ),
    );
  }

  setActions(
    canManage
      ? h('button', { class: 'btn primary', disabled: !batches.length, onclick: () => slotForm({ slot: null, batches, courses, faculty, onSaved: rerender }) }, renderIcon('plus', { size: 16 }), 'Add lecture')
      : null,
  );
  await rerender();
  return h('div', { class: 'cb-page grid', style: 'gap:16px' }, tabsHost, host);
}
