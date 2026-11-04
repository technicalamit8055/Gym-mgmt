import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/**
 * GymBook's WhatsApp front desk and free trial passes: the desk issuing,
 * sending, scanning and cancelling passes under the one-trial-per-number
 * rules; the follow-up sweep; and the AI assistant answering from the gym's
 * live plans and booking a trial — the QR pass, the map pin and the owner's
 * alert — against a scripted model.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-gym-receptionist-test-'));
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

const { createApp } = await import('../src/app.js');
const { all, closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { utcTimestamp } = await import('../src/clock.js');
const { setAiClientForTests } = await import('../src/aiCoach.js');
const { sentInMemory, simulateInboundMessage } = await import('../src/whatsapp.js');
const { receptionistIdle } = await import('../src/waChat.js');
const { receiveGymWhatsAppMessage } = await import('../src/gymReceptionist.js');
const { FALLBACK_REPLY } = await import('../src/gymReceptionistAi.js');
const { issueTrialPass, sendTrialFollowUps, trialCodeFromScan } = await import('../src/trialPasses.js');

const GYM = 'iron-den';
const HALL = 'quiet-hall';
const ACADEMY = 'apex-academy';
const OWNER = '9811177777';

/** A zone where it is around midday now, so the follow-up sweep's daytime
 * window is open whenever the suite runs, and the gym's "today" is the same
 * day for the requests and for the sweep. */
const MIDDAY_ZONE = (() => {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
})();

let root;
let server;
let token;
let trainerToken;

const call = async (method, urlPath, body, { useToken = token, slug = GYM } = {}) => {
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

const signup = (slug, name, email, businessType, extra = {}) =>
  call(
    'POST',
    '/api/platform/signup',
    { slug, gym_name: name, admin_name: 'Owner Name', admin_email: email, admin_password: 'strongpass123', business_type: businessType, currency: 'INR', ...extra },
    { useToken: null, slug: null },
  );

const inGym = (fn) => tenantStorage.run({ slug: GYM, dbFile: tenantDbPath(GYM), timezone: MIDDAY_ZONE, businessType: 'gym' }, fn);

/* ── A scripted Gemini ───────────────────────────────────────────────── */

const fake = {
  calls: [],
  script: [],
  models: {
    generateContent: async (params) => {
      fake.calls.push(structuredClone({ contents: params.contents, system: params.config.systemInstruction }));
      const step = fake.script.shift();
      if (!step) throw new Error('The fake model has no scripted reply left');
      return step;
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
const toolResultsAt = (i) =>
  fake.calls[i].contents
    .at(-1)
    .parts.filter((p) => p.functionResponse)
    .map((p) => p.functionResponse.response);

let phoneSeq = 0;
/** A fresh visitor number per test, so chats, leads and trials never overlap. */
const newVisitor = () => {
  phoneSeq += 1;
  const local = `97${String(phoneSeq).padStart(8, '0')}`;
  return { local, phone: `91${local}`, jid: `91${local}@s.whatsapp.net` };
};
let msgSeq = 0;
const say = (visitor, text, extra = {}) =>
  receiveGymWhatsAppMessage({ slug: GYM, jid: visitor.jid, phone: visitor.phone, pushName: 'Priya', id: `GYMMSG${++msgSeq}`, text, kind: 'text', fromMe: false, ...extra });

const conversationOf = (visitor) => inGym(() => get('SELECT * FROM wa_conversations WHERE jid = ?', [visitor.jid]));
const sentTo = (jid) => sentInMemory.filter((m) => m.jid === jid);
const waitFor = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return check();
};

/** A walk-in filed at the desk. */
const fileLead = async (visitor, extra = {}) => {
  const res = await call('POST', '/api/trials/leads', { name: 'Rahul Sharma', phone: visitor.local, goal: 'Weight loss', ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

before(async () => {
  setAiClientForTests(fake);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;

  const gym = await signup(GYM, 'Iron Den', 'owner@iron.test', 'gym', { timezone: MIDDAY_ZONE });
  assert.equal(gym.status, 201, JSON.stringify(gym.body));
  token = gym.body.token;
  assert.equal((await signup(HALL, 'Quiet Hall', 'owner@hall.test', 'library')).status, 201);
  assert.equal((await signup(ACADEMY, 'Apex Academy', 'owner@apex.test', 'coaching')).status, 201);

  assert.equal((await call('POST', '/api/staff', { name: 'Coach Vikram', email: 'vikram@iron.test', password: 'trainerpass1', role: 'trainer' })).status, 201);
  trainerToken = (await call('POST', '/api/auth/login', { email: 'vikram@iron.test', password: 'trainerpass1' }, { useToken: null })).body.token;
  inGym(() => run("UPDATE users SET qualification = 'ACE certified', specialization = 'Fat loss' WHERE email = 'vikram@iron.test'"));
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

/* ── The desk ────────────────────────────────────────────────────────── */

describe('trial passes at the desk', () => {
  const rahul = newVisitor();
  let lead;
  let pass;

  it('reads a pass code however the desk receives it', () => {
    assert.equal(trialCodeFromScan('GBT1:TR7K4Q2M'), 'TR7K4Q2M');
    assert.equal(trialCodeFromScan('gbt1:tr7k4q2m\n'), 'TR7K4Q2M');
    assert.equal(trialCodeFromScan('tr7k-4q2m'), 'TR7K4Q2M');
    assert.equal(trialCodeFromScan('GB1:abcdef'), null, 'a member card is not a pass');
    assert.equal(trialCodeFromScan('GM0042'), null);
  });

  it('files a walk-in, issues a pass and sends its QR on WhatsApp', async () => {
    lead = await fileLead(rahul, { source: 'walk_in' });
    assert.equal(lead.stage, 'lead');

    const res = await call('POST', `/api/trials/leads/${lead.id}/pass`, {});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    pass = res.body;
    assert.match(pass.code, /^TR[A-Z2-9]{6}$/);
    assert.equal(pass.payload, `GBT1:${pass.code}`);
    assert.equal(pass.state, 'active');
    assert.equal(pass.valid_from, inGym(today));
    assert.equal(pass.valid_until, inGym(() => addDays(today(), 2)), 'three days by default');
    assert.equal(pass.visits_allowed, 3);
    assert.equal(pass.sent, true);
    assert.match(pass.svg, /<svg/);
    assert.equal(pass.lead.stage, 'booked');

    const sent = sentTo(rahul.jid).at(-1);
    assert.ok(sent.image, 'the QR went as a picture');
    assert.match(sent.message, new RegExp(`Pass code: \\*${pass.code}\\*`));
    assert.match(sent.message, /\*Rahul Sharma\*/);
    assert.match(sent.message, /Free trial pass — Iron Den/);
  });

  it('checks a trial visitor in from the QR, once a day', async () => {
    const look = await call('POST', '/api/qr/lookup', { code: pass.payload });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.equal(look.body.trial.name, 'Rahul Sharma');
    assert.equal(look.body.trial.can_check_in, true);
    assert.equal(look.body.trial.visits_used, 0);

    const first = await call('POST', '/api/qr/check-in', { code: pass.payload });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.action, 'trial_checked_in');
    assert.equal(first.body.trial.visits_used, 1);
    assert.equal(first.body.trial.visits_left, 2);
    assert.equal(first.body.trial.first_visit, true);

    const again = await call('POST', '/api/qr/check-in', { code: pass.payload });
    assert.equal(again.status, 200);
    assert.equal(again.body.action, 'trial_already_in');

    // Typed off the visitor's phone into the ordinary desk box.
    const typed = await call('POST', '/api/attendance/check-in', { code: `${pass.code.slice(0, 4).toLowerCase()} ${pass.code.slice(4)}` });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.equal(typed.body.trial.visits_used, 1, 'still one visit');

    const list = await call('GET', '/api/trials');
    assert.equal(list.body.items.find((l) => l.id === lead.id).stage, 'visited');
    assert.equal(list.body.in_today, 1);
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM attendance').n), 0, 'a trial visitor is not on the members’ attendance');
  });

  it('refuses a pass that has not started, was cancelled or is used up', async () => {
    const later = await fileLead(newVisitor(), { name: 'Neha Kapoor' });
    const tomorrow = inGym(() => addDays(today(), 1));
    const issued = await call('POST', `/api/trials/leads/${later.id}/pass`, { start_on: tomorrow, send: false });
    assert.equal(issued.status, 201);
    assert.equal(issued.body.state, 'upcoming');
    assert.equal(issued.body.sent, null, 'not sent when asked not to');
    const early = await call('POST', '/api/qr/check-in', { code: issued.body.payload });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /Neha Kapoor's trial starts on/);

    const revoked = await call('POST', `/api/trials/passes/${issued.body.id}/revoke`);
    assert.equal(revoked.body.state, 'revoked');
    assert.equal(revoked.body.lead.status, 'new');
    assert.match((await call('POST', '/api/qr/check-in', { code: issued.body.payload })).body.error, /cancelled/);

    const used = await fileLead(newVisitor(), { name: 'Arjun Mehta' });
    const usedPass = (await call('POST', `/api/trials/leads/${used.id}/pass`, { send: false })).body;
    inGym(() => {
      run('UPDATE trial_passes SET valid_from = ?, visits_allowed = 1 WHERE id = ?', [addDays(today(), -1), usedPass.id]);
      run('INSERT INTO trial_visits (pass_id, visit_date) VALUES (?, ?)', [usedPass.id, addDays(today(), -1)]);
    });
    const spent = await call('POST', '/api/qr/check-in', { code: usedPass.payload });
    assert.equal(spent.status, 400);
    assert.match(spent.body.error, /used all 1 trial visits/);
  });

  it('allows one trial per number, never to a member, and the desk can override', async () => {
    // The same person, the number typed another way.
    const again = await fileLead({ local: `+91-${rahul.local.slice(0, 5)}-${rahul.local.slice(5)}` }, { name: 'Rahul S' });
    const refused = await call('POST', `/api/trials/leads/${again.id}/pass`, { send: false });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.details.code, 'cooldown');
    assert.match(refused.body.error, /already had a free trial/);
    const forced = await call('POST', `/api/trials/leads/${again.id}/pass`, { send: false, override: true });
    assert.equal(forced.status, 201, JSON.stringify(forced.body));

    const meera = newVisitor();
    assert.equal((await call('POST', '/api/members', { first_name: 'Meera', phone: meera.local })).status, 201);
    const memberLead = await fileLead(meera, { name: 'Meera Iyer' });
    const member = await call('POST', `/api/trials/leads/${memberLead.id}/pass`, { send: false });
    assert.equal(member.status, 409);
    assert.equal(member.body.details.code, 'member');

    const lookup = await call('GET', `/api/trials/lookup?phone=${meera.local}`);
    assert.equal(lookup.body.member.first_name, 'Meera');
  });

  it('caps how many trials start on one day', async () => {
    const startingToday = inGym(() => get("SELECT COUNT(*) AS n FROM trial_passes WHERE valid_from = ? AND status = 'active'", [today()]).n);
    assert.equal((await call('PATCH', '/api/trials/settings', { trial_daily_cap: startingToday })).status, 200);
    const late = await fileLead(newVisitor(), { name: 'Kabir Singh' });
    const full = await call('POST', `/api/trials/leads/${late.id}/pass`, { send: false });
    assert.equal(full.status, 409);
    assert.equal(full.body.details.code, 'full');
    const tomorrow = await call('POST', `/api/trials/leads/${late.id}/pass`, { send: false, start_on: inGym(() => addDays(today(), 1)) });
    assert.equal(tomorrow.status, 201);
    const tooFar = await fileLead(newVisitor(), { name: 'Isha Rao' });
    const far = await call('POST', `/api/trials/leads/${tooFar.id}/pass`, { send: false, start_on: inGym(() => addDays(today(), 30)) });
    assert.equal(far.body.details.code, 'too_far');
    assert.equal((await call('PATCH', '/api/trials/settings', { trial_daily_cap: 0 })).status, 200);
  });

  it('turns a lead into a member, after which the pass no longer checks in', async () => {
    const res = await call('POST', `/api/trials/leads/${lead.id}/convert`, {});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.lead.stage, 'converted');
    const member = (await call('GET', `/api/members/${res.body.member_id}`)).body;
    assert.match(member.code, /^GM\d{4}$/);
    assert.equal(member.first_name, 'Rahul');
    assert.equal(member.last_name, 'Sharma');
    assert.equal((await call('POST', `/api/trials/leads/${lead.id}/convert`, {})).status, 409);
    const blocked = await call('POST', '/api/qr/check-in', { code: pass.payload });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /member now/);
  });

  it('lets a trainer look but not file, and is not part of a study hall', async () => {
    assert.equal((await call('GET', '/api/trials', undefined, { useToken: trainerToken })).status, 200);
    assert.equal((await call('POST', '/api/trials/leads', { name: 'X Y', phone: '9000000000' }, { useToken: trainerToken })).status, 403);
    assert.equal((await call('PATCH', '/api/trials/settings', { trial_days: 5 }, { useToken: trainerToken })).status, 403);

    const hallOwner = (await call('POST', '/api/auth/login', { email: 'owner@hall.test', password: 'strongpass123' }, { useToken: null, slug: HALL })).body.token;
    const hall = await call('GET', '/api/trials', undefined, { useToken: hallOwner, slug: HALL });
    assert.equal(hall.status, 404);
    assert.equal(hall.body.details.code, 'module_not_enabled');
  });
});

/* ── Follow-ups ──────────────────────────────────────────────────────── */

describe('trial follow-ups', () => {
  /** A lead with a pass, its days and visits arranged by `arrange`. */
  const trialFor = (visitor, name, arrange) =>
    inGym(() => {
      const leadId = Number(run("INSERT INTO gym_leads (name, phone, status) VALUES (?, ?, 'new')", [name, visitor.local]).lastInsertRowid);
      const { pass } = issueTrialPass(get('SELECT * FROM gym_leads WHERE id = ?', [leadId]), { startOn: today() });
      arrange(pass.id);
      return pass.id;
    });

  it('nudges a no-show, asks a visitor how it went and reminds on the last day — once each', async () => {
    const noShow = newVisitor();
    const visited = newVisitor();
    const lastDay = newVisitor();
    const handled = newVisitor();
    trialFor(noShow, 'Sana Khan', (id) => run('UPDATE trial_passes SET valid_from = ?, valid_until = ? WHERE id = ?', [addDays(today(), -1), addDays(today(), 1), id]));
    trialFor(visited, 'Dev Patel', (id) => run('INSERT INTO trial_visits (pass_id, visit_date, check_in) VALUES (?, ?, ?)', [id, today(), utcTimestamp(-3 * 3_600_000)]));
    trialFor(lastDay, 'Tara Nair', (id) => {
      run("UPDATE trial_passes SET valid_from = ?, valid_until = ?, visited_sent_at = datetime('now', '-2 days') WHERE id = ?", [addDays(today(), -2), today(), id]);
      run('INSERT INTO trial_visits (pass_id, visit_date, check_in) VALUES (?, ?, ?)', [id, addDays(today(), -1), utcTimestamp(-26 * 3_600_000)]);
    });
    // Someone on the team is talking to this one: no automated message.
    trialFor(handled, 'Om Joshi', (id) => {
      run('UPDATE trial_passes SET valid_from = ? WHERE id = ?', [addDays(today(), -1), id]);
      run("INSERT INTO wa_conversations (jid, phone, bot_paused_until) VALUES (?, ?, '9999-12-31 23:59:59')", [handled.jid, handled.phone]);
    });

    const queued = inGym(() => sendTrialFollowUps({ gymName: 'Iron Den' }));
    assert.ok(queued >= 3, `queued ${queued}`);
    assert.ok(await waitFor(() => sentTo(noShow.jid).length && sentTo(visited.jid).length && sentTo(lastDay.jid).length));
    assert.match(sentTo(noShow.jid)[0].message, /Hi Sana, your free trial pass at Iron Den is waiting for you/);
    assert.match(sentTo(visited.jid)[0].message, /Hi Dev, thanks for training with us at Iron Den! How did you find the workout\?/);
    assert.match(sentTo(lastDay.jid)[0].message, /Hi Tara, your free trial at Iron Den ends on/);
    assert.equal(sentTo(handled.jid).length, 0);

    const transcript = inGym(() => get("SELECT m.meta FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id WHERE c.jid = ?", [noShow.jid]));
    assert.deepEqual(JSON.parse(transcript.meta), { followup: 'noshow' });

    inGym(() => sendTrialFollowUps({ gymName: 'Iron Den' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const v of [noShow, visited, lastDay]) assert.equal(sentTo(v.jid).length, 1, 'once each');
  });
});

/* ── The WhatsApp front desk ─────────────────────────────────────────── */

describe('the WhatsApp front desk', () => {
  const priya = newVisitor();

  it('stores and answers nothing until it is switched on', async () => {
    const v = newVisitor();
    assert.deepEqual(await say(v, 'Hi, fees?'), { handled: false, reason: 'off' });
    assert.equal(conversationOf(v), undefined);
    assert.equal(fake.calls.length, 0);
  });

  it('switches on from the trials settings, starting the plan’s free trial', async () => {
    const res = await call('PATCH', '/api/trials/settings', {
      ai_receptionist: true,
      ai_persona_name: 'Zoya',
      opening_hours: 'Mon–Sat 5:30 AM – 10:30 PM, Sun 7 AM – 12 PM',
      ai_persona_notes: 'Steam room and lockers included. Couples get 10% off the Quarterly plan.',
      gym_address: '1st floor, Galaxy Mall, Sector 18',
      landmark_directions: 'Above the Domino’s, lift on the left',
      maps_url: 'https://www.google.com/maps/place/Iron+Den/@28.5708,77.3260,17z',
      owner_phone: OWNER,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.trial_started, true);
    assert.equal(res.body.plan.status, 'trial');
    assert.equal(res.body.settings.latitude, 28.5708);
    assert.equal(res.body.settings.longitude, 77.326);

    assert.equal((await call('PATCH', '/api/trials/settings', { trial_visits: 10 })).status, 400, 'more visits than days');
    assert.equal((await call('PATCH', '/api/trials/settings', { owner_phone: '12' })).status, 400);
  });

  it('answers from the live plans and files the lead', async () => {
    fake.script = [
      toolCall('save_lead', { name: 'Priya', goal: 'weight loss', preferred_time: 'evenings' }),
      textReply('Hi Priya! 😊 Our **Monthly** plan is ₹1,500 for 1 month, and the gym is open Mon–Sat 5:30 AM – 10:30 PM. Would you like a free 3-day trial?'),
    ];
    // Through the same entry point the socket uses.
    const first = await simulateInboundMessage({ slug: GYM, jid: priya.jid, phone: priya.phone, pushName: 'Priya', id: 'P1', text: 'Hi' });
    assert.deepEqual(first, { handled: true, reason: 'queued' });
    await simulateInboundMessage({ slug: GYM, jid: priya.jid, phone: priya.phone, pushName: 'Priya', id: 'P2', text: 'monthly fees kitni hai? weight loss karna hai, evening' });
    await receptionistIdle();

    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[0].system, /virtual front-desk assistant of Iron Den, a gym/);
    assert.match(fake.calls[0].system, /Zoya/);
    const prompt = fake.calls[0].contents.at(-1).parts.at(-1).text;
    assert.match(prompt, /^GYM DATA/);
    assert.match(prompt, /- Hi\n- monthly fees kitni hai/);
    assert.match(prompt, /"name":"Monthly","price":1500,"duration":"1 month"/);
    assert.match(prompt, /"opening_hours":"Mon–Sat 5:30 AM – 10:30 PM, Sun 7 AM – 12 PM"/);
    assert.match(prompt, /"qualification":"ACE certified"/);
    assert.match(prompt, /"free_trial":\{"offered":true,"days":3,"visits":3/);

    const replies = sentTo(priya.jid);
    assert.equal(replies.length, 1);
    assert.match(replies[0].message, /\*Monthly\* plan is ₹1,500/);

    const lead = inGym(() => get('SELECT * FROM gym_leads WHERE id = ?', [conversationOf(priya).lead_id]));
    assert.equal(lead.ai_captured, 1);
    assert.equal(lead.source, 'whatsapp');
    assert.equal(lead.name, 'Priya');
    assert.equal(lead.goal, 'weight loss');
    assert.equal(lead.phone, `+${priya.phone}`);
  });

  it('books a free trial: the QR pass, the map pin and the owner’s hot-lead alert', async () => {
    const start = inGym(today);
    fake.script = [
      toolCall('get_trial_dates'),
      toolCall('book_trial', { name: 'Priya Verma', start_date: start, arrival_time: '18:30', note: 'Wants evening workouts' }),
      textReply('Done, Priya ji! Your free trial is booked — sending your pass now. 🎟️'),
    ];
    await say(priya, 'Haan aaj se trial kar lungi, 6:30 baje aaungi. Priya Verma');
    await receptionistIdle();

    const offered = toolResultsAt(1)[0];
    assert.equal(offered.ok, true);
    assert.equal(offered.dates[0].date, start);
    assert.equal(offered.trial_days, 3);
    const booked = toolResultsAt(2)[0];
    assert.equal(booked.ok, true, JSON.stringify(booked));
    assert.equal(booked.qr_pass_will_be_sent, true);
    assert.equal(booked.location_pin_will_be_sent, true);
    assert.equal(booked.trial.arrival, '6:30 PM');

    const lead = inGym(() => get('SELECT * FROM gym_leads WHERE id = ?', [conversationOf(priya).lead_id]));
    assert.equal(lead.status, 'trial');
    assert.equal(lead.name, 'Priya Verma');
    assert.match(lead.notes, /Wants evening workouts/);
    const pass = inGym(() => get('SELECT * FROM trial_passes WHERE lead_id = ?', [lead.id]));
    assert.equal(pass.issued_by, 'ai');
    assert.equal(pass.arrival_time, '18:30');
    assert.ok(pass.sent_at);

    const toPriya = sentTo(priya.jid).slice(1);
    assert.equal(toPriya.length, 4, 'the reply, the pass, the pin, the landmark directions');
    assert.match(toPriya[0].message, /sending your pass now/);
    assert.ok(toPriya[1].image);
    assert.match(toPriya[1].message, new RegExp(pass.code));
    assert.match(toPriya[1].message, /we expect you around 6:30 PM/);
    assert.deepEqual(toPriya[2].location, { latitude: 28.5708, longitude: 77.326, name: 'Iron Den', address: '1st floor, Galaxy Mall, Sector 18' });
    assert.match(toPriya[3].message, /Above the Domino’s/);

    const alert = sentInMemory.find((m) => m.jid === `91${OWNER}@s.whatsapp.net`);
    assert.ok(alert, 'the owner heard about it');
    assert.match(alert.message, /🔥 \*HOT LEAD:\* Free trial booked for \*Priya Verma\*/);
    assert.match(alert.message, /coming around 6:30 PM/);
    assert.match(alert.message, /Goal: weight loss/);
    assert.equal(inGym(() => get("SELECT status FROM whatsapp_logs WHERE type = 'lead_alert'")).status, 'sent');
  });

  it('treats a repeat confirmation as the same pass — no second pass, no second alert', async () => {
    const before = sentTo(priya.jid).length;
    fake.script = [toolCall('book_trial', { name: 'Priya Verma', start_date: inGym(today) }), textReply('Your pass is already on its way, Priya ji! See you at 6:30.')];
    await say(priya, 'confirm hai na?');
    await receptionistIdle();
    assert.equal(toolResultsAt(1)[0].already_issued, true);
    assert.equal(sentTo(priya.jid).length, before + 1, 'just the reply');
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM trial_passes WHERE lead_id = ?', [conversationOf(priya).lead_id]).n), 1);
    assert.equal(sentInMemory.filter((m) => m.jid === `91${OWNER}@s.whatsapp.net`).length, 1);
  });

  it('will not book a trial for a member', async () => {
    const member = newVisitor();
    assert.equal((await call('POST', '/api/members', { first_name: 'Kunal', phone: member.local })).status, 201);
    fake.script = [toolCall('get_trial_dates'), textReply('Hi Kunal! You are already a member with us, so the team will help you out here shortly.')];
    await say(member, 'Can I get a free trial?');
    await receptionistIdle();
    const result = toolResultsAt(1)[0];
    assert.equal(result.ok, false);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /belongs to a member \(Kunal/);
    assert.match(fake.calls[0].contents.at(-1).parts.at(-1).text, /"KNOWN_MEMBER":\{"first_name":"Kunal"/);
  });

  it('never sends a price it made up', async () => {
    const v = newVisitor();
    fake.script = [textReply('Monthly is just ₹999!'), textReply('Sorry, monthly is ₹999 only.')];
    await say(v, 'monthly kitne ka hai');
    await receptionistIdle();
    assert.match(fake.calls[1].contents.at(-1).parts[0].text, /SYSTEM CHECK \(not from the contact\).*₹999.*GYM DATA/);
    assert.equal(sentTo(v.jid)[0].message, FALLBACK_REPLY);
    const conv = conversationOf(v);
    assert.equal(conv.needs_staff, 1);
    assert.match(conv.handoff_reason, /999/);
  });

  it('steps back when staff reply, and lets the desk read and answer the chat', async () => {
    const leadId = conversationOf(priya).lead_id;
    assert.deepEqual(await say(priya, 'Thanks bhaiya, see you', { fromMe: true }), { handled: true, reason: 'staff_reply' });
    assert.deepEqual(await say(priya, 'Locker hai?'), { handled: true, reason: 'paused' });

    const chat = await call('GET', `/api/trials/leads/${leadId}/whatsapp`);
    assert.equal(chat.status, 200);
    assert.equal(chat.body.conversation.paused, true);
    assert.equal(chat.body.conversation.paused_by, 'staff_reply');
    assert.ok(chat.body.messages.some((m) => m.author === 'ai' && m.kind === 'media' && m.meta.trial_pass));

    const reply = await call('POST', `/api/trials/leads/${leadId}/whatsapp/reply`, { text: 'Yes, lockers are free for members.' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(sentTo(priya.jid).at(-1).message, 'Yes, lockers are free for members.');
    const resumed = await call('POST', `/api/trials/leads/${leadId}/whatsapp/assistant`, { paused: false });
    assert.equal(resumed.body.conversation.paused, false);
  });

  it('does not treat the owner as a lead, and answers only for a live GymBook account', async () => {
    assert.deepEqual(await say({ jid: `91${OWNER}@s.whatsapp.net`, phone: `91${OWNER}` }, 'test'), { handled: false, reason: 'insider' });
    const v = newVisitor();
    assert.deepEqual(await receiveGymWhatsAppMessage({ slug: HALL, jid: v.jid, phone: v.phone, id: 'H1', text: 'Fees?' }), { handled: false, reason: 'not_gym' });
    // A CoachBook account still goes to its own admissions assistant.
    assert.deepEqual(await simulateInboundMessage({ slug: ACADEMY, jid: v.jid, phone: v.phone, id: 'A1', text: 'Fees?' }), { handled: false, reason: 'off' });
    assert.deepEqual(await simulateInboundMessage({ slug: HALL, jid: v.jid, phone: v.phone, id: 'H2', text: 'Fees?' }), { handled: false, reason: 'not_gym' });
  });

  it('shows the desk which leads the assistant captured', async () => {
    const list = await call('GET', '/api/trials?stage=needs_reply');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 1);
    assert.ok(list.body.items.every((l) => l.wa_needs_staff));
    assert.equal(list.body.ai.on, true);
    assert.ok(list.body.ai.captured_this_month >= 2);
    const all_ = await call('GET', '/api/trials');
    const priyaRow = all_.body.items.find((l) => l.name === 'Priya Verma');
    assert.equal(priyaRow.stage, 'booked');
    assert.equal(priyaRow.pass.issued_by, 'ai');
    assert.ok(priyaRow.wa_last_message_at);
  });
});
