/**
 * A demo class for trying CoachBook Studio (studio/) on your own PC.
 *
 *   npm start                                  (terminal 1: the server)
 *   node scripts/studio-demo.js                (terminal 2: this)
 *   cd studio && npm install && npm start      (terminal 3: the board)
 *
 * Against the running server it sets up a coaching institute with a
 * classroom ("Room 101"), a teacher, two lectures timetabled for today, three
 * students, and a smartboard waiting to be paired — and prints the address
 * and pairing code to type into Studio. Re-running it reuses all of that.
 *
 * Then it stays running as the class's students. The student app has no live
 * screens yet, so whenever a class goes live they join it over the socket,
 * send doubts, and answer every poll. With `--export <folder>`, it also plays
 * Note 3: when the class ends it drops a notes PDF into that folder, so Studio
 * has something to find and send.
 *
 * Options: --server <url> (default http://localhost:3000), --export <folder>,
 * --new-code (unpair the board and print a fresh code).
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFKit from 'pdfkit';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const SERVER = (option('--server') || 'http://localhost:3000').replace(/\/+$/, '');
const EXPORT_DIR = option('--export');
const NEW_CODE = args.includes('--new-code');
const SLUG = 'studio-demo';
const ADMIN = { email: 'director@studio-demo.test', password: 'demo-pass-123' };
const TEACHER = { name: 'Prof Verma', email: 'verma@studio-demo.test', password: 'teacher-pass-123' };
const STUDENTS = [['Aarav', 'Sharma'], ['Priya', 'Nair'], ['Kabir', 'Singh']];
const DOUBTS = [
  'Why is torque zero when the force passes through the axis?',
  'Sir, is angular momentum conserved when the ball rolls down the incline?',
  'In the last example, why did we take the moment of inertia about the centre?',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toLocaleTimeString(), ...parts);

async function api(method, url, body, token) {
  const res = await fetch(`${SERVER}/g/${SLUG}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function must(res, what) {
  if (res.status >= 400) throw new Error(`${what} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

/* ── The institute ───────────────────────────────────────────────────── */

async function adminToken() {
  let health;
  try {
    health = await fetch(`${SERVER}/api/health`);
  } catch {
    throw new Error(`Cannot reach ${SERVER} — start the server first (npm start)`);
  }
  if (!health.ok) throw new Error(`${SERVER} is not a CoachBook server`);
  const signup = await fetch(`${SERVER}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG, gym_name: 'Studio Demo Institute', admin_name: 'Demo Director', admin_email: ADMIN.email, admin_password: ADMIN.password,
      currency: 'INR', business_type: 'coaching',
    }),
  });
  if (signup.ok) {
    log('Created the demo institute.');
    return (await signup.json()).token;
  }
  return must(await api('POST', '/api/auth/login', ADMIN), 'Signing in to the demo institute').token;
}

async function setUp(token) {
  const get = async (url) => must(await api('GET', url, undefined, token), `GET ${url}`);
  const post = async (url, body) => must(await api('POST', url, body, token), `POST ${url}`);

  const course = (await get('/api/coaching/courses')).items[0];
  const batch = (await get('/api/coaching/batches')).items.find((b) => b.code === 'B12A');
  const room = (await get('/api/coaching/classrooms')).items.find((r) => r.name === 'Room 101')
    ?? await post('/api/coaching/classrooms', { name: 'Room 101', capacity: 40 });

  let teacher = (await get('/api/staff')).items.find((u) => u.email === TEACHER.email);
  if (!teacher) teacher = await post('/api/staff', { ...TEACHER, role: 'trainer' });

  // Two lectures today in Room 101 (the batch's room), so the board has a list.
  const weekday = new Date().getDay();
  const slots = (await get(`/api/coaching/timetable?batch_id=${batch.id}`)).items.filter((s) => s.weekday === weekday);
  const [physics, , maths] = course.subjects;
  for (const [subject, start, end] of [[physics, '08:00', '13:00'], [maths, '13:00', '20:00']]) {
    if (!slots.some((s) => s.subject_id === subject.id)) {
      await post('/api/coaching/timetable', { batch_id: batch.id, subject_id: subject.id, faculty_id: teacher.id, weekday, start_time: start, end_time: end, override: true });
    }
  }

  const students = [];
  const roster = (await get(`/api/coaching/attendance/sheet?batch_id=${batch.id}`)).items;
  for (const [first, last] of STUDENTS) {
    let memberId = roster.find((r) => r.first_name === first)?.member_id;
    if (!memberId) {
      memberId = (await post('/api/members', { first_name: first, last_name: last, phone: '9800000000' })).id;
      await post('/api/coaching/enrollments', { member_id: memberId, batch_id: batch.id });
    }
    // A fresh temporary password each run; the script signs in with it.
    const issued = await post(`/api/members/${memberId}/app-login`, { deliver: 'show' });
    const login = must(await api('POST', '/api/portal/login', { identifier: issued.member.code, password: issued.password }), `Signing in ${first}`);
    students.push({ id: memberId, name: first, code: issued.member.code, password: issued.password, token: login.token });
  }

  let device = (await get('/api/coaching/studio-devices')).items.find((d) => d.classroom_id === room.id);
  let pairing = null;
  if (!device) {
    ({ device, pairing } = await post('/api/coaching/studio-devices', { name: 'Room 101 smartboard', classroom_id: room.id }));
  } else if (NEW_CODE || !device.paired) {
    ({ device, pairing } = await post(`/api/coaching/studio-devices/${device.id}/pairing-code`, {}));
  }
  return { batch, students, device, pairing };
}

/* ── The students ────────────────────────────────────────────────────── */

function joinClass(student, sessionId, { askDoubt }) {
  return new Promise((resolve) => {
    (async () => {
      const ticket = await api('POST', `/api/portal/coaching/live/sessions/${sessionId}/socket-ticket`, undefined, student.token);
      if (ticket.status !== 200) return resolve();
      const ws = new WebSocket(`${SERVER.replace(/^http/, 'ws')}${ticket.body.path}?ticket=${ticket.body.ticket}`);
      let ref = 0;
      const send = (event, data) => ws.send(JSON.stringify({ event, data, ref: ++ref }));
      ws.on('open', async () => {
        if (askDoubt) {
          await sleep(3000 + Math.random() * 4000);
          send('student:ask_doubt', { body: askDoubt });
          log(`${student.name} asked: “${askDoubt}”`);
        }
      });
      ws.on('message', async (raw) => {
        const { event, data, ok, error } = JSON.parse(raw);
        if (event === 'ack' && ok === false) log(`${student.name}: refused — ${error}`);
        if (event === 'poll:started') {
          await sleep(1500 + Math.random() * Math.min(12_000, data.remaining_ms - 3000));
          const letters = ['A', 'B', 'C', 'D'].slice(0, data.option_count);
          const choice = letters[Math.floor(Math.random() * letters.length)];
          send('student:submit_vote', { poll_id: data.poll_id, choice });
          log(`${student.name} answered ${choice}`);
        }
        if (event === 'poll:my_result') log(`${student.name}: ${data.correct ? `right, rank ${data.rank}` : data.choice ? 'wrong' : 'did not answer'}`);
        if (event === 'doubt:pinned') log(`${student.name} sees pinned on screen: “${data.body}” (${data.name})`);
        if (event === 'doubt:resolved' && data.was_pinned === false) log(`${student.name}: my doubt was answered`);
        if (event === 'session:ended') ws.close();
      });
      ws.on('close', resolve);
      ws.on('error', () => resolve());
      return undefined;
    })();
  });
}

/** Note 3's part: the class's notes, written into the export folder. */
function exportNotes(subject) {
  return new Promise((resolve) => {
    const doc = new PDFKit({ size: [1920, 1080], margin: 0 });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const file = path.join(EXPORT_DIR, `${subject} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}.pdf`);
    doc.pipe(fs.createWriteStream(file)).on('finish', () => resolve(file));
    for (const [i, line] of ['Rotational motion', 'Torque  τ = r × F', 'Angular momentum  L = Iω'].entries()) {
      if (i) doc.addPage({ size: [1920, 1080], margin: 0 });
      doc.rect(0, 0, 1920, 1080).fill('#10241d');
      doc.fillColor('#ffffff').fontSize(80).text(line, 140, 440);
    }
    doc.end();
  });
}

async function attendClasses(students) {
  log('Waiting for a class to go live in Room 101 — press Go live in Studio. (Ctrl+C to stop)');
  const seen = new Set();
  for (;;) {
    const active = await api('GET', '/api/portal/coaching/live/active', undefined, students[0].token);
    const session = active.body?.items?.[0];
    if (session && !seen.has(session.id)) {
      seen.add(session.id);
      log(`Class ${session.id} is live: ${session.subject_name}, ${session.batch_name}. The students are joining.`);
      await Promise.all(students.map((s, i) => joinClass(s, session.id, { askDoubt: i < 2 ? DOUBTS[(session.id + i) % DOUBTS.length] : null })));
      log(`Class ${session.id} is over.`);
      if (EXPORT_DIR) {
        await sleep(2000);
        log(`Note 3 exported ${await exportNotes(session.subject_name)}`);
      }
      log('Waiting for the next class…');
    }
    await sleep(3000);
  }
}

/* ── Start ───────────────────────────────────────────────────────────── */

try {
  if (EXPORT_DIR) fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const token = await adminToken();
  const { students, device, pairing } = await setUp(token);
  console.log(`
  Studio Demo Institute is ready.

  In CoachBook Studio, pair with:
    Address:       ${SERVER}/g/${SLUG}
    Pairing code:  ${pairing ? pairing.code : `(${device.name} is already paired — run with --new-code for a fresh code)`}
  ${EXPORT_DIR ? `  Note 3 folder: ${path.resolve(EXPORT_DIR)}   (set this as "Note 3 exports" in Studio)\n` : ''}
  To join the class as a student, open ${SERVER}/g/${SLUG}/#/portal and sign in as
    ${students[0].code} / ${students[0].password}   (it asks you to pick a new password)
  Staff sign-in: ${ADMIN.email} / ${ADMIN.password}
`);
  // The first student is yours to sign in as in the browser; the script plays the other two.
  await attendClasses(students.slice(1));
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
