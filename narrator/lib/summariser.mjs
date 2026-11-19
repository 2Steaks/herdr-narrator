// The background summariser: keeps one Summary per pane fresh, off the focus path.
//
// Triggers: a pane's agent finishing or blocking (pane.agent_status_changed, one subscription per pane) and, for
// Claude Code panes, the Stop hook (onHook). The hook wins over the status path. Each Summary goes into a Map,
// is mirrored to the pane's tokens.summary, and is pre-rendered into the sidecar's audio cache.
// Raw pane and transcript text goes to the model and nowhere else: never into logs, tokens or errors.
import { readLastTurn } from './transcript.mjs';
import { isCredentialsError } from './bedrock.mjs';

/** Splits streamed text into sentences as they complete. push() returns the finished ones; flush() the remainder. */
export function createSentenceSplitter() {
  let buf = '';
  const take = (final) => {
    const out = [];
    for (;;) {
      const m = /^([\s\S]*?[.!?]["')\]]*)\s+/.exec(buf);
      if (!m) break;
      out.push(m[1].trim());
      buf = buf.slice(m[0].length);
    }
    if (final && buf.trim()) { out.push(buf.trim()); buf = ''; }
    return out.filter(Boolean);
  };
  return { push(delta) { buf += delta; return take(false); }, flush() { return take(true); } };
}

export const summaryKey = (paneId, revision) => `${paneId}#${revision}`;

const SUMMARY_CAP = 80; // Herdr's token cap, for the sidebar's $summary
const PANE_LINES = 80;
const BEDROCK_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 4000;
const isAbort = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

/** First 80 characters of a Summary for the sidebar, cut at a word. */
export function capForTokens(text, cap = SUMMARY_CAP) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= cap) return line;
  return line.slice(0, cap - 1).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '.';
}

/** An event's kind with dots as underscores: the envelope names it in `event` or `data.type`. */
export const kindOf = (msg) => String(msg.event ?? msg.data?.type ?? '').replaceAll('.', '_');

/** The raw label of the tab holding `paneId`, from a session.snapshot result's `snapshot`; undefined when unknown. */
export const tabLabelOf = (snap, paneId) => snap?.tabs?.find((t) => t.tab_id === snap?.panes?.find((p) => p.pane_id === paneId)?.tab_id)?.label;

export function createSummariser({
  herdr,
  llm,
  bedrock = llm, // legacy name, still accepted
  sidecar,
  ownPaneId,
  readTranscript = readLastTurn,
  coalesceMs = 250, // bursts of triggers on one pane collapse into one call
  hookWaitMs = 1000, // on a pane whose hook works, the status path waits this long for the hook
  bedrockTimeoutMs = BEDROCK_TIMEOUT_MS,
  hookPreferMs = 1000, // a status change this soon after a hook adds nothing
  source = 'narrator',
  ttlMs = 3_600_000,
  log = () => {},
  onSummary = () => {}, // { paneId, text, revision, key, live }
  onPaneClosed = () => {}, // paneId
  onStatusChange = () => {}, // { paneId, prev, next, initial?, source }: every pane's agent status, for Blocked alerts
  onAuthLapsed = () => {},
}) {
  const model = llm ?? bedrock;
  const panes = new Map(); // paneId -> per-pane state
  const store = new Map(); // paneId -> { text, revision, at }
  let lifecycleSub = null;
  let authLapsed = false;
  let stopped = false;
  let revisionCounter = 0;

  // ---- panes -----------------------------------------------------------------------------------------

  function addPane(paneId, status) {
    if (stopped || paneId === ownPaneId || panes.has(paneId)) return Promise.resolve();
    const P = { paneId, status, gen: 0, timer: null, controller: null, inflight: null, pending: null,
      lastHookAt: 0, hookSeen: false, closed: false, sub: null, eventSeq: 0 };
    panes.set(paneId, P);
    if (status) onStatusChange({ paneId, prev: undefined, next: status, initial: true, source: 'snapshot' });
    return herdr.subscribe([{ type: 'pane.agent_status_changed', pane_id: paneId }], (msg) => onStatus(P, msg)).then(
      (sub) => { if (P.closed) sub.close(); else P.sub = sub; },
      (err) => { panes.delete(paneId); P.closed = true; log({ level: 'error', msg: 'status subscription failed', pane: paneId, err: err.message }); },
    );
  }

  function dropPane(paneId) {
    const P = panes.get(paneId);
    if (!P) return;
    P.closed = true;
    clearTimeout(P.timer);
    P.controller?.abort();
    P.sub?.close();
    panes.delete(paneId);
    onPaneClosed(paneId);
    const entry = store.get(paneId);
    if (entry) { store.delete(paneId); sidecar.evict?.(summaryKey(paneId, entry.revision)); }
  }

  async function sync() {
    // Events invalidate; the snapshot is the truth (Herdr docs, "Event subscriptions"). A status event that arrives
    // while the snapshot is in flight is newer than it, so that pane keeps its event status.
    const seqAt = new Map([...panes].map(([id, P]) => [id, P.eventSeq]));
    const snap = (await herdr.request('session.snapshot')).snapshot;
    const live = new Set();
    const subscribed = [];
    for (const p of snap?.panes ?? []) {
      live.add(p.pane_id);
      const known = panes.get(p.pane_id);
      if (!known) { subscribed.push(addPane(p.pane_id, p.agent_status)); continue; }
      if (known.eventSeq === seqAt.get(p.pane_id) && p.agent_status && p.agent_status !== known.status) {
        applyStatus(known, p.agent_status, 'snapshot'); // a change we missed while blind
      }
    }
    for (const id of [...panes.keys()]) if (!live.has(id)) dropPane(id);
    await Promise.all(subscribed); // events must flow before start() returns
  }

  let syncTimer = null;
  function scheduleSync() { // several subscriptions can come back together: one resync is enough
    if (stopped) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync().catch((err) => log({ level: 'error', msg: 'resync failed', err: err.message })), 50);
  }

  function onLifecycle(msg) {
    const kind = kindOf(msg);
    // pane_created nests the pane ({ pane: { pane_id } }, seen live); pane_closed carries pane_id directly.
    const paneId = msg.data?.pane?.pane_id ?? msg.data?.pane_id;
    if (kind === 'pane_created' && paneId) void addPane(paneId, undefined);
    else if (kind === 'pane_closed' && paneId) dropPane(paneId);
    else if (kind === 'subscription_restored') scheduleSync();
  }

  // ---- triggers --------------------------------------------------------------------------------------

  function onStatus(P, msg) {
    if (kindOf(msg) === 'subscription_restored') return scheduleSync(); // each pane has its own connection: it may be the only one that lost events
    const next = msg.data?.agent_status ?? msg.agent_status;
    if (!next) return;
    P.eventSeq++;
    applyStatus(P, next, 'event');
  }

  function applyStatus(P, next, source) {
    if (next === P.status) return;
    const prev = P.status;
    P.status = next;
    onStatusChange({ paneId: P.paneId, prev, next, source });
    if (next === 'done' || next === 'blocked' || (next === 'idle' && prev === 'working')) trigger(P, 'status');
  }

  function trigger(P, kind, hook) {
    if (P.closed || stopped) return;
    const now = Date.now();
    let delay;
    if (kind === 'hook') {
      P.lastHookAt = now;
      P.hookSeen = true;
      if (P.inflight === 'status') { P.controller?.abort(); } // the hook wins: drop the status-driven call
      P.pending = { kind, hook };
      delay = Math.min(coalesceMs, 50);
    } else {
      // Status path: skip when a hook has already covered this turn or is covering it right now.
      if (P.pending?.kind === 'hook' || P.inflight === 'hook' || now - P.lastHookAt < hookPreferMs) return;
      P.pending = { kind };
      delay = P.hookSeen ? hookWaitMs : coalesceMs; // a pane whose hook works gets time to deliver it
    }
    clearTimeout(P.timer);
    P.timer = setTimeout(() => launch(P), delay);
  }

  // ---- one Summary -----------------------------------------------------------------------------------

  async function gatherInput(P, job) {
    const labelP = herdr.request('session.snapshot').then(
      (r) => tabLabelOf(r.snapshot, P.paneId),
      () => undefined,
    );
    let input = null;
    if (job.kind === 'hook') {
      const turn = job.hook.transcriptPath ? await readTranscript(job.hook.transcriptPath) : null;
      if (turn) input = { text: turn.text, lastTool: turn.lastTool };
    }
    if (!input) { // status path, or a hook whose transcript is not readable yet: read the pane instead
      const res = await herdr.request('pane.read', { pane_id: P.paneId, source: 'recent_unwrapped', lines: PANE_LINES });
      const text = String(res?.read?.text ?? '').split('\n').slice(-PANE_LINES).join('\n').trim().slice(-MAX_INPUT_CHARS);
      if (text) input = { text, lastTool: undefined };
    }
    if (!input) return null;
    return { ...input, label: await labelP };
  }

  async function launch(P) {
    P.timer = null;
    const job = P.pending;
    P.pending = null;
    if (!job || P.closed || stopped) return 'stale';
    P.controller?.abort(); // at most one in-flight Summary per pane: the newest trigger wins
    const ac = new AbortController();
    const gen = ++P.gen;
    P.controller = ac;
    P.inflight = job.kind;
    const stale = () => P.closed || stopped || gen !== P.gen || ac.signal.aborted;
    try {
      const input = await gatherInput(P, job);
      if (!input || stale()) return 'stale';
      const splitter = job.kind === 'live' ? createSentenceSplitter() : null;
      let sentences = 0;
      const emit = (sentence) => { if (!stale()) job.onSentence?.(sentence, sentences++); };
      const out = await model.summarise({
        ...input,
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(bedrockTimeoutMs)]),
        ...(splitter ? { onToken: (delta) => splitter.push(delta).forEach(emit) } : {}),
      });
      if (splitter) splitter.flush().forEach(emit);
      if (stale()) return 'stale';
      const text = String(out?.text ?? '').trim();
      if (!text) { log({ level: 'warn', msg: 'empty summary', pane: P.paneId }); return 'failed'; }
      if (authLapsed) { authLapsed = false; log({ level: 'info', msg: 'credentials are back' }); }
      await commit(P, text, out.ttftMs, job.kind === 'live');
      return 'done';
    } catch (err) {
      if (isAbort(err) || stale()) return 'stale';
      if ((model.isAuthError ?? isCredentialsError)(err)) {
        log({ level: 'error', msg: 'summary failed: login lapsed', pane: P.paneId, err: err.name });
        if (!authLapsed) { authLapsed = true; onAuthLapsed(); }
      } else {
        log({ level: 'error', msg: 'summary failed', pane: P.paneId, err: err.name ?? 'Error', status: err.$metadata?.httpStatusCode });
      }
      return 'failed';
    } finally {
      if (P.gen === gen) { P.inflight = null; P.controller = null; }
    }
  }

  async function commit(P, text, ttftMs, live = false) {
    const previous = store.get(P.paneId);
    const revision = ++revisionCounter; // monotonic across pane drops, so audio keys are never reused
    const key = summaryKey(P.paneId, revision);
    store.set(P.paneId, { text, revision, at: Date.now() });
    if (previous) sidecar.evict?.(summaryKey(P.paneId, previous.revision));
    if (!live) sidecar.prerender({ key, text }); // pre-render so focus only has to play it; a live Summary was just spoken
    log({ level: 'info', msg: 'summary stored', pane: P.paneId, revision, ttft_ms: ttftMs, chars: text.length });
    try {
      await herdr.request('pane.report_metadata', {
        source, pane_id: P.paneId, tokens: { summary: capForTokens(text) }, ttl_ms: ttlMs,
      });
    } catch (err) {
      log({ level: 'warn', msg: 'could not mirror summary to tokens', pane: P.paneId, err: err.message });
    }
    if (!P.closed) onSummary({ paneId: P.paneId, text, revision, key, live });
  }

  // ---- public ----------------------------------------------------------------------------------------

  return {
    async start() {
      lifecycleSub = await herdr.subscribe([{ type: 'pane.created' }, { type: 'pane.closed' }], onLifecycle);
      await sync();
    },
    /** A Claude Code Stop hook fired for this pane. */
    onHook({ paneId, transcriptPath }) {
      const P = paneId ? panes.get(paneId) : undefined;
      if (!P) return;
      trigger(P, 'hook', { transcriptPath });
    },
    get: (paneId) => store.get(paneId),
    statusOf: (paneId) => panes.get(paneId)?.status,
    /**
     * Focus with nothing cached: summarise now and hand each finished sentence to `onSentence(text, index)`.
     * Resolves 'done' | 'busy' (a background Summary for the pane is already on its way and will be spoken when it
     * lands) | 'unknown-pane' | 'stale' (aborted) | 'failed' (logged; credential failures also fire onAuthLapsed once).
     */
    async summariseLive(paneId, { onSentence }) {
      const P = panes.get(paneId);
      if (!P) return 'unknown-pane';
      if (P.inflight || P.pending || P.timer) return 'busy';
      P.pending = { kind: 'live', onSentence };
      return launch(P); // 'done' | 'failed' | 'stale' (aborted: focus moved on, or the pane closed)
    },
    /** Abort a live Summary for this pane (focus moved on). Background Summaries are left alone. */
    cancelLive(paneId) {
      const P = panes.get(paneId);
      if (P?.inflight === 'live') P.controller?.abort();
    },
    async stop() {
      stopped = true;
      clearTimeout(syncTimer);
      lifecycleSub?.close();
      for (const id of [...panes.keys()]) dropPane(id);
    },
  };
}
