import { coaching } from '../../coachingApi.js';
import { buildForm, clear, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, toast } from '../../ui.js';
import { batchOptions, fill, fullName, MATERIAL_KIND_LABEL, section, selectControl } from './common.js';

/**
 * Study material: notes, DPPs, PYQs, assignments and solutions, uploaded as
 * files (up to 15 MB) or added as links, for one batch, a whole course, or
 * the whole institute. Students see and download them in their app.
 * Assignments carry a due date and a submitted/pending register.
 */

const MAX_BYTES = 15 * 1024 * 1024;
const KIND_ICON = { notes: 'book', dpp: 'edit', pyq: 'history', assignment: 'checkCircle', syllabus: 'list', solution: 'verified' };

const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes ? `${Math.max(1, Math.round(bytes / 1024))} KB` : '');

function scopeFields(batches, courses) {
  return [
    {
      name: 'scope',
      label: 'Who sees it',
      type: 'select',
      full: true,
      options: [
        ...batches.map((b) => ({ value: `b:${b.id}`, label: `Batch · ${b.name}` })),
        ...courses.map((c) => ({ value: `c:${c.id}`, label: `Every batch of ${c.name}` })),
        { value: '', label: 'Every student in the institute' },
      ],
    },
    { name: 'kind', label: 'Type', type: 'select', value: 'notes', options: Object.entries(MATERIAL_KIND_LABEL).map(([value, label]) => ({ value, label })) },
    { name: 'due_date', label: 'Due date (assignments)', type: 'date' },
    { name: 'description', label: 'Description', type: 'textarea', full: true, placeholder: 'Chapter 4 — attempt Q1–Q25' },
  ];
}

const scopeParams = (scope) => (scope?.startsWith('b:') ? { batch_id: scope.slice(2) } : scope?.startsWith('c:') ? { course_id: scope.slice(2) } : {});

function openUpload({ batches, courses, onSaved }) {
  const file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt' });
  const form = buildForm([{ name: 'title', label: 'Title', required: true, full: true, placeholder: 'Electrostatics — chapter notes' }, ...scopeFields(batches, courses)], {
    submitLabel: 'Upload',
    onSubmit: async (values) => {
      const chosen = file.files[0];
      if (!chosen) throw new Error('Choose a file to upload');
      if (chosen.size > MAX_BYTES) throw new Error('That file is over 15 MB');
      await coaching.uploadMaterial(chosen, {
        title: values.title,
        kind: values.kind,
        due_date: values.due_date || undefined,
        description: values.description || undefined,
        ...scopeParams(values.scope),
      });
      closeModal();
      toast('Uploaded — students can download it from their app');
      await onSaved?.();
    },
  });
  form.querySelector('.form-grid').prepend(h('label', { class: 'field full' }, h('span', {}, 'File', h('span', { class: 'req' }, ' *')), file, h('div', { class: 'muted cb-small' }, 'PDF, image, Word, PowerPoint or Excel, up to 15 MB')));
  file.addEventListener('change', () => {
    const title = form.querySelector('[name="title"]');
    if (!title.value && file.files[0]) title.value = file.files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  });
  openModal({ title: 'Upload study material', icon: 'upload', wide: true, body: form });
}

function openLink({ batches, courses, onSaved }) {
  openModal({
    title: 'Add a link',
    subtitle: 'A Drive folder, a YouTube lecture, an online test — anything with a web address.',
    icon: 'link',
    wide: true,
    body: buildForm(
      [
        { name: 'title', label: 'Title', required: true, full: true, placeholder: 'JEE Main PYQs 2019–2025' },
        { name: 'file_url', label: 'Link', required: true, full: true, placeholder: 'https://…' },
        ...scopeFields(batches, courses),
      ],
      {
        submitLabel: 'Add link',
        onSubmit: async (values) => {
          await coaching.addMaterialLink({
            title: values.title,
            file_url: values.file_url,
            kind: values.kind,
            due_date: values.due_date || undefined,
            description: values.description || undefined,
            ...scopeParams(values.scope),
          });
          closeModal();
          toast('Link added');
          await onSaved?.();
        },
      },
    ),
  });
}

async function openSubmissions(material) {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  openModal({ title: `${material.title} · submissions`, icon: 'checkCircle', wide: true, body });
  const paint = async () => {
    const data = await coaching.submissions(material.id);
    fill(body, 
      h('p', { class: 'muted cb-small' }, `${data.submitted} of ${data.total} submitted${data.material.due_date ? ` · due ${date(data.material.due_date)}` : ''}`),
      ...data.items.map((s) =>
        h(
          'div',
          { class: 'list-item' },
          h('span', { class: 'cb-roll' }, s.roll_number || '—'),
          h('div', { class: 'cb-grow cb-strong' }, fullName(s)),
          s.status === 'pending'
            ? h('span', { class: 'badge grey' }, 'Pending')
            : h('span', { class: `badge ${s.status === 'late' ? 'amber' : 'green'}` }, `${s.status === 'late' ? 'Late' : 'Submitted'} ${date(s.submitted_on)}`),
          h(
            'button',
            {
              class: 'btn sm ghost',
              onclick: async () => {
                await coaching.setSubmission(material.id, { member_id: s.member_id, submitted: s.status === 'pending' });
                await paint();
              },
            },
            s.status === 'pending' ? 'Mark submitted' : 'Undo',
          ),
        ),
      ),
    );
  };
  await paint();
}

function materialRow(m, reload) {
  return h(
    'div',
    { class: 'list-item cb-material' },
    h('span', { class: `cb-kind is-${m.kind}` }, renderIcon(KIND_ICON[m.kind] || 'fileText', { size: 17 })),
    h(
      'div',
      { class: 'cb-grow' },
      h('div', { class: 'cb-strong' }, m.title),
      h(
        'div',
        { class: 'muted cb-small' },
        [MATERIAL_KIND_LABEL[m.kind], m.batch_name || (m.course_name ? `All of ${m.course_name}` : 'Whole institute'), m.subject_name, sizeLabel(m.file_size_bytes), date(m.created_at)].filter(Boolean).join(' · '),
      ),
      m.description ? h('div', { class: 'cb-small' }, m.description) : null,
      m.kind === 'assignment' && m.due_date ? h('span', { class: 'badge amber' }, `Due ${date(m.due_date)}`) : null,
    ),
    m.kind === 'assignment'
      ? h('button', { class: 'btn sm', onclick: () => openSubmissions(m) }, `${m.submissions ?? 0} submitted`)
      : null,
    m.has_file
      ? h(
          'button',
          {
            class: 'btn sm ghost',
            title: 'Download',
            'aria-label': `Download ${m.title}`,
            onclick: () => coaching.downloadMaterial(m.id).catch((err) => toast(err.message, 'error')),
          },
          renderIcon('download', { size: 15 }),
        )
      : h('a', { class: 'btn sm ghost', href: m.file_url, target: '_blank', rel: 'noopener', title: 'Open link', 'aria-label': `Open ${m.title}` }, renderIcon('link', { size: 15 })),
    h(
      'button',
      {
        class: 'btn sm ghost',
        title: 'Delete',
        'aria-label': `Delete ${m.title}`,
        onclick: () =>
          confirmDialog({
            title: `Delete ${m.title}?`,
            message: 'Students will no longer see it in their app.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
              await coaching.deleteMaterial(m.id);
              toast('Deleted');
              await reload();
            },
          }),
      },
      renderIcon('trash', { size: 15 }),
    ),
  );
}

export async function renderMaterials({ setActions }) {
  const [{ items: batches }, { items: courses }] = await Promise.all([coaching.batches(), coaching.courses()]);
  const state = { batchId: '', kind: '' };
  const host = h('div', {});

  async function paint() {
    const { items } = await coaching.materials({ batch_id: state.batchId || undefined, kind: state.kind || undefined });
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
          selectControl(Object.entries(MATERIAL_KIND_LABEL).map(([value, label]) => ({ value, label })), state.kind, (v) => {
            state.kind = v;
            paint();
          }, { placeholder: 'All types' }),
        ),
        section(
          `${items.length} item${items.length === 1 ? '' : 's'}`,
          items.length ? h('div', {}, ...items.map((m) => materialRow(m, paint))) : emptyState('Nothing uploaded yet.', { icon: 'fileText' }),
          { icon: 'fileText' },
        ),
      ),
    );
  }

  setActions(
    h('button', { class: 'btn ghost', onclick: () => openLink({ batches, courses, onSaved: paint }) }, renderIcon('link', { size: 15 }), 'Add link'),
    h('button', { class: 'btn primary', onclick: () => openUpload({ batches, courses, onSaved: paint }) }, renderIcon('upload', { size: 16 }), 'Upload'),
  );
  await paint();
  return h('div', { class: 'cb-page' }, host);
}
