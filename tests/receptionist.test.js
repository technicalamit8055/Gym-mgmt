import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-receptionist-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.WHATSAPP_TRANSPORT = 'memory';
process.env.WHATSAPP_MESSAGE_GAP_MS = '0';
process.env.WHATSAPP_CHAT_GAP_MS = '0';
process.env.AI_RECEPTIONIST_DEBOUNCE_MS = '40';
process.env.AI_RECEPTIONIST_MAX_WAIT_MS = '200';
process.env.AI_RECEPTIONIST_CHAT_HOURLY_LIMIT = '4';

const { createApp } = await import('../src/app.js');
const { all, closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { setAiClientForTests } = await import('../src/aiCoach.js');
const { messageText, sentInMemory, simulateInboundMessage } = await import('../src/whatsapp.js');
const { receiveWhatsAppMessage, receptionistIdle } = await import('../src/coaching/receptionist.js');
const { amountsIn, checkGrounding, collectNumbers, FALLBACK_REPLY, promisesFollowUp, toWhatsApp } = await import('../src/coaching/receptionistAi.js');
const { coordinatesFromMapsUrl } = await import('../src/routes/coaching/admissions.js');

const SLUG = 'apex-classes';
const OTHER = 'zenith-classes';
const GYM = 'iron-gym';
const DIRECTOR = '9811199999';

let root;
let server;
let token;
let teacherToken;
let deskToken;
const seeded = {};

const call = async (method, urlPath, body, { useToken = token, slug = SLUG } = {}) => {
  const res = await fetch(`${root}${slug ? `/g/${slug}` : ''}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const signup = (slug, name, email, businessType) =>
  call(
    'POST',
    '/api/platform/signup',
    { slug, gym_name: name, admin_name: 'Owner Name', admin_email: email, admin_password: 'strongpass123', business_type: businessType, currency: 'INR' },
    { useToken: null, slug: null },
  );

const inTenant = (fn, slug = SLUG) => tenantStorage.run({ slug, dbFile: tenantDbPath(slug), businessType: 'coaching' }, fn);

/* ── A scripted Gemini ───────────────────────────────────────────────── */

const fake = {
  calls: [],
  script: [],
  models: {
    generateContent: async (params) => {
      fake.calls.push(structuredClone({ contents: params.contents, tools: params.config.tools }));
      const step = fake.script.shift();
      if (!step) throw new Error('The fake model has no scripted reply left');
      return typeof step === 'function' ? step(params) : step;
    },
  },
};

const toolCall = (name, args = {}) => ({
  functionCalls: [{ id: `call-${name}`, name, args }],
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: `call-${name}`, name, args } }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
});
const textReply = (text) => ({
  text,
  candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
});

/** The tool results the model's latest call was answering. */
const lastToolResults = () =>
  fake.calls
    .at(-1)
    .contents.at(-1)
    .parts.filter((p) => p.functionResponse)
    .map((p) => p.functionResponse);

let phoneSeq = 0;
/** A fresh parent number per test, so chats and ceilings never overlap. */
const newParent = () => {
  phoneSeq += 1;
  const phone = `9198${String(phoneSeq).padStart(8, '0')}`;
  return { phone, jid: `${phone}@s.whatsapp.net` };
};
let msgSeq = 0;
const say = (parent, text, extra = {}) =>
  receiveWhatsAppMessage({ slug: SLUG, jid: parent.jid, phone: parent.phone, pushName: 'Sunita Gupta', id: `WAMSG${++msgSeq}`, text, kind: 'text', fromMe: false, ...extra });

const conversationOf = (parent) => inTenant(() => get('SELECT * FROM wa_conversations WHERE jid = ?', [parent.jid]));
const transcriptOf = (parent) =>
  inTenant(() => all('SELECT m.author, m.kind, m.body, m.status FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id WHERE c.jid = ? ORDER BY m.id', [parent.jid]));
const sentTo = (jid) => sentInMemory.filter((m) => m.jid === jid);

before(async () => {
  setAiClientForTests(fake);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;

  const apex = await signup(SLUG, 'Apex Classes', 'director@apex.test', 'coaching');
  assert.equal(apex.status, 201, JSON.stringify(apex.body));
  token = apex.body.token;
  assert.equal((await signup(OTHER, 'Zenith Classes', 'director@zenith.test', 'coaching')).status, 201);
  assert.equal((await signup(GYM, 'Iron Gym', 'owner@iron.test', 'gym')).status, 201);

  assert.equal((await call('POST', '/api/staff', { name: 'Er. Verma', email: 'verma@apex.test', password: 'teacherpass1', role: 'trainer' })).status, 201);
  assert.equal((await call('POST', '/api/staff', { name: 'Desk Riya', email: 'desk@apex.test', password: 'deskpass123', role: 'staff' })).status, 201);
  teacherToken = (await call('POST', '/api/auth/login', { email: 'verma@apex.test', password: 'teacherpass1' }, { useToken: null })).body.token;
  deskToken = (await call('POST', '/api/auth/login', { email: 'desk@apex.test', password: 'deskpass123' }, { useToken: null })).body.token;

  // The institute's academic setup, written straight in: this suite is
  // about the assistant, not the academic screens.
  inTenant(() => {
    const course = run("INSERT INTO academic_courses (name, target_exam, academic_year) VALUES ('Class 12 Board + JEE', 'JEE Main', '2026-2027')");
    seeded.courseId = Number(course.lastInsertRowid);
    const physics = run("INSERT INTO academic_subjects (course_id, name) VALUES (?, 'Physics')", [seeded.courseId]);
    const batch = run(
      "INSERT INTO academic_batches (course_id, name, code, capacity, weekdays, start_time, end_time, start_date) VALUES (?, 'JEE Evening', 'JE1', 30, '1,3,5', '16:00', '19:00', ?)",
      [seeded.courseId, today()],
    );
    const verma = get("SELECT id FROM users WHERE email = 'verma@apex.test'");
    seeded.teacherId = verma.id;
    run("UPDATE users SET qualification = 'B.Tech, IIT Delhi' WHERE id = ?", [verma.id]);
    run('INSERT INTO faculty_allocations (faculty_id, batch_id, subject_id) VALUES (?, ?, ?)', [verma.id, batch.lastInsertRowid, physics.lastInsertRowid]);
    run(
      "INSERT INTO fee_structures (course_id, name, total_fee, installments, interval_days, components) VALUES (?, 'Full year', 120000, 3, 90, ?)",
      [seeded.courseId, JSON.stringify([{ label: 'Tuition', amount: 110000 }, { label: 'Study material', amount: 10000 }])],
    );
  });
  // Two days out, so it is always bookable whatever time the suite runs.
  seeded.demoDate = addDays(today(), 2);
  seeded.demoWeekday = new Date(`${seeded.demoDate}T00:00:00Z`).getUTCDay();
  const slot = await call('POST', '/api/coaching/admissions/demo-slots', {
    weekday: seeded.demoWeekday, start_time: '16:00', capacity: 4, course_id: seeded.courseId, faculty_id: seeded.teacherId,
  });
  assert.equal(slot.status, 201, JSON.stringify(slot.body));
  seeded.slotId = slot.body.slots[0].id;
  const tiny = await call('POST', '/api/coaching/admissions/demo-slots', { weekday: seeded.demoWeekday, start_time: '18:00', capacity: 1 });
  seeded.tinySlotId = tiny.body.slots.find((s) => s.start_time === '18:00').id;
});

beforeEach(() => {
  fake.calls = [];
  fake.script = [];
});

afterEach(async () => {
  assert.ok(await receptionistIdle(), 'every gathered message was answered');
});

after(() => {
  setAiClientForTests(null);
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Pure helpers ────────────────────────────────────────────────────── */

describe('grounding checks', () => {
  it('reads rupee amounts however they are written', () => {
    assert.deepEqual(amountsIn('Total *₹1,20,000*, first ₹40,000 at admission'), [120000, 40000]);
    assert.deepEqual(amountsIn('Rs. 45000 only'), [45000]);
    assert.deepEqual(amountsIn('sirf 1.2 lakh rupaye'), [120000]);
    assert.deepEqual(amountsIn('fees 35,000/- hai'), [35000]);
    assert.deepEqual(amountsIn('Class at 4:00 PM, 4 seats left, call 98765 43210'), []);
  });

  it('flags only amounts that appear nowhere in the data', () => {
    const grounded = collectNumbers({ total_fee: 120000, installments: [{ amount: 40000 }], note: 'Sibling discount ₹5,000' });
    assert.deepEqual(checkGrounding('₹1,20,000 in 3 parts of ₹40,000; ₹5,000 off for a sibling', grounded), []);
    assert.deepEqual(checkGrounding('Only ₹99,000 this week!', grounded), [99000]);
  });

  it('notices when a reply promises that a person will follow up', () => {
    assert.equal(promisesFollowUp('Discount ke liye, hamari team aapse baat karegi.'), true);
    assert.equal(promisesFollowUp('Our admissions team will get back to you tomorrow.'), true);
    assert.equal(promisesFollowUp('Ji Ma’am, Kabir ki attendance ke liye office hours mein team contact karegi.'), true);
    assert.equal(promisesFollowUp('Sir, the fee is ₹1,20,000. Shall I confirm the demo?'), false);
    assert.equal(promisesFollowUp('Our faculty team shares weekly tests every Sunday.'), false);
  });

  it('turns markdown into WhatsApp formatting', () => {
    assert.equal(toWhatsApp('## Fees\n**₹1,20,000** total\n- Tuition'), 'Fees\n*₹1,20,000* total\n• Tuition');
  });

  it('pulls the pin out of a pasted Google Maps link', () => {
    assert.deepEqual(coordinatesFromMapsUrl('https://www.google.com/maps/place/Apex/@28.6129,77.2295,17z'), { latitude: 28.6129, longitude: 77.2295 });
    assert.deepEqual(coordinatesFromMapsUrl('https://maps.google.com/?q=26.9124,75.7873'), { latitude: 26.9124, longitude: 75.7873 });
    assert.equal(coordinatesFromMapsUrl('https://maps.app.goo.gl/AbCdEf'), null);
  });

  it('reads the text out of the message shapes WhatsApp sends', () => {
    assert.deepEqual(messageText({ conversation: 'Fees?' }), { kind: 'text', text: 'Fees?' });
    assert.deepEqual(messageText({ ephemeralMessage: { message: { extendedTextMessage: { text: 'Timing?' } } } }), { kind: 'text', text: 'Timing?' });
    assert.equal(messageText({ audioMessage: {} }).text, '[voice note]');
    assert.equal(messageText({ reactionMessage: { text: '👍' } }), null);
  });
});

/* ── Off by default ──────────────────────────────────────────────────── */

describe('before the owner switches it on', () => {
  it('stores and answers nothing', async () => {
    const parent = newParent();
    assert.deepEqual(await say(parent, 'Hello, fees?'), { handled: false, reason: 'off' });
    assert.equal(conversationOf(parent), undefined);
    assert.equal(fake.calls.length, 0);
  });

  it('is configured from the admissions settings, map link and all', async () => {
    const res = await call('PATCH', '/api/coaching/admissions/assistant', {
      ai_receptionist: true,
      ai_persona_name: 'Riya',
      institute_address: '2nd floor, Sharma Complex, Civil Lines',
      landmark_directions: 'Opposite the SBI ATM, above Bikaner Sweets',
      maps_url: 'https://www.google.com/maps/place/Apex/@26.9124,75.7873,17z',
      director_phone: DIRECTOR,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.ai_receptionist, 1);
    assert.equal(res.body.settings.latitude, 26.9124);
    assert.equal(res.body.settings.longitude, 75.7873);
    assert.equal(res.body.ai_configured, true);

    const bad = await call('PATCH', '/api/coaching/admissions/assistant', { office_open: '20:00', office_close: '09:00' });
    assert.equal(bad.status, 400);
    const teacher = await call('PATCH', '/api/coaching/admissions/assistant', { ai_receptionist: false }, { useToken: teacherToken });
    assert.equal(teacher.status, 403);
  });
});

/* ── Answering ───────────────────────────────────────────────────────── */

describe('answering a parent', () => {
  it('gathers a burst of messages into one grounded reply and files the lead', async () => {
    const parent = newParent();
    fake.script = [
      toolCall('get_fee_details', { course_id: seeded.courseId }),
      textReply('Namaste ji! 12th Board + JEE ki total fees **₹1,20,000** hai, 3 installments mein (pehli ₹40,000 admission par). Batch Mon, Wed, Fri 4:00 PM – 7:00 PM hai.'),
    ];
    // Through the same entry point the socket uses.
    await simulateInboundMessage({ slug: SLUG, jid: parent.jid, phone: parent.phone, pushName: 'Sunita Gupta', id: 'BURST1', text: 'Hello' });
    await simulateInboundMessage({ slug: SLUG, jid: parent.jid, phone: parent.phone, pushName: 'Sunita Gupta', id: 'BURST2', text: '12th + JEE ki fees kitni hai' });
    await simulateInboundMessage({ slug: SLUG, jid: parent.jid, phone: parent.phone, pushName: 'Sunita Gupta', id: 'BURST3', text: 'aur timing?' });
    await receptionistIdle();

    assert.equal(fake.calls.length, 2, 'one exchange (a tool round and the answer) for three messages');
    const prompt = fake.calls[0].contents.at(-1).parts.at(-1).text;
    assert.match(prompt, /- Hello\n- 12th \+ JEE ki fees kitni hai\n- aur timing\?/);
    assert.match(prompt, /"name":"Class 12 Board \+ JEE"/);
    assert.match(prompt, /"qualification":"B.Tech, IIT Delhi"/);
    assert.equal(lastToolResults()[0].response.fee_plans[0].installments[0].amount, 40000);

    const replies = sentTo(parent.jid);
    assert.equal(replies.length, 1);
    assert.match(replies[0].message, /\*₹1,20,000\*/, 'markdown bold became WhatsApp bold');
    assert.deepEqual(
      transcriptOf(parent).map((m) => m.author),
      ['parent', 'parent', 'parent', 'ai'],
    );

    const conv = conversationOf(parent);
    const lead = inTenant(() => get('SELECT * FROM student_inquiries WHERE id = ?', [conv.inquiry_id]));
    assert.equal(lead.ai_captured, 1);
    assert.equal(lead.source, 'whatsapp');
    assert.equal(lead.guardian_name, 'Sunita Gupta');
    assert.equal(lead.phone, `+${parent.phone}`);
  });

  it('ignores a message WhatsApp delivers twice', async () => {
    const parent = newParent();
    fake.script = [textReply('Hello! How can I help you with admissions?')];
    await say(parent, 'Hi', { id: 'DUP1' });
    assert.deepEqual(await say(parent, 'Hi', { id: 'DUP1' }), { handled: false, reason: 'duplicate' });
    await receptionistIdle();
    assert.equal(sentTo(parent.jid).length, 1);
  });

  it('sends a fee it made up back for correction, and uses the corrected reply', async () => {
    const parent = newParent();
    fake.script = [
      toolCall('get_fee_details', { course_id: seeded.courseId }),
      textReply('The fee is ₹99,000 for the year.'),
      textReply('The fee is *₹1,20,000* for the year.'),
    ];
    await say(parent, 'Fees for JEE?');
    await receptionistIdle();
    assert.match(fake.calls.at(-1).contents.at(-1).parts[0].text, /SYSTEM CHECK.*₹99,000/);
    assert.equal(sentTo(parent.jid)[0].message, 'The fee is *₹1,20,000* for the year.');
  });

  it('never sends a fee that is still made up after correction', async () => {
    const parent = newParent();
    fake.script = [textReply('Only ₹75,000 this week!'), textReply('Special price ₹75,000 for you.')];
    await say(parent, 'Any discount?');
    await receptionistIdle();
    const [reply] = sentTo(parent.jid);
    assert.equal(reply.message, FALLBACK_REPLY);
    assert.doesNotMatch(transcriptOf(parent).map((m) => m.body).join(' '), /75,000/);
    const conv = conversationOf(parent);
    assert.equal(conv.needs_staff, 1);
    assert.match(conv.handoff_reason, /75000/);
  });

  it('flags the chat for the desk when the reply promises the team will follow up', async () => {
    const parent = newParent();
    fake.script = [textReply('NEET ka course abhi nahi hai. Discount ke liye hamari team aapse baat karegi.')];
    await say(parent, 'NEET course hai? 30% discount milega?');
    await receptionistIdle();
    const conv = conversationOf(parent);
    assert.equal(conv.needs_staff, 1);
    assert.match(conv.handoff_reason, /30% discount/);
    const lead = inTenant(() => get('SELECT follow_up_on, ai_captured FROM student_inquiries WHERE id = ?', [conv.inquiry_id]));
    assert.equal(lead.follow_up_on, today(), 'on today’s follow-up list');
    assert.equal(lead.ai_captured, 1);
  });

  it('sends a holding message and flags the chat when the model fails', async () => {
    const parent = newParent();
    fake.script = [() => Promise.reject(new Error('429 RESOURCE_EXHAUSTED'))];
    await say(parent, 'Hello?');
    await receptionistIdle();
    assert.equal(sentTo(parent.jid)[0].message, FALLBACK_REPLY);
    assert.equal(conversationOf(parent).needs_staff, 1);
  });
});

/* ── Booking a demo ──────────────────────────────────────────────────── */

describe('booking a demo', () => {
  const parent = newParent();

  it('books the seat, sends the map pin and alerts the director', async () => {
    fake.script = [
      toolCall('get_demo_slots', { course_id: seeded.courseId }),
      toolCall('book_demo', { slot_id: seeded.slotId, date: seeded.demoDate, student_name: 'Aarav Gupta', target_class: 'Class 12', notes: 'Wants JEE evening batch' }),
      textReply('Done! Aarav’s free demo is booked. Sending you our location now. 📍'),
    ];
    await say(parent, 'Haan Wednesday wala demo book kar do, Aarav Gupta, class 12');
    await receptionistIdle();

    const offered = fake.calls[1].contents.at(-1).parts[0].functionResponse.response;
    assert.equal(offered.slots[0].teacher, 'Er. Verma');
    assert.equal(offered.slots[0].seats_left, 4);
    const booked = lastToolResults()[0].response;
    assert.equal(booked.ok, true);
    assert.equal(booked.booking.seats_left, 3);
    assert.equal(booked.location_pin_will_be_sent, true);

    const lead = inTenant(() => get('SELECT * FROM student_inquiries WHERE id = ?', [conversationOf(parent).inquiry_id]));
    assert.equal(lead.status, 'demo_scheduled');
    assert.equal(lead.demo_on, seeded.demoDate);
    assert.equal(lead.demo_time, '16:00');
    assert.equal(lead.demo_slot_id, seeded.slotId);
    assert.equal(lead.student_name, 'Aarav Gupta');
    assert.equal(lead.course_id, seeded.courseId);
    assert.match(lead.notes, /Wants JEE evening batch/);

    const toParent = sentTo(parent.jid);
    assert.equal(toParent.length, 3, 'the reply, the pin, the landmark directions');
    assert.deepEqual(toParent[1].location, { latitude: 26.9124, longitude: 75.7873, name: 'Apex Classes', address: '2nd floor, Sharma Complex, Civil Lines' });
    assert.match(toParent[2].message, /Opposite the SBI ATM/);

    const alert = sentInMemory.find((m) => m.jid === `91${DIRECTOR}@s.whatsapp.net`);
    assert.ok(alert, 'the director heard about it');
    assert.match(alert.message, /🔥 \*HOT LEAD:\* Demo booked for \*Aarav Gupta\*/);
    assert.match(alert.message, /with Er\. Verma/);
    const logged = inTenant(() => get("SELECT * FROM whatsapp_logs WHERE type = 'lead_alert'"));
    assert.equal(logged.status, 'sent');
  });

  it('treats a repeat confirmation as the same booking — no second seat, no second alert', async () => {
    const alertsBefore = sentInMemory.filter((m) => m.jid === `91${DIRECTOR}@s.whatsapp.net`).length;
    fake.script = [
      toolCall('book_demo', { slot_id: seeded.slotId, date: seeded.demoDate, student_name: 'Aarav Gupta' }),
      textReply('Yes, it is confirmed.'),
    ];
    await say(parent, 'Confirm hai na?');
    await receptionistIdle();
    assert.equal(lastToolResults()[0].response.already_booked, true);
    assert.equal(sentInMemory.filter((m) => m.jid === `91${DIRECTOR}@s.whatsapp.net`).length, alertsBefore);
    const seats = inTenant(() => get("SELECT COUNT(*) AS n FROM student_inquiries WHERE demo_slot_id = ? AND status = 'demo_scheduled'", [seeded.slotId]).n);
    assert.equal(seats, 1);
  });

  it('refuses a full slot and a date the slot does not run on', async () => {
    const first = newParent();
    fake.script = [toolCall('book_demo', { slot_id: seeded.tinySlotId, date: seeded.demoDate, student_name: 'Kabir' }), textReply('Booked.')];
    await say(first, 'Book 6 PM for Kabir');
    await receptionistIdle();
    assert.equal(lastToolResults()[0].response.ok, true);

    const second = newParent();
    fake.calls = [];
    fake.script = [
      toolCall('book_demo', { slot_id: seeded.tinySlotId, date: seeded.demoDate, student_name: 'Meera' }),
      toolCall('book_demo', { slot_id: seeded.slotId, date: addDays(seeded.demoDate, 1), student_name: 'Meera' }),
      textReply('Sorry, that one just filled up.'),
    ];
    await say(second, 'Book 6 PM for Meera');
    await receptionistIdle();
    assert.match(fake.calls[1].contents.at(-1).parts[0].functionResponse.response.error, /full/);
    assert.match(lastToolResults()[0].response.error, /not open/);
    assert.equal(inTenant(() => get('SELECT status FROM student_inquiries WHERE student_name = ?', ['Meera']))?.status ?? 'none', 'none');
  });
});

/* ── People first ────────────────────────────────────────────────────── */

describe('human takeover', () => {
  const parent = newParent();

  it('steps back the moment staff reply from the phone', async () => {
    fake.script = [textReply('Hello! Which class is your child in?')];
    await say(parent, 'Hi');
    await receptionistIdle();

    assert.deepEqual(await say(parent, 'Main call karti hoon', { fromMe: true, pushName: null, text: 'Ji, main aapko 10 min mein call karti hoon' }), {
      handled: true,
      reason: 'staff_reply',
    });
    const conv = conversationOf(parent);
    assert.ok(conv.bot_paused_until > new Date().toISOString().replace('T', ' ').slice(0, 19));
    assert.equal(conv.paused_by, 'staff_reply');

    assert.deepEqual(await say(parent, 'Ok thank you'), { handled: true, reason: 'paused' });
    assert.equal(fake.calls.length, 1, 'no model call while paused');
    const authors = transcriptOf(parent).map((m) => m.author);
    assert.deepEqual(authors, ['parent', 'ai', 'staff', 'system', 'parent']);
  });

  it('drops queued messages when staff reply before the assistant does', async () => {
    const other = newParent();
    await say(other, 'Fees?');
    await say(other, 'Hello sir', { fromMe: true, pushName: null });
    await receptionistIdle();
    assert.equal(fake.calls.length, 0);
    assert.equal(sentTo(other.jid).length, 0);
  });

  it('lets the desk read the chat, reply in it and switch the assistant back on', async () => {
    const inquiryId = (() => {
      const conv = conversationOf(parent);
      if (conv.inquiry_id) return conv.inquiry_id;
      return inTenant(() => {
        const info = run("INSERT INTO student_inquiries (student_name, phone) VALUES ('Riya Test', ?)", [`+${parent.phone}`]);
        return Number(info.lastInsertRowid);
      });
    })();

    const chat = await call('GET', `/api/coaching/inquiries/${inquiryId}/whatsapp`);
    assert.equal(chat.status, 200);
    assert.equal(chat.body.conversation.paused, true);
    assert.deepEqual(chat.body.messages.map((m) => m.author), ['parent', 'ai', 'staff', 'system', 'parent']);
    const newer = await call('GET', `/api/coaching/inquiries/${inquiryId}/whatsapp?after=${chat.body.messages.at(-1).id}`);
    assert.equal(newer.body.messages.length, 0);

    const denied = await call('POST', `/api/coaching/inquiries/${inquiryId}/whatsapp/reply`, { text: 'Hi' }, { useToken: teacherToken });
    assert.equal(denied.status, 403);
    const reply = await call('POST', `/api/coaching/inquiries/${inquiryId}/whatsapp/reply`, { text: 'Demo is on Wednesday, see you!' }, { useToken: deskToken });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.messages.at(-1).author, 'staff');
    assert.deepEqual(reply.body.messages.at(-1).meta, { by: 'Desk Riya' });
    assert.equal(sentTo(parent.jid).at(-1).message, 'Demo is on Wednesday, see you!');

    const resumed = await call('POST', `/api/coaching/inquiries/${inquiryId}/whatsapp/assistant`, { paused: false });
    assert.equal(resumed.body.conversation.paused, false);
    fake.script = [textReply('You are welcome!')];
    await say(parent, 'Thanks');
    await receptionistIdle();
    assert.equal(sentTo(parent.jid).at(-1).message, 'You are welcome!');
  });

  it('pauses itself when one chat hits the hourly reply ceiling', async () => {
    const chatty = newParent();
    for (let i = 0; i < 5; i++) {
      fake.script = [textReply(`Reply ${i}`)];
      await say(chatty, `Message ${i}`);
      await receptionistIdle();
    }
    assert.equal(sentTo(chatty.jid).length, 4);
    const conv = conversationOf(chatty);
    assert.equal(conv.paused_by, 'limit');
    assert.equal(conv.needs_staff, 1);
  });

  it('leaves office hours to the desk when told to', async () => {
    await call('PATCH', '/api/coaching/admissions/assistant', { ai_reply_mode: 'after_hours', office_open: '00:00', office_close: '23:59', office_days: [0, 1, 2, 3, 4, 5, 6] });
    try {
      assert.deepEqual(await say(newParent(), 'Hello'), { handled: true, reason: 'office_hours' });
    } finally {
      await call('PATCH', '/api/coaching/admissions/assistant', { ai_reply_mode: 'always' });
    }
  });

  it('does not treat the director’s own messages as a lead', async () => {
    const res = await receiveWhatsAppMessage({ slug: SLUG, jid: `91${DIRECTOR}@s.whatsapp.net`, phone: `91${DIRECTOR}`, id: 'DIR1', text: 'Testing the bot' });
    assert.deepEqual(res, { handled: false, reason: 'insider' });
  });
});

/* ── Isolation ───────────────────────────────────────────────────────── */

describe('one institute’s socket, one institute’s data', () => {
  it('answers only for a CoachBook account that has the assistant on', async () => {
    const parent = newParent();
    assert.deepEqual(await receiveWhatsAppMessage({ slug: GYM, jid: parent.jid, phone: parent.phone, id: 'X1', text: 'Fees?' }), { handled: false, reason: 'not_coaching' });
    assert.deepEqual(await receiveWhatsAppMessage({ slug: OTHER, jid: parent.jid, phone: parent.phone, id: 'X2', text: 'Fees?' }), { handled: false, reason: 'off' });
    assert.deepEqual(await receiveWhatsAppMessage({ slug: 'no-such-place', jid: parent.jid, phone: parent.phone, id: 'X3', text: 'Fees?' }), { handled: false, reason: 'not_coaching' });
    assert.equal(conversationOf(parent), undefined, 'nothing written to Apex for another account’s message');
    assert.equal(inTenant(() => get('SELECT COUNT(*) AS n FROM wa_conversations').n, OTHER), 0);
    assert.equal(fake.calls.length, 0);
  });

  it('marks captured leads on the admissions list', async () => {
    const list = await call('GET', '/api/coaching/inquiries?ai=1');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 2);
    assert.ok(list.body.items.every((i) => i.ai_captured === 1));
    assert.ok(list.body.items.some((i) => i.wa_last_message_at));
    assert.equal(list.body.ai.on, true);
    assert.ok(list.body.ai.captured_this_month >= 2);
    assert.ok(list.body.ai.needs_reply >= 1);
  });
});
