import { append, clear, h, renderIcon } from './ui.js';
import { landscape, unlockOrientation } from './orientation.js';

/**
 * The class's own player, for the student's live classroom
 * (views/coaching/liveClass.js) and for rewatching a recorded lecture
 * (views/coaching/myBatches.js): one look and one set of controls — play,
 * 10 seconds back and forward (or a double tap on either half of the
 * picture), sound and its level, back to live, quality — whatever carries
 * the class. A tap anywhere on the picture brings the controls up; they fade
 * after a few seconds of playing untouched.
 *
 * Live, "back" goes into what the stream keeps behind the edge (YouTube's
 * DVR, the HLS playlist's window), and "forward" stops at live.
 *
 *   hls      a private class (Cloudflare Stream, src/coaching/privateStream.js),
 *            through hls.js where the browser has Media Source Extensions,
 *            which is what makes the quality menu (Auto, 1080p, 720p…)
 *            possible; the choice is remembered on the device. Where hls.js
 *            cannot run (an old iPhone), the browser's own HLS, on Auto.
 *   video    a direct file, in the same <video>
 *   youtube  YouTube's player with its own controls off and every tap caught
 *            by a cover laid over it, so nothing in it opens YouTube. Its title
 *            bar and logo sit in strips above and below the picture that are
 *            cropped off. YouTube picks the quality itself — its embed API no
 *            longer lets a page choose — so there is no menu for it.
 *            YouTube's API policies forbid covering its player; see
 *            docs/PRIVATE_STREAMING.md.
 *
 * A stream that is not there yet — the board has not started sending, or
 * the channel is not live — shows "Waiting for the class video" and is
 * tried again by itself. `refreshSrc`, if given, is asked for a fresh link
 * before each retry: a private stream's link is signed, and expires.
 *
 * `vod` is a recorded lecture instead: a seek bar with the time, 10 seconds
 * back and forward (or a double tap on either half of the picture), a speed
 * menu and full screen, and no "Go live". It starts at `startAt` seconds,
 * and `onProgress(position, duration)` hears where the student is every few
 * seconds while it plays, when it pauses or ends, and when it is closed.
 * `chapters` ([{ offset_sec, label }], the topics its teacher marked on the
 * board) are ticks on the seek bar, the current one's name beside the time,
 * and a menu to jump between them.
 *
 * @returns {{ el: HTMLElement, seekTo(seconds: number): void, destroy(): void }}
 */

const IDLE_MS = 3000;
const BEHIND_S = 15; // further than this from live, offer "Go live"
const SKIP_S = 10;
const REPORT_MS = 10_000;
const DOUBLE_TAP_MS = 300;
const QUALITY_KEY = 'cbp-quality';
const SPEED_KEY = 'cbp-speed';
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const WAITING = 'Waiting for the class video…';
const NOT_READY = 'This lecture is not ready to play yet. Trying again…';

let hlsLoad;
/** hls.js, fetched once, on the first private class; null if it would not load. */
function loadHls() {
  hlsLoad ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/js/vendor/hls.light.min.js';
    script.onload = () => resolve(window.Hls ?? null);
    script.onerror = () => {
      hlsLoad = undefined;
      script.remove();
      resolve(null);
    };
    document.head.append(script);
  });
  return hlsLoad;
}

let ytLoad;
/** YouTube's IFrame API, fetched once; null if it would not load. */
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytLoad ??= new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      ytLoad = undefined;
      script.remove();
      resolve(null);
    };
    document.head.append(script);
  });
  return ytLoad;
}

const remembered = (key = QUALITY_KEY) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (label, key = QUALITY_KEY) => {
  try {
    localStorage.setItem(key, label);
  } catch {
    // private mode: the choice lasts this class only
  }
};

/** 1:02:09, or 4:05 under the hour. */
export function clockTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hours ? 2 : 1, '0');
  return `${hours ? `${hours}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

/** The chapter playing at `seconds`: the last one started by then. */
export function chapterAt(chapters, seconds) {
  let current = null;
  for (const c of chapters) {
    if (c.offset_sec > seconds + 0.5) break;
    current = c;
  }
  return current;
}

export function classPlayer(source, { title = 'Live class', refreshSrc = null, vod = false, startAt = 0, onProgress = null, chapters = [] } = {}) {
  const savedSpeed = Number(remembered(SPEED_KEY));
  const st = {
    playing: false,
    buffering: true,
    waiting: null,
    ended: false,
    muted: false,
    soundBlocked: false,
    behind: false,
    qualities: null, // [{ index, label }], best first; null when the engine has no choice to offer
    quality: -1, // -1 is Auto
    autoLabel: null,
    rate: vod && SPEEDS.includes(savedSpeed) ? savedSpeed : 1,
    menu: false, // false, true (settings) or 'chapters'
    idle: false,
  };
  const media = h('div', { class: 'cbp-media' });
  const shield = h('div', { class: 'cbp-shield' });
  const cover = h('div', { class: 'cbp-cover' });
  const menu = h('div', { class: 'cbp-menu', role: 'menu' });
  const bar = h('div', { class: 'cbp-bar' });
  const flash = h('div', { class: 'cbp-flash', 'aria-hidden': 'true' });
  const el = h('div', { class: `cbp is-${source.kind}${vod ? ' is-vod' : ''}` }, media, shield, flash, cover, menu, bar);
  let engine = null;
  let destroyed = false;
  let idleTimer = null;
  let remountTimer = null;
  let resumeAt = vod ? Math.max(0, Math.floor(startAt || 0)) : 0;

  // A recorded lecture's seek bar and clock, kept across repaints so a drag
  // is not cut short by the next one.
  const seek = h('input', { class: 'cbp-seek', type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Seek' });
  const clockLabel = h('span', { class: 'cbp-time' });
  let dragging = false;
  // Ticks over the seek bar, where each topic starts; laid out once the length is known.
  const marks = vod ? [...chapters].filter((c) => c.offset_sec >= 0 && c.label).sort((a, b) => a.offset_sec - b.offset_sec) : [];
  const ticks = h('div', { class: 'cbp-ticks', 'aria-hidden': 'true' });
  const chapterLabel = h('span', { class: 'cbp-chapter-name' });
  let ticksFor = 0;

  function showChapter(seconds) {
    if (marks.length) chapterLabel.textContent = chapterAt(marks, seconds)?.label ?? 'Start';
  }

  function layTicks(duration) {
    if (!marks.length || Math.floor(duration) === ticksFor) return;
    ticksFor = Math.floor(duration);
    clear(ticks);
    for (const c of marks) {
      if (c.offset_sec <= 0 || c.offset_sec >= duration) continue;
      ticks.append(h('span', { class: 'cbp-tick', style: `left:${(c.offset_sec / duration) * 100}%` }));
    }
  }

  function jumpTo(seconds) {
    if (!engine) return;
    engine.seek(seconds);
    if (st.ended) set({ ended: false });
    engine.play();
    showTime();
    wake();
  }

  function set(patch) {
    if (Object.entries(patch).every(([k, v]) => st[k] === v)) return;
    Object.assign(st, patch);
    paint();
  }

  /* — the controls — */

  function wake() {
    clearTimeout(idleTimer);
    set({ idle: false });
    idleTimer = setTimeout(() => st.playing && !st.menu && !dragging && set({ idle: true }), IDLE_MS);
  }

  function skip(by) {
    if (!engine) return;
    const [from, to] = engine.span();
    engine.seek(Math.max(from, Math.min(to, engine.position() + by)));
    if (st.ended) set({ ended: false });
    showTime();
    flash.textContent = by < 0 ? `« ${SKIP_S}s` : `${SKIP_S}s »`;
    flash.className = `cbp-flash is-on ${by < 0 ? 'is-left' : 'is-right'}`;
    setTimeout(() => { flash.className = 'cbp-flash'; }, 450);
  }

  let lastTap = { at: 0, side: null };
  shield.addEventListener('click', (event) => {
    if (st.menu) return set({ menu: false });
    // A double tap on either half of the picture skips, as phone players do.
    const box = shield.getBoundingClientRect();
    const side = event.clientX - box.left < box.width / 2 ? 'left' : 'right';
    const now = Date.now();
    if (now - lastTap.at < DOUBLE_TAP_MS && lastTap.side === side) {
      lastTap = { at: 0, side: null };
      skip(side === 'left' ? -SKIP_S : SKIP_S);
    } else lastTap = { at: now, side };
    // Any tap brings every control up; they fade again by themselves.
    return wake();
  });
  // A real mouse only: a tap on a phone also fires a mousemove.
  el.addEventListener('pointermove', (event) => event.pointerType === 'mouse' && wake());

  // The sound level, kept across repaints like the seek bar.
  let volume = 1;
  const volumeBar = h('input', { class: 'cbp-seek cbp-volume', type: 'range', min: '0', max: '100', step: '1', value: '100', 'aria-label': 'Volume' });
  function showVolume() {
    const level = st.muted ? 0 : Math.round(volume * 100);
    volumeBar.value = String(level);
    volumeBar.style.setProperty('--p', `${level}%`);
  }
  for (const type of ['click', 'pointerdown']) volumeBar.addEventListener(type, (event) => event.stopPropagation());
  volumeBar.addEventListener('input', () => {
    volume = Number(volumeBar.value) / 100;
    engine?.setVolume(volume);
    engine?.mute(volume === 0);
    set({ soundBlocked: false });
    showVolume();
    wake();
  });
  function toggleMute() {
    // Sound back on at no volume would still be silent.
    if (st.muted && volume === 0) {
      volume = 0.5;
      engine?.setVolume(volume);
    }
    engine?.mute(!st.muted);
    set({ soundBlocked: false });
  }
  // No "Copy video URL", "Save video as" or YouTube's own menu.
  el.addEventListener('contextmenu', (event) => event.preventDefault());

  for (const type of ['click', 'pointerdown']) seek.addEventListener(type, (event) => event.stopPropagation());
  seek.addEventListener('input', () => {
    dragging = true;
    clockLabel.textContent = `${clockTime(Number(seek.value))} / ${clockTime(Number(seek.max))}`;
    seek.style.setProperty('--p', `${seek.max > 0 ? (seek.value / seek.max) * 100 : 0}%`);
    // Dragging names the topic it would land in.
    showChapter(Number(seek.value));
    wake();
  });
  seek.addEventListener('change', () => {
    dragging = false;
    engine?.seek(Number(seek.value));
    if (st.ended) set({ ended: false });
    wake();
  });

  const button = (label, icon, onclick, extra = {}) => h('button', { class: 'cbp-btn', type: 'button', 'aria-label': label, onclick: (event) => { event.stopPropagation(); onclick(); wake(); }, ...extra }, renderIcon(icon, { size: 20 }));
  const skipButton = (by) => h('button', {
    class: 'cbp-btn cbp-skip',
    type: 'button',
    'aria-label': by < 0 ? `Back ${SKIP_S} seconds` : `Forward ${SKIP_S} seconds`,
    onclick: (event) => {
      event.stopPropagation();
      skip(by);
      wake();
    },
  }, by < 0 ? `−${SKIP_S}` : `+${SKIP_S}`);

  function qualityLabel() {
    if (st.quality === -1) return st.autoLabel ? `Auto · ${st.autoLabel}` : 'Auto';
    return st.qualities?.find((q) => q.index === st.quality)?.label ?? 'Auto';
  }

  function settingsLabel() {
    const parts = [];
    if (vod && st.rate !== 1) parts.push(`${st.rate}×`);
    if (st.qualities?.length > 1) parts.push(qualityLabel());
    return parts.join(' · ');
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      unlockOrientation();
      return document.exitFullscreen().catch(() => {});
    }
    if (el.requestFullscreen) {
      await el.requestFullscreen().catch(() => {});
      // A lecture is wide: turn the phone with it.
      return landscape();
    }
    // iOS only lets the video itself go full screen.
    return el.querySelector('video')?.webkitEnterFullscreen?.();
  }
  const onFullscreen = () => paint();
  document.addEventListener('fullscreenchange', onFullscreen);

  function paint() {
    el.classList.toggle('is-idle', st.idle && st.playing && !st.menu);
    el.classList.toggle('is-playing', st.playing);

    // Over the picture: why it is not playing, or nothing at all.
    clear(cover);
    cover.className = 'cbp-cover';
    if (st.waiting) {
      cover.classList.add('is-solid');
      append(cover, [h('div', { class: 'cbp-spinner' }), h('strong', {}, st.waiting)]);
    } else if (st.ended && vod) {
      cover.classList.add('is-solid');
      append(cover, [
        renderIcon('checkCircle', { size: 30 }),
        h('strong', {}, 'You finished this lecture'),
        h('button', { class: 'cbp-replay', type: 'button', onclick: () => { engine?.seek(0); engine?.play(); set({ ended: false }); wake(); } }, renderIcon('refreshCw', { size: 16 }), 'Watch again'),
      ]);
    } else if (st.ended) {
      cover.classList.add('is-solid');
      append(cover, [renderIcon('checkCircle', { size: 30 }), h('strong', {}, 'The class video has ended')]);
    } else if (!st.playing && !st.buffering) {
      // Paused, or the browser would not start it: the play button — and,
      // on YouTube, solid, over YouTube's own pause screen and its links.
      cover.classList.add(source.kind === 'youtube' ? 'is-solid' : 'is-dim');
      cover.append(h('button', { class: 'cbp-play', type: 'button', 'aria-label': 'Play', onclick: () => { engine?.play(); wake(); } }, renderIcon('play', { size: 34 })));
    } else if (st.buffering) {
      cover.append(h('div', { class: 'cbp-spinner' }));
    }
    if (st.soundBlocked && st.playing) {
      cover.append(h('button', {
        class: 'cbp-unmute',
        type: 'button',
        onclick: () => {
          engine?.mute(false);
          set({ soundBlocked: false });
        },
      }, renderIcon('volumeX', { size: 18 }), 'Tap for sound'));
    }

    clear(bar);
    // Nothing to control while there is nothing to play.
    if (st.waiting || (st.ended && !vod)) {
      menu.hidden = true;
      return;
    }
    const settings = vod || st.qualities?.length > 1
      ? h('button', {
        class: `cbp-quality${st.menu ? ' is-on' : ''}`,
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': String(st.menu),
        'aria-label': 'Playback settings',
        onclick: (event) => {
          event.stopPropagation();
          set({ menu: st.menu === true ? false : true });
          wake();
        },
      }, renderIcon('settings', { size: 18 }), settingsLabel() || null)
      : null;
    // Play, ±10s and the sound, the same live or recorded.
    showVolume();
    const transport = [
      button(st.playing ? 'Pause' : 'Play', st.playing ? 'pause' : 'play', () => (st.playing ? engine?.pause() : engine?.play())),
      skipButton(-SKIP_S),
      skipButton(SKIP_S),
      button(st.muted ? 'Sound on' : 'Mute', st.muted ? 'volumeX' : 'volume', toggleMute),
      volumeBar,
    ];
    if (vod) {
      append(bar, [
        h('div', { class: 'cbp-seekrow' }, seek, ticks),
        ...transport,
        clockLabel,
        marks.length
          ? h('button', {
            class: `cbp-chapter${st.menu === 'chapters' ? ' is-on' : ''}`,
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': String(st.menu === 'chapters'),
            'aria-label': 'Topics in this lecture',
            onclick: (event) => {
              event.stopPropagation();
              set({ menu: st.menu === 'chapters' ? false : 'chapters' });
              wake();
            },
          }, renderIcon('list', { size: 16 }), chapterLabel)
          : null,
        h('span', { class: 'cb-grow' }),
        settings,
        button(document.fullscreenElement ? 'Exit full screen' : 'Full screen', document.fullscreenElement ? 'minimize' : 'maximize', toggleFullscreen),
      ]);
      showTime();
    } else {
      append(bar, [
        ...transport,
        st.behind
          ? h('button', { class: 'cbp-live', type: 'button', onclick: (event) => { event.stopPropagation(); engine?.goLive(); wake(); } }, h('span', { class: 'cbp-live-dot' }), 'Go live')
          : null,
        h('span', { class: 'cb-grow' }),
        settings,
      ]);
    }

    menu.hidden = !st.menu;
    if (st.menu) paintMenu();
  }

  function paintMenu() {
    const item = (on, label, choose) => h('button', {
      class: `cbp-menu-item${on ? ' is-on' : ''}`,
      type: 'button',
      role: 'menuitemradio',
      'aria-checked': String(on),
      onclick: (event) => {
        event.stopPropagation();
        choose();
        set({ menu: false });
        wake();
      },
    }, h('span', { class: 'cb-grow' }, label), on ? renderIcon('check', { size: 16 }) : null);
    const quality = (index, label) => item(st.quality === index, label, () => {
      engine?.setQuality(index);
      remember(index === -1 ? 'auto' : label);
      st.quality = index;
    });
    clear(menu);
    if (st.menu === 'chapters') {
      const current = chapterAt(marks, engine?.position() ?? 0);
      append(menu, [
        h('div', { class: 'cbp-menu-head' }, 'Topics'),
        ...marks.map((c) => item(c === current, h('span', {}, h('span', { class: 'cbp-menu-at' }, clockTime(c.offset_sec)), c.label), () => jumpTo(c.offset_sec))),
      ]);
      return;
    }
    append(menu, [
      ...(vod
        ? [
          h('div', { class: 'cbp-menu-head' }, 'Speed'),
          ...SPEEDS.map((rate) => item(st.rate === rate, rate === 1 ? 'Normal' : `${rate}×`, () => {
            engine?.setRate(rate);
            remember(String(rate), SPEED_KEY);
            st.rate = rate;
          })),
        ]
        : []),
      ...(st.qualities?.length > 1
        ? [
          h('div', { class: 'cbp-menu-head' }, 'Quality'),
          quality(-1, st.autoLabel ? `Auto (${st.autoLabel})` : 'Auto'),
          ...st.qualities.map((q) => quality(q.index, q.label)),
        ]
        : []),
    ]);
  }

  /** The seek bar and clock, from where the engine is. */
  function showTime() {
    if (!vod || !engine || dragging) return;
    const position = engine.position();
    const duration = engine.duration();
    seek.max = String(Math.max(0, Math.floor(duration)));
    seek.value = String(Math.floor(position));
    seek.disabled = !(duration > 0);
    seek.style.setProperty('--p', `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%`);
    clockLabel.textContent = duration > 0 ? `${clockTime(position)} / ${clockTime(duration)}` : clockTime(position);
    if (duration > 0) layTicks(duration);
    showChapter(position);
  }

  /* — where the student is, for "Continue watching" — */

  let reported = { at: 0, position: -1 };
  function report(force = false) {
    if (!vod || !onProgress || !engine) return;
    const position = engine.position();
    const duration = engine.duration();
    if (!(position > 0) && !st.ended) return;
    const at = Date.now();
    if (!force && (at - reported.at < REPORT_MS || Math.abs(position - reported.position) < 1)) return;
    reported = { at, position };
    resumeAt = position;
    onProgress(st.ended && duration > 0 ? duration : position, duration > 0 ? duration : 0);
  }

  /* — engines: each plays one kind of source and reports through set() — */

  /** HLS (and plain files) in our own <video>. */
  function videoEngine() {
    const video = h('video', { class: 'cbp-video', playsinline: true, 'webkit-playsinline': '', autoplay: true, controlslist: 'nodownload noplaybackrate', disablepictureinpicture: true });
    media.append(video);
    let src = source.src;
    let hls = null;
    let retry = null;

    video.addEventListener('playing', () => set({ playing: true, buffering: false, waiting: null, ended: false }));
    video.addEventListener('pause', () => {
      set({ playing: false, buffering: false });
      report(true);
    });
    video.addEventListener('waiting', () => set({ buffering: true }));
    video.addEventListener('volumechange', () => {
      volume = video.volume;
      set({ muted: video.muted });
    });
    video.addEventListener('ended', () => {
      set({ playing: false, ended: true });
      report(true);
    });
    video.addEventListener('ratechange', () => set({ rate: video.playbackRate }));
    // A recorded lecture opens where the student left it, at their speed.
    video.addEventListener('loadedmetadata', () => {
      if (!vod) return;
      video.playbackRate = st.rate;
      if (resumeAt > 0 && video.duration > resumeAt + 5 && Math.abs(video.currentTime - resumeAt) > 2) video.currentTime = resumeAt;
      showTime();
    });

    // With sound if the browser allows it; otherwise muted, with "Tap for sound".
    const start = () => video.play().catch(() => {
      video.muted = true;
      set({ soundBlocked: true });
      return video.play().catch(() => set({ buffering: false }));
    });

    const notThere = vod ? NOT_READY : WAITING;
    const again = () => {
      clearTimeout(retry);
      retry = setTimeout(async () => {
        src = (refreshSrc && (await refreshSrc().catch(() => null))) || src;
        if (destroyed) return;
        if (hls) hls.loadSource(src);
        else {
          video.src = src;
          start();
        }
      }, 5000);
    };

    (async () => {
      const Hls = source.kind === 'hls' ? await loadHls() : null;
      if (destroyed) return;
      if (Hls?.isSupported()) {
        hls = new Hls(vod ? { startPosition: resumeAt > 0 ? resumeAt : -1, backBufferLength: 90 } : { lowLatencyMode: true, backBufferLength: 60 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // One choice per height, its best bitrate; the menu lists them best first.
          const byHeight = new Map();
          hls.levels.forEach((level, index) => {
            if (!level.height) return;
            const seen = byHeight.get(level.height);
            if (seen === undefined || level.bitrate > hls.levels[seen].bitrate) byHeight.set(level.height, index);
          });
          const qualities = [...byHeight].sort((a, b) => b[0] - a[0]).map(([height, index]) => ({ index, label: `${height}p` }));
          const kept = qualities.find((q) => q.label === remembered());
          if (kept) hls.currentLevel = kept.index;
          set({ qualities, quality: kept ? kept.index : -1, waiting: null });
          start();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, { level }) => {
          const height = hls.levels[level]?.height;
          set({ autoLabel: height ? `${height}p` : null });
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
          // Not on air yet, a dropped connection, or the signed link ran out.
          set({ waiting: notThere, playing: false });
          return again();
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (source.kind === 'video' || video.canPlayType('application/vnd.apple.mpegurl')) {
        video.addEventListener('error', () => {
          set({ waiting: notThere, playing: false });
          again();
        });
        video.src = src;
        start();
      } else {
        set({ waiting: 'This browser cannot play the class. Update it, or open the app in Chrome.', buffering: false });
      }
    })();

    const isLive = () => (hls ? Boolean((hls.latestLevelDetails ?? hls.levels[hls.currentLevel]?.details)?.live) : video.duration === Infinity);
    return {
      play: () => start(),
      pause: () => video.pause(),
      mute: (on) => { video.muted = on; },
      setVolume: (level) => { video.volume = level; },
      setQuality: (index) => { if (hls) hls.currentLevel = index; },
      setRate: (rate) => { video.playbackRate = rate; },
      seek: (to) => { video.currentTime = to; },
      position: () => video.currentTime || 0,
      duration: () => (Number.isFinite(video.duration) ? video.duration : 0),
      /** [earliest, latest] a skip may land on: live, the stream's window up to the live edge. */
      span() {
        const s = video.seekable;
        if (!s.length) return [0, vod ? Infinity : video.currentTime || 0];
        const end = s.end(s.length - 1);
        return [s.start(0), (isLive() && hls?.liveSyncPosition) || end - 1];
      },
      goLive() {
        if (hls?.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
        else if (video.seekable.length) video.currentTime = video.seekable.end(video.seekable.length - 1) - 1;
        start();
      },
      behind() {
        if (!isLive() || !video.currentTime) return false;
        const edge = hls ? hls.liveSyncPosition : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.currentTime;
        return edge - video.currentTime > BEHIND_S;
      },
      destroy() {
        clearTimeout(retry);
        hls?.destroy();
        video.removeAttribute('src');
        video.load();
      },
    };
  }

  /** YouTube's player, its controls off, behind the shield. */
  function youtubeEngine() {
    const url = new URL(source.src);
    const params = { enablejsapi: '1', controls: '0', disablekb: '1', fs: '0', iv_load_policy: '3', rel: '0', playsinline: '1', autoplay: '1', origin: window.location.origin };
    if (resumeAt > 0) params.start = String(Math.floor(resumeAt));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const frame = h('iframe', {
      class: 'cbp-yt-frame',
      src: url.href,
      title,
      tabindex: '-1',
      allow: 'autoplay; encrypted-media',
      // The app sends no referrer at all; YouTube's player will not start without one.
      referrerpolicy: 'strict-origin-when-cross-origin',
    });
    media.append(h('div', { class: 'cbp-yt' }, h('div', { class: 'cbp-yt-box' }, frame)));
    let player = null;
    let soundCheck = null;
    let played = false;
    const notThere = vod ? NOT_READY : WAITING;
    // Nothing on screen yet: the channel is not live, or YouTube is still
    // processing the recording. YouTube then shows "This video is
    // unavailable" and reports neither ready nor an error.
    const startCheck = setTimeout(() => {
      if (played) return;
      set({ waiting: notThere, playing: false });
      remountIn(15_000);
    }, 12_000);

    (async () => {
      const YT = await loadYouTubeApi();
      if (destroyed) return;
      if (!YT) {
        set({ waiting: 'Could not load the class video. Checking again…' });
        remountIn(15_000);
        return;
      }
      const S = YT.PlayerState;
      player = new YT.Player(frame, {
        events: {
          onReady() {
            volume = (player.getVolume?.() ?? 100) / 100;
            set({ muted: player.isMuted() });
            showVolume();
            if (vod && st.rate !== 1) player.setPlaybackRate(st.rate);
            player.playVideo();
            // Sound needs the browser's say-so; refused, YouTube sits unstarted
            // rather than loading. Then muted, with "Tap for sound".
            soundCheck = setTimeout(() => {
              if (played || player.getPlayerState() === S.BUFFERING) return;
              player.mute();
              player.playVideo();
              set({ muted: true, soundBlocked: true });
            }, 4000);
          },
          onStateChange({ data }) {
            if (data === S.PLAYING) {
              played = true;
              set({ playing: true, buffering: false, waiting: null, ended: false });
            } else if (data === S.BUFFERING) set({ buffering: true });
            else if (data === S.PAUSED) {
              set({ playing: false, buffering: false });
              report(true);
            } else if (data === S.ENDED) {
              set({ playing: false, buffering: false, ended: true });
              report(true);
            }
          },
          onPlaybackRateChange({ data }) {
            set({ rate: data });
          },
          onError() {
            set({ waiting: notThere, playing: false });
            remountIn(20_000);
          },
        },
      });
    })();

    return {
      play: () => player?.playVideo(),
      pause: () => player?.pauseVideo(),
      mute(on) {
        if (!player) return;
        if (on) player.mute();
        else player.unMute();
        set({ muted: on });
      },
      setVolume: (level) => player?.setVolume?.(Math.round(level * 100)),
      setQuality() {},
      setRate: (rate) => player?.setPlaybackRate?.(rate),
      seek: (to) => player?.seekTo?.(to, true),
      position: () => player?.getCurrentTime?.() || 0,
      duration: () => player?.getDuration?.() || 0,
      /** Live, YouTube's duration is the live edge, and it keeps what its DVR holds behind it. */
      span() {
        const duration = player?.getDuration?.() || 0;
        if (!(duration > 0)) return [0, Infinity];
        return [0, vod ? duration - 1 : duration];
      },
      goLive() {
        player?.seekTo(player.getDuration(), true);
        player?.playVideo();
      },
      behind() {
        if (!played || player?.getVideoData?.()?.isLive !== true) return false;
        // YouTube's own live delay is 10–20s already; only offer it past that.
        return player.getDuration() - player.getCurrentTime() > BEHIND_S * 2;
      },
      destroy() {
        clearTimeout(soundCheck);
        clearTimeout(startCheck);
        player?.destroy?.();
      },
    };
  }

  /* — mounting — */

  function mount() {
    clearTimeout(remountTimer);
    engine?.destroy();
    clear(media);
    Object.assign(st, { playing: false, buffering: true, ended: false, behind: false, qualities: null, quality: -1, autoLabel: null, menu: false });
    engine = source.kind === 'youtube' ? youtubeEngine() : videoEngine();
    paint();
  }

  /** A fresh player in a while: YouTube's channel feed only shows a stream once it is live. */
  function remountIn(ms) {
    clearTimeout(remountTimer);
    remountTimer = setTimeout(() => !destroyed && mount(), ms);
  }

  // Once a second: how far behind live a class is, or where a lecture has got to.
  const ticker = setInterval(() => {
    if (!el.isConnected || !engine) return;
    if (vod) {
      showTime();
      if (st.playing) report();
    } else set({ behind: Boolean(engine.behind()) });
  }, 1000);

  mount();
  wake();

  return {
    el,
    seekTo: jumpTo,
    destroy() {
      if (destroyed) return;
      report(true);
      destroyed = true;
      clearInterval(ticker);
      clearTimeout(idleTimer);
      clearTimeout(remountTimer);
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      engine?.destroy();
    },
  };
}
