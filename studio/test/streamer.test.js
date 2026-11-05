import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { RENDITIONS, createStreamer, explainFailure, ffmpegArgs, hlsArgs, sentBytes, youtubeOutput } from '../src/streamer.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stream-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const KEY = 'abcd-efgh-ijkl-mnop-qrst';

describe('the YouTube stream', () => {
  it('sends YouTube H.264 with a keyframe every two seconds, and AAC, over RTMPS', () => {
    const args = ffmpegArgs({ output: youtubeOutput(KEY) });
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(after('-c:v'), 'libx264');
    assert.equal(after('-g'), '60');
    assert.equal(after('-c:a'), 'aac');
    assert.equal(after('-f'), 'flv');
    assert.equal(args.at(-1), `rtmps://a.rtmps.youtube.com:443/live2/${KEY}`);
  });

  it('never repeats the stream key in what it tells the teacher', () => {
    const stderr = `[flv @ 0x1] rtmps://a.rtmps.youtube.com:443/live2/${KEY}: Input/output error\n`;
    const message = explainFailure(stderr, KEY);
    assert.match(message, /stream key/);
    assert.ok(!message.includes(KEY));
    const other = explainFailure(`something odd about ${KEY}`, KEY);
    assert.ok(!other.includes(KEY), other);
    assert.match(explainFailure('Failed to resolve hostname a.rtmps.youtube.com', KEY), /internet/);
  });

  it('reports a stream that dies as failed, and one it stopped as stopped', async () => {
    const statuses = [];
    const fakeChild = () => {
      const child = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { writable: true, chunks: [], write(c) { this.chunks.push(c); }, end() { setImmediate(() => child.emit('exit', 0)); } });
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {};
      return child;
    };
    let child;
    const streamer = createStreamer({ ffmpegPath: 'ffmpeg', onStatus: (s) => statuses.push(s), spawnImpl: () => { child = fakeChild(); return child; } });

    streamer.start({ output: youtubeOutput(KEY), secret: KEY });
    streamer.write(new Uint8Array([1, 2, 3]));
    assert.equal(child.stdin.chunks.length, 1);
    child.stderr.emit('data', `rtmps://x/live2/${KEY}: Input/output error`);
    child.emit('exit', 1);
    assert.equal(statuses.at(-1).state, 'failed');
    assert.ok(!statuses.at(-1).error.includes(KEY));

    streamer.start({ output: youtubeOutput(KEY), secret: KEY });
    streamer.stop();
    await new Promise((r) => setImmediate(r));
    assert.equal(statuses.at(-1).state, 'stopped');
    assert.equal(streamer.running, false);
  });

  it('is on air only once ffmpeg has sent something, not merely because it is running', () => {
    const statuses = [];
    const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null });
    const streamer = createStreamer({ ffmpegPath: 'ffmpeg', onStatus: (s) => statuses.push(s.state), spawnImpl: () => child });
    streamer.start({ output: youtubeOutput(KEY), secret: KEY });
    // ffmpeg waiting for the page's first video: progress, but nothing sent.
    child.stdout.emit('data', 'frame=0\ntotal_size=0\nprogress=continue\n');
    assert.deepEqual(statuses, ['starting']);
    child.stdout.emit('data', 'frame=12\ntotal_size=48213\nprogress=continue\n');
    child.stdout.emit('data', 'frame=24\ntotal_size=96120\nprogress=continue\n');
    assert.deepEqual(statuses, ['starting', 'live']);
    assert.equal(sentBytes('total_size=N/A\n'), false);
  });

  it('turns the page’s WebM into a stream YouTube can take (real ffmpeg)', { timeout: 60_000 }, async () => {
    // What the dock's MediaRecorder makes: VP8 video and Opus audio in WebM.
    const webm = path.join(dir, 'board.webm');
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '3', '-c:v', 'libvpx', '-c:a', 'libopus', '-y', webm,
    ]);
    const flv = path.join(dir, 'out.flv');
    const statuses = [];
    const streamer = createStreamer({ ffmpegPath, onStatus: (s) => statuses.push(s) });
    streamer.start({ output: flv });
    // Fed in pieces, as the recorder sends them.
    const bytes = fs.readFileSync(webm);
    for (let i = 0; i < bytes.length; i += 16 * 1024) streamer.write(bytes.subarray(i, i + 16 * 1024));
    // On air once ffmpeg reports it has written something.
    for (let i = 0; i < 200 && statuses.at(-1)?.state !== 'live'; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(statuses.at(-1)?.state, 'live', JSON.stringify(statuses));
    streamer.stop();
    for (let i = 0; i < 200 && statuses.at(-1)?.state !== 'stopped'; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(statuses.at(-1)?.state, 'stopped', JSON.stringify(statuses));

    let probe = '';
    try {
      execFileSync(ffmpegPath, ['-hide_banner', '-i', flv], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      probe = err.stderr.toString(); // "-i" alone exits 1 after describing the file
    }
    assert.match(probe, /Video: h264 .*1280x720.*30 fps/);
    assert.match(probe, /Audio: aac .*44100 Hz, stereo/);
  });
});

describe('the private stream (HLS uploaded to CoachBook)', () => {
  const UPLOAD = 'https://coachbook.in/g/apex/api/studio/hls/tok123/';

  it('encodes every quality with keyframes in step, and PUTs them under the upload address', () => {
    const args = hlsArgs({ hls: UPLOAD });
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(RENDITIONS.length, 3);
    assert.match(after('-filter_complex'), /split=3.*scale=-2:720.*scale=-2:480.*scale=-2:360/);
    assert.equal(after('-var_stream_map'), 'v:0,a:0 v:1,a:1 v:2,a:2');
    assert.equal(after('-g'), '60');
    assert.equal(after('-sc_threshold'), '0');
    assert.equal(after('-f'), 'hls');
    assert.equal(after('-method'), 'PUT');
    assert.equal(after('-master_pl_name'), 'master.m3u8');
    assert.equal(after('-hls_segment_filename'), `${UPLOAD}stream_%v_%05d.ts`);
    assert.equal(args.at(-1), `${UPLOAD}stream_%v.m3u8`);
  });

  it('is on air past the first segment, since HLS reports no size', () => {
    assert.equal(sentBytes('total_size=N/A\nout_time_us=900000\n'), false);
    assert.equal(sentBytes('total_size=N/A\nout_time_us=3100000\n'), true);
  });

  it('uploads a master playlist and every quality (real ffmpeg)', { timeout: 60_000 }, async () => {
    const webm = path.join(dir, 'board-hls.webm');
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '5', '-c:v', 'libvpx', '-c:a', 'libopus', '-y', webm,
    ]);
    // CoachBook, as far as ffmpeg can tell: it takes PUTs.
    const uploads = new Map();
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'PUT') uploads.set(req.url.split('/').pop(), Buffer.concat(chunks));
        res.writeHead(req.method === 'PUT' ? 201 : 204).end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const statuses = [];
    const streamer = createStreamer({ ffmpegPath, onStatus: (s) => statuses.push(s) });
    try {
      streamer.start({ hls: `http://127.0.0.1:${server.address().port}/api/studio/hls/tok/`, secret: 'tok' });
      streamer.write(fs.readFileSync(webm));
      for (let i = 0; i < 300 && !(uploads.has('master.m3u8') && statuses.some((s) => s.state === 'live')); i += 1) await new Promise((r) => setTimeout(r, 100));
      streamer.stop();
      for (let i = 0; i < 100 && statuses.at(-1)?.state !== 'stopped'; i += 1) await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.close();
    }
    const master = uploads.get('master.m3u8')?.toString() ?? '';
    assert.match(master, /RESOLUTION=1280x720[\s\S]*RESOLUTION=854x480[\s\S]*RESOLUTION=640x360/);
    for (const v of [0, 1, 2]) {
      assert.ok(uploads.has(`stream_${v}.m3u8`), `playlist ${v}`);
      assert.ok(uploads.has(`stream_${v}_00000.ts`), `first segment ${v}`);
    }
    assert.ok(statuses.some((s) => s.state === 'live'), JSON.stringify(statuses));
  });
});
