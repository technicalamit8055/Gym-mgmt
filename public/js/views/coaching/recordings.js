import { coaching } from '../../coachingApi.js';
import { classPlayer, clockTime } from '../../classPlayer.js';
import { streamSource } from '../../liveStream.js';
import { buildForm, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, toast } from '../../ui.js';
import { batchOptions, fill, section, selectControl } from './common.js';

/**
 * Recorded lectures: each batch's library of classes, by subject and
 * chapter, that students rewatch in My Batches. A live class files its own
 * recording when it ends (src/coaching/recordings.js); here staff add a
 * lecture recorded elsewhere by its link, rename one, put it in a chapter,
 * hide it from students, or delete it. Deleting never touches the video on
 * YouTube or Cloudflare.
 */

const SOURCE_LABEL = { youtube: 'YouTube', cloudflare: 'Private', server: 'Private · on this server', link: 'Link' };
const STATUS_BADGE = {
  processing: () => h('span', { class: 'badge amber' }, 'Processing'),
  failed: () => h('span', { class: 'badge red' }, 'No recording'),
};

/** The subjects of the batch's course, for a <select>. */
function subjectsOf(batchId, batches, courses) {
  const batch = batches.find((b) => String(b.id) === String(batchId));
  const course = courses.find((c) => c.id === batch?.course_id);
  return (course?.subjects ?? []).map((s) => ({ value: s.id, label: s.name }));
}

/** Keeps a form's subject list in step with its batch. */
function linkSubjectToBatch(form, batches, courses, chosen = '') {
  const batch = form.querySelector('[name="batch_id"]');
  const subject = form.querySelector('[name="subject_id"]');
  const refill = (value = '') => fill(subject, ...subjectsOf(batch.value, batches, courses).map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  batch?.addEventListener('change', () => refill());
  refill(chosen);
}

function chapterList(chapters) {
  return h('datalist', { id: 'cb-chapters' }, ...chapters.map((c) => h('option', { value: c })));
}

function openAdd({ batches, courses, chapters, batchId, onSaved }) {
  const form = buildForm(
    [
      { name: 'url', label: 'Lecture link', required: true, full: true, placeholder: 'https://youtu.be/… or a video file', hint: 'A YouTube video (unlisted is fine), a Vimeo video, or a link to an .mp4 or .m3u8.' },
      { name: 'title', label: 'Title', required: true, full: true, placeholder: 'Electrostatics — Coulomb’s law' },
      { name: 'batch_id', label: 'Batch', type: 'select', value: batchId || batches[0]?.id, options: batchOptions(batches) },
      { name: 'subject_id', label: 'Subject', type: 'select', options: [] },
      { name: 'chapter', label: 'Chapter', list: 'cb-chapters', placeholder: 'Electrostatics' },
      { name: 'recorded_on', label: 'Taught on', type: 'date' },
      { name: 'duration_min', label: 'Length (minutes)', type: 'number', min: 1, max: 600 },
    ],
    {
      submitLabel: 'Add lecture',
      onSubmit: async (values) => {
        await coaching.addRecording({
          url: values.url,
          title: values.title,
          batch_id: values.batch_id,
          subject_id: values.subject_id,
          chapter: values.chapter || undefined,
          recorded_on: values.recorded_on || undefined,
          duration_min: values.duration_min || undefined,
        });
        closeModal();
        toast('Added — students see it under the subject in My Batches');
        await onSaved?.();
      },
    },
  );
  form.append(chapterList(chapters));
  linkSubjectToBatch(form, batches, courses);
  openModal({ title: 'Add a recorded lecture', subtitle: 'A lecture recorded outside a live class.', icon: 'play', wide: true, body: form });
}

function openEdit(r, { batches, courses, chapters, onSaved }) {
  const form = buildForm(
    [
      { name: 'title', label: 'Title', required: true, full: true, value: r.title },
      { name: 'subject_id', label: 'Subject', type: 'select', options: subjectsOf(r.batch_id, batches, courses), value: r.subject_id },
      { name: 'chapter', label: 'Chapter', list: 'cb-chapters', value: r.chapter || '', placeholder: 'Electrostatics' },
      {
        name: 'published',
        label: 'Students',
        type: 'select',
        value: r.published ? '1' : '0',
        options: [{ value: '1', label: 'Can watch it' }, { value: '0', label: 'Hidden from students' }],
      },
    ],
    {
      onSubmit: async (values) => {
        await coaching.updateRecording(r.id, { title: values.title, subject_id: values.subject_id, chapter: values.chapter, published: values.published === '1' });
        closeModal();
        toast('Saved');
        await onSaved?.();
      },
    },
  );
  form.append(chapterList(chapters));
  openModal({ title: 'Edit lecture', subtitle: `${r.batch_name}${r.subject_name ? ` · ${r.subject_name}` : ''}`, icon: 'edit', body: form });
}

async function openPlayer(r) {
  const { play_url: url, chapters } = await coaching.playRecording(r.id);
  const src = streamSource(url);
  const stage = h('div', { class: 'cbl-stage' });
  let handle = null;
  if (src.kind === 'youtube' || src.kind === 'hls' || src.kind === 'video') {
    handle = classPlayer(src, { title: r.title, vod: true, chapters });
    stage.append(handle.el);
  } else if (src.kind === 'vimeo') {
    stage.append(h('iframe', { class: 'cbl-player', src: src.src, title: r.title, allow: 'autoplay; encrypted-media; fullscreen', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin' }));
  } else if (src.kind === 'link') {
    stage.append(h('div', { class: 'cbl-noplayer' }, renderIcon('link', { size: 28 }), h('strong', {}, `Plays on ${src.host}`), h('a', { class: 'btn primary', href: src.src, target: '_blank', rel: 'noopener' }, 'Open')));
  } else {
    stage.append(h('div', { class: 'cbl-noplayer' }, renderIcon('monitor', { size: 28 }), h('strong', {}, 'This recording cannot be played here'), h('span', {}, 'Private recordings need the platform’s Cloudflare Stream settings.')));
  }
  openModal({ title: r.title, subtitle: [r.batch_name, r.subject_name, r.faculty_name].filter(Boolean).join(' · '), icon: 'play', wide: true, body: stage, onClose: () => handle?.destroy() });
}

function recordingRow(r, ctx) {
  const reload = ctx.onSaved;
  return h(
    'div',
    { class: 'list-item cb-recording' },
    h('span', { class: 'cbb-thumb' }, renderIcon('play', { size: 16 }), r.duration_sec ? h('span', { class: 'cbb-thumb-time' }, clockTime(r.duration_sec)) : null),
    h(
      'div',
      { class: 'cb-grow' },
      r.chapter ? h('div', { class: 'cbb-eyebrow' }, r.chapter) : null,
      h('div', { class: 'cb-strong' }, r.title, ' ', STATUS_BADGE[r.status]?.() ?? null, r.published ? null : h('span', { class: 'badge grey' }, 'Hidden')),
      h('div', { class: 'muted cb-small' }, [r.batch_name, r.subject_name, r.faculty_name, date(r.recorded_on), SOURCE_LABEL[r.source], r.live_session_id ? 'from a live class' : null].filter(Boolean).join(' · ')),
      r.viewers ? h('div', { class: 'cb-small' }, `${r.viewers} student${r.viewers === 1 ? '' : 's'} watched · ${r.completed} finished`) : null,
    ),
    r.status === 'ready'
      ? h('button', { class: 'btn sm ghost', title: 'Play', 'aria-label': `Play ${r.title}`, onclick: () => openPlayer(r).catch((err) => toast(err.message, 'error')) }, renderIcon('play', { size: 15 }))
      : null,
    r.status === 'processing'
      ? h('button', {
        class: 'btn sm ghost',
        title: 'Check again',
        onclick: async () => {
          const fresh = await coaching.checkRecording(r.id).catch((err) => toast(err.message, 'error'));
          if (fresh) toast(fresh.status === 'ready' ? 'Ready — students can watch it now' : fresh.status === 'failed' ? 'No recording was found for this class' : 'Still processing');
          await reload();
        },
      }, renderIcon('refreshCw', { size: 15 }))
      : null,
    h('button', { class: 'btn sm ghost', title: 'Edit', 'aria-label': `Edit ${r.title}`, onclick: () => openEdit(r, ctx) }, renderIcon('edit', { size: 15 })),
    h('button', {
      class: 'btn sm ghost',
      title: 'Delete',
      'aria-label': `Delete ${r.title}`,
      onclick: () => confirmDialog({
        title: `Delete ${r.title}?`,
        message: 'Students will no longer see it in My Batches. The video itself stays on YouTube or Cloudflare.',
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          await coaching.deleteRecording(r.id);
          toast('Deleted');
          await reload();
        },
      }),
    }, renderIcon('trash', { size: 15 })),
  );
}

export async function renderRecordings({ setActions }) {
  const [{ items: batches }, { items: courses }] = await Promise.all([coaching.batches(), coaching.courses()]);
  const state = { batchId: '', subjectId: '', status: '' };
  const host = h('div', {});
  let chapters = [];

  async function paint() {
    const { items } = await coaching.recordings({ batch_id: state.batchId || undefined, subject_id: state.subjectId || undefined, status: state.status || undefined });
    chapters = [...new Set(items.map((r) => r.chapter).filter(Boolean))].sort();
    const ctx = { batches, courses, chapters, onSaved: paint };
    fill(host,
      h('div', { class: 'grid', style: 'gap:16px' },
        h('div', { class: 'toolbar' },
          selectControl(batchOptions(batches), state.batchId, (v) => {
            state.batchId = v;
            state.subjectId = '';
            paint();
          }, { placeholder: 'All batches' }),
          state.batchId
            ? selectControl(subjectsOf(state.batchId, batches, courses), state.subjectId, (v) => {
              state.subjectId = v;
              paint();
            }, { placeholder: 'All subjects' })
            : null,
          selectControl([{ value: 'ready', label: 'Ready' }, { value: 'processing', label: 'Processing' }, { value: 'failed', label: 'No recording' }], state.status, (v) => {
            state.status = v;
            paint();
          }, { placeholder: 'Any status' })),
        section(
          `${items.length} lecture${items.length === 1 ? '' : 's'}`,
          items.length
            ? h('div', {}, ...items.map((r) => recordingRow(r, ctx)))
            : emptyState('No recorded lectures yet. A live class adds its recording here when it ends.', { icon: 'play' }),
          { icon: 'play', subtitle: 'What students rewatch in My Batches, by subject and chapter' })));
  }

  setActions(h('button', { class: 'btn primary', onclick: () => openAdd({ batches, courses, chapters, batchId: state.batchId, onSaved: paint }) }, renderIcon('plus', { size: 16 }), 'Add lecture'));
  await paint();
  return h('div', { class: 'cb-page' }, host);
}
