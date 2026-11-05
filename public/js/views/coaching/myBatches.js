import { coaching } from '../../coachingApi.js';
import { classPlayer, clockTime } from '../../classPlayer.js';
import { streamSource } from '../../liveStream.js';
import { h, renderIcon, time, toast } from '../../ui.js';
import { fill, MATERIAL_KIND_LABEL, weekdayList } from './common.js';

/**
 * My Batches — the student app's library of everything taught to them, the
 * way PW and Unacademy lay it out: batch → subject → lecture.
 *
 *   My Batches  the `batches` tab: each batch the student is in (course,
 *               timing, teachers, how many lectures they have watched), a
 *               LIVE badge on one on air, and "Continue watching" for the
 *               lecture they last left part-way
 *   a batch     its subjects as cards (lectures, notes, progress), and the
 *               latest lectures
 *   a subject   Lectures — numbered, grouped by chapter when staff have
 *               filed them in chapters — and a tab per kind of material the
 *               subject has: Notes, DPPs, PYQs…
 *   a lecture   the recording in the class player (classPlayer.js, `vod`),
 *               opening where the student left it; the class's notes; and
 *               the next lecture of the subject
 *
 * The batch, subject and lecture are pushed screens (portal.js openScreen),
 * so the phone's back gesture walks back up the same way. Recordings come
 * from src/coaching/recordings.js: a live class files its own when it ends.
 */

const PROGRESS_FLOOR_S = 5;

const shortDay = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: ymd.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' }) : '');
const minutes = (seconds) => {
  if (!seconds) return null;
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.max(1, m)} min`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const watchedPct = (watched, total) => (total ? Math.round((watched / total) * 100) : 0);
const subjectInitials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function bar(percent, extra = '') {
  return h('div', { class: `cbb-progress${extra}` }, h('span', { style: `width:${Math.max(0, Math.min(100, percent))}%` }));
}

/** How far into a lecture a student is, as a fraction — done is the whole bar. */
const lectureFraction = (r) => (r.completed ? 1 : r.duration_sec ? Math.min(1, (r.position_sec || 0) / r.duration_sec) : 0);

export function myBatchesScreens({ openScreen, switchTab, registerCleanup }) {
  /* — the tab — */

  async function batchesTab() {
    const { items, continue_watching: resume } = await coaching.portal.myBatches();
    const head = h('div', { class: 'portal-page-head' }, h('h2', {}, 'My Batches'), h('p', {}, 'Your courses, recorded lectures and notes.'));
    if (!items.length) {
      return h('div', { class: 'portal-tab-body cbp-stack' }, head,
        h('div', { class: 'cbp-card cbl-idle' },
          h('div', { class: 'cbl-idle-icon' }, renderIcon('layers', { size: 32 })),
          h('h2', {}, 'You are not in a batch yet'),
          h('p', { class: 'muted' }, 'Once the institute puts you in a batch, its lectures and notes appear here.')));
    }
    return h('div', { class: 'portal-tab-body cbp-stack' },
      head,
      resume ? continueCard(resume) : null,
      ...items.map(batchCard));
  }

  function continueCard(r) {
    const left = r.duration_sec ? Math.max(0, r.duration_sec - (r.position_sec || 0)) : null;
    return h('button', { class: 'cbb-continue', type: 'button', onclick: () => openLecture(r.id) },
      h('span', { class: 'cbb-thumb' }, renderIcon('play', { size: 22 })),
      h('div', { class: 'cb-grow' },
        h('div', { class: 'cbb-eyebrow' }, 'Continue watching'),
        h('div', { class: 'cb-strong cbb-clip' }, r.title),
        h('div', { class: 'muted cb-small' }, [r.subject_name, r.batch_name, left !== null ? `${clockTime(left)} left` : null].filter(Boolean).join(' · ')),
        bar(lectureFraction(r) * 100, ' is-thin')),
      renderIcon('chevronRight', { size: 18 }));
  }

  function batchCard(b) {
    const percent = watchedPct(b.watched, b.lectures);
    const timing = b.start_time ? `${weekdayList(b.weekdays)} · ${time(b.start_time)}${b.end_time ? ` – ${time(b.end_time)}` : ''}` : null;
    return h('div', { class: 'cbb-batch' },
      h('button', { class: 'cbb-batch-top', type: 'button', onclick: () => openBatch(b) },
        h('div', { class: 'cbb-batch-chips' },
          b.target_exam ? h('span', { class: 'cbb-chip' }, b.target_exam) : null,
          b.academic_year ? h('span', { class: 'cbb-chip is-quiet' }, b.academic_year) : null,
          b.live_session_id ? h('span', { class: 'cbb-chip is-live' }, h('span', { class: 'cbl-dot' }), 'LIVE') : null),
        h('h3', { class: 'cbb-batch-name' }, b.name),
        h('div', { class: 'cbb-batch-course' }, b.course_name),
        timing ? h('div', { class: 'cbb-batch-meta' }, renderIcon('clock', { size: 14 }), timing) : null,
        b.teachers.length ? h('div', { class: 'cbb-batch-meta' }, renderIcon('users', { size: 14 }), b.teachers.join(', ')) : null),
      h('div', { class: 'cbb-batch-body' },
        h('div', { class: 'cbb-batch-stats' },
          h('div', {}, h('strong', {}, String(b.subjects)), plural(b.subjects, 'subject').replace(/^\d+ /, '')),
          h('div', {}, h('strong', {}, String(b.lectures)), plural(b.lectures, 'lecture').replace(/^\d+ /, '')),
          h('div', {}, h('strong', {}, `${percent}%`), 'watched')),
        bar(percent),
        h('div', { class: 'cbb-batch-actions' },
          b.live_session_id
            ? h('button', { class: 'btn', type: 'button', onclick: () => switchTab('live') }, h('span', { class: 'cbl-dot' }), 'Join live')
            : null,
          h('button', { class: 'btn primary', type: 'button', onclick: () => openBatch(b) }, 'Let’s study', renderIcon('chevronRight', { size: 16 })))));
  }

  /* — a batch — */

  function openBatch(b) {
    return openScreen({
      title: b.name,
      subtitle: b.course_name,
      render: async () => {
        const data = await coaching.portal.myBatch(b.id);
        return h('div', { class: 'cbp-stack' },
          data.live
            ? h('button', { class: 'cbl-home', type: 'button', onclick: () => switchTab('live') },
              h('span', { class: 'cbl-home-badge' }, h('span', { class: 'cbl-dot' }), 'LIVE'),
              h('div', { class: 'cb-grow' },
                h('div', { class: 'cb-strong' }, `${data.live.subject_name} is live now`),
                h('div', { class: 'cb-small cbl-home-sub' }, data.live.faculty_name || data.batch.name)),
              h('span', { class: 'cbl-home-join' }, 'Join', renderIcon('chevronRight', { size: 16 })))
            : null,
          h('div', {},
            h('h3', { class: 'cbb-section' }, 'Subjects'),
            data.subjects.length
              ? h('div', { class: 'cbb-subjects' }, ...data.subjects.map((s, i) => subjectCard(b, s, i)))
              : h('div', { class: 'cbp-card cbp-empty' }, 'No subjects in this course yet.')),
          data.recent.length
            ? h('div', {},
              h('h3', { class: 'cbb-section' }, 'Latest lectures'),
              h('div', { class: 'cbp-card cbb-list' }, ...data.recent.map((r) => lectureRow(r, { onBack: () => openBatch(b), showSubject: true }))))
            : null);
      },
    });
  }

  function subjectCard(b, s, index) {
    const percent = watchedPct(s.watched, s.lectures);
    return h('button', { class: `cbb-subject is-c${index % 6}`, type: 'button', onclick: () => openSubject(b, s) },
      h('span', { class: 'cbb-subject-icon' }, s.id ? subjectInitials(s.name) : renderIcon('layers', { size: 18 })),
      h('div', { class: 'cbb-subject-name' }, s.name),
      h('div', { class: 'muted cb-small' }, [plural(s.lectures, 'lecture'), s.materials ? `${s.materials} notes & sheets` : null].filter(Boolean).join(' · ')),
      s.teachers.length ? h('div', { class: 'cb-small cbb-clip' }, s.teachers.join(', ')) : null,
      s.lectures ? bar(percent, ' is-thin') : null);
  }

  /* — a subject — */

  function openSubject(b, s, tab = 'lectures') {
    return openScreen({
      title: s.name,
      subtitle: b.name,
      onBack: () => openBatch(b),
      render: async () => {
        const data = await coaching.portal.mySubject(b.id, s.id);
        const kinds = Object.keys(MATERIAL_KIND_LABEL).filter((k) => data.materials.some((m) => m.kind === k));
        const tabs = [{ key: 'lectures', label: 'Lectures', count: data.lectures.length }, ...kinds.map((k) => ({ key: k, label: MATERIAL_KIND_LABEL[k], count: data.materials.filter((m) => m.kind === k).length }))];
        let active = tabs.some((t) => t.key === tab) ? tab : 'lectures';
        const strip = h('div', { class: 'cbb-tabs', role: 'tablist' });
        const panel = h('div', {});
        const paint = () => {
          fill(strip, ...tabs.map((t) => h('button', {
            type: 'button',
            role: 'tab',
            class: `cbb-tab${t.key === active ? ' is-on' : ''}`,
            'aria-selected': String(t.key === active),
            onclick: () => {
              active = t.key;
              paint();
            },
          }, t.label, h('span', { class: 'cbb-tab-count' }, String(t.count)))));
          fill(panel, active === 'lectures'
            ? lectureList(data.lectures, { onBack: () => openSubject(b, s, 'lectures') })
            : h('div', { class: 'cbp-card cbb-list' }, ...data.materials.filter((m) => m.kind === active).map(materialRow)));
        };
        paint();
        return h('div', { class: 'cbp-stack' },
          data.subject.teachers.length ? h('div', { class: 'muted cb-small cbb-teachers' }, renderIcon('users', { size: 14 }), data.subject.teachers.join(', ')) : null,
          tabs.length > 1 ? strip : null,
          panel);
      },
    });
  }

  /**
   * A subject's lectures. Filed in chapters, they are grouped — the chapter
   * taught most recently first, its lectures in the order they were taught;
   * otherwise one list, newest first.
   */
  function lectureList(lectures, { onBack }) {
    if (!lectures.length) {
      return h('div', { class: 'cbp-card cbp-empty' }, 'No lectures yet. A class taught live appears here once it ends.');
    }
    if (!lectures.some((r) => r.chapter)) {
      return h('div', { class: 'cbp-card cbb-list' }, ...lectures.map((r) => lectureRow(r, { onBack })));
    }
    const groups = new Map();
    for (const r of lectures) {
      const key = r.chapter || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    // `lectures` arrive newest first, so each group's first is its latest.
    return h('div', { class: 'cbp-stack' }, ...[...groups].map(([chapter, rows], i) => {
      const done = rows.filter((r) => r.completed).length;
      const body = h('div', { class: 'cbb-list' }, ...[...rows].reverse().map((r) => lectureRow(r, { onBack })));
      const details = h('details', { class: 'cbp-card cbb-chapter', open: i === 0 ? '' : null },
        h('summary', {},
          h('div', { class: 'cb-grow' },
            h('div', { class: 'cb-strong' }, chapter || 'Other lectures'),
            h('div', { class: 'muted cb-small' }, `${plural(rows.length, 'lecture')} · ${done} watched`)),
          renderIcon('chevronDown', { size: 18 })),
        body);
      return details;
    }));
  }

  function lectureRow(r, { onBack = null, showSubject = false } = {}) {
    const processing = r.status !== 'ready';
    const fraction = lectureFraction(r);
    return h('button', {
      class: `cbb-lecture${processing ? ' is-processing' : ''}${r.completed ? ' is-done' : ''}`,
      type: 'button',
      disabled: processing,
      onclick: () => openLecture(r.id, { onBack }),
    },
    h('span', { class: 'cbb-thumb' },
      processing ? h('span', { class: 'cbp-spinner is-small' }) : renderIcon(r.completed ? 'check' : 'play', { size: 18 }),
      r.duration_sec ? h('span', { class: 'cbb-thumb-time' }, clockTime(r.duration_sec)) : null),
    h('div', { class: 'cb-grow' },
      h('div', { class: 'cbb-eyebrow' }, [r.number ? `Lecture ${r.number}` : null, showSubject ? r.subject_name : null].filter(Boolean).join(' · ') || 'Lecture'),
      h('div', { class: 'cb-strong cbb-clip' }, r.title),
      h('div', { class: 'muted cb-small' }, processing
        ? 'Processing — ready in a few minutes'
        : [shortDay(r.recorded_on), r.faculty_name, r.completed ? 'Watched' : fraction > 0 ? `${Math.round(fraction * 100)}% watched` : null].filter(Boolean).join(' · ')),
      !processing && fraction > 0 && !r.completed ? bar(fraction * 100, ' is-thin') : null));
  }

  function materialRow(m) {
    return h('div', { class: 'cbp-install' },
      h('span', { class: `cb-kind is-${m.kind}` }, renderIcon(m.has_file ? 'fileText' : 'link', { size: 17 })),
      h('div', { class: 'cb-grow' },
        h('div', { class: 'cb-strong' }, m.title),
        h('div', { class: 'muted cb-small' }, [MATERIAL_KIND_LABEL[m.kind], shortDay(String(m.created_at).slice(0, 10))].filter(Boolean).join(' · ')),
        m.description ? h('div', { class: 'cb-small' }, m.description) : null,
        m.kind === 'assignment'
          ? h('span', { class: `badge ${m.submission?.status === 'pending' ? 'amber' : 'green'}` }, m.submission?.status === 'pending' ? 'To submit' : 'Submitted')
          : null),
      m.has_file
        ? h('button', {
          class: 'btn sm',
          type: 'button',
          'aria-label': `Download ${m.title}`,
          onclick: () => coaching.portal.downloadMaterial(m.id).then((saved) => saved && toast(saved)).catch((err) => toast(err.message, 'error')),
        }, renderIcon('download', { size: 15 }))
        : h('a', { class: 'btn sm', href: m.file_url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${m.title}` }, renderIcon('link', { size: 15 })));
  }

  /* — a lecture — */

  function openLecture(id, { onBack = null } = {}) {
    return openScreen({
      title: 'Lecture',
      onBack,
      render: async () => {
        const r = await coaching.portal.recording(id);
        const stage = h('div', { class: 'cbl-stage' });
        const src = streamSource(r.play_url);
        let handle = null;
        if (src.kind === 'youtube' || src.kind === 'hls' || src.kind === 'video') {
          handle = classPlayer(src, {
            title: r.title,
            vod: true,
            chapters: r.chapters,
            // A finished lecture starts again from the top.
            startAt: r.completed ? 0 : r.position_sec,
            refreshSrc: r.private_stream ? async () => (await coaching.portal.recording(id)).play_url : null,
            onProgress: (position, duration) => {
              if (position < PROGRESS_FLOOR_S) return;
              coaching.portal.saveProgress(id, { position_sec: Math.round(position), duration_sec: Math.round(duration) || undefined }).catch(() => {});
            },
          });
          stage.append(handle.el);
          // The screen has no close of its own: the player stops when it is
          // taken off the page, whatever took it (back, a tab, another lecture).
          const watch = setInterval(() => {
            if (stage.isConnected) return;
            clearInterval(watch);
            handle.destroy();
          }, 500);
          registerCleanup(() => {
            clearInterval(watch);
            handle.destroy();
          });
        } else if (src.kind === 'vimeo') {
          stage.append(h('iframe', { class: 'cbl-player', src: src.src, title: r.title, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin' }));
        } else if (src.kind === 'link') {
          stage.append(h('div', { class: 'cbl-noplayer' },
            renderIcon('play', { size: 30 }),
            h('strong', {}, `This lecture plays on ${src.host}.`),
            h('a', { class: 'btn primary', href: src.src, target: '_blank', rel: 'noopener' }, renderIcon('link', { size: 16 }), 'Open the lecture')));
        } else {
          stage.append(h('div', { class: 'cbl-noplayer' },
            renderIcon('monitor', { size: 30 }),
            h('strong', {}, 'This lecture cannot be played right now'),
            h('span', {}, 'Ask the institute to check its video settings.')));
        }

        return h('div', { class: 'cbp-stack' },
          stage,
          h('div', {},
            h('div', { class: 'cbb-eyebrow' }, [`Lecture ${r.number}`, r.subject_name, r.chapter].filter(Boolean).join(' · ')),
            h('h2', { class: 'cbb-lecture-title' }, r.title),
            h('div', { class: 'muted cb-small' }, [r.faculty_name, shortDay(r.recorded_on), minutes(r.duration_sec), r.batch_name].filter(Boolean).join(' · '))),
          handle && r.chapters.length
            ? h('div', { class: 'cbp-card' },
              h('h3', { class: 'cbp-title', style: 'margin-bottom:6px' }, 'Topics'),
              ...r.chapters.map((c) => h('button', {
                class: 'cbb-topic',
                type: 'button',
                onclick: () => {
                  handle.seekTo(c.offset_sec);
                  stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                },
              }, h('span', { class: 'cbb-topic-at' }, clockTime(c.offset_sec)), h('span', { class: 'cb-grow' }, c.label), renderIcon('play', { size: 14 }))))
            : null,
          r.notes.length
            ? h('div', { class: 'cbp-card' },
              h('h3', { class: 'cbp-title', style: 'margin-bottom:6px' }, 'Class notes'),
              ...r.notes.map(materialRow))
            : null,
          r.next
            ? h('div', {},
              h('h3', { class: 'cbb-section' }, 'Up next'),
              h('div', { class: 'cbp-card cbb-list' }, lectureRow({ ...r.next, number: r.number + 1 }, { onBack })))
            : null);
      },
    });
  }

  return { batchesTab, openLecture };
}
