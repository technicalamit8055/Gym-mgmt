/**
 * How a live class's stream_url plays in the student app. Kept apart from the
 * screen (views/coaching/liveClass.js) and free of the DOM, so it can be tested.
 *
 *   youtube  YouTube (watch, youtu.be, /live/, /embed/) — embedded player
 *   vimeo    Vimeo — embedded player
 *   video    a direct .mp4 / .webm / .mov — the page's own <video>
 *   hls      a .m3u8 stream — <video> where the browser plays HLS itself
 *   link     anything else (Zoom, Meet, a custom player) — opened outside
 *   none     no stream: the class is in the room, and the app is for polls,
 *            doubts and notes
 */
export function streamSource(url) {
  if (!url) return { kind: 'none' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'none' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { kind: 'none' };
  const host = u.hostname.replace(/^(www|m)\./, '');

  // A channel's live feed: whatever it is streaming now — what CoachBook
  // Studio sets, since it knows the institute's channel, not each stream's id.
  // YouTube shows a public stream here, not an unlisted one.
  const channel = ['youtube.com', 'youtube-nocookie.com'].includes(host)
    ? (u.pathname === '/embed/live_stream' ? u.searchParams.get('channel') : (/^\/channel\/(UC[\w-]{22})\/live\/?$/.exec(u.pathname) || [])[1])
    : null;
  if (channel && /^UC[\w-]{22}$/.test(channel)) {
    return { kind: 'youtube', src: `https://www.youtube.com/embed/live_stream?channel=${channel}&autoplay=1&playsinline=1&rel=0` };
  }

  const youtube = host === 'youtu.be'
    ? u.pathname.slice(1)
    : ['youtube.com', 'youtube-nocookie.com'].includes(host)
      ? u.searchParams.get('v') || (/^\/(?:live|embed|shorts)\/([^/?#]+)/.exec(u.pathname) || [])[1]
      : null;
  if (youtube && youtube !== 'live_stream' && /^[\w-]{6,20}$/.test(youtube)) {
    return {
      kind: 'youtube',
      src: `https://www.youtube-nocookie.com/embed/${youtube}?autoplay=1&playsinline=1&rel=0&modestbranding=1`,
    };
  }

  const vimeo = host === 'vimeo.com' ? (/^\/(\d+)/.exec(u.pathname) || [])[1] : null;
  if (vimeo) return { kind: 'vimeo', src: `https://player.vimeo.com/video/${vimeo}?autoplay=1&playsinline=1` };

  const ext = (/\.([a-z0-9]+)$/i.exec(u.pathname) || [])[1]?.toLowerCase();
  if (ext === 'm3u8') return { kind: 'hls', src: u.href };
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return { kind: 'video', src: u.href };
  return { kind: 'link', src: u.href, host };
}
