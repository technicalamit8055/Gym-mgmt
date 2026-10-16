import { session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { clear, confirmDialog, date, dateField, emptyState, h, openModal, renderIcon, time, toast, today } from '../../ui.js';
import { ATTENDANCE_STATUS, batchOptions, fill, fullName, openAlertSettings, pct, percentBar, pillTabs, reportSend, section, selectControl, timeRange, WEEKDAYS_LONG } from './common.js';

/**
 * The attendance desk.
 *
 * "Take attendance" lists the day's lectures (from the timetable); opening
 * one gives the 1-tap sheet — every student with Present / Absent / Late /
 * Excused, everyone pre-set to Present (or to what is already saved), and
 * anyone who scanned in at the gate flagged. Saving today's sheet queues the
 * WhatsApp alert to each absent student's guardian (src/coaching/notify.js).
 *
 * "Reports" is the month per batch, with the low-attendance warning to
 * parents.
 */

let pendingSheet = null;
/** Lets another screen (the dashboard's "Take attendance") open a sheet here. */
export function requestSheet(spec) {
  pendingSheet = spec;
}

const STATUS_ORDER = ['present', 'absent', 'late', 'excused'];

function sheetView({ sheet, subjectName, lecture, onSaved }) {
  const isToday = sheet.date === today();
  const marks = new Map(sheet.items.map((s) => [s.member_id, s.status || 'present']));
  let notify = isToday;

  const counts = h('div', { class: 'cb-sheet-counts' });
  const paintCounts = () => {
    const tally = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    for (const v of marks.values()) tally[v] += 1;
    fill(counts, 
      ...STATUS_ORDER.map((s) => h('span', { class: `badge ${ATTENDANCE_STATUS[s].tone}` }, `${ATTENDANCE_STATUS[s].label} ${tally[s]}`)),
    );
  };

  const rows = sheet.items.map((student) => {
    const buttons = STATUS_ORDER.map((status) =>
      h(
        'button',
        {
          type: 'button',
          class: `cb-mark is-${status}`,
          title: ATTENDANCE_STATUS[status].label,
          'aria-label': `${ATTENDANCE_STATUS[status].label}: ${fullName(student)}`,
          onclick: () => {
            marks.set(student.member_id, status);
            paint();
            paintCounts();
          },
        },
        ATTENDANCE_STATUS[status].short,
      ),
    );
    const paint = () => {
      const current = marks.get(student.member_id);
      buttons.forEach((b, i) => {
        b.classList.toggle('is-on', STATUS_ORDER[i] === current);
        b.setAttribute('aria-pressed', String(STATUS_ORDER[i] === current));
      });
    };
    paint();
    return h(
      'div',
      { class: 'cb-sheet-row' },
      h('span', { class: 'cb-roll' }, student.roll_number || '—'),
      h(
        'div',
        { class: 'cb-grow' },
        h('div', { class: 'cb-strong' }, fullName(student)),
        h(
          'div',
          { class: 'cb-small muted' },
          student.member_code,
          student.scanned_in_at ? h('span', { class: 'badge blue cb-ml' }, `Scanned in ${time(student.scanned_in_at.slice(11, 16))}`) : null,
          student.alerted ? h('span', { class: 'badge grey cb-ml' }, 'Parent alerted') : null,
        ),
      ),
      h('div', { class: 'cb-marks' }, ...buttons),
    );
  });
  paintCounts();

  const save = h('button', { class: 'btn primary', type: 'button' }, renderIcon('check', { size: 16 }), 'Save attendance');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const result = await coaching.saveAttendance({
        batch_id: sheet.batch.id,
        subject_id: sheet.subject_id || undefined,
        date: sheet.date,
        notify,
        entries: [...marks].map(([member_id, status]) => ({ member_id, status })),
      });
      toast(`Attendance saved for ${result.saved} students`);
      if (notify) reportSend(result.alerts, { what: 'absentee alerts' });
      await onSaved?.();
    } catch (err) {
      toast(err.message || 'Could not save attendance', 'error');
    } finally {
      save.disabled = false;
    }
  });

  const notifyToggle = h(
    'label',
    { class: 'cb-check' },
    h('input', { type: 'checkbox', checked: notify, disabled: !isToday, onchange: (e) => (notify = e.target.checked) }),
    isToday ? 'WhatsApp the parents of absent students' : 'Parent alerts only go out for today’s sheet',
  );

  return h(
    'div',
    { class: 'card cb-sheet' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('h3', {}, `${sheet.batch.name}${subjectName ? ` · ${subjectName}` : ' · Whole day'}`),
        h('p', { class: 'muted cb-section-sub' }, `${WEEKDAYS_LONG[new Date(`${sheet.date}T00:00:00`).getDay()]} ${date(sheet.date)}${lecture?.start_time ? ` · ${timeRange(lecture.start_time, lecture.end_time)}` : ''}`),
      ),
      h('div', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: () => {
            for (const id of marks.keys()) marks.set(id, 'present');
            for (const row of rows) row.querySelectorAll('.cb-mark').forEach((b, i) => b.classList.toggle('is-on', i === 0));
            paintCounts();
          },
        },
        'All present',
      ),
    ),
    counts,
    sheet.items.length ? h('div', { class: 'cb-sheet-list' }, ...rows) : emptyState('Nobody is enrolled in this batch yet.', { icon: 'members' }),
    sheet.items.length ? h('div', { class: 'cb-sheet-foot' }, notifyToggle, h('div', { class: 'spacer' }), save) : null,
  );
}

async function takeAttendancePane(state, rerender) {
  const [day, batches, courses] = await Promise.all([
    coaching.attendanceDay({ date: state.date }),
    coaching.batches(),
    coaching.courses(),
  ]);
  const subjectsOf = (batchId) => courses.items.find((c) => c.id === batches.items.find((b) => b.id === Number(batchId))?.course_id)?.subjects || [];

  if (pendingSheet) {
    state.batchId = pendingSheet.batch_id;
    state.subjectId = pendingSheet.subject_id ?? '';
    pendingSheet = null;
  }

  const sheetHost = h('div', {});
  const openSheet = async (batchId, subjectId, lecture) => {
    state.batchId = batchId;
    state.subjectId = subjectId ?? '';
    fill(sheetHost, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading the sheet…')));
    try {
      const sheet = await coaching.attendanceSheet({ batch_id: batchId, subject_id: subjectId || undefined, date: state.date });
      const subjectName = subjectsOf(batchId).find((s) => s.id === Number(subjectId))?.name;
      fill(sheetHost, sheetView({ sheet, subjectName, lecture, onSaved: rerender }));
      sheetHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      fill(sheetHost, h('div', { class: 'card' }, h('p', { class: 'cb-red' }, err.message)));
    }
  };

  const lectureList = day.lectures.length
    ? h(
        'div',
        { class: 'cb-lecture-grid' },
        ...day.lectures.map((lecture) => {
          const done = lecture.marked >= lecture.enrolled && lecture.enrolled > 0;
          const active = Number(state.batchId) === lecture.batch_id && String(state.subjectId || '') === String(lecture.subject_id || '');
          const card = h(
            'button',
            {
              type: 'button',
              class: `cb-lecture-card${active ? ' is-active' : ''}${done ? ' is-done' : ''}`,
              onclick: () => {
                for (const other of lectureList.querySelectorAll('.cb-lecture-card')) other.classList.remove('is-active');
                card.classList.add('is-active');
                openSheet(lecture.batch_id, lecture.subject_id, lecture);
              },
            },
            h('div', { class: 'cb-lecture-card-time' }, lecture.start_time ? timeRange(lecture.start_time, lecture.end_time) : 'Whole day'),
            h('div', { class: 'cb-strong' }, lecture.subject_name || 'Whole-day attendance'),
            h('div', { class: 'muted cb-small' }, `${lecture.batch_name}${lecture.room ? ` · ${lecture.room}` : ''}`),
            h(
              'div',
              { class: 'cb-lecture-card-foot' },
              lecture.marked
                ? h('span', { class: `badge ${lecture.absent ? 'amber' : 'green'}` }, `${lecture.marked}/${lecture.enrolled} marked${lecture.absent ? ` · ${lecture.absent} absent` : ''}`)
                : h('span', { class: 'badge grey' }, `${lecture.enrolled} students`),
            ),
          );
          return card;
        }),
      )
    : emptyState(`No lectures on ${WEEKDAYS_LONG[day.weekday]}'s timetable. Pick a batch below for an extra class.`, { icon: 'calendar' });

  // Any batch, any subject — an extra class, a doubt session, or a batch with
  // no timetable yet.
  let pickBatch = state.batchId || '';
  let pickSubject = state.subjectId || '';
  const subjectSelect = h('span', {});
  const paintSubjects = () =>
    fill(subjectSelect, 
      selectControl(subjectsOf(pickBatch).map((s) => ({ value: s.id, label: s.name })), pickSubject, (v) => (pickSubject = v), { placeholder: 'Whole day' }),
    );
  paintSubjects();
  const picker = h(
    'div',
    { class: 'toolbar cb-picker' },
    selectControl(batchOptions(batches.items), pickBatch, (v) => {
      pickBatch = v;
      pickSubject = '';
      paintSubjects();
    }, { placeholder: 'Choose a batch…' }),
    subjectSelect,
    h('button', { class: 'btn', type: 'button', onclick: () => (pickBatch ? openSheet(pickBatch, pickSubject) : toast('Choose a batch first', 'info')) }, 'Open sheet'),
  );

  if (state.batchId) openSheet(state.batchId, state.subjectId, day.lectures.find((l) => l.batch_id === Number(state.batchId) && String(l.subject_id || '') === String(state.subjectId || '')));

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    section(`Lectures · ${WEEKDAYS_LONG[day.weekday]} ${date(day.date)}`, lectureList, { icon: 'calendar' }),
    section('Another batch or subject', picker, { icon: 'plus', subtitle: 'For an extra class, or a batch that has no timetable yet' }),
    sheetHost,
  );
}

function calendarModal(student, month) {
  const body = h('div', { class: 'cb-calendar-host' }, h('p', { class: 'muted' }, 'Loading…'));
  const load = async (m) => {
    const data = await coaching.attendanceCalendar(student.member_id, { month: m });
    fill(body, attendanceCalendarView(data, { onMonth: load }));
  };
  openModal({ title: `${fullName(student)} · attendance`, icon: 'calendar', body });
  load(month).catch((err) => fill(body, h('p', { class: 'cb-red' }, err.message)));
}

/** A month grid of coloured days, shared with the student's own page. */
export function attendanceCalendarView(data, { onMonth } = {}) {
  const [y, m] = data.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysIn = new Date(y, m, 0).getDate();
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const lead = (first.getDay() + 6) % 7; // Monday first
  const shift = (delta) => {
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const detail = h('div', { class: 'cb-cal-detail muted cb-small' }, 'Tap a day to see each lecture.');
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'cb-cal-cell is-blank' }));
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${data.month}-${String(d).padStart(2, '0')}`;
    const day = byDate.get(iso);
    cells.push(
      h(
        'button',
        {
          type: 'button',
          class: `cb-cal-cell${day ? ` is-${day.status}` : ''}${iso === today() ? ' is-today' : ''}`,
          disabled: !day,
          onclick: () =>
            fill(detail, 
              h('strong', {}, date(iso)),
              ...day.lectures.map((l) =>
                h('div', {}, `${l.subject_name || 'Whole day'} · ${l.batch_name}: `, h('span', { class: `badge ${ATTENDANCE_STATUS[l.status].tone}` }, ATTENDANCE_STATUS[l.status].label), l.source === 'scan' ? ' (gate scan)' : ''),
              ),
            ),
        },
        String(d),
      ),
    );
  }
  const s = data.summary || {};
  return h(
    'div',
    { class: 'cb-calendar' },
    h(
      'div',
      { class: 'cb-cal-head' },
      onMonth ? h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Previous month', onclick: () => onMonth(shift(-1)) }, renderIcon('chevronLeft', { size: 16 })) : null,
      h('strong', {}, first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })),
      onMonth ? h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Next month', onclick: () => onMonth(shift(1)) }, renderIcon('chevronRight', { size: 16 })) : null,
      h('div', { class: 'spacer' }),
      h('span', { class: 'cb-strong' }, pct(s.percentage)),
    ),
    h('div', { class: 'cb-cal-grid cb-cal-labels' }, ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l) => h('div', {}, l))),
    h('div', { class: 'cb-cal-grid' }, ...cells),
    h(
      'div',
      { class: 'cb-cal-legend' },
      ...STATUS_ORDER.map((st) => h('span', { class: `cb-legend is-${st}` }, `${ATTENDANCE_STATUS[st].label} ${s[st] ?? 0}`)),
    ),
    detail,
  );
}

async function reportsPane(state, rerender) {
  const batches = await coaching.batches();
  if (!state.reportBatch && batches.items.length) state.reportBatch = batches.items[0].id;
  const month = state.reportMonth || today().slice(0, 7);
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    selectControl(batchOptions(batches.items), state.reportBatch, (v) => {
      state.reportBatch = v;
      rerender();
    }),
    h('input', {
      type: 'month',
      value: month,
      onchange: (e) => {
        state.reportMonth = e.target.value;
        rerender();
      },
    }),
  );
  if (!state.reportBatch) return h('div', {}, toolbar, emptyState('Create a batch first.', { icon: 'graduation' }));

  const report = await coaching.attendanceReport({ batch_id: state.reportBatch, month });
  const canWarn = session.managesBilling;
  const warn = canWarn && report.below_threshold
    ? h(
        'button',
        {
          class: 'btn',
          onclick: () =>
            confirmDialog({
              title: `Warn ${report.below_threshold} parents?`,
              message: `Each student below ${report.threshold}% in ${report.batch.name} this month gets a WhatsApp warning to their guardian.`,
              confirmLabel: 'Send warnings',
              onConfirm: async () => reportSend(await coaching.lowAttendanceAlerts({ batch_id: state.reportBatch, month }), { what: 'warnings' }),
            }),
        },
        renderIcon('whatsapp', { size: 15 }),
        `Warn parents below ${report.threshold}%`,
      )
    : null;

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    toolbar,
    section(
      `${report.batch.name} · ${new Date(`${month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`,
      report.items.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'cb-table' },
              h('thead', {}, h('tr', {}, ...['Roll', 'Student', 'Present', 'Late', 'Absent', 'Excused', 'Attendance'].map((label) => h('th', {}, label)))),
              h(
                'tbody',
                {},
                ...report.items.map((row) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => calendarModal(row, month) },
                    h('td', { class: 'muted' }, row.roll_number || '—'),
                    h('td', {}, h('div', { class: 'cb-strong' }, fullName(row)), h('div', { class: 'muted cb-small' }, row.member_code)),
                    h('td', {}, row.present),
                    h('td', {}, row.late),
                    h('td', { class: row.absent ? 'cb-red' : '' }, row.absent),
                    h('td', {}, row.excused),
                    h('td', { style: 'min-width:150px' }, percentBar(row.percentage, { threshold: report.threshold })),
                  ),
                ),
              ),
            ),
          )
        : emptyState('Nobody is enrolled in this batch.', { icon: 'members' }),
      {
        icon: 'reports',
        subtitle: `${report.lectures} lecture${report.lectures === 1 ? '' : 's'} marked · ${report.below_threshold} below ${report.threshold}%`,
        actions: warn,
      },
    ),
  );
}

export async function renderAttendanceDesk({ setActions }) {
  const state = { pane: 'take', date: today(), batchId: null, subjectId: '' };
  const host = h('div', {});
  const tabsHost = h('div', {});

  const dateInput = dateField({
    name: 'date',
    value: state.date,
    max: today(),
    onchange: (e) => {
      const value = e?.target?.value ?? e;
      if (!value || value > today()) return;
      state.date = value;
      state.batchId = null;
      rerender();
    },
  });

  setActions(
    h('label', { class: 'toolbar-pair' }, h('span', { class: 'muted' }, 'Date'), dateInput),
    h('button', { class: 'btn ghost', onclick: () => openAlertSettings({ focus: 'attendance' }) }, renderIcon('settings', { size: 15 }), 'Alert settings'),
  );

  async function rerender() {
    fill(tabsHost, 
      pillTabs(
        [
          { key: 'take', label: 'Take attendance', icon: 'checkin' },
          { key: 'reports', label: 'Reports', icon: 'reports' },
        ],
        state.pane,
        (key) => {
          state.pane = key;
          rerender();
        },
      ),
    );
    fill(host, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading…')));
    try {
      const pane = state.pane === 'take' ? await takeAttendancePane(state, rerender) : await reportsPane(state, rerender);
      fill(host, pane);
    } catch (err) {
      fill(host, h('div', { class: 'card' }, h('p', { class: 'cb-red' }, err.message)));
    }
  }
  await rerender();
  return h('div', { class: 'cb-page' }, tabsHost, host);
}
