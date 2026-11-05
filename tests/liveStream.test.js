import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { streamSource } from '../public/js/liveStream.js';

describe('liveStream — which player a class stream gets', () => {
  it('embeds YouTube from every shape of link, privacy-enhanced', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/live/dQw4w9WgXcQ?feature=share',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      const s = streamSource(url);
      assert.equal(s.kind, 'youtube', url);
      assert.match(s.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    }
  });

  it('plays a channel’s live feed — what Studio sets for its YouTube stream', () => {
    const live = 'https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv&autoplay=1&playsinline=1&rel=0';
    assert.deepEqual(streamSource('https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv'), { kind: 'youtube', src: live });
    assert.deepEqual(streamSource('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live'), { kind: 'youtube', src: live });
    assert.equal(streamSource('https://www.youtube.com/embed/live_stream?channel=bogus').kind, 'link', 'not a channel id');
  });

  it('embeds Vimeo, and plays files and HLS in the page', () => {
    assert.equal(streamSource('https://vimeo.com/123456789').src, 'https://player.vimeo.com/video/123456789?autoplay=1&playsinline=1');
    assert.deepEqual(streamSource('https://cdn.apex.in/live/b12a.m3u8'), { kind: 'hls', src: 'https://cdn.apex.in/live/b12a.m3u8' });
    assert.equal(streamSource('https://cdn.apex.in/rec/class.MP4').kind, 'video');
  });

  it('opens anything else outside the app, and ignores no link or a bad one', () => {
    assert.deepEqual(streamSource('https://us02web.zoom.us/j/123'), { kind: 'link', src: 'https://us02web.zoom.us/j/123', host: 'us02web.zoom.us' });
    assert.equal(streamSource('https://www.youtube.com/channel/UCxyz').kind, 'link', 'a channel page is not a video');
    for (const url of [null, '', 'not a url', 'javascript:alert(1)']) assert.deepEqual(streamSource(url), { kind: 'none' }, String(url));
  });
});
