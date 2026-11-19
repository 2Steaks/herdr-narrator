// Raw Unix socket client for Herdr: newline-delimited JSON.
// Two connections, as the handoff asks: one long-lived for the subscription, one for requests.
import net from 'node:net';

/** Splits a stream into lines and hands each parsed JSON object to onMessage. Bad lines go to onBad. */
function lineReader(onMessage, onBad) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onBad(line.length);
        continue;
      }
      if (msg === null || typeof msg !== 'object') { onBad(line.length); continue; }
      onMessage(msg);
    }
  };
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.setEncoding('utf8');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

export function createHerdrClient({ socketPath, log = () => {}, requestTimeoutMs = 3000 }) {
  let nextId = 1;
  const inflight = new Set(); // request sockets, so close() can drop them

  /**
   * One short-lived connection per request. Herdr 0.9.5 closes a connection after it answers one ordinary
   * request (found live), so the "request connection" is opened fresh each time. A unix connect costs well under 1 ms.
   */
  async function request(method, params = {}) {
    const sock = await connect(socketPath);
    inflight.add(sock);
    const id = `g${nextId++}`;
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        clearTimeout(timer);
        inflight.delete(sock);
        sock.destroy();
        fn(value);
      };
      const timer = setTimeout(() => done(reject, new Error(`${method} timed out`)), requestTimeoutMs);
      sock.on('data', lineReader(
        (msg) => {
          if (msg.id !== id) return;
          if (msg.error) done(reject, Object.assign(new Error(msg.error.message ?? 'herdr error'), { code: msg.error.code }));
          else done(resolve, msg.result);
        },
        (len) => log({ level: 'warn', msg: 'malformed line on request socket', len }),
      ));
      sock.on('error', (e) => done(reject, e));
      sock.on('close', () => done(reject, new Error(`${method}: connection closed before a reply`)));
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  const subs = new Set(); // open subscriptions, so close() can drop them
  let closing = false;

  /**
   * Opens a subscription connection and keeps it alive: on a drop it reconnects with backoff and resubscribes.
   * Returns { close } for this one subscription. Per-pane status subscriptions each get their own connection,
   * so adding or dropping a pane never disturbs the others.
   */
  async function subscribe(subscriptions, onEvent) {
    const sub = { sock: null, closed: false };
    subs.add(sub);
    try {
      await openSubscription(sub, subscriptions, onEvent);
    } catch (err) {
      sub.closed = true; // no reconnect loop for a subscription the caller never got
      sub.sock?.removeAllListeners('close');
      sub.sock?.destroy();
      subs.delete(sub);
      throw err;
    }
    return {
      close() {
        sub.closed = true;
        subs.delete(sub);
        sub.sock?.destroy();
      },
    };
  }

  function reconnectLater(sub, subscriptions, onEvent, attempt = 0) {
    if (closing || sub.closed) return;
    const wait = Math.min(200 * 2 ** attempt, 5000);
    log({ level: 'warn', msg: 'subscription lost, reconnecting', in_ms: wait });
    setTimeout(async () => {
      if (closing || sub.closed) return;
      try {
        await openSubscription(sub, subscriptions, onEvent);
        log({ level: 'info', msg: 'subscription restored' });
        onEvent({ event: 'subscription_restored' });
      } catch (err) {
        sub.sock?.removeAllListeners('close'); // this retry chain is the only one
        sub.sock?.destroy();
        reconnectLater(sub, subscriptions, onEvent, attempt + 1);
      }
    }, wait).unref?.();
  }

  async function openSubscription(sub, subscriptions, onEvent) {
    const sock = await connect(socketPath);
    sub.sock = sock;
    if (sub.closed) { sock.destroy(); return; }
    sock.on('error', () => {});
    await new Promise((resolve, reject) => {
      let acked = false;
      sock.on('data', lineReader(
        (msg) => {
          if (!acked && msg.id === 'sub') {
            if (msg.error) return reject(new Error(msg.error.message ?? 'subscribe failed'));
            acked = true;
            return resolve();
          }
          if (msg.error) {
            // events_lost: Herdr dropped events we had not read yet and is about to close this connection. The close
            // handler reconnects, waits for the new acknowledgement, and tells consumers (subscription_restored) to
            // rebuild from session.snapshot and treat later events as invalidation.
            return log({ level: 'warn', msg: 'subscription error from herdr', code: msg.error.code });
          }
          if (msg.event !== undefined || msg.data !== undefined) onEvent(msg);
        },
        (len) => log({ level: 'warn', msg: 'malformed line on subscription socket', len }),
      ));
      sock.once('error', reject);
      sock.once('close', () => reject(new Error('subscription closed before it was acknowledged')));
      sock.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } }) + '\n');
    });
    // Only an acknowledged subscription owns the reconnect chain. A close before the ack rejects above and the
    // caller (subscribe, or the retry timer) handles it, so exactly one chain exists.
    sock.removeAllListeners('close');
    if (sock.destroyed) reconnectLater(sub, subscriptions, onEvent);
    else sock.on('close', () => reconnectLater(sub, subscriptions, onEvent));
  }

  function close() {
    closing = true;
    for (const s of inflight) s.destroy();
    for (const sub of subs) { sub.closed = true; sub.sock?.destroy(); }
    subs.clear();
  }

  return { request, subscribe, close };
}
