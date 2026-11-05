import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { tenantStorage } from '../db.js';
import { HttpError } from '../errors.js';
import { askDoubt, doubtSnapshot, pinDoubt, resolveDoubt, sendChat, unpinDoubt } from './liveDoubts.js';
import { closeAllPolls, createPoll, endPollByTeacher, pollSnapshot, revealAnswer, submitVote } from './livePolls.js';
import { enterRoom, leaveRoom } from './liveRooms.js';

/**
 * The WebSocket side of live classes, at /ws/live (or /g/<slug>/ws/live).
 *
 * A socket never authenticates itself. The app first asks the REST API for a
 * ticket — POST …/live/sessions/:id/socket-ticket, staff or portal — which
 * runs the request through the usual tenant, sign-in, module and enrolment
 * checks, and then connects with `?ticket=`. A ticket is single-use, lives
 * 30 seconds, and carries the tenant context the REST call resolved, so the
 * upgrade needs no tenant lookup and a long-lived bearer token never sits in
 * a URL (and so in an access log).
 *
 * Messages are JSON both ways: `{ event, data, ref }` in, `{ event, data }`
 * out. Every inbound message gets an `ack` echoing its `ref`, carrying the
 * result or `{ error, details }` — the same shape as an API error.
 *
 *   teacher → teacher:create_poll   { question?, option_count?, options?, correct_option?, duration_sec? }
 *   teacher → poll:end              { poll_id }       ends it before the timer
 *   teacher → teacher:reveal_answer { poll_id, correct_option }   after the voting
 *   student → student:submit_vote   { poll_id, choice }
 *   student → student:ask_doubt     { body }          into the teacher's queue only
 *   teacher → teacher:pin_doubt     { doubt_id }      onto every screen, replacing the last
 *   teacher → teacher:unpin_doubt   { doubt_id }
 *   teacher → teacher:resolve_doubt { doubt_id }
 *   either  → chat:send             { text }          slow mode for students
 *   server  → room:joined, poll:started, poll:tick, poll:end, poll:revealed, poll:my_result, session:ended, session:stream,
 *             doubt:new (teachers), doubt:pinned, doubt:unpinned, doubt:resolved, chat:message
 */

export const LIVE_SOCKET_PATH = '/ws/live';
const TICKET_TTL_MS = 30_000;
const HEARTBEAT_MS = 30_000;
/** Far above what a person tapping options can send; a client past it is broken or hostile. */
const MAX_MESSAGES_PER_SECOND = 20;

const tickets = new Map();

/**
 * Called from a REST route after it has checked who may join which class.
 * @param {{sessionId: number, role: 'teacher'|'student', userId?: number, memberId?: number, name: string}} who
 */
export function issueSocketTicket({ sessionId, role, userId = null, memberId = null, name }) {
  const now = Date.now();
  for (const [key, held] of tickets) if (held.expires < now) tickets.delete(key);
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { store: tenantStorage.getStore(), sessionId, role, userId, memberId, name, expires: now + TICKET_TTL_MS });
  return { ticket, path: LIVE_SOCKET_PATH, expires_in: TICKET_TTL_MS / 1000 };
}

function redeem(ticket) {
  const held = ticket ? tickets.get(ticket) : null;
  if (!held) return null;
  tickets.delete(ticket);
  return held.expires >= Date.now() ? held : null;
}

const HANDLERS = {
  'teacher:create_poll': createPoll,
  'student:submit_vote': submitVote,
  'poll:end': endPollByTeacher,
  'teacher:reveal_answer': revealAnswer,
  'student:ask_doubt': askDoubt,
  'teacher:pin_doubt': pinDoubt,
  'teacher:unpin_doubt': unpinDoubt,
  'teacher:resolve_doubt': resolveDoubt,
  'chat:send': sendChat,
};

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function connect(ws, ticket) {
  const client = {
    ...ticket,
    alive: true,
    window: { start: Date.now(), count: 0 },
    send(event, data) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, data }));
    },
  };
  const ack = (ref, body) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: 'ack', ref: ref ?? null, ...body }));
  };

  ws.on('pong', () => { client.alive = true; });
  ws.on('close', () => leaveRoom(client));
  ws.on('message', (raw, isBinary) => {
    const now = Date.now();
    if (now - client.window.start >= 1000) client.window = { start: now, count: 0 };
    client.window.count += 1;
    if (client.window.count > MAX_MESSAGES_PER_SECOND) {
      ws.close(1008, 'Too many messages');
      return;
    }
    let message = null;
    try {
      message = isBinary ? null : JSON.parse(raw.toString('utf8'));
    } catch {
      // answered below
    }
    if (!message || typeof message !== 'object') return ack(null, { ok: false, error: 'Messages are JSON: { event, data, ref }' });
    const handler = HANDLERS[message.event];
    if (!handler) return ack(message.ref, { ok: false, error: `Unknown event "${message.event}"` });
    try {
      return ack(message.ref, { ok: true, data: handler(client, message.data ?? {}) });
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error('[live-gateway]', message.event, err);
        return ack(message.ref, { ok: false, status: 500, error: 'Something went wrong on our side' });
      }
      return ack(message.ref, { ok: false, status: err.status, error: err.message, details: err.details });
    }
  });

  const room = enterRoom(client);
  client.send('room:joined', {
    room: `session_${room.sessionId}`,
    role: client.role,
    poll: pollSnapshot(client),
    ...doubtSnapshot(client),
  });
  return client;
}

/**
 * Hooks the gateway onto the HTTP server. Returns `close()`, which saves any
 * running poll and drops every socket — server.close() never finishes while
 * a socket is open.
 */
export function attachLiveGateway(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  const clients = new Map();

  const onUpgrade = (req, socket, head) => {
    let url = null;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // refused below
    }
    if (!url || !url.pathname.endsWith(LIVE_SOCKET_PATH)) return refuse(socket, 404, 'Not Found');
    const ticket = redeem(url.searchParams.get('ticket'));
    if (!ticket) return refuse(socket, 401, 'Unauthorized');
    return wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, connect(ws, ticket));
      ws.on('close', () => clients.delete(ws));
    });
  };
  server.on('upgrade', onUpgrade);

  // A phone that walked out of Wi-Fi never sends a close; this notices.
  const heartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      closeAllPolls();
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
    },
  };
}
