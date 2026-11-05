import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import PDFKit from 'pdfkit';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream, degrees } from 'pdf-lib';
import { openSocket } from './helpers/liveSocket.js';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-notes-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { stampNotesPdf, toUserSpace } = await import('../src/coaching/notesPdf.js');
const { formatDay } = await import('../src/coaching/notify.js');
const { attachLiveGateway } = await import('../src/coaching/liveGateway.js');

/* ── PDF fixtures and inspection ─────────────────────────────────────── */

/** A board export: one page per slide, the second one landscape. */
function boardExport({ slides = 3, userPassword } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ autoFirstPage: false, userPassword });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (let i = 1; i <= slides; i += 1) {
      doc.addPage({ size: 'A4', layout: i === 2 ? 'landscape' : 'portrait' });
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#111');
      doc.fillColor('#fff').fontSize(28).text(`Slide ${i}: torque and angular momentum`, 60, 300);
    }
    doc.end();
  });
}

/** Each page's content streams, decoded, in drawing order. */
async function pageStreams(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    return streams.map((s) => Buffer.from(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()).toString('latin1'));
  });
}

/** Whether `text` is drawn on the page — pdf-lib writes it as a hex string. */
const draws = (streams, text) => streams.join('\n').toLowerCase().includes(`<${Buffer.from(text, 'latin1').toString('hex')}>`);

/* ── The stamp itself ────────────────────────────────────────────────── */

describe('stamping the notes PDF', () => {
  const stamp = { institute: 'Vidya Classes', batch: 'Batch 12-A', subject: 'Physics', date: '04/11/2026', teacher: 'Prof Verma', title: 'Physics notes' };

  it('puts the institute, batch, subject, date and page numbers on every page', async () => {
    const { pdf, pages } = await stampNotesPdf(await boardExport(), stamp);
    assert.equal(pages, 3);
    const streams = await pageStreams(pdf);
    assert.equal(streams.length, 3);
    streams.forEach((page, i) => {
      assert.ok(draws(page, 'Vidya Classes'), `institute on page ${i + 1}`);
      assert.ok(draws(page, 'Batch 12-A  ·  Physics  ·  04/11/2026'), `batch, subject and date on page ${i + 1}`);
      assert.ok(draws(page, `Page ${i + 1} of 3`), `page number on page ${i + 1}`);
      assert.ok(draws(page, 'Notes by Prof Verma'));
    });
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getTitle(), 'Physics notes');
    assert.equal(doc.getAuthor(), 'Vidya Classes');
    assert.deepEqual(doc.getPages().map((p) => Math.round(p.getWidth())), [595, 842, 595], 'page sizes untouched');
  });

  it('fences the board’s own drawing off from the stamp', async () => {
    const [first] = await pageStreams((await stampNotesPdf(await boardExport({ slides: 1 }), stamp)).pdf);
    assert.equal(first[0].trim(), 'q', 'the board’s content starts on a saved graphics state');
    const restore = first.findIndex((s) => s.trim() === 'Q');
    const stampAt = first.findIndex((s) => s.includes('Tj'));
    assert.ok(restore > 0 && stampAt > restore, 'and the stamp is drawn after it is restored');
  });

  it('drops characters the built-in font cannot draw instead of failing', async () => {
    const { pdf } = await stampNotesPdf(await boardExport({ slides: 1 }), { ...stamp, institute: 'विद्या Vidya Classes', batch: 'Bätch 12-A' });
    const [page] = await pageStreams(pdf);
    assert.ok(draws(page, 'Vidya Classes'));
    assert.ok(draws(page, 'Bätch 12-A  ·  Physics  ·  04/11/2026'), 'Latin-1 accents are kept');
    assert.equal((await PDFDocument.load(pdf)).getAuthor(), 'विद्या Vidya Classes', 'the metadata keeps the full name');
  });

  it('stamps a rotated page upright', async () => {
    const src = await PDFDocument.create();
    src.addPage([595, 842]).setRotation(degrees(90));
    const { pdf } = await stampNotesPdf(await src.save(), stamp);
    const [page] = await pageStreams(pdf);
    assert.ok(draws(page, 'Page 1 of 1'));
    // A text matrix of [0 1 -1 0 …] is a 90° counter-clockwise turn, which
    // a clockwise display rotation of 90° brings back to horizontal.
    const matrices = [...page.join('\n').matchAll(/^(\S+) (\S+) (\S+) (\S+) \S+ \S+ Tm$/gm)].map((m) => m.slice(1, 5).map(Number));
    assert.ok(matrices.length >= 2);
    for (const [a, b, c, d] of matrices) {
      assert.ok(Math.abs(a) < 1e-9 && b === 1 && c === -1 && Math.abs(d) < 1e-9, `text matrix ${[a, b, c, d]}`);
    }
  });

  /** Where the PDF spec says a page-space point shows up: turned clockwise by
   * /Rotate, then shifted so the crop box's corner is at the origin. */
  function displayed(box, rotation, ux, uy) {
    const r = (rotation * Math.PI) / 180;
    const turn = (x, y) => [x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)];
    const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]].map(([x, y]) => turn(x, y));
    const [x, y] = turn(ux, uy);
    return [x - Math.min(...corners.map((c) => c[0])), y - Math.min(...corners.map((c) => c[1]))];
  }

  it('maps a displayed point back into page space for every rotation', () => {
    const box = { x: 20, y: 35, width: 600, height: 800 };
    for (const rotation of [0, 90, 180, 270]) {
      const sideways = rotation % 180 !== 0;
      const [w, h] = sideways ? [box.height, box.width] : [box.width, box.height];
      for (const [vx, vy] of [[0, 0], [w, 0], [0, h], [w, h], [123, 45]]) {
        const at = toUserSpace(box, rotation, vx, vy);
        const [dx, dy] = displayed(box, rotation, at.x, at.y);
        assert.ok(Math.abs(dx - vx) < 1e-6 && Math.abs(dy - vy) < 1e-6, `rotation ${rotation}: (${vx}, ${vy}) came back as (${dx}, ${dy})`);
        const a = (at.angle * Math.PI) / 180;
        const [ex, ey] = displayed({ x: 0, y: 0, width: 0, height: 0 }, rotation, Math.cos(a), Math.sin(a));
        assert.ok(Math.abs(ex - 1) < 1e-6 && Math.abs(ey) < 1e-6, `rotation ${rotation}: text runs left to right`);
      }
    }
  });

  it('refuses anything that is not a readable, unlocked PDF', async () => {
    const reason = async (bytes) => {
      try {
        await stampNotesPdf(bytes, stamp);
        return 'accepted';
      } catch (err) {
        assert.equal(err.status, 400);
        return err.details.file;
      }
    };
    assert.equal(await reason(Buffer.from('just some text')), 'not a PDF');
    assert.equal(await reason(Buffer.alloc(0)), 'not a PDF');
    assert.equal(await reason(await boardExport({ slides: 1, userPassword: 'board123' })), 'encrypted');
    assert.equal(await reason(Buffer.from('%PDF-1.7\n%%EOF')), 'unreadable');
  });
});

/* ── The pipeline, end to end ────────────────────────────────────────── */

let root;
let server;
let admin;
const SLUG = 'vidya-notes';

const call = async (method, urlPath, body, { useToken = admin, slug = SLUG, raw = null, contentType = 'application/pdf' } = {}) => {
  const res = await fetch(`${root}/g/${slug}${urlPath}`, {
    method,
    headers: {
      ...(raw ? { 'Content-Type': contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: res.status, body: null, bytes: Buffer.from(await res.arrayBuffer()), type };
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const signup = async (slug, name, email, businessType = 'coaching') => {
  const res = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug, gym_name: name, admin_name: 'Director', admin_email: email, admin_password: 'strongpass123', currency: 'INR', business_type: businessType,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.token;
};

const inTenant = (fn) => tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG), businessType: 'coaching' }, fn);

async function staffMember(name, email, role) {
  assert.equal((await call('POST', '/api/staff', { name, email, password: 'staffpass123', role })).status, 201);
  const login = await call('POST', '/api/auth/login', { email, password: 'staffpass123' }, { useToken: null });
  return { id: login.body.user.id, token: login.body.token };
}

async function student(firstName, batch) {
  const created = await call('POST', '/api/members', { first_name: firstName, last_name: 'Sharma', phone: '9800000004' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: batch.id })).status, 201);
  const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
  return { id: created.body.id, token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }) };
}

const publish = (sessionId, bytes, useToken, query = '') =>
  call('POST', `/api/coaching/live/sessions/${sessionId}/publish-notes${query}`, undefined, { useToken, raw: bytes });
const notesAlerts = async (who) =>
  (await call('GET', '/api/portal/notifications', undefined, { useToken: who.token })).body.items.filter((n) => n.title === 'Physics notes are ready');

let physics;
let batchA;
let batchB;
let verma; // teaches batch A Physics
let rao; // teaches batch B Chemistry
let desk;
let aarav; // batch A
let kabir; // batch A
let diya; // batch B
let session;
let material;
let gateway;
let aaravSocket;

describe('publishing a live class’s notes', () => {
  before(async () => {
    server = createApp().listen(0);
    gateway = attachLiveGateway(server);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    admin = await signup(SLUG, 'Vidya Classes', 'director@vidya-notes.test');

    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    const [phy, chemistry] = course.subjects;
    physics = phy;
    batchA = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
    batchB = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today() })).body;
    verma = await staffMember('Prof Verma', 'verma@vidya-notes.test', 'trainer');
    rao = await staffMember('Prof Rao', 'rao@vidya-notes.test', 'trainer');
    desk = await staffMember('Front Desk', 'desk@vidya-notes.test', 'staff');
    await call('POST', `/api/coaching/batches/${batchA.id}/faculty`, { faculty_id: verma.id, subject_id: physics.id });
    await call('POST', `/api/coaching/batches/${batchB.id}/faculty`, { faculty_id: rao.id, subject_id: chemistry.id });
    aarav = await student('Aarav', batchA);
    kabir = await student('Kabir', batchA);
    diya = await student('Diya', batchB);

    // The class: on air, then over — which is when the board exports.
    const live = await call('POST', '/api/coaching/live/sessions', { batch_id: batchA.id, subject_id: physics.id, title: 'Rotational motion' }, { useToken: verma.token });
    assert.equal(live.status, 201, JSON.stringify(live.body));
    session = live.body;
    // Aarav stays on the class screen after it ends, waiting for the notes.
    const ticket = await call('POST', `/api/portal/coaching/live/sessions/${session.id}/socket-ticket`, undefined, { useToken: aarav.token });
    aaravSocket = await openSocket(root, ticket.body);
    assert.equal((await call('PATCH', `/api/coaching/live/sessions/${session.id}/end`, undefined, { useToken: verma.token })).status, 200);
  });

  after(() => {
    aaravSocket.close();
    gateway.close();
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('turns the board’s export into the batch’s notes', async () => {
    const res = await publish(session.id, await boardExport(), verma.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    material = res.body.material;
    const date = today();
    assert.equal(res.body.pages, 3);
    assert.equal(res.body.replaced, false);
    assert.equal(res.body.notified, 2, 'both students on batch A');
    assert.equal(material.kind, 'notes');
    assert.equal(material.batch_id, batchA.id);
    assert.equal(material.subject_id, physics.id);
    assert.equal(material.live_session_id, session.id);
    assert.equal(material.mime, 'application/pdf');
    assert.equal(material.has_file, 1);
    assert.equal(material.uploaded_by, verma.id);
    assert.equal(material.title, `Physics notes — Rotational motion (${formatDay(date)})`);
    assert.equal(material.file_name, `B12A_Physics_${date}_notes.pdf`);
    const pushed = await aaravSocket.next('notes:published');
    assert.equal(pushed.material.id, material.id, 'a student still on the class screen is told at once');
    assert.equal(pushed.replaced, false);
  });

  it('lets a student on the batch download the stamped notes straight away', async () => {
    const list = await call('GET', '/api/portal/coaching/materials', undefined, { useToken: aarav.token });
    assert.equal(list.status, 200);
    const listed = list.body.items.find((m) => m.id === material.id);
    assert.ok(listed, 'in the student’s Notes & DPPs');
    assert.equal(listed.live_session_id, session.id);

    const file = await call('GET', `/api/portal/coaching/materials/${material.id}/file`, undefined, { useToken: aarav.token });
    assert.equal(file.status, 200);
    assert.equal(file.type, 'application/pdf');
    const pages = await pageStreams(file.bytes);
    assert.equal(pages.length, 3);
    assert.ok(draws(pages[0], 'Vidya Classes'));
    assert.ok(draws(pages[1], `Batch 12-A (Evening)  ·  Physics  ·  ${formatDay(today())}`));
    assert.ok(draws(pages[2], 'Page 3 of 3'));
    assert.ok(draws(pages[2], 'Notes by Prof Verma'));
  });

  it('alerts every student on the batch, and nobody else', async () => {
    for (const who of [aarav, kabir]) {
      const alerts = await notesAlerts(who);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].screen, 'materials');
      assert.match(alerts[0].body, /Rotational motion .* with Prof Verma: the notes are in Notes & DPPs\./);
    }
    assert.deepEqual(await notesAlerts(diya), []);
  });

  it('keeps the notes from another batch’s students', async () => {
    const list = await call('GET', '/api/portal/coaching/materials', undefined, { useToken: diya.token });
    assert.ok(!list.body.items.some((m) => m.id === material.id));
    const file = await call('GET', `/api/portal/coaching/materials/${material.id}/file`, undefined, { useToken: diya.token });
    assert.equal(file.status, 404);
  });

  it('replaces the file on a re-export, without alerting the batch again', async () => {
    const res = await publish(session.id, await boardExport({ slides: 1 }), verma.token, '?title=Rotational+motion+(corrected)');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.replaced, true);
    assert.equal(res.body.notified, 0);
    assert.equal(res.body.material.id, material.id);
    assert.equal(res.body.material.title, 'Rotational motion (corrected)');

    const staffList = await call('GET', `/api/coaching/materials?batch_id=${batchA.id}&kind=notes`);
    assert.equal(staffList.body.items.filter((m) => m.live_session_id === session.id).length, 1, 'one notes file per class');
    assert.equal((await notesAlerts(aarav)).length, 1);
    const file = await call('GET', `/api/portal/coaching/materials/${material.id}/file`, undefined, { useToken: aarav.token });
    assert.equal((await pageStreams(file.bytes)).length, 1, 'students get the corrected copy');
  });

  it('only takes notes from the class’s teacher or a manager', async () => {
    const pdf = await boardExport({ slides: 1 });
    assert.equal((await publish(session.id, pdf, rao.token)).status, 403);
    assert.equal((await publish(session.id, pdf, desk.token)).status, 403);
    assert.equal((await publish(session.id, pdf, aarav.token)).status, 401);
    assert.equal((await publish(session.id, pdf, null)).status, 401);
    const byManager = await publish(session.id, pdf, admin);
    assert.equal(byManager.status, 200);
    assert.equal(byManager.body.material.uploaded_by_name, 'Director');
  });

  it('refuses a bad file, an unknown class and one that never started', async () => {
    const notPdf = await publish(session.id, Buffer.from('hello'), verma.token);
    assert.equal(notPdf.status, 400);
    assert.equal(notPdf.body.details.file, 'not a PDF');
    const locked = await publish(session.id, await boardExport({ slides: 1, userPassword: 'x' }), verma.token);
    assert.equal(locked.status, 400);
    assert.equal(locked.body.details.file, 'encrypted');
    const empty = await call('POST', `/api/coaching/live/sessions/${session.id}/publish-notes`, undefined, { useToken: verma.token });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.details.file, 'is required');
    assert.equal((await publish(9999, await boardExport({ slides: 1 }), admin)).status, 404);

    const scheduled = inTenant(() => run(
      "INSERT INTO live_sessions (batch_id, subject_id, faculty_id, status) VALUES (?, ?, ?, 'scheduled')",
      [batchA.id, physics.id, verma.id],
    ).lastInsertRowid);
    assert.equal((await publish(scheduled, await boardExport({ slides: 1 }), verma.token)).status, 409);
  });

  it('is not part of a gym account', async () => {
    const gym = await signup('iron-notes', 'Iron Gym', 'owner@iron-notes.test', 'gym');
    const res = await call('POST', '/api/coaching/live/sessions/1/publish-notes', undefined, { useToken: gym, slug: 'iron-notes', raw: Buffer.from('%PDF-1.4') });
    assert.equal(res.status, 404);
    assert.equal(res.body.details.code, 'module_not_enabled');
  });
});
