import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/**
 * The owner's WhatsApp voice commands (src/voiceAdmin.js): a voice note from
 * the owner's number is written down, turned into one function call by a
 * scripted model, checked against the gym's data and carried out — member,
 * membership and payment together — with a welcome QR card to the member
 * and a ✅ back to the owner. Plus who may command, the questions asked
 * instead of guessing, and undo.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-voice-admin-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.WHATSAPP_TRANSPORT = 'memory';
process.env.WHATSAPP_MESSAGE_GAP_MS = '0';
process.env.WHATSAPP_CHAT_GAP_MS = '0';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { setAiClientForTests } = await import('../src/aiCoach.js');
const { sentInMemory, simulateInboundMessage } = await import('../src/whatsapp.js');
const { voiceAdminIdle } = await import('../src/voiceAdmin.js');

const GYM = 'steel-house';
const OWNER = { local: '9811177777', phone: '919811177777', jid: '919811177777@s.whatsapp.net' };
const MANAGER = { local: '9822288888', phone: '919822288888', jid: '919822288888@s.whatsapp.net' };
const STRANGER = { local: '9833399999', phone: '919833399999', jid: '919833399999@s.whatsapp.net' };

let root;
let server;
let token;
const plans = {};

const call = async (method, urlPath, body) => {
  const res = await fetch(`${root}/g/${GYM}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const inGym = (fn) => tenantStorage.run({ slug: GYM, dbFile: tenantDbPath(GYM), businessType: 'gym' }, fn);

/* ── A scripted Gemini ───────────────────────────────────────────────── */

const fake = {
  calls: [],
  script: [],
  models: {
    generateContent: async (params) => {
      fake.calls.push(structuredClone({ contents: params.contents, config: { ...params.config, abortSignal: undefined } }));
      const step = fake.script.shift();
      if (!step) throw new Error('The fake model has no scripted reply left');
      if (step instanceof Error) throw step;
      return step;
    },
  },
};

const transcript = (text) => ({ text: JSON.stringify({ text }), usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 30 } });
const toolCall = (name, args = {}) => ({
  functionCalls: [{ id: `call-${name}`, name, args }],
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: `call-${name}`, name, args } }] } }],
  usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40 },
});

/* ── Messages ────────────────────────────────────────────────────────── */

let msgSeq = 0;
const AUDIO = Buffer.from('OggS-fake-opus-voice-note');

/** A voice note from `from`, through the same router the socket uses. */
const voiceNote = (from, extra = {}) =>
  simulateInboundMessage({
    slug: GYM,
    jid: from.jid,
    phone: from.phone,
    id: `VOICE${++msgSeq}`,
    kind: 'media',
    text: '[voice note]',
    audio: { mimetype: 'audio/ogg; codecs=opus', seconds: 9, bytes: AUDIO.length, voiceNote: true, download: async () => AUDIO },
    ...extra,
  });
const typed = (from, text, extra = {}) => simulateInboundMessage({ slug: GYM, jid: from.jid, phone: from.phone, id: `TEXT${++msgSeq}`, kind: 'text', text, ...extra });

const repliesTo = (who) => sentInMemory.filter((m) => m.jid === who.jid && m.type === 'chat');
const lastReplyTo = (who) => repliesTo(who).at(-1)?.message ?? null;
const memberByPhone = (local) => inGym(() => get('SELECT * FROM members WHERE phone = ?', [local]));
const lastLog = () => inGym(() => get('SELECT * FROM voice_admin_log ORDER BY id DESC LIMIT 1'));

const RAHUL = {
  first_name: 'Rahul',
  last_name: 'Verma',
  mobile: '9811223344',
  amount_paid: 4000,
  payment_method: 'cash',
};

before(async () => {
  setAiClientForTests(fake);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;

  const signup = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: GYM, gym_name: 'Steel House', admin_name: 'Owner Name', admin_email: 'owner@steel.test', admin_password: 'strongpass123', business_type: 'gym', currency: 'INR' }),
  });
  assert.equal(signup.status, 201);
  token = (await signup.json()).token;

  // Only this suite's plans are on sale, so the plan list in a question is known.
  inGym(() => run('UPDATE plans SET active = 0'));
  for (const [key, plan] of Object.entries({
    monthly: { name: 'Monthly Gym', price: 1500, duration_days: 30 },
    strength: { name: '3-Month Strength', price: 4500, duration_days: 90 },
    cardio: { name: '3-Month Cardio', price: 4200, duration_days: 90 },
  })) {
    const res = await call('POST', '/api/plans', plan);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    plans[key] = res.body;
  }
  assert.equal((await call('POST', '/api/staff', { name: 'Manager Meera', email: 'meera@steel.test', password: 'managerpass1', role: 'manager' })).status, 201);
  inGym(() => run("UPDATE users SET phone = ? WHERE email = 'meera@steel.test'", [MANAGER.local]));
});

beforeEach(() => {
  fake.calls = [];
  fake.script = [];
});

afterEach(async () => {
  assert.ok(await voiceAdminIdle(), 'every command was answered');
  assert.equal(fake.script.length, 0, 'every scripted model reply was used');
});

after(() => {
  setAiClientForTests(null);
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Turning it on ───────────────────────────────────────────────────── */

describe('switching voice commands on', () => {
  it('is off until the owner turns it on, and leaves their messages alone', async () => {
    const result = await voiceNote(OWNER);
    assert.notEqual(result.reason, 'queued');
    assert.equal(fake.calls.length, 0, 'nothing was sent to the model');
    assert.equal(repliesTo(OWNER).length, 0);
  });

  it('refuses to switch on with no number to trust', async () => {
    inGym(() => run("UPDATE users SET phone = NULL WHERE email = 'meera@steel.test'"));
    const res = await call('PATCH', '/api/trials/settings', { voice_admin: true });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /owner's WhatsApp number/);
    inGym(() => run("UPDATE users SET phone = ? WHERE email = 'meera@steel.test'", [MANAGER.local]));
  });

  it("switches on with the owner's number", async () => {
    const res = await call('PATCH', '/api/trials/settings', { owner_phone: OWNER.local, voice_admin: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.voice_admin, 1);
  });
});

/* ── The happy path ──────────────────────────────────────────────────── */

describe('"Add Rahul Verma, 9811223344, 3-month strength plan, took 4000 cash, starts tomorrow"', () => {
  const said = 'Add Rahul Verma, 9811223344, 3-month strength plan, took 4000 cash, starts tomorrow.';
  let member;

  it('adds the member, sells the plan and logs the payment in one go', async () => {
    const tomorrow = inGym(() => addDays(today(), 1));
    fake.script.push(transcript(said), toolCall('add_member', { ...RAHUL, plan_id: plans.strength.id, start_date: tomorrow }));
    const result = await voiceNote(OWNER);
    assert.equal(result.reason, 'queued');
    assert.ok(await voiceAdminIdle());

    // The clip went to Gemini as audio, with WhatsApp's codecs suffix dropped.
    const audioPart = fake.calls[0].contents[0].parts[0].inlineData;
    assert.equal(audioPart.mimeType, 'audio/ogg');
    assert.equal(audioPart.data, AUDIO.toString('base64'));
    // The instruction went in with the gym's live plans and today's date,
    // and the model could only answer with a function call.
    const ask = fake.calls[1];
    assert.equal(ask.config.toolConfig.functionCallingConfig.mode, 'ANY');
    const prompt = ask.contents[0].parts[0].text;
    assert.ok(prompt.includes(said));
    assert.ok(prompt.includes('3-Month Strength'));
    assert.ok(prompt.includes(inGym(today)));

    member = memberByPhone('9811223344');
    assert.ok(member, 'the member exists');
    assert.equal(member.first_name, 'Rahul');
    assert.equal(member.last_name, 'Verma');
    assert.match(member.code, /^GM\d{4}$/);
    assert.equal(member.status, 'active');
    assert.ok(member.qr_token, 'a QR card was issued');

    const sub = inGym(() => get('SELECT * FROM subscriptions WHERE member_id = ?', [member.id]));
    assert.equal(sub.plan_id, plans.strength.id);
    assert.equal(sub.start_date, tomorrow);
    assert.equal(sub.end_date, addDays(tomorrow, 89));
    assert.equal(sub.price, 4500);
    assert.match(sub.note, /WhatsApp by Owner/);

    const pay = inGym(() => get('SELECT * FROM payments WHERE member_id = ?', [member.id]));
    assert.equal(pay.amount, 4000);
    assert.equal(pay.method, 'cash');
    assert.equal(pay.subscription_id, sub.id);
  });

  it('sends the member a welcome WhatsApp with their QR card', () => {
    const welcome = sentInMemory.find((m) => m.type === 'welcome' && m.memberId === member.id);
    assert.ok(welcome, 'a welcome message went out');
    assert.equal(welcome.jid, '919811223344@s.whatsapp.net');
    assert.equal(welcome.image.mimetype, 'image/png');
    assert.ok(welcome.image.bytes > 500, 'the QR picture is attached');
    assert.match(welcome.message, /Welcome to Steel House, Rahul!/);
    assert.ok(welcome.message.includes(member.code));
  });

  it('tells the owner exactly what was saved', () => {
    const reply = lastReplyTo(OWNER);
    assert.ok(reply.startsWith(`✅ *Rahul Verma* added (${member.code})`), reply);
    assert.ok(reply.includes('98112 23344'));
    assert.ok(reply.includes('3-Month Strength registered'));
    assert.ok(reply.includes('₹4,000 Cash logged'));
    assert.ok(reply.includes('₹500 due'), 'paying less than the price is dues, not a discount');
    assert.ok(reply.includes('Welcome WhatsApp sent to member with QR card.'));
    assert.ok(reply.includes(`Heard: “${said}”`));
    assert.ok(reply.includes('undo'));
    const log = lastLog();
    assert.equal(log.outcome, 'added');
    assert.equal(log.source, 'voice');
    assert.equal(log.transcript, said);
    assert.equal(log.member_id, member.id);
    assert.ok(log.tokens > 0);
  });

  it('ignores WhatsApp redelivering the same voice note', async () => {
    const id = `VOICE${msgSeq}`;
    const result = await simulateInboundMessage({ slug: GYM, jid: OWNER.jid, phone: OWNER.phone, id, kind: 'media', text: '[voice note]', audio: { mimetype: 'audio/ogg', download: async () => AUDIO } });
    assert.equal(result.reason, 'duplicate');
    assert.equal(fake.calls.length, 0);
  });

  it('will not add the same number twice', async () => {
    fake.script.push(transcript('Add Rahul, 98112 23344, monthly'), toolCall('add_member', { first_name: 'Rahul', mobile: '98112 23344', plan_id: plans.monthly.id }));
    await voiceNote(OWNER);
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), new RegExp(`already \\*Rahul Verma\\* \\(${member.code}\\) — nothing was added`));
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM members WHERE phone = ?', ['9811223344']).n), 1);
  });

  it('reverses the entry when the owner replies "undo"', async () => {
    await typed(OWNER, 'undo');
    assert.ok(await voiceAdminIdle());
    assert.equal(fake.calls.length, 0, 'undo needs no model');
    assert.match(lastReplyTo(OWNER), /↩️ Undone: \*Rahul Verma\*.*3-Month Strength membership and the ₹4,000 Cash payment/);
    assert.equal(memberByPhone('9811223344'), undefined);
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM payments WHERE amount = 4000').n), 0);

    await typed(OWNER, 'undo');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /Nothing to undo/);
  });
});

/* ── Asking instead of guessing ──────────────────────────────────────── */

describe('when something is missing or does not add up', () => {
  it('asks which plan, then carries out the answer with the first message', async () => {
    fake.script.push(toolCall('ask_owner', { question: 'Which 3-month plan — 3-Month Strength (₹4,500) or 3-Month Cardio (₹4,200)?' }));
    await typed(OWNER, 'Add Priya Sharma 9876501234, 3 month plan, 4200 UPI');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /^❓ Which 3-month plan/);
    assert.equal(lastLog().outcome, 'clarify');
    assert.equal(memberByPhone('9876501234'), undefined, 'nothing saved while asking');

    fake.script.push(toolCall('add_member', { first_name: 'Priya', last_name: 'Sharma', mobile: '9876501234', plan_id: plans.cardio.id, amount_paid: 4200, payment_method: 'upi' }));
    await typed(OWNER, 'cardio');
    assert.ok(await voiceAdminIdle());
    const data = JSON.parse(fake.calls[1].contents[0].parts[0].text.split('\n')[1]);
    assert.deepEqual(data.PENDING_QUESTION, [
      { owner_said: 'Add Priya Sharma 9876501234, 3 month plan, 4200 UPI', you_asked: 'Which 3-month plan — 3-Month Strength (₹4,500) or 3-Month Cardio (₹4,200)?' },
    ]);
    const priya = memberByPhone('9876501234');
    assert.ok(priya);
    assert.equal(inGym(() => get('SELECT plan_id FROM subscriptions WHERE member_id = ?', [priya.id])).plan_id, plans.cardio.id);
    assert.match(lastReplyTo(OWNER), /₹4,200 UPI logged · fully paid/);
  });

  it('asks again for a number that is not ten digits', async () => {
    fake.script.push(toolCall('add_member', { first_name: 'Aman', mobile: '981122334', plan_id: plans.monthly.id }));
    await typed(OWNER, 'Add Aman 981122334 monthly');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /981122334 — that is 9 digits\. What is Aman's 10-digit mobile number\?/);
    assert.equal(lastLog().outcome, 'clarify');
  });

  it('asks before taking more money than the plan costs', async () => {
    fake.script.push(transcript('Add Kabir Rao 9700011122 monthly, took 15000 cash'), toolCall('add_member', { first_name: 'Kabir', last_name: 'Rao', mobile: '9700011122', plan_id: plans.monthly.id, amount_paid: 15000 }));
    await voiceNote(OWNER);
    assert.ok(await voiceAdminIdle());
    const reply = lastReplyTo(OWNER);
    assert.match(reply, /₹15,000 is more than the Monthly Gym price of ₹1,500/);
    assert.ok(reply.includes('Heard: “Add Kabir Rao'), 'the owner sees what was heard');
    assert.equal(memberByPhone('9700011122'), undefined);
  });

  it('refuses a plan id that is not on sale', async () => {
    fake.script.push(toolCall('add_member', { first_name: 'Neha', mobile: '9700011123', plan_id: 9999 }));
    await typed(OWNER, 'Add Neha 9700011123 gold plan');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /Which plan is Neha joining\?\n• Monthly Gym — ₹1,500/);
  });

  it('says so when the voice note is silent', async () => {
    fake.script.push(transcript(''));
    await voiceNote(OWNER);
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /could not make out anything/);
  });

  it('says what it cannot do yet', async () => {
    fake.script.push(toolCall('cannot_do', { message: 'From WhatsApp I can only add new members for now — renew Priya in GymBook.' }));
    await typed(OWNER, 'Renew Priya for another month');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /only add new members for now[\s\S]*Try: "Add Rahul Verma/);
  });

  it('stays quiet about a message meant for the staff, and leaves it unread', async () => {
    const before = repliesTo(OWNER).length;
    fake.script.push(toolCall('not_for_me'));
    await typed(OWNER, 'Ramesh, please switch on the AC on the first floor');
    assert.ok(await voiceAdminIdle());
    assert.equal(repliesTo(OWNER).length, before);
    assert.equal(lastLog().outcome, 'ignored');
  });

  it('answers with nothing changed when the model is down', async () => {
    fake.script.push(new Error('503 Service Unavailable'));
    await typed(OWNER, 'Add Dev 9700011124 monthly');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(OWNER), /nothing was changed/);
    assert.equal(lastLog().outcome, 'failed');
    assert.equal(memberByPhone('9700011124'), undefined);
  });
});

/* ── Who may command ─────────────────────────────────────────────────── */

describe('who may send commands', () => {
  it("takes a manager's own phone", async () => {
    fake.script.push(toolCall('add_member', { first_name: 'Sana', mobile: '9700022211', plan_id: plans.monthly.id, amount_paid: 1500 }));
    await typed(MANAGER, 'Add Sana 9700022211 monthly 1500 cash');
    assert.ok(await voiceAdminIdle());
    assert.match(lastReplyTo(MANAGER), /✅ \*Sana\* added/);
    assert.equal(lastLog().sender_name, 'Manager Meera');
    // Undo reaches only the sender's own entries.
    await typed(OWNER, 'undo');
    assert.ok(await voiceAdminIdle());
    assert.ok(memberByPhone('9700022211'), "the owner's undo did not touch the manager's entry");
  });

  it('passes anyone else on to the front desk untouched', async () => {
    const result = await voiceNote(STRANGER);
    assert.notEqual(result.reason, 'queued');
    assert.equal(fake.calls.length, 0);
    assert.equal(repliesTo(STRANGER).length, 0);
  });

  it("ignores staff typing to someone from the gym's phone", async () => {
    const result = await typed(STRANGER, 'Add Rahul 9811223344 monthly', { fromMe: true });
    assert.notEqual(result.reason, 'queued');
    assert.equal(fake.calls.length, 0);
  });

  it("takes the linked phone's chat with itself when that is the owner's number", async () => {
    fake.script.push(toolCall('not_for_me'));
    const result = await typed(OWNER, 'hello', { fromMe: true, self: true });
    assert.equal(result.reason, 'queued');
  });
});

/* ── Free-trial leads ────────────────────────────────────────────────── */

describe('a free-trial lead who joins', () => {
  it('marks the lead joined, and undo opens it again', async () => {
    const lead = await call('POST', '/api/trials/leads', { name: 'Isha Kapoor', phone: '9700033311', source: 'walk_in' });
    assert.equal(lead.status, 201, JSON.stringify(lead.body));

    fake.script.push(toolCall('add_member', { first_name: 'Isha', last_name: 'Kapoor', mobile: '9700033311', plan_id: plans.monthly.id, amount_paid: 1500, payment_method: 'upi' }));
    await typed(OWNER, 'Isha Kapoor joined, 9700033311, monthly, 1500 GPay');
    assert.ok(await voiceAdminIdle());
    const isha = memberByPhone('9700033311');
    let row = inGym(() => get('SELECT status, member_id FROM gym_leads WHERE id = ?', [lead.body.id]));
    assert.equal(row.status, 'converted');
    assert.equal(row.member_id, isha.id);
    assert.match(lastReplyTo(OWNER), /free-trial lead is marked as joined/);

    await typed(OWNER, 'Undo');
    assert.ok(await voiceAdminIdle());
    row = inGym(() => get('SELECT status, member_id FROM gym_leads WHERE id = ?', [lead.body.id]));
    assert.equal(row.status, 'new');
    assert.equal(row.member_id, null);
  });
});
