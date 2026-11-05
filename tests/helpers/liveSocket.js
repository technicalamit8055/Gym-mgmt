import WebSocket from 'ws';

/**
 * A live-class socket for tests (src/coaching/liveGateway.js) that keeps
 * every message it is sent, so a test can wait for an event that may already
 * have arrived — or check one never did.
 *
 * `ticket` is the body of a socket-ticket call: { ticket, path }.
 */
export async function openSocket(root, ticket) {
  const ws = new WebSocket(`${root.replace('http', 'ws')}${ticket.path}?ticket=${ticket.ticket}`);
  const inbox = [];
  const waiters = new Set();
  let ref = 0;
  ws.on('message', (raw) => {
    inbox.push(JSON.parse(raw.toString()));
    for (const w of [...waiters]) w();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const take = (match) => {
    const i = inbox.findIndex(match);
    return i === -1 ? undefined : inbox.splice(i, 1)[0];
  };
  const waitFor = (match, what, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const found = take(match);
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    function check() {
      const hit = take(match);
      if (!hit) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(hit);
    }
    waiters.add(check);
    return undefined;
  });
  return {
    ws,
    inbox,
    /** The next `event` whose data passes `match` — one that already arrived, or the next to. */
    next: (event, match = () => true, timeoutMs) => waitFor((m) => m.event === event && match(m.data), event, timeoutMs).then((m) => m.data),
    /** Whether an `event` passing `match` has arrived (without consuming it). */
    got: (event, match = () => true) => inbox.some((m) => m.event === event && match(m.data)),
    /** Sends `{ event, data, ref }` and resolves with its ack. */
    request(event, data) {
      ref += 1;
      const mine = ref;
      ws.send(JSON.stringify({ event, data, ref: mine }));
      return waitFor((m) => m.event === 'ack' && m.ref === mine, `ack ${event}`);
    },
    close: () => ws.close(),
  };
}

/** Connecting must fail; resolves with the HTTP status the upgrade got. */
export const refusedWith = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
  ws.on('open', () => resolve('opened'));
  ws.on('error', () => {});
});
