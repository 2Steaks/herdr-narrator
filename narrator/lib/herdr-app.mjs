// Herdr app backend: the same { request, subscribe, close } surface as lib/herdr.mjs, built on the `herdr-app`
// and `hc` CLIs. Herdr app has no event socket, so focus, status and lifecycle events come from polling
// `herdr-app ls` + `herdr-app status` (about 5 ms each). A "pane id" here is the terminal address (t7): it is
// what `hc read` takes, what HC_TERMINAL_ID holds in a hook, and it is stable for the life of the terminal.
import { execFile } from 'node:child_process';

const defaultRun = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

export function createHerdrAppClient({ run = defaultRun, pollMs = 150, log = () => {} } = {}) {
  const subs = new Set();
  let timer = null;
  let last = null; // previous world, for diffing
  let polling = false;

  /** One look at the window: terminals that run an agent, plus where focus is. */
  async function world() {
    const [ls, status] = await Promise.all([
      run('herdr-app', ['ls']).then(JSON.parse),
      run('herdr-app', ['status']).then(JSON.parse),
    ]);
    const panes = new Map(); // terminal address -> info
    const tabs = [];
    for (const sp of ls.spaces ?? []) {
      for (const tab of sp.tabs ?? []) {
        tabs.push({ tab_id: tab.id, label: tab.name });
        for (const t of tab.terminals ?? []) {
          panes.set(t.terminal, {
            pane_id: t.terminal, layout_pane: t.pane, tab_id: tab.id,
            agent: t.app && t.app !== 'shell' ? t.app : undefined, agent_status: t.app && t.app !== 'shell' ? t.status : undefined,
            tab_active: Boolean(sp.active && tab.active),
          });
        }
      }
    }
    // status.focused_pane is the layout pane id; status.agent is the terminal an agent block shows.
    let focusedTerminal = null;
    for (const p of panes.values()) if (p.layout_pane === status.focused_pane) focusedTerminal = p.pane_id;
    const activeTab = status.tab ?? null;
    return { panes, tabs, focusedTerminal, activeTab };
  }

  const infoOf = (w, id) => {
    const p = w.panes.get(id);
    return p ? { pane_id: id, tab_id: p.tab_id, focused: w.focusedTerminal === id, agent: p.agent, agent_status: p.agent_status, revision: 0 } : null;
  };

  async function request(method, params = {}) {
    switch (method) {
      case 'pane.current': {
        const w = await world();
        return { pane: w.focusedTerminal ? infoOf(w, w.focusedTerminal) : null };
      }
      case 'pane.get': {
        const w = await world();
        return { pane: infoOf(w, params.pane_id) };
      }
      case 'agent.list': {
        const w = await world();
        return { agents: [...w.panes.values()].filter((p) => p.agent).map((p) => ({ pane_id: p.pane_id, tab_id: p.tab_id, agent_status: p.agent_status })) };
      }
      case 'session.snapshot': {
        const w = await world();
        return { snapshot: { panes: [...w.panes.values()].filter((p) => p.agent).map((p) => ({ pane_id: p.pane_id, tab_id: p.tab_id, agent_status: p.agent_status })), tabs: w.tabs } };
      }
      case 'pane.read': {
        const text = await run('hc', ['read', params.pane_id, '--lines', String(params.lines ?? 50)]);
        return { read: { text } };
      }
      case 'pane.report_metadata': return {}; // Herdr app keeps no per-pane tokens; the Summary store lives in Narrator
      default: throw new Error(`herdr-app backend: unsupported request ${method}`);
    }
  }

  function emit(type, data) {
    for (const s of subs) {
      for (const want of s.subscriptions) {
        if (want.type !== type) continue;
        if (want.pane_id && want.pane_id !== data.pane_id) continue;
        s.onEvent({ event: type, data: { type, ...data } });
      }
    }
  }

  function diff(prev, next) {
    if (!prev) return;
    for (const [id, p] of next.panes) {
      const was = prev.panes.get(id);
      if (!was) emit('pane.created', { pane: { pane_id: id } });
      else if (p.agent_status !== was.agent_status && p.agent_status) emit('pane.agent_status_changed', { pane_id: id, agent_status: p.agent_status });
    }
    for (const id of prev.panes.keys()) if (!next.panes.has(id)) emit('pane.closed', { pane_id: id });
    const tabNow = [...next.panes.values()].find((p) => p.tab_active)?.tab_id ?? null;
    const tabWas = [...prev.panes.values()].find((p) => p.tab_active)?.tab_id ?? null;
    if (tabNow && tabNow !== tabWas) emit('tab.focused', { tab_id: tabNow });
    if (next.focusedTerminal && next.focusedTerminal !== prev.focusedTerminal) emit('pane.focused', { pane_id: next.focusedTerminal, tab_id: next.panes.get(next.focusedTerminal)?.tab_id });
  }

  async function tick() {
    if (polling) return;
    polling = true;
    try {
      const next = await world();
      diff(last, next);
      last = next;
    } catch (err) {
      log({ level: 'warn', msg: 'herdr-app poll failed', err: err.message });
    } finally {
      polling = false;
    }
  }

  async function subscribe(subscriptions, onEvent) {
    const s = { subscriptions, onEvent };
    subs.add(s);
    if (!timer) {
      await tick(); // the first world is the baseline: nothing is an event until it changes
      timer = setInterval(tick, pollMs);
      timer.unref?.();
    }
    return { close() { subs.delete(s); } };
  }

  function close() {
    subs.clear();
    clearInterval(timer);
    timer = null;
  }

  return { request, subscribe, close, _tick: tick };
}
