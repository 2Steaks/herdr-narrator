#!/usr/bin/env node
// The Narrator's Narrator: speak a pane's Summary (or a tab's Rollup) when focus settles, keep Summaries fresh in the
// background, and speak up when an unfocused agent is blocked.
//
// Focus path: on every focus event we cancel the line that is playing, find what to say and start rendering it
// straight away (a cache hit when the summariser pre-rendered it). When focus has been still for debounceMs we speak.
//   pane.focused  the pane's cached Summary; with nothing cached, summarise now and speak sentences as they stream
//   tab.focused   a Rollup built from agent.list and cached Summaries (no model call)
// Everything spoken goes through lib/voice.mjs, which owns mute, no-repeats, replay and "alerts never interrupt".
import { createHerdrClient } from './lib/herdr.mjs';
import { createHerdrAppClient } from './lib/herdr-app.mjs';
import { createSidecar } from './lib/sidecar.mjs';
import { createSummariser, summaryKey, kindOf, tabLabelOf } from './lib/summariser.mjs';
import { createHookServer, DEFAULT_SOCKET } from './lib/hook-server.mjs';
import { createLlm } from './lib/llm.mjs';
import { createVoice } from './lib/voice.mjs';
import { createState } from './lib/state.mjs';
import { buildRollup, rollupSignature } from './lib/rollup.mjs';

const FOCUS_EVENTS = new Set(['pane_focused', 'tab_focused']);
const AUTH_NOTICE = "My AWS login lapsed. I'll stay quiet until you log in again.";

export function createNarrator({
  socketPath,
  herdrClient, // optional: a ready client (the Herdr app backend); without it it connects to socketPath
  ownPaneId: ownPaneIdOption, // optional: a hidden Narrator has no pane of its own, so there is nothing to ignore
  sidecar,
  debounceMs = 400,
  llm = null,
  bedrock = llm, // legacy name for llm, still accepted; without it the Narrator only plays Summaries that are already in tokens.summary (phase 1 behaviour)
  hookSocketPath, // where the Stop hook and the plugin send their lines; omit to run without them
  state = createState(),
  blockedWaitMs = 4000, // how long a Blocked alert waits for a fresh Summary before it goes out bare
  summariserOptions = {},
  log = () => {},
  onSpoke = () => {}, // { paneId, eventAt, settledAt, startedAt } in epoch ms, for latency measurement
  onAuthLapsed = () => {},
  onQuit = () => {}, // the plugin's narrator.quit arrived: the caller shuts the process down (stop(), sidecar.close(), exit)
}) {
  const ownPaneId = ownPaneIdOption || null; // '' and undefined both mean "none"; null never equals a real pane id
  const herdr = herdrClient ?? createHerdrClient({ socketPath, log });
  const voice = createVoice({ sidecar, state, log, onIdle: retryDeferredAlerts });
  const model = llm ?? bedrock;
  const summariser = model
    ? createSummariser({
      herdr, llm: model, sidecar, ownPaneId, log,
      onSummary: onSummary,
      onStatusChange,
      onPaneClosed(paneId) { // forget everything keyed by the pane, so a reused id starts clean
        blockedEpisodes.delete(paneId);
        deferredAlerts.delete(paneId);
        liveSpoke.delete(paneId);
        voice.forget(paneId);
      },
      onAuthLapsed: () => {
        onAuthLapsed();
        // Once per expiry (the summariser fires this once), so it must not be lost: it replaces a held Blocked alert.
        voice.alert({ key: 'notice:auth', text: model.authNotice ?? AUTH_NOTICE, replace: true });
      },
      ...summariserOptions,
    })
    : null;
  const hookServer = hookSocketPath
    ? createHookServer({ socketPath: hookSocketPath, log, onHook: (h) => summariser?.onHook(h), onCommand })
    : null;
  let timer = null;
  let generation = 0;
  let resolved = null; // promise of what the latest focus event landed on
  let eventAt = 0;
  let windowTab = false; // a tab.focused arrived in this debounce window: the Rollup wins over a pane.focused beside it
  let focusedPane = null; // last pane we know the user is looking at
  let liveFor = null; // pane with a live Summary in flight
  let liveSeq = 0;
  const liveSpoke = new Map(); // paneId -> true once a live sentence for it was spoken
  const blockedEpisodes = new Set(); // panes whose current blocked episode was already handled
  const deferredAlerts = new Map(); // paneId -> alert the voice dropped (slot full); offered again when the voice is idle
  const summaryWaiters = new Map(); // paneId -> [{ afterRevision, resolve }]

  // ---- what to say ----------------------------------------------------------------------------------

  /** A Summary the summariser already holds for this pane, as something the sidecar can play. */
  function stored(paneId) {
    const entry = summariser?.get(paneId);
    return entry ? { paneId, key: summaryKey(paneId, entry.revision), text: entry.text } : null;
  }

  /** The focused pane, with its cached Summary if it has one. null for the Narrator's own pane. */
  async function resolveFocus() {
    const current = (await herdr.request('pane.current')).pane;
    if (!current || current.pane_id === ownPaneId) return null;
    focusedPane = current.pane_id;
    const fromStore = stored(current.pane_id);
    if (fromStore) return fromStore;
    // pane.current returns the same PaneInfo as pane.get, tokens included (checked live), and every real
    // Herdr request costs about 100 ms, so one request is enough.
    const text = current.tokens?.summary;
    if (typeof text !== 'string' || !text.trim()) return { paneId: current.pane_id, agent: Boolean(current.agent) }; // nothing yet
    return { paneId: current.pane_id, key: `${current.pane_id}:${current.revision}`, text };
  }

  /** What a tab focus lands on: a Rollup, or the one agent's Summary, or nothing. */
  async function resolveTab(tabId) {
    if (!tabId) return null;
    const list = (await herdr.request('agent.list')).agents ?? [];
    const inTab = list.filter((a) => a.tab_id === tabId && a.pane_id !== ownPaneId);
    if (!inTab.length) return null;
    if (inTab.length === 1) {
      const only = inTab[0];
      focusedPane = only.pane_id;
      const fromStore = stored(only.pane_id);
      if (fromStore) return fromStore;
      const pane = (await herdr.request('pane.get', { pane_id: only.pane_id })).pane;
      const text = pane?.tokens?.summary;
      if (typeof text === 'string' && text.trim()) return { paneId: only.pane_id, key: `${only.pane_id}:${pane.revision}`, text };
      return { paneId: only.pane_id, agent: true };
    }
    const agents = inTab.map((a) => {
      const entry = summariser?.get(a.pane_id);
      return { paneId: a.pane_id, status: a.agent_status, summary: entry?.text, revision: entry?.revision };
    });
    const text = buildRollup(agents);
    if (!text) return null;
    const sig = rollupSignature(agents);
    return { rollup: true, paneId: `tab:${tabId}`, key: `rollup:${tabId}:${sig}`, text };
  }

  // ---- focus ------------------------------------------------------------------------------------------

  function onEvent(msg) {
    const kind = kindOf(msg);
    if (!FOCUS_EVENTS.has(kind)) return;
    log({ level: 'info', msg: 'focus event', kind, pane: msg.data?.pane_id, tab: msg.data?.tab_id });
    if (kind === 'pane_focused' && windowTab && timer !== null) return; // beside a tab.focused: the Rollup stands
    const gen = ++generation; // anything still in flight for an earlier focus is now stale
    eventAt = Date.now();
    voice.setQuiet(true); // alerts wait until this focus has been spoken (or found silent)
    voice.cancel(); // the line that is playing no longer matches what the user is looking at
    if (liveFor) { summariser?.cancelLive(liveFor); liveFor = null; }
    let pending;
    if (kind === 'tab_focused') {
      windowTab = true;
      pending = resolveTab(msg.data?.tab_id);
    } else {
      windowTab = false;
      // pane.focused names the pane, so a Summary we already hold needs no Herdr request (each costs about 100 ms).
      const eventPane = msg.data?.pane_id;
      if (eventPane) focusedPane = eventPane;
      const direct = eventPane && eventPane !== ownPaneId ? stored(eventPane) : null;
      pending = direct ? Promise.resolve(direct) : resolveFocus();
    }
    resolved = pending.then(
      (target) => {
        if (target?.text && gen === generation) sidecar.render({ key: target.key, text: target.text });
        return target;
      },
      (err) => {
        log({ level: 'error', msg: 'resolving focus failed', err: err.message });
        return null;
      },
    );
    clearTimeout(timer);
    timer = setTimeout(() => settle(gen, resolved), debounceMs);
  }

  async function settle(gen, pending) {
    timer = null;
    windowTab = false;
    const settledAt = Date.now();
    try {
      const resolvedTarget = await pending;
      if (!resolvedTarget) { log({ level: 'info', msg: 'silent', why: 'nothing to say or own pane' }); return; }
      if (gen !== generation) { log({ level: 'info', msg: 'silent', why: 'focus moved on' }); return; }
      // A background Summary may have landed while focus was settling: the store is the freshest source.
      const target = resolvedTarget.rollup ? resolvedTarget : (stored(resolvedTarget.paneId) ?? (resolvedTarget.text ? resolvedTarget : null));
      if (target) {
        const out = await voice.say({ paneId: target.paneId, key: target.key, text: target.text });
        if (!out.spoken) log({ level: 'info', msg: 'silent', why: out.reason, pane: target.paneId });
        else if (out.res.cancelled) log({ level: 'info', msg: 'silent', why: 'cancelled', pane: target.paneId });
        if (out.spoken && !out.res.cancelled) onSpoke({ paneId: target.paneId, eventAt, settledAt, startedAt: out.res.startedAtMs });
        return;
      }
      if (summariser && resolvedTarget.agent) await liveFallback(resolvedTarget.paneId, gen, settledAt);
    } catch (err) {
      log({ level: 'error', msg: 'speaking failed', err: err.message });
    } finally {
      if (gen === generation) voice.setQuiet(false);
    }
  }

  /** Nothing cached for the focused pane: summarise now and speak each sentence as it completes. */
  async function liveFallback(paneId, gen, settledAt) {
    liveFor = paneId;
    let previous = null; // the previous sentence's say(), so sentences play in order
    await summariser.summariseLive(paneId, {
      onSentence(text, index) {
        if (gen !== generation) return; // focus moved on
        const key = `${paneId}#live${++liveSeq}`;
        if (!voice.muted) liveSpoke.set(paneId, true);
        previous = index === 0
          ? voice.say({ key, text })
          : previous.then(async (prev) => {
            if (!prev?.spoken) return prev; // the line before it never played (cut off or muted): drop the rest
            if ((await prev.res.ended) === 'cancelled') return { spoken: false, res: { cancelled: true } }; // cut off: do not talk over what replaced it
            return gen === generation ? voice.say({ key, text }) : { spoken: false, res: { cancelled: true } };
          });
        if (index === 0) {
          previous.then((out) => {
            if (out.spoken && !out.res.cancelled) onSpoke({ paneId, eventAt, settledAt, startedAt: out.res.startedAtMs });
          }, () => {});
        }
        previous.catch((err) => log({ level: 'error', msg: 'live sentence failed', err: err.message }));
      },
    });
    if (liveFor === paneId) liveFor = null;
    liveSpoke.delete(paneId); // onSummary(live) ran inside summariseLive; whatever the outcome, nothing is left to mark
    await previous?.catch(() => {});
  }

  // ---- background Summaries and Blocked alerts ----------------------------------------------------------

  /** A Summary landed. Speak it only if its pane is the focused one and focus is not mid-flick. */
  async function onSummary({ paneId, key, text, revision, live }) {
    for (const w of summaryWaiters.get(paneId) ?? []) if (revision > w.afterRevision) w.resolve({ text, revision });
    if (live) { // spoken sentence by sentence already: only record that this revision was heard
      if (liveSpoke.get(paneId)) voice.markSpoken(paneId, key, text);
      liveSpoke.delete(paneId);
      return;
    }
    if (paneId === ownPaneId || timer !== null) return; // a pending focus settle will pick the fresh Summary up
    try {
      const current = (await herdr.request('pane.current')).pane;
      if (current?.pane_id !== paneId || timer !== null) return;
      if (summariser.get(paneId)?.text !== text) return; // superseded while we asked
      await voice.say({ paneId, key, text });
    } catch (err) {
      log({ level: 'error', msg: 'speaking a background summary failed', err: err.message });
    }
  }

  function waitForSummary(paneId, afterRevision, ms) {
    return new Promise((resolve) => {
      const waiter = { afterRevision: afterRevision ?? 0, resolve: (v) => done(v) };
      const list = summaryWaiters.get(paneId) ?? [];
      summaryWaiters.set(paneId, [...list, waiter]);
      const t = setTimeout(() => done(null), ms);
      function done(v) {
        clearTimeout(t);
        const rest = (summaryWaiters.get(paneId) ?? []).filter((w) => w !== waiter);
        if (rest.length) summaryWaiters.set(paneId, rest); else summaryWaiters.delete(paneId);
        resolve(v);
      }
    });
  }

  function onStatusChange({ paneId, next, initial }) {
    if (paneId === ownPaneId) return;
    if (next !== 'blocked') { blockedEpisodes.delete(paneId); deferredAlerts.delete(paneId); return; } // leaving blocked ends the episode
    if (blockedEpisodes.has(paneId)) return; // same episode, already handled
    blockedEpisodes.add(paneId);
    if (initial) return; // blocked before we started looking: not news
    blockedAlert(paneId).catch((err) => log({ level: 'error', msg: 'blocked alert failed', err: err.message }));
  }

  async function tabLabelFor(paneId) {
    try {
      const snap = (await herdr.request('session.snapshot')).snapshot;
      const label = String(tabLabelOf(snap, paneId) ?? '').trim();
      if (!label) return 'An agent';
      return /^\d+$/.test(label) ? `Tab ${label}` : label;
    } catch {
      return 'An agent';
    }
  }

  /** The voice is idle and its slot is free: offer dropped Blocked alerts again, once each, while still relevant. */
  function retryDeferredAlerts() {
    for (const [paneId, alert] of deferredAlerts) {
      if (!alert.relevant()) { deferredAlerts.delete(paneId); continue; }
      if (voice.alert(alert) === 'dropped') return;
      deferredAlerts.delete(paneId);
    }
  }

  async function blockedAlert(paneId) {
    const stillBlocked = () => summariser.statusOf(paneId) === 'blocked';
    // The Summary written when the pane blocked says what it is waiting on; an older one describes a past turn.
    const fresh = await waitForSummary(paneId, summariser.get(paneId)?.revision, blockedWaitMs);
    if (!stillBlocked()) return;
    const current = await herdr.request('pane.current').then((r) => r.pane, () => null);
    if (current?.pane_id === paneId) return; // The user is looking at it: its Summary speaks for it
    const label = await tabLabelFor(paneId);
    const text = fresh?.text ? `${label} needs you. ${fresh.text}` : `${label} needs you.`;
    const alert = {
      key: `blocked:${paneId}`,
      text,
      relevant: () => stillBlocked() && focusedPane !== paneId,
    };
    const how = voice.alert(alert);
    if (how === 'dropped') deferredAlerts.set(paneId, alert); // the slot was full: announce it when the voice goes idle
    log({ level: 'info', msg: 'blocked alert', pane: paneId, how, reason_cached: Boolean(fresh) });
  }

  // ---- plugin commands --------------------------------------------------------------------------------

  /** The focused pane's cached Summary, for replay when nothing has been spoken yet. */
  async function focusedSummary() {
    const target = await resolveFocus();
    return target?.text ? { key: target.key, text: target.text } : null;
  }

  function onCommand(cmd) {
    if (cmd === 'quit') onQuit();
    else if (cmd === 'mute') voice.toggleMute();
    else if (cmd === 'replay') voice.replay(focusedSummary).catch((err) => log({ level: 'error', msg: 'replay failed', err: err.message }));
  }

  return {
    async start() {
      await herdr.subscribe([{ type: 'pane.focused' }, { type: 'tab.focused' }], onEvent);
      if (hookServer) {
        try { await hookServer.start(); } catch (err) { log({ level: 'error', msg: 'hook socket unavailable: Stop hooks and the plugin keys will not reach the Narrator', err: err.message }); }
      }
      await summariser?.start();
    },
    async stop() {
      clearTimeout(timer);
      await summariser?.stop();
      await hookServer?.stop();
      herdr.close();
    },
  };
}

// Run as a script: connect to the real Herdr and the real sidecar.
// Normally start.sh launches its hidden, with no HERDR_PANE_ID. Opened as a pane for debugging it has one and ignores it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const logger = (entry) => process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const ownPaneId = process.env.HERDR_PANE_ID || undefined;
  const appBackend = process.env.NARRATOR_BACKEND === 'herdr-app'; // Herdr app: poll `herdr-app` and `hc`, no socket
  if (!socketPath && !appBackend) {
    logger({ level: 'error', msg: 'HERDR_SOCKET_PATH must be set; run the Narrator from a Herdr plugin or a Herdr pane (or set NARRATOR_BACKEND=herdr-app)' });
    process.exit(1);
  }
  const sidecar = createSidecar({ log: logger });
  const state = createState({ log: logger });
  let shuttingDown = false;
  /** Stop everything and exit 0: hook socket closed and removed, sidecar quit. Safe to call twice. */
  async function shutdown(why) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger({ level: 'info', msg: 'narrator is shutting down', why });
    setTimeout(() => process.exit(0), 3000).unref(); // a stuck close must not keep its alive
    try { await narrator.stop(); } catch (err) { logger({ level: 'error', msg: 'stop failed', err: err.message }); }
    try { await sidecar.close(); } catch { /* exiting anyway */ }
    process.exit(0);
  }
  let llm = null;
  if (!process.env.NARRATOR_NO_SUMMARISER) {
    try { llm = createLlm(); logger({ level: 'info', msg: 'summary provider', provider: llm.name }); }
    catch (err) { logger({ level: 'error', msg: 'no summary provider: the Narrator only plays Summaries that already exist', err: err.message }); }
  }
  const narrator = createNarrator({
    socketPath,
    herdrClient: appBackend ? createHerdrAppClient({ log: logger }) : undefined,
    ownPaneId,
    sidecar,
    state,
    llm,
    hookSocketPath: DEFAULT_SOCKET,
    onQuit: () => shutdown('quit command'),
    onAuthLapsed: () => logger({ level: 'warn', msg: `${llm?.name ?? 'model'} login lapsed: ${llm?.authHint ?? 'check your credentials'} (logged once per expiry)` }),
    debounceMs: Number(process.env.NARRATOR_DEBOUNCE_MS ?? 400),
    log: logger,
    onSpoke: (m) => logger({ level: 'info', msg: 'spoke', pane: m.paneId, event_to_audio_ms: m.startedAt - m.eventAt, settle_to_audio_ms: m.startedAt - m.settledAt }),
  });
  process.on('unhandledRejection', (e) => logger({ level: 'error', msg: 'unhandled rejection', err: String(e?.message ?? e) }));
  await sidecar.warm(); // load Kokoro before the first focus
  await narrator.start();
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  logger({ level: 'info', msg: 'narrator is listening', own_pane: ownPaneId ?? null, muted: state.muted });
}
