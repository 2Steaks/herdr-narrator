// Fake Herdr socket server for tests. Newline-delimited JSON over a Unix socket.
// Mirrors the shapes seen on Herdr 0.9.5 (protocol 22).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function startFakeHerdr() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-'));
  const socketPath = path.join(dir, 'herdr.sock');
  const state = {
    panes: {}, // pane_id -> { tab_id, tokens, revision }
    focused: null,
    requests: [], // every request received, in order
    subscribers: new Map(), // socket -> [{ type, pane_id? }]
    connections: new Set(),
    delays: {}, // method -> ms
    reports: [], // pane.report_metadata params, in order
    tabLabels: {},
    dropSubscribeAcks: 0, // the next N events.subscribe requests lose their connection instead of being acknowledged
  };

  const paneInfo = (id) => {
    const p = state.panes[id];
    if (!p) return null;
    return {
      pane_id: id, workspace_id: 'w1', tab_id: p.tab_id, focused: state.focused === id,
      agent: p.agent === null ? undefined : (p.agent ?? 'claude'), agent_status: p.status ?? 'idle', revision: p.revision ?? 1,
      ...(p.tokens ? { tokens: p.tokens } : {}),
    };
  };

  const server = net.createServer((sock) => {
    state.connections.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('close', () => { state.connections.delete(sock); state.subscribers.delete(sock); });
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        state.requests.push(req);
        // Real Herdr 0.9.5 closes a connection after answering one ordinary request. Subscriptions stay open.
        const reply = (result) => {
          sock.write(JSON.stringify({ id: req.id, result }) + '\n');
          if (req.method !== 'events.subscribe') sock.end();
        };
        const respond = () => {
          switch (req.method) {
            case 'events.subscribe': {
              if (state.dropSubscribeAcks > 0) { state.dropSubscribeAcks--; return sock.destroy(); }
              const subs = req.params?.subscriptions ?? [];
              const bad = subs.find((x) => x.type === 'pane.agent_status_changed' && !x.pane_id);
              if (bad) return sock.write(JSON.stringify({ id: req.id, error: { code: 'invalid_params', message: 'pane.agent_status_changed requires pane_id' } }) + '\n');
              state.subscribers.set(sock, subs);
              return reply({ type: 'subscription_started' });
            }
            case 'session.snapshot':
              return reply({
                type: 'session_snapshot',
                snapshot: {
                  focused_pane_id: state.focused,
                  tabs: [...new Set(Object.values(state.panes).map((p) => p.tab_id))].map((t) => ({ tab_id: t, label: state.tabLabels[t] ?? t })),
                  panes: Object.keys(state.panes).map(paneInfo),
                },
              });
            case 'agent.list':
              return reply({
                type: 'agent_list',
                agents: Object.keys(state.panes).filter((id) => state.panes[id].agent !== null).map((id) => {
                  const i = paneInfo(id);
                  return { pane_id: id, tab_id: i.tab_id, workspace_id: i.workspace_id, agent: i.agent, agent_status: i.agent_status, focused: i.focused, revision: i.revision };
                }),
              });
            case 'pane.read': {
              const p = state.panes[req.params?.pane_id];
              if (!p) return (sock.write(JSON.stringify({ id: req.id, error: { code: 'pane_not_found', message: 'no such pane' } }) + '\n'), sock.end());
              return reply({ type: 'pane_read', read: { pane_id: req.params.pane_id, source: req.params.source, text: p.text ?? '', revision: p.revision ?? 1, truncated: false } });
            }
            case 'pane.report_metadata': {
              const p = state.panes[req.params?.pane_id];
              if (!p) return (sock.write(JSON.stringify({ id: req.id, error: { code: 'pane_not_found', message: 'no such pane' } }) + '\n'), sock.end());
              state.reports.push(req.params);
              p.tokens = { ...(p.tokens ?? {}) };
              for (const [k, v] of Object.entries(req.params.tokens ?? {})) { if (v === null) delete p.tokens[k]; else p.tokens[k] = v; }
              p.revision = (p.revision ?? 1) + 1;
              return reply({ type: 'ok' });
            }
            case 'pane.current':
              return reply({ type: 'pane_current', pane: paneInfo(state.focused) });
            case 'pane.get': {
              const info = paneInfo(req.params?.pane_id);
              return info
                ? reply({ type: 'pane_info', pane: info })
                : (sock.write(JSON.stringify({ id: req.id, error: { code: 'pane_not_found', message: 'no such pane' } }) + '\n'), sock.end());
            }
            default:
              return sock.write(JSON.stringify({ id: req.id, error: { code: 'unknown_method', message: req.method } }) + '\n');
          }
        };
        const delay = state.delays[req.method];
        if (delay) setTimeout(respond, delay); else respond();
      }
    });
  });
  await new Promise((r) => server.listen(socketPath, r));

  const push = (line) => { for (const s of state.subscribers.keys()) s.write(line + '\n'); };
  // Deliver an event only to subscriptions of that type (and pane, for filtered ones), as Herdr does.
  const emit = (type, data) => {
    const line = JSON.stringify({ event: type.replaceAll('.', '_'), data: { type: type.replaceAll('.', '_'), ...data } });
    for (const [sock, subs] of state.subscribers) {
      if (subs.some((x) => x.type === type && (!x.pane_id || x.pane_id === data.pane_id))) sock.write(line + '\n');
    }
  };
  return {
    socketPath,
    state,
    addPane(id, { tab = 't1', summary, revision = 1, agent, status, text } = {}) {
      state.panes[id] = { tab_id: tab, revision, agent, status, text, tokens: summary ? { summary } : undefined };
    },
    setFocused(id) { state.focused = id; },
    delay(method, ms) { state.delays[method] = ms; },
    /** Move focus and emit pane.focused, as Herdr does. */
    focusPane(id) {
      state.focused = id;
      emit('pane.focused', { pane_id: id, workspace_id: 'w1' });
    },
    focusTab(tabId, paneId) {
      state.focused = paneId;
      emit('tab.focused', { tab_id: tabId, workspace_id: 'w1' });
    },
    emitRaw: push,
    emit,
    /** Number of live subscriptions for a pane's status events. */
    statusSubscribers: (paneId) => [...state.subscribers.values()].flat().filter((x) => x.type === 'pane.agent_status_changed' && x.pane_id === paneId).length,
    setStatus(id, status) {
      state.panes[id].status = status;
      emit('pane.agent_status_changed', { pane_id: id, workspace_id: 'w1', agent_status: status, agent: state.panes[id].agent ?? 'claude' });
    },
    /** Herdr overran a slow subscriber: send events_lost on each subscription connection, then close it. */
    loseEvents() {
      for (const [sock] of [...state.subscribers]) {
        sock.write(JSON.stringify({ id: 'sub', error: { code: 'events_lost', message: 'subscriber fell behind' } }) + '\n');
        sock.end();
      }
    },
    /** events_lost on one pane's status subscription only. */
    loseEventsFor(paneId) {
      for (const [sock, subs] of [...state.subscribers]) {
        if (!subs.some((x) => x.pane_id === paneId)) continue;
        sock.write(JSON.stringify({ id: 'sub', error: { code: 'events_lost', message: 'subscriber fell behind' } }) + '\n');
        sock.end();
      }
    },
    /** Change a pane's status without emitting an event, as if the event was lost. */
    setStatusQuietly(id, status) { state.panes[id].status = status; },
    setText(id, text) { state.panes[id].text = text; },
    createPane(id, opts) {
      this.addPane(id, opts);
      // Real Herdr 0.9.5 nests the pane: data is { type: 'pane_created', pane: { pane_id, ... } } (seen live).
      emit('pane.created', { pane: { pane_id: id, tab_id: state.panes[id].tab_id, workspace_id: 'w1' } });
    },
    closePane(id) {
      delete state.panes[id];
      emit('pane.closed', { pane_id: id, workspace_id: 'w1' });
    },
    get reports() { return state.reports; },
    requestsFor: (method) => state.requests.filter((r) => r.method === method),
    /** The next `n` subscribe requests are cut off before the acknowledgement. */
    dropNextSubscribeAcks(n) { state.dropSubscribeAcks = n; },
    dropConnections() { for (const s of state.connections) s.destroy(); },
    async close() {
      for (const s of state.connections) s.destroy();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
