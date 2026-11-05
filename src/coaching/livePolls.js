import { utcTimestamp } from '../clock.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { allRooms, broadcast, dropIfIdle, getRoom, inTenant } from './liveRooms.js';

/**
 * The live-poll engine: "A, B, C or D — 30 seconds" during a live class.
 *
 * A running poll lives in memory, in its class's room, and nothing touches
 * the database while students vote: a vote is a Map lookup and a counter
 * increment, so a batch of 300 answering in the same two seconds costs no
 * writes at all. The poll row is written when it opens (so it has an id and
 * survives in history) and the votes are written in one transaction when it
 * closes.
 *
 * That makes the open poll's votes as durable as this process: a restart
 * mid-poll loses them, and the poll is left 'open' in the database until the
 * class's next poll closes it. One process serves every institute (SQLite on
 * one volume), so there is no second machine for a vote to land on.
 *
 * Response time is measured here, from the moment the poll opened to the
 * moment the vote arrived — never reported by the client, so nobody can
 * claim a faster answer than they gave.
 *
 * Transport-agnostic: a "client" is anything with `send(event, data)` plus
 * who it is (see liveGateway.js), so the rules can be exercised without
 * sockets. The rooms themselves are liveRooms.js's.
 */

export const POLL_OPTIONS = ['A', 'B', 'C', 'D'];
export const LEADERBOARD_SIZE = 10;
/** How long past the advertised close a vote is still taken: a tap at 29.9s
 * on a slow connection should count. */
export const VOTE_GRACE_MS = 250;
const TICK_MS = 1000;

/* ── Results ─────────────────────────────────────────────────────────── */

/**
 * One-decimal percentages that add up to exactly 100 (largest remainder), so
 * a 1/1/1 split reads 33.4/33.3/33.3 rather than three 33.3s that sum to 99.9.
 */
export function percentages(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return counts.map(() => 0);
  const exact = counts.map((n) => (n * 1000) / total);
  const tenths = exact.map(Math.floor);
  let left = 1000 - tenths.reduce((sum, n) => sum + n, 0);
  const byRemainder = exact.map((e, i) => ({ i, r: e - tenths[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    tenths[i] += 1;
    left -= 1;
  }
  return tenths.map((t) => t / 10);
}

/**
 * Who answered fastest: the correct answers when the poll has one, everyone
 * when it is an opinion poll. Ordered by response time, then by who arrived
 * first; equal times share a rank and the next place is skipped (1, 2, 2, 4),
 * the same as test ranks (ranks.js).
 *
 * @param {Array<{member_id: number, choice: string, response_ms: number, seq: number}>} votes
 */
export function rankRespondents(votes, correctOption) {
  const eligible = votes
    .filter((v) => !correctOption || v.choice === correctOption)
    .sort((a, b) => a.response_ms - b.response_ms || a.seq - b.seq);
  const ranks = [];
  eligible.forEach((vote, i) => {
    const prev = eligible[i - 1];
    ranks.push(prev && prev.response_ms === vote.response_ms ? ranks[i - 1] : i + 1);
  });
  return eligible.map((vote, i) => ({ ...vote, rank: ranks[i] }));
}

/**
 * The breakdown of one poll — shared by the live close, the reveal and the
 * history API, so the numbers a class saw are the numbers the report shows.
 *
 * A poll with no answer yet is waiting for the teacher to reveal it (the
 * board asks for the answer only after the voting, so the class never sees
 * it on the board first). Until then there is nobody to rank: being fastest
 * means nothing before anyone knows who was right.
 */
export function pollResults({ optionCount, correctOption, votes }) {
  const letters = POLL_OPTIONS.slice(0, optionCount);
  const counts = letters.map((letter) => votes.filter((v) => v.choice === letter).length);
  const percents = percentages(counts);
  const ranked = correctOption ? rankRespondents(votes, correctOption) : [];
  const correctCount = correctOption ? votes.filter((v) => v.choice === correctOption).length : null;
  return {
    awaiting_answer: !correctOption,
    total: votes.length,
    options: letters.map((option, i) => ({ option, count: counts[i], percent: percents[i], correct: correctOption ? option === correctOption : null })),
    correct_option: correctOption ?? null,
    correct_count: correctCount,
    accuracy: correctOption ? (votes.length ? Math.round((correctCount / votes.length) * 1000) / 10 : 0) : null,
    avg_response_ms: votes.length ? Math.round(votes.reduce((sum, v) => sum + v.response_ms, 0) / votes.length) : null,
    leaderboard: ranked
      .filter((r) => r.rank <= LEADERBOARD_SIZE)
      .map((r) => ({ rank: r.rank, member_id: r.member_id, name: r.name, choice: r.choice, response_ms: r.response_ms })),
    ranked,
  };
}

/* ── Views ───────────────────────────────────────────────────────────── */

function publicPoll(poll, now = Date.now()) {
  return {
    poll_id: poll.id,
    question: poll.question,
    option_count: poll.optionCount,
    options: POLL_OPTIONS.slice(0, poll.optionCount).map((option) => ({ option, text: poll.texts[option] ?? null })),
    duration_sec: poll.durationMs / 1000,
    // A countdown from remaining_ms, not from closes_at against the phone's
    // own clock, which can be minutes out.
    remaining_ms: Math.max(0, poll.closesAt - now),
    votes: poll.votes.size,
  };
}

const teacherPoll = (poll, now) => ({
  ...publicPoll(poll, now),
  correct_option: poll.correctOption,
  counts: Object.fromEntries(POLL_OPTIONS.slice(0, poll.optionCount).map((o, i) => [o, poll.counts[i]])),
});

const myVote = (poll, client) => {
  const vote = client.role === 'student' ? poll.votes.get(client.memberId) : null;
  return vote ? { choice: vote.choice, response_ms: vote.response_ms } : null;
};

/**
 * The running poll as this client should see it on joining — so a student
 * who reconnects mid-poll sees it again, with their vote, and the app shows
 * "answered" rather than offering a second go.
 */
export function pollSnapshot(client) {
  const { poll } = client.room;
  if (!poll) return null;
  return client.role === 'teacher' ? teacherPoll(poll) : { ...publicPoll(poll), my_vote: myVote(poll, client) };
}

/* ── Polls ───────────────────────────────────────────────────────────── */

const POLL_FIELDS = {
  question: { type: 'string', max: 300 },
  option_count: { type: 'int', min: 2, max: 4, default: 4 },
  correct_option: { type: 'enum', values: POLL_OPTIONS },
  duration_sec: { type: 'int', min: 5, max: 600, default: 30 },
};

function parsePoll(data) {
  const body = parse(data, POLL_FIELDS);
  const letters = POLL_OPTIONS.slice(0, body.option_count);
  if (body.correct_option && !letters.includes(body.correct_option)) {
    throw badRequest(`With ${body.option_count} options the answer has to be ${letters.join(', ')}`, { correct_option: 'not an option' });
  }
  const texts = {};
  const given = data?.options && typeof data.options === 'object' ? data.options : {};
  for (const letter of letters) {
    const text = given[letter] === undefined || given[letter] === null ? '' : String(given[letter]).trim();
    if (text.length > 120) throw badRequest(`Option ${letter} is too long`, { [`options.${letter}`]: 'must be at most 120 characters' });
    if (text) texts[letter] = text;
  }
  return { ...body, texts };
}

/** Teacher opens a poll: written once, then broadcast with its countdown. */
export function createPoll(client, data) {
  if (client.role !== 'teacher') throw forbidden('Only the teacher can start a poll');
  const room = client.room;
  if (room.poll) throw conflict('A poll is already running — end it first', { code: 'poll_running', poll_id: room.poll.id });
  const body = parsePoll(data);

  const now = Date.now();
  const durationMs = body.duration_sec * 1000;
  const id = inTenant(room, () => tx(() => {
    const session = get('SELECT status FROM live_sessions WHERE id = ?', [room.sessionId]);
    if (session?.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
    // Left 'open' by a restart mid-poll; its votes went with the process.
    run("UPDATE live_polls SET status = 'closed', closed_at = ? WHERE session_id = ? AND status = 'open'", [utcTimestamp(), room.sessionId]);
    return Number(run(
      `INSERT INTO live_polls (session_id, question, option_count, option_a, option_b, option_c, option_d, correct_option,
                               duration_sec, status, opened_at, closes_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      [
        room.sessionId, body.question || null, body.option_count, body.texts.A ?? null, body.texts.B ?? null, body.texts.C ?? null, body.texts.D ?? null,
        body.correct_option ?? null, body.duration_sec, utcTimestamp(), utcTimestamp(durationMs), client.userId,
      ],
    ).lastInsertRowid);
  }));

  const poll = {
    id,
    question: body.question || null,
    optionCount: body.option_count,
    texts: body.texts,
    correctOption: body.correct_option ?? null,
    durationMs,
    openedAt: now,
    closesAt: now + durationMs,
    votes: new Map(),
    counts: [0, 0, 0, 0],
    seq: 0,
    closing: false,
  };
  room.poll = poll;
  poll.endTimer = setTimeout(() => endPoll(room, { reason: 'timer' }), durationMs + VOTE_GRACE_MS);
  poll.tickTimer = setInterval(() => {
    const at = Date.now();
    broadcast(room, 'poll:tick', { poll_id: id, remaining_ms: Math.max(0, poll.closesAt - at), votes: poll.votes.size }, { role: 'student' });
    broadcast(room, 'poll:tick', teacherPoll(poll, at), { role: 'teacher' });
  }, TICK_MS);
  poll.endTimer.unref?.();
  poll.tickTimer.unref?.();

  broadcast(room, 'poll:started', publicPoll(poll, now), { role: 'student' });
  broadcast(room, 'poll:started', teacherPoll(poll, now), { role: 'teacher' });
  return teacherPoll(poll, now);
}

/** A student's answer: memory only, first answer final. */
export function submitVote(client, data) {
  if (client.role !== 'student') throw forbidden('Only students vote');
  const poll = client.room.poll;
  const pollId = Number(data?.poll_id);
  if (!poll || poll.closing || poll.id !== pollId) throw conflict('This poll has closed', { code: 'poll_closed' });
  const now = Date.now();
  if (now > poll.closesAt + VOTE_GRACE_MS) throw conflict('Time is up for this poll', { code: 'poll_closed' });
  const choice = String(data?.choice ?? '').trim().toUpperCase();
  const index = POLL_OPTIONS.indexOf(choice);
  if (index === -1 || index >= poll.optionCount) {
    throw badRequest(`Choose one of ${POLL_OPTIONS.slice(0, poll.optionCount).join(', ')}`, { choice: 'not an option' });
  }
  const existing = poll.votes.get(client.memberId);
  if (existing) {
    throw conflict('You have already answered this poll', { code: 'already_voted', choice: existing.choice, response_ms: existing.response_ms });
  }
  poll.seq += 1;
  const vote = { member_id: client.memberId, name: client.name, choice, response_ms: now - poll.openedAt, seq: poll.seq };
  poll.votes.set(client.memberId, vote);
  poll.counts[index] += 1;
  return { poll_id: poll.id, choice, response_ms: vote.response_ms };
}

/**
 * Closes the room's poll — on its timer, at the teacher's word, or when the
 * class ends — writes the votes in one transaction, and tells the room the
 * breakdown, the answer and the fastest. Each student also hears how they
 * did; nobody else's choice is sent to them beyond the leaderboard.
 */
export function endPoll(room, { reason = 'teacher' } = {}) {
  const poll = room.poll;
  if (!poll || poll.closing) return null;
  poll.closing = true;
  clearTimeout(poll.endTimer);
  clearInterval(poll.tickTimer);

  const votes = [...poll.votes.values()];
  const results = pollResults({ optionCount: poll.optionCount, correctOption: poll.correctOption, votes });
  try {
    inTenant(room, () => tx(() => {
      for (const v of [...votes].sort((a, b) => a.seq - b.seq)) {
        run('INSERT INTO live_poll_votes (poll_id, member_id, choice, response_ms, created_at) VALUES (?, ?, ?, ?, ?)', [
          poll.id, v.member_id, v.choice, v.response_ms, utcTimestamp(poll.openedAt + v.response_ms - Date.now()),
        ]);
      }
      run("UPDATE live_polls SET status = 'closed', closed_at = ? WHERE id = ?", [utcTimestamp(), poll.id]);
    }));
  } catch (err) {
    // The class still sees its result; only the history misses this poll.
    console.error(`[live-polls] could not save poll ${poll.id} in ${room.key}:`, err);
  }
  room.poll = null;

  const payload = announceResults(room, { event: 'poll:end', pollId: poll.id, question: poll.question, reason, results, votes: poll.votes });
  dropIfIdle(room);
  return payload;
}

/**
 * Tells the room how a poll went (`event`), and each student how they did.
 * Nobody is sent anyone else's choice beyond the leaderboard.
 */
function announceResults(room, { event, pollId, question, reason, results, votes }) {
  const { ranked, ...shared } = results;
  const payload = { poll_id: pollId, question, reason, ...shared };
  broadcast(room, event, payload);
  const rankOf = new Map(ranked.map((r) => [r.member_id, r.rank]));
  for (const client of room.clients) {
    if (client.role !== 'student') continue;
    const vote = votes.get(client.memberId);
    client.send('poll:my_result', {
      poll_id: pollId,
      choice: vote?.choice ?? null,
      correct: vote && results.correct_option ? vote.choice === results.correct_option : null,
      response_ms: vote?.response_ms ?? null,
      rank: rankOf.get(client.memberId) ?? null,
      ranked_of: ranked.length,
    });
  }
  return payload;
}

const shortName = (m) => [m.first_name, m.last_name ? `${m.last_name[0].toUpperCase()}.` : ''].filter(Boolean).join(' ');

/**
 * The teacher marks the right answer once the voting is over — the board
 * never shows it before, so the class cannot read it off the screen. If the
 * poll is still running, revealing closes it first. Revealing again (a
 * mis-tap) re-marks every vote: correctness is worked out, never stored.
 */
export function revealAnswer(client, data) {
  if (client.role !== 'teacher') throw forbidden('Only the teacher can reveal the answer');
  const room = client.room;
  const pollId = Number(data?.poll_id);
  const answer = String(data?.correct_option ?? '').trim().toUpperCase();
  const row = inTenant(room, () => get('SELECT id, question, option_count FROM live_polls WHERE id = ? AND session_id = ?', [pollId, room.sessionId]));
  if (!row) throw notFound('Poll not found');
  const letters = POLL_OPTIONS.slice(0, row.option_count);
  if (!letters.includes(answer)) throw badRequest(`The answer has to be one of ${letters.join(', ')}`, { correct_option: 'not an option' });
  if (room.poll?.id === pollId) endPoll(room, { reason: 'teacher' });

  const votes = inTenant(room, () => {
    run('UPDATE live_polls SET correct_option = ? WHERE id = ?', [answer, pollId]);
    return all(
      `SELECT v.member_id, v.choice, v.response_ms, v.id AS seq, m.first_name, m.last_name
       FROM live_poll_votes v JOIN members m ON m.id = v.member_id WHERE v.poll_id = ?`,
      [pollId],
    ).map((v) => ({ member_id: v.member_id, choice: v.choice, response_ms: v.response_ms, seq: v.seq, name: shortName(v) }));
  });
  const results = pollResults({ optionCount: row.option_count, correctOption: answer, votes });
  return announceResults(room, {
    event: 'poll:revealed', pollId, question: row.question, reason: 'revealed', results, votes: new Map(votes.map((v) => [v.member_id, v])),
  });
}

/** The teacher's "End poll" — only for the poll that is actually running. */
export function endPollByTeacher(client, data) {
  if (client.role !== 'teacher') throw forbidden('Only the teacher can end a poll');
  const poll = client.room.poll;
  if (!poll || poll.id !== Number(data?.poll_id)) throw conflict('That poll is not running', { code: 'poll_closed' });
  return endPoll(client.room, { reason: 'teacher' });
}

/** The running poll's votes, for the history API to show a poll mid-flight. */
export function liveVotes(slug, sessionId, pollId) {
  const poll = getRoom(slug, sessionId)?.poll;
  return poll && poll.id === pollId ? [...poll.votes.values()] : null;
}

/** The class went off air: close its poll and tell the room. */
export function closeSessionRoom(slug, sessionId) {
  const room = getRoom(slug, sessionId);
  if (!room) return;
  endPoll(room, { reason: 'class_ended' });
  broadcast(room, 'session:ended', { session_id: sessionId });
}

/** Shutdown: every running poll is closed and saved before the database is. */
export function closeAllPolls() {
  for (const room of allRooms()) endPoll(room, { reason: 'shutdown' });
}
