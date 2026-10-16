import { session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import {
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  date,
  emptyState,
  h,
  money,
  openModal,
  renderIcon,
  stat,
  toast,
  today,
} from '../../ui.js';
import { fill, fullName, pillTabs, section, timeRange, WEEK_ORDER, weekdayList, WEEKDAYS } from './common.js';
import { openEnrollModal } from './enrollForm.js';

/**
 * Courses & batches: the academic year's setup. A course has subjects and fee
 * structures; a batch is a group of students of one course, with a timing, a
 * room and a seat count. Classrooms (with desk counts) feed the timetable's
 * over-capacity warning.
 */

const thisSession = () => {
  const [y, m] = today().split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${start + 1}`;
};

/* ── Courses ─────────────────────────────────────────────────────────── */

function openCourseForm({ course, onSaved }) {
  const editing = Boolean(course);
  openModal({
    title: editing ? `Edit ${course.name}` : 'New course',
    subtitle: editing ? null : 'A program students enrol for — e.g. “Class 12 Science (Board + JEE)”.',
    icon: 'graduation',
    body: buildForm(
      [
        { name: 'name', label: 'Course name', required: true, full: true, value: course?.name, placeholder: 'JEE 1-Year Dropper' },
        { name: 'code', label: 'Short code', value: course?.code, placeholder: 'JEE-DROP' },
        { name: 'academic_year', label: 'Session', required: true, value: course?.academic_year || thisSession() },
        { name: 'target_exam', label: 'Target exam', full: true, value: course?.target_exam, placeholder: 'JEE Main + Advanced', list: 'cb-exams' },
        editing ? null : { name: 'subjects', label: 'Subjects', full: true, placeholder: 'Physics, Chemistry, Mathematics', hint: 'Comma-separated; you can add more later.' },
        { name: 'description', label: 'Description', type: 'textarea', full: true, value: course?.description },
      ],
      {
        submitLabel: editing ? 'Save' : 'Create course',
        onSubmit: async (values) => {
          const payload = { ...values };
          if (!editing) {
            payload.subjects = String(values.subjects || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((name) => ({ name }));
          }
          if (editing) {
            delete payload.subjects;
            await coaching.updateCourse(course.id, payload);
          } else await coaching.createCourse(payload);
          closeModal();
          toast(editing ? 'Course saved' : 'Course created');
          await onSaved?.();
        },
      },
    ),
  });
  // Common exam targets, as suggestions only.
  document.querySelector('.modal-backdrop:last-child .modal-body')?.append(
    h('datalist', { id: 'cb-exams' }, ...['CBSE Board', 'ICSE Board', 'State Board', 'JEE Main', 'JEE Main + Advanced', 'NEET-UG', 'CUET', 'UPSC CSE', 'SSC CGL', 'Banking (IBPS/SBI)', 'CLAT', 'NDA', 'Olympiad / NTSE'].map((v) => h('option', { value: v }))),
  );
}

function openFeeStructureForm({ course, structure, onSaved }) {
  const editing = Boolean(structure);
  const componentsText = (structure?.components || []).map((c) => `${c.label}: ${c.amount}`).join('\n');
  openModal({
    title: editing ? `Edit ${structure.name}` : `New fee structure · ${course.name}`,
    subtitle: 'The usual price and split for this course. Each student’s own plan is copied from it and can then be adjusted.',
    icon: 'wallet',
    body: buildForm(
      [
        { name: 'name', label: 'Name', required: true, full: true, value: structure?.name, placeholder: '3 installments' },
        { name: 'total_fee', label: 'Total fee', type: 'number', required: true, min: 0, value: structure?.total_fee },
        {
          name: 'installments',
          label: 'Installments',
          type: 'select',
          value: String(structure?.installments ?? 3),
          options: [1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: n === 1 ? 'Pay in full' : `${n} installments` })),
        },
        { name: 'interval_days', label: 'Days between installments', type: 'number', min: 0, max: 365, value: structure?.interval_days ?? 60 },
        {
          name: 'components',
          label: 'Fee breakdown (optional)',
          type: 'textarea',
          full: true,
          value: componentsText,
          placeholder: 'Tuition: 38000\nStudy material: 4000\nTest series: 3000',
          hint: 'One “Label: amount” per line. If given, it must add up to the total; it is printed on receipts.',
        },
      ],
      {
        submitLabel: editing ? 'Save' : 'Add fee structure',
        onSubmit: async (values) => {
          const components = String(values.components || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [label, amount] = line.split(/:\s*/);
              return { label: label?.trim(), amount: Number(String(amount || '').replace(/[^\d.]/g, '')) };
            });
          const payload = { ...values, components };
          if (editing) await coaching.updateFeeStructure(structure.id, payload);
          else await coaching.createFeeStructure(course.id, payload);
          closeModal();
          toast('Fee structure saved');
          await onSaved?.();
        },
      },
    ),
  });
}

function courseCard(course, reload) {
  const canManage = session.managesBilling;
  const subjectChips = h(
    'div',
    { class: 'pill-row' },
    ...course.subjects.map((s) =>
      h(
        'span',
        { class: 'cb-chip' },
        s.name,
        canManage
          ? h(
              'button',
              {
                type: 'button',
                class: 'cb-chip-x',
                title: `Remove ${s.name}`,
                'aria-label': `Remove ${s.name}`,
                onclick: () =>
                  confirmDialog({
                    title: `Remove ${s.name}?`,
                    message: 'Only possible while it has no attendance or tests.',
                    confirmLabel: 'Remove',
                    danger: true,
                    onConfirm: async () => {
                      await coaching.deleteSubject(s.id);
                      toast(`${s.name} removed`);
                      await reload();
                    },
                  }),
              },
              '×',
            )
          : null,
      ),
    ),
    canManage
      ? h(
          'button',
          {
            type: 'button',
            class: 'cb-chip is-add',
            onclick: () =>
              openModal({
                title: `Add a subject · ${course.name}`,
                body: buildForm(
                  [
                    { name: 'name', label: 'Subject', required: true, full: true, placeholder: 'Organic Chemistry' },
                    { name: 'code', label: 'Short code', placeholder: 'OCH' },
                  ],
                  {
                    submitLabel: 'Add subject',
                    onSubmit: async (values) => {
                      await coaching.createSubject(course.id, values);
                      closeModal();
                      toast('Subject added');
                      await reload();
                    },
                  },
                ),
              }),
          },
          renderIcon('plus', { size: 13 }),
          'Subject',
        )
      : null,
  );

  const fees = course.fee_structures.length
    ? h(
        'div',
        {},
        ...course.fee_structures.map((f) =>
          h(
            'div',
            { class: 'list-item' },
            h(
              'div',
              { class: 'cb-grow' },
              h('div', { class: 'cb-strong' }, f.name),
              h(
                'div',
                { class: 'muted cb-small' },
                f.installments === 1 ? 'Paid in full' : `${f.installments} installments, ${f.interval_days} days apart`,
                f.components.length ? ` · ${f.components.map((c) => c.label).join(', ')}` : '',
              ),
            ),
            h('strong', {}, money(f.total_fee)),
            canManage
              ? h('button', { class: 'btn sm ghost', onclick: () => openFeeStructureForm({ course, structure: f, onSaved: reload }) }, 'Edit')
              : null,
          ),
        ),
      )
    : h('p', { class: 'muted cb-small' }, 'No fee structure yet — add one to price admissions in a tap.');

  return h(
    'div',
    { class: `card cb-course${course.active ? '' : ' is-archived'}` },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'cb-section-icon' }, renderIcon('graduation', { size: 18 })),
      h(
        'div',
        {},
        h('h3', {}, course.name, course.code ? h('span', { class: 'badge grey cb-ml' }, course.code) : null, course.active ? null : h('span', { class: 'badge grey cb-ml' }, 'Archived')),
        h('p', { class: 'muted cb-section-sub' }, [course.target_exam, `Session ${course.academic_year}`].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'spacer' }),
      canManage
        ? h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn sm ghost', onclick: () => openCourseForm({ course, onSaved: reload }) }, 'Edit'),
            course.active
              ? h(
                  'button',
                  {
                    class: 'btn sm ghost',
                    onclick: () =>
                      confirmDialog({
                        title: `Remove ${course.name}?`,
                        message: 'A course with students is archived (its batches too) rather than deleted, so its records stay.',
                        confirmLabel: 'Remove',
                        danger: true,
                        onConfirm: async () => {
                          const res = await coaching.deleteCourse(course.id);
                          toast(res.archived ? 'Course archived' : 'Course deleted');
                          await reload();
                        },
                      }),
                  },
                  'Remove',
                )
              : h('button', { class: 'btn sm', onclick: async () => { await coaching.updateCourse(course.id, { active: true }); toast('Course restored'); await reload(); } }, 'Restore'),
          )
        : null,
    ),
    h(
      'div',
      { class: 'cb-course-stats' },
      h('span', {}, h('strong', {}, course.student_count), ' students'),
      h('span', {}, h('strong', {}, course.batch_count), ' batches'),
      h('span', {}, h('strong', {}, course.subject_count), ' subjects'),
    ),
    h('div', { class: 'cb-subhead' }, 'Subjects'),
    subjectChips,
    h(
      'div',
      { class: 'cb-subhead row' },
      h('span', {}, 'Fee structures'),
      h('div', { class: 'spacer' }),
      canManage ? h('button', { class: 'btn sm ghost', onclick: () => openFeeStructureForm({ course, onSaved: reload }) }, renderIcon('plus', { size: 13 }), 'Add') : null,
    ),
    fees,
  );
}

/* ── Batches ─────────────────────────────────────────────────────────── */

export function openBatchForm({ batch, courses, onSaved }) {
  const editing = Boolean(batch);
  const days = new Set(String(batch?.weekdays || '').split(',').filter(Boolean).map(Number));
  const dayPicker = h(
    'div',
    { class: 'cb-daypicker' },
    ...WEEK_ORDER.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: `cb-day${days.has(d) ? ' is-on' : ''}`,
          'aria-pressed': String(days.has(d)),
          onclick: (e) => {
            if (days.has(d)) days.delete(d);
            else days.add(d);
            e.currentTarget.classList.toggle('is-on', days.has(d));
            e.currentTarget.setAttribute('aria-pressed', String(days.has(d)));
          },
        },
        WEEKDAYS[d],
      ),
    ),
  );
  const form = buildForm(
    [
      {
        name: 'course_id',
        label: 'Course',
        type: 'select',
        required: true,
        full: true,
        value: batch?.course_id ?? courses[0]?.id,
        options: courses.map((c) => ({ value: c.id, label: c.name })),
      },
      { name: 'name', label: 'Batch name', required: true, value: batch?.name, placeholder: 'Morning Batch A' },
      { name: 'code', label: 'Batch code', required: true, value: batch?.code, placeholder: 'B12A', hint: 'Prefixes roll numbers (B12A-07)' },
      { name: 'start_time', label: 'Starts at', type: 'time', value: batch?.start_time },
      { name: 'end_time', label: 'Ends at', type: 'time', value: batch?.end_time },
      { name: 'room', label: 'Room / hall', value: batch?.room, placeholder: 'Room 101' },
      { name: 'capacity', label: 'Seats', type: 'number', min: 1, value: batch?.capacity ?? 40 },
      { name: 'start_date', label: 'Batch starts', type: 'date', required: true, value: batch?.start_date || today() },
      { name: 'end_date', label: 'Batch ends', type: 'date', value: batch?.end_date },
    ],
    {
      submitLabel: editing ? 'Save batch' : 'Create batch',
      onSubmit: async (values) => {
        const payload = { ...values, weekdays: [...days] };
        if (editing) await coaching.updateBatch(batch.id, payload);
        else await coaching.createBatch(payload);
        closeModal();
        toast(editing ? 'Batch saved' : 'Batch created');
        await onSaved?.();
      },
    },
  );
  form.querySelector('.form-grid').append(h('div', { class: 'field full' }, h('span', {}, 'Days'), dayPicker));
  openModal({ title: editing ? `Edit ${batch.name}` : 'New batch', icon: 'members', wide: true, body: form });
}

function batchesTable(batches, courses, navigate, reload) {
  if (!batches.length) {
    return emptyState('No batches yet.', {
      icon: 'graduation',
      action: session.managesBilling && courses.length ? h('button', { class: 'btn sm primary', onclick: () => openBatchForm({ courses, onSaved: reload }) }, 'Create a batch') : null,
    });
  }
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'cb-table' },
      h('thead', {}, h('tr', {}, ...['Batch', 'Course', 'Timing', 'Room', 'Students', 'Runs'].map((l) => h('th', {}, l)))),
      h(
        'tbody',
        {},
        ...batches.map((b) =>
          h(
            'tr',
            { class: 'clickable', onclick: () => navigate(`/batches/${b.id}`) },
            h('td', {}, h('div', { class: 'cb-strong' }, b.name), h('div', { class: 'muted cb-small' }, b.code)),
            h('td', {}, b.course_name),
            h('td', {}, h('div', {}, weekdayList(b.weekdays)), h('div', { class: 'muted cb-small' }, timeRange(b.start_time, b.end_time))),
            h('td', {}, b.room || '—'),
            h('td', { style: 'min-width:140px' }, h('div', { class: 'cb-occupancy-row' }, h('div', { class: 'cb-occupancy' }, h('span', { style: `width:${Math.min(100, (b.enrolled / b.capacity) * 100)}%` })), h('span', { class: 'cb-small' }, `${b.enrolled}/${b.capacity}`))),
            h('td', { class: 'muted cb-small' }, `${date(b.start_date)}${b.end_date ? ` → ${date(b.end_date)}` : ''}`),
          ),
        ),
      ),
    ),
  );
}

/* ── Classrooms ──────────────────────────────────────────────────────── */

function openRoomForm({ room, onSaved }) {
  openModal({
    title: room ? `Edit ${room.name}` : 'New classroom',
    subtitle: 'The desk count is what the timetable checks a batch against.',
    icon: 'building',
    body: buildForm(
      [
        { name: 'name', label: 'Room name', required: true, value: room?.name, placeholder: 'Room 101', hint: 'Use the same name as on the batch or lecture' },
        { name: 'capacity', label: 'Desks', type: 'number', min: 1, required: true, value: room?.capacity },
        { name: 'notes', label: 'Notes', full: true, value: room?.notes, placeholder: 'Projector, AC…' },
      ],
      {
        submitLabel: 'Save',
        onSubmit: async (values) => {
          if (room) await coaching.updateClassroom(room.id, values);
          else await coaching.createClassroom(values);
          closeModal();
          toast('Classroom saved');
          await onSaved?.();
        },
      },
    ),
  });
}

function roomsList(rooms, reload) {
  if (!rooms.length) return emptyState('No classrooms recorded. Rooms on batches and lectures still work as plain names.', { icon: 'building' });
  return h(
    'div',
    {},
    ...rooms.map((r) =>
      h(
        'div',
        { class: 'list-item' },
        h('span', { class: 'cb-section-icon' }, renderIcon('building', { size: 16 })),
        h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, r.name), h('div', { class: 'muted cb-small' }, `${r.capacity} desks${r.notes ? ` · ${r.notes}` : ''} · ${r.batch_count} batch${r.batch_count === 1 ? '' : 'es'}`)),
        session.managesBilling
          ? h(
              'div',
              { class: 'row' },
              h('button', { class: 'btn sm ghost', onclick: () => openRoomForm({ room: r, onSaved: reload }) }, 'Edit'),
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  onclick: () =>
                    confirmDialog({
                      title: `Delete ${r.name}?`,
                      message: 'Batches and lectures keep the room name; only the desk count is forgotten.',
                      confirmLabel: 'Delete',
                      danger: true,
                      onConfirm: async () => {
                        await coaching.deleteClassroom(r.id);
                        await reload();
                      },
                    }),
                },
                'Delete',
              ),
            )
          : null,
      ),
    ),
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

let lastPane = 'courses';

export async function renderAcademics({ navigate, reload, setActions }) {
  const [{ items: courses }, { items: batches }, { items: rooms }] = await Promise.all([
    coaching.courses({ archived: '1' }),
    coaching.batches(),
    coaching.classrooms(),
  ]);
  const activeCourses = courses.filter((c) => c.active);
  const canManage = session.managesBilling;
  const host = h('div', {});
  const tabsHost = h('div', {});

  const paint = () => {
    fill(tabsHost, 
      pillTabs(
        [
          { key: 'courses', label: 'Courses', icon: 'graduation', count: activeCourses.length },
          { key: 'batches', label: 'Batches', icon: 'members', count: batches.length },
          { key: 'rooms', label: 'Classrooms', icon: 'building', count: rooms.length },
        ],
        lastPane,
        (key) => {
          lastPane = key;
          paint();
        },
      ),
    );
    setActions(
      canManage
        ? lastPane === 'courses'
          ? h('button', { class: 'btn primary', onclick: () => openCourseForm({ onSaved: reload }) }, renderIcon('plus', { size: 16 }), 'New course')
          : lastPane === 'batches'
            ? h('button', { class: 'btn primary', disabled: !activeCourses.length, onclick: () => openBatchForm({ courses: activeCourses, onSaved: reload }) }, renderIcon('plus', { size: 16 }), 'New batch')
            : h('button', { class: 'btn primary', onclick: () => openRoomForm({ onSaved: reload }) }, renderIcon('plus', { size: 16 }), 'New classroom')
        : null,
    );
    fill(host, 
      lastPane === 'courses'
        ? courses.length
          ? h('div', { class: 'grid cols-2 top' }, ...courses.map((c) => courseCard(c, reload)))
          : emptyState('No courses yet.', { icon: 'graduation' })
        : lastPane === 'batches'
          ? h('div', { class: 'card', style: 'padding:6px 6px 14px' }, batchesTable(batches, activeCourses, navigate, reload))
          : section('Classrooms', roomsList(rooms, reload), { icon: 'building' }),
    );
  };
  paint();
  return h('div', { class: 'cb-page grid', style: 'gap:16px' }, tabsHost, host);
}

/* ── One batch ───────────────────────────────────────────────────────── */

function openAllocateForm({ batch, onSaved }) {
  coaching.faculty().then(({ items: faculty }) => {
    openModal({
      title: `Assign a teacher · ${batch.name}`,
      icon: 'users',
      body: buildForm(
        [
          {
            name: 'faculty_id',
            label: 'Teacher',
            type: 'select',
            required: true,
            full: true,
            options: faculty.map((f) => ({ value: f.id, label: `${f.name}${f.specialization ? ` · ${f.specialization}` : ''}` })),
          },
          { name: 'subject_id', label: 'Subject', type: 'select', required: true, full: true, options: batch.subjects.map((s) => ({ value: s.id, label: s.name })) },
          { name: 'hourly_rate', label: 'Rate per hour (optional)', type: 'number', min: 0 },
        ],
        {
          submitLabel: 'Assign',
          onSubmit: async (values) => {
            await coaching.allocateFaculty(batch.id, values);
            closeModal();
            toast('Teacher assigned');
            await onSaved?.();
          },
        },
      ),
    });
  });
}

export async function renderBatchDetail({ params, setTitle, setActions, reload, navigate }) {
  const [batch, { items: courses }] = await Promise.all([coaching.batch(params[0]), coaching.courses()]);
  setTitle(batch.name);
  const canManage = session.managesBilling;
  const active = batch.students.filter((s) => s.status === 'active');
  const others = batch.students.filter((s) => s.status !== 'active');

  setActions(
    h('button', { class: 'btn primary', onclick: () => openEnrollModal({ batchId: batch.id, onDone: reload }) }, renderIcon('userPlus', { size: 16 }), 'Enroll student'),
    canManage ? h('button', { class: 'btn', onclick: () => openBatchForm({ batch, courses, onSaved: reload }) }, 'Edit batch') : null,
  );

  const roster = active.length
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'cb-table' },
          h('thead', {}, h('tr', {}, ...['Roll', 'Student', 'Guardian', 'Enrolled', ''].map((l) => h('th', {}, l)))),
          h(
            'tbody',
            {},
            ...active.map((s) =>
              h(
                'tr',
                {},
                h('td', { class: 'cb-strong' }, s.roll_number || '—'),
                h('td', {}, h('a', { class: 'cb-strong', href: `#/members/${s.member_id}` }, fullName(s)), h('div', { class: 'muted cb-small' }, s.member_code)),
                h('td', {}, h('div', {}, s.emergency_contact || '—'), h('div', { class: 'muted cb-small' }, s.emergency_phone || s.phone || '')),
                h('td', { class: 'muted cb-small' }, date(s.enrolled_on)),
                h(
                  'td',
                  {},
                  h(
                    'div',
                    { class: 'row' },
                    h(
                      'button',
                      {
                        class: 'btn sm ghost',
                        onclick: () => {
                          const sameCourse = courses.find((c) => c.id === batch.course_id);
                          coaching.batches({ course_id: batch.course_id }).then(({ items }) => {
                            const targets = items.filter((b) => b.id !== batch.id);
                            if (!targets.length) return toast(`${sameCourse?.name || 'This course'} has no other batch to move to`, 'info');
                            openModal({
                              title: `Move ${fullName(s)}`,
                              subtitle: 'To another batch of the same course. Their history here is kept.',
                              body: buildForm(
                                [{ name: 'batch_id', label: 'New batch', type: 'select', full: true, options: targets.map((b) => ({ value: b.id, label: `${b.name} (${b.enrolled}/${b.capacity})` })) }],
                                {
                                  submitLabel: 'Move',
                                  onSubmit: async (values) => {
                                    const moved = await coaching.transferEnrollment(s.enrollment_id, values);
                                    closeModal();
                                    toast(`Moved to ${moved.batch_name} · roll no. ${moved.roll_number}`);
                                    await reload();
                                  },
                                },
                              ),
                            });
                          });
                        },
                      },
                      'Move',
                    ),
                    h(
                      'button',
                      {
                        class: 'btn sm ghost',
                        onclick: () =>
                          confirmDialog({
                            title: `Remove ${fullName(s)} from ${batch.name}?`,
                            message: 'A student with attendance or marks here is marked as dropped, keeping their record.',
                            confirmLabel: 'Remove',
                            danger: true,
                            onConfirm: async () => {
                              const res = await coaching.removeEnrollment(s.enrollment_id);
                              toast(res.dropped ? 'Marked as dropped' : 'Enrollment removed');
                              await reload();
                            },
                          }),
                      },
                      'Remove',
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    : emptyState('Nobody is enrolled yet.', { icon: 'members' });

  const faculty = h(
    'div',
    {},
    ...(batch.faculty.length
      ? batch.faculty.map((f) =>
          h(
            'div',
            { class: 'list-item' },
            h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, f.subject_name), h('div', { class: 'muted cb-small' }, f.faculty_name)),
            canManage
              ? h('button', { class: 'btn sm ghost', onclick: async () => { await coaching.removeAllocation(f.id); toast('Removed'); await reload(); } }, 'Remove')
              : null,
          ),
        )
      : [h('p', { class: 'muted cb-small' }, 'No teachers assigned yet.')]),
  );

  return h(
    'div',
    { class: 'cb-page grid', style: 'gap:16px' },
    h('a', { class: 'cb-back', href: '#/courses' }, renderIcon('arrowLeft', { size: 15 }), 'Courses & batches'),
    h(
      'div',
      { class: 'grid cols-4' },
      stat('Students', `${active.length}/${batch.capacity}`, batch.capacity - active.length > 0 ? `${batch.capacity - active.length} seats free` : 'Batch is full', { icon: 'members' }),
      stat('Timing', timeRange(batch.start_time, batch.end_time), weekdayList(batch.weekdays), { icon: 'clock' }),
      stat('Room', batch.room || '—', batch.course_name, { icon: 'building' }),
      stat('Runs', date(batch.start_date), batch.end_date ? `until ${date(batch.end_date)}` : 'No end date', { icon: 'calendar' }),
    ),
    h(
      'div',
      { class: 'grid cols-2 top cb-batch-grid' },
      section(`Roster · ${active.length}`, roster, { icon: 'members' }),
      h(
        'div',
        { class: 'grid', style: 'gap:16px' },
        section('Teachers', faculty, {
          icon: 'users',
          actions: canManage ? h('button', { class: 'btn sm ghost', onclick: () => openAllocateForm({ batch, onSaved: reload }) }, renderIcon('plus', { size: 13 }), 'Assign') : null,
        }),
        section(
          'Shortcuts',
          h(
            'div',
            { class: 'pill-row' },
            h('a', { class: 'btn sm', href: '#/timetable' }, renderIcon('calendar', { size: 14 }), 'Timetable'),
            h('a', { class: 'btn sm', href: '#/attendance' }, renderIcon('checkin', { size: 14 }), 'Attendance'),
            h('a', { class: 'btn sm', href: '#/tests' }, renderIcon('trophy', { size: 14 }), 'Tests'),
            h('a', { class: 'btn sm', href: '#/materials' }, renderIcon('fileText', { size: 14 }), 'Material'),
          ),
          { icon: 'zap' },
        ),
        others.length
          ? section(
              'Past students',
              h('div', {}, ...others.map((s) => h('div', { class: 'list-item' }, h('a', { class: 'cb-grow', href: `#/members/${s.member_id}` }, fullName(s)), h('span', { class: 'badge grey' }, s.status)))),
              { icon: 'history' },
            )
          : null,
      ),
    ),
  );
}

