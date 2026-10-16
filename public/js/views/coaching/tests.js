import { coaching } from '../../coachingApi.js';
import { buildForm, clear, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, stat, toast, today } from '../../ui.js';
import { batchOptions, fill, fullName, openAlertSettings, pct, reportSend, section, selectControl, TEST_TYPE_LABEL } from './common.js';

/**
 * Test series. The list is every test with how far its marks have got; a
 * test's own page is the marks sheet — one row per student, Tab/Enter down
 * the marks column, ranks and percentiles recomputed on every save — and
 * Publish, which puts the result in the student app and (optionally) sends
 * each parent the scorecard on WhatsApp.
 */

const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

function openTestForm({ test, batches, courses, onSaved }) {
  const editing = Boolean(test);
  const subjectsFor = (batchId) => courses.find((c) => c.id === batches.find((b) => b.id === Number(batchId))?.course_id)?.subjects || [];
  const firstBatch = test?.batch_id ?? batches[0]?.id;
  const form = buildForm(
    [
      { name: 'title', label: 'Test title', required: true, full: true, value: test?.title, placeholder: 'Weekly Test 3: Thermodynamics' },
      { name: 'batch_id', label: 'Batch', type: 'select', required: true, value: firstBatch, options: batchOptions(batches) },
      {
        name: 'subject_id',
        label: 'Subject',
        type: 'select',
        value: test?.subject_id ?? '',
        options: [{ value: '', label: 'All subjects (combined)' }, ...subjectsFor(firstBatch).map((s) => ({ value: s.id, label: s.name }))],
      },
      {
        name: 'test_type',
        label: 'Type',
        type: 'select',
        value: test?.test_type ?? 'weekly',
        options: Object.entries(TEST_TYPE_LABEL).map(([value, label]) => ({ value, label })),
      },
      { name: 'test_date', label: 'Date', type: 'date', required: true, value: test?.test_date || today() },
      { name: 'max_marks', label: 'Maximum marks', type: 'number', required: true, min: 1, value: test?.max_marks ?? 100 },
      { name: 'passing_marks', label: 'Passing marks', type: 'number', min: 0, value: test?.passing_marks ?? '' },
      { name: 'negative_marking', label: 'Negative marks per wrong answer', type: 'number', min: 0, step: '0.25', value: test?.negative_marking ?? 0, hint: 'Allows scores below zero' },
      { name: 'syllabus', label: 'Syllabus / chapters', type: 'textarea', full: true, value: test?.syllabus, placeholder: 'Electrostatics, Current Electricity' },
    ],
    {
      submitLabel: editing ? 'Save test' : 'Create test',
      onSubmit: async (values) => {
        const saved = editing ? await coaching.updateTest(test.id, values) : await coaching.createTest(values);
        closeModal();
        toast(editing ? 'Test saved' : 'Test created — enter the marks when it is done');
        await onSaved?.(saved);
      },
    },
  );
  form.querySelector('[name="batch_id"]').addEventListener('change', (e) => {
    clear(form.querySelector('[name="subject_id"]')).append(
      h('option', { value: '' }, 'All subjects (combined)'),
      ...subjectsFor(e.target.value).map((s) => h('option', { value: s.id }, s.name)),
    );
  });
  openModal({ title: editing ? `Edit ${test.title}` : 'New test', icon: 'trophy', wide: true, body: form });
}

export async function renderTests({ navigate, setActions }) {
  const [{ items: batches }, { items: courses }] = await Promise.all([coaching.batches(), coaching.courses()]);
  const state = { batchId: '', type: '' };
  const host = h('div', {});

  setActions(
    h('button', { class: 'btn ghost', onclick: () => openAlertSettings({ focus: 'tests' }) }, renderIcon('settings', { size: 15 }), 'Scorecard message'),
    h(
      'button',
      { class: 'btn primary', disabled: !batches.length, onclick: () => openTestForm({ batches, courses, onSaved: (t) => navigate(`/tests/${t.id}`) }) },
      renderIcon('plus', { size: 16 }),
      'New test',
    ),
  );

  async function paint() {
    const { items } = await coaching.tests({ batch_id: state.batchId || undefined, type: state.type || undefined });
    const upcoming = items.filter((t) => t.test_date >= today()).length;
    const unpublished = items.filter((t) => t.test_date < today() && !t.published_at).length;
    fill(host, 
      h(
        'div',
        { class: 'grid', style: 'gap:16px' },
        h(
          'div',
          { class: 'toolbar' },
          selectControl(batchOptions(batches), state.batchId, (v) => {
            state.batchId = v;
            paint();
          }, { placeholder: 'All batches' }),
          selectControl(Object.entries(TEST_TYPE_LABEL).map(([value, label]) => ({ value, label })), state.type, (v) => {
            state.type = v;
            paint();
          }, { placeholder: 'All types' }),
          h('span', { class: 'muted cb-small' }, `${upcoming} upcoming · ${unpublished} awaiting results`),
        ),
        h(
          'div',
          { class: 'card', style: 'padding:6px 6px 14px' },
          items.length
            ? h(
                'div',
                { class: 'table-wrap' },
                h(
                  'table',
                  { class: 'cb-table' },
                  h('thead', {}, h('tr', {}, ...['Date', 'Test', 'Batch', 'Marks in', 'Average', 'Highest', 'Status'].map((l) => h('th', {}, l)))),
                  h(
                    'tbody',
                    {},
                    ...items.map((t) =>
                      h(
                        'tr',
                        { class: 'clickable', onclick: () => navigate(`/tests/${t.id}`) },
                        h('td', { class: 'muted' }, date(t.test_date)),
                        h('td', {}, h('div', { class: 'cb-strong' }, t.title), h('div', { class: 'muted cb-small' }, `${TEST_TYPE_LABEL[t.test_type]}${t.subject_name ? ` · ${t.subject_name}` : ''} · out of ${fmt(t.max_marks)}`)),
                        h('td', {}, t.batch_name),
                        h('td', {}, `${t.marks_entered}/${t.enrolled}`),
                        h('td', {}, t.average === null ? '—' : `${fmt(t.average)} (${pct((t.average / t.max_marks) * 100)})`),
                        h('td', {}, fmt(t.highest)),
                        h(
                          'td',
                          {},
                          t.published_at
                            ? h('span', { class: 'badge dot green' }, 'Published')
                            : t.test_date > today()
                              ? h('span', { class: 'badge dot blue' }, 'Upcoming')
                              : h('span', { class: 'badge dot amber' }, t.marks_entered ? 'Draft' : 'Enter marks'),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : emptyState('No tests yet. Create one to start the test series.', { icon: 'trophy' }),
        ),
      ),
    );
  }
  await paint();
  return h('div', { class: 'cb-page' }, host);
}

/** A plain rank list in a new window, for the notice board. */
function printRankList(sheet, instituteName) {
  const ranked = sheet.items.filter((i) => i.entered).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const win = window.open('', '_blank', 'width=800,height=900');
  if (!win) return toast('Allow pop-ups to print the rank list', 'info');
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(sheet.test.title)} · Rank list</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;color:#111}h1{font-size:20px;margin:0}p{color:#555;margin:4px 0 18px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:7px 10px;border-bottom:1px solid #ddd;text-align:left}th{background:#f3f4f6}
.r{text-align:right}.abs{color:#999}</style></head><body>
<h1>${esc(instituteName)} — ${esc(sheet.test.title)}</h1>
<p>${esc(sheet.test.batch_name)}${sheet.test.subject_name ? ` · ${esc(sheet.test.subject_name)}` : ''} · ${esc(date(sheet.test.test_date))} · Max ${esc(fmt(sheet.test.max_marks))} ·
Appeared ${sheet.stats.appeared} · Average ${esc(fmt(sheet.stats.average))} · Highest ${esc(fmt(sheet.stats.highest))}</p>
<table><thead><tr><th>Rank</th><th>Roll</th><th>Student</th><th class="r">Marks</th><th class="r">%</th><th class="r">Percentile</th></tr></thead><tbody>
${ranked
  .map((r) =>
    r.is_absent
      ? `<tr class="abs"><td>—</td><td>${esc(r.roll_number)}</td><td>${esc(fullName(r))}</td><td class="r">Absent</td><td></td><td></td></tr>`
      : `<tr><td>${r.rank}</td><td>${esc(r.roll_number)}</td><td>${esc(fullName(r))}</td><td class="r">${esc(fmt(r.marks_obtained))}</td><td class="r">${esc(fmt((r.marks_obtained / sheet.test.max_marks) * 100))}</td><td class="r">${esc(fmt(r.percentile))}</td></tr>`,
  )
  .join('')}
</tbody></table><script>window.onload=()=>window.print()</script></body></html>`);
  win.document.close();
}

export async function renderTestDetail({ params, setTitle, setActions, navigate, reload }) {
  let sheet = await coaching.test(params[0]);
  const [{ items: batches }, { items: courses }] = await Promise.all([coaching.batches(), coaching.courses()]);
  const test = sheet.test;
  setTitle(test.title);
  const instituteName = document.querySelector('.brand-name')?.textContent || '';

  const entries = new Map(sheet.items.map((i) => [i.member_id, { marks: i.marks_obtained, absent: i.is_absent, remarks: i.remarks || '' }]));
  let dirty = false;
  const statsHost = h('div', {});
  const tableHost = h('div', {});
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, renderIcon('save', { size: 16 }), 'Save marks');

  const paintStats = () =>
    fill(statsHost, 
      h(
        'div',
        { class: 'grid cols-4' },
        stat('Appeared', `${sheet.stats.appeared}`, sheet.stats.absent ? `${sheet.stats.absent} absent` : `of ${test.enrolled} enrolled`, { icon: 'members' }),
        stat('Batch average', fmt(sheet.stats.average), sheet.stats.average_percentage !== null ? pct(sheet.stats.average_percentage) : 'No marks yet', { icon: 'barChart' }),
        stat('Highest', fmt(sheet.stats.highest), `out of ${fmt(test.max_marks)}`, { icon: 'trophy', accent: true }),
        stat(
          test.passing_marks ? 'Passed' : 'Lowest',
          test.passing_marks ? `${sheet.stats.passed ?? 0}/${sheet.stats.appeared}` : fmt(sheet.stats.lowest),
          test.passing_marks ? `Pass mark ${fmt(test.passing_marks)}` : 'Lowest score',
          { icon: 'target' },
        ),
      ),
    );

  const paintTable = () => {
    const inputs = [];
    const rows = sheet.items.map((student) => {
      const entry = entries.get(student.member_id);
      const marks = h('input', {
        type: 'number',
        class: 'cb-marks-input',
        step: '0.25',
        min: test.negative_marking > 0 ? -test.max_marks : 0,
        max: test.max_marks,
        value: entry.absent ? '' : entry.marks ?? '',
        disabled: entry.absent,
        'aria-label': `Marks for ${fullName(student)}`,
        oninput: (e) => {
          entry.marks = e.target.value === '' ? null : Number(e.target.value);
          dirty = true;
          e.target.classList.toggle('is-bad', e.target.value !== '' && (Number(e.target.value) > test.max_marks || Number(e.target.value) < (test.negative_marking > 0 ? -test.max_marks : 0)));
        },
        onkeydown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const next = inputs[inputs.indexOf(marks) + 1];
            if (next) next.focus();
            else saveBtn.focus();
          }
        },
      });
      inputs.push(marks);
      const absent = h('input', {
        type: 'checkbox',
        checked: entry.absent,
        'aria-label': `${fullName(student)} was absent`,
        onchange: (e) => {
          entry.absent = e.target.checked;
          marks.disabled = entry.absent;
          if (entry.absent) marks.value = '';
          dirty = true;
        },
      });
      const remarks = h('input', { type: 'text', class: 'cb-remarks-input', value: entry.remarks, placeholder: 'Remarks', oninput: (e) => { entry.remarks = e.target.value; dirty = true; } });
      return h(
        'tr',
        {},
        h('td', { class: 'cb-strong' }, student.rank ? `#${student.rank}` : '—'),
        h('td', { class: 'muted' }, student.roll_number || '—'),
        h('td', {}, h('div', { class: 'cb-strong' }, fullName(student)), h('div', { class: 'muted cb-small' }, student.member_code)),
        h('td', {}, marks, h('span', { class: 'muted cb-small' }, ` / ${fmt(test.max_marks)}`)),
        h('td', {}, h('label', { class: 'cb-check' }, absent, 'Absent')),
        h('td', { class: 'muted' }, student.percentile !== null ? fmt(student.percentile) : '—'),
        h('td', {}, remarks),
        h('td', {}, student.whatsapp_sent ? h('span', { class: 'badge green', title: 'Scorecard sent to the parent' }, renderIcon('whatsapp', { size: 12 })) : null),
      );
    });
    fill(tableHost, 
      sheet.items.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'cb-table cb-marks-table' },
              h('thead', {}, h('tr', {}, ...['Rank', 'Roll', 'Student', 'Marks', '', 'Percentile', 'Remarks', ''].map((l) => h('th', {}, l)))),
              h('tbody', {}, ...rows),
            ),
          )
        : emptyState('Nobody is enrolled in this batch.', { icon: 'members' }),
    );
  };

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const payload = [...entries].map(([member_id, e]) => ({ member_id, marks_obtained: e.absent ? null : e.marks, is_absent: e.absent, remarks: e.remarks || null }));
      sheet = await coaching.saveMarks(test.id, payload);
      for (const i of sheet.items) entries.set(i.member_id, { marks: i.marks_obtained, absent: i.is_absent, remarks: i.remarks || '' });
      dirty = false;
      toast('Marks saved — ranks updated');
      paintStats();
      paintTable();
    } catch (err) {
      toast(err.message || 'Could not save the marks', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  const publish = () => {
    if (dirty) return toast('Save the marks first', 'info');
    const body = h('div', {});
    const notify = h('input', { type: 'checkbox', checked: true });
    body.append(
      h('p', { class: 'muted' }, `The result shows in the student app. ${sheet.stats.appeared} students sat this test.`),
      h('label', { class: 'cb-check' }, notify, 'WhatsApp each parent their child’s scorecard (rank, highest and batch average)'),
    );
    const go = h('button', { class: 'btn primary' }, 'Publish result');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const res = await coaching.publishTest(test.id, notify.checked);
        closeModal();
        toast('Result published');
        if (notify.checked) reportSend(res.whatsapp, { what: 'scorecards', none: 'Every parent already has this scorecard' });
        await reload();
      } catch (err) {
        toast(err.message, 'error');
        go.disabled = false;
      }
    });
    openModal({ title: `Publish ${test.title}?`, icon: 'trophy', body, footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), go] });
  };

  setActions(
    h('button', { class: 'btn ghost', onclick: () => printRankList(sheet, instituteName) }, renderIcon('print', { size: 15 }), 'Rank list'),
    h('button', { class: 'btn ghost', onclick: () => openTestForm({ test, batches, courses, onSaved: reload }) }, 'Edit'),
    test.published_at
      ? h('button', { class: 'btn', onclick: publish }, renderIcon('send', { size: 15 }), 'Send new scorecards')
      : h('button', { class: 'btn primary', onclick: publish }, renderIcon('send', { size: 15 }), 'Publish'),
  );

  paintStats();
  paintTable();
  return h(
    'div',
    { class: 'cb-page grid', style: 'gap:16px' },
    h('a', { class: 'cb-back', href: '#/tests' }, renderIcon('arrowLeft', { size: 15 }), 'Tests & marks'),
    h(
      'div',
      { class: 'cb-test-head' },
      h('span', { class: 'badge violet' }, TEST_TYPE_LABEL[test.test_type]),
      h('span', { class: 'muted' }, `${test.batch_name}${test.subject_name ? ` · ${test.subject_name}` : ''} · ${date(test.test_date)} · out of ${fmt(test.max_marks)}${test.negative_marking ? ` · −${fmt(test.negative_marking)} per wrong answer` : ''}`),
      test.published_at ? h('span', { class: 'badge dot green' }, `Published ${date(test.published_at)}`) : h('span', { class: 'badge dot amber' }, 'Not published'),
    ),
    test.syllabus ? h('p', { class: 'muted cb-small' }, `Syllabus: ${test.syllabus}`) : null,
    statsHost,
    section('Marks', tableHost, {
      icon: 'edit',
      subtitle: 'Type a mark and press Enter to move down. Ranks update when you save.',
      actions: h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn sm ghost danger-text',
            onclick: () =>
              confirmDialog({
                title: `Delete ${test.title}?`,
                message: 'Its marks go with it. This cannot be undone.',
                confirmLabel: 'Delete test',
                danger: true,
                onConfirm: async () => {
                  await coaching.deleteTest(test.id);
                  toast('Test deleted');
                  navigate('/tests');
                },
              }),
          },
          'Delete',
        ),
        saveBtn,
      ),
    }),
  );
}
