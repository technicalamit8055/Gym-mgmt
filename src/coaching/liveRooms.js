import { tenantStorage } from '../db.js';

/**
 * A live class's room: everyone connected to it, and whatever is running in
 * it (a poll — see livePolls.js). Polls and doubts (liveDoubts.js) both work
 * on rooms; neither owns them, so neither has to import the other.
 *
 * Keyed `slug:session_<id>`: session ids start at 1 in every institute's own
 * database, so the institute is part of the key — two institutes' "session 3"
 * are different rooms.
 */
const rooms = new Map();

export const roomKey = (slug, sessionId) => `${slug}:session_${sessionId}`;

export const getRoom = (slug, sessionId) => rooms.get(roomKey(slug, sessionId));

export const allRooms = () => [...rooms.values()];

/** Runs `fn` against the room's institute's database. */
export const inTenant = (room, fn) => tenantStorage.run(room.store, fn);

/**
 * Sends to everyone in the room, or only to `role`, or only to the clients
 * `to` accepts.
 */
export function broadcast(room, event, data, { role, to } = {}) {
  for (const client of room.clients) {
    if (role && client.role !== role) continue;
    if (to && !to(client)) continue;
    client.send(event, data);
  }
}

/** Tells a class's room something, if anyone is connected to it. */
export function broadcastToSession(slug, sessionId, event, data) {
  const room = getRoom(slug, sessionId);
  if (room) broadcast(room, event, data);
}

export function enterRoom(client) {
  const key = roomKey(client.store.slug, client.sessionId);
  let room = rooms.get(key);
  if (!room) {
    room = { key, store: client.store, sessionId: client.sessionId, clients: new Set(), poll: null };
    rooms.set(key, room);
  }
  room.clients.add(client);
  client.room = room;
  return room;
}

/** Forgets a room nobody is in, unless a poll is still running in it. */
export function dropIfIdle(room) {
  if (!room.clients.size && !room.poll) rooms.delete(room.key);
}

export function leaveRoom(client) {
  const { room } = client;
  if (!room) return;
  room.clients.delete(client);
  dropIfIdle(room);
}
