// Node side of the Kokoro sidecar (ADR 0002): spawn it, talk newline-delimited JSON over stdio.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PYTHON = path.join(os.homedir(), 'narrator-voice/.venv/bin/python');
const DEFAULT_SCRIPT = path.join(HERE, '../sidecar/kokoro_sidecar.py');

/**
 * speak({key, text}) resolves when audio has started: { cancelled, renderMs, cached, startedAtMs, ended }, where
 * `ended` is a promise that resolves once the line has finished or been cut off (absent when cancelled before it started).
 * cancel() stops playback. A dead sidecar is logged and respawned on the next speak, never thrown at the caller loop.
 */
export function createSidecar({
  command = process.env.NARRATOR_PYTHON ?? DEFAULT_PYTHON,
  args = [DEFAULT_SCRIPT],
  env = {},
  log = () => {},
} = {}) {
  let child = null;
  let ready = null;
  let nextId = 1;
  const waiting = new Map(); // id -> { resolve, info }
  let closed = false;

  function failAll(reason) {
    for (const [id, w] of waiting) { w.resolve({ cancelled: true, error: reason }); w.end('cancelled'); waiting.delete(id); }
  }

  function start() {
    const proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    let buf = '';
    let readyResolve;
    ready = new Promise((r) => { readyResolve = r; });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { log({ level: 'warn', msg: 'malformed line from sidecar', len: line.length }); continue; }
        handle(msg, readyResolve);
      }
    });
    proc.stderr.on('data', () => {}); // Python tracebacks can contain text; keep them out of our log
    proc.on('error', (e) => log({ level: 'error', msg: 'sidecar failed to start', err: e.message }));
    proc.on('exit', (code, signal) => {
      if (child === proc) { child = null; ready = null; }
      readyResolve?.(false);
      failAll('sidecar exited');
      if (!closed) log({ level: 'error', msg: 'sidecar exited', code, signal });
    });
  }

  function handle(msg, readyResolve) {
    if (msg.event === 'ready') { log({ level: 'info', msg: 'sidecar ready', load_ms: msg.load_ms }); return readyResolve(true); }
    if (msg.event === 'log') { const { event, ...entry } = msg; return log(entry); } // device names only, never text
    const w = waiting.get(msg.id);
    if (msg.event === 'render' && w) { w.info = { renderMs: msg.render_ms, cached: msg.cached }; return; }
    if (msg.event === 'started' && w) { return w.resolve({ cancelled: false, ...w.info, startedAtMs: msg.t_ms, ended: w.ended }); }
    if ((msg.event === 'cancelled' || msg.event === 'error') && w) {
      if (msg.event === 'error') log({ level: 'error', msg: 'sidecar error', err: msg.message });
      waiting.delete(msg.id);
      w.resolve({ cancelled: true, error: msg.message });
      return w.end('cancelled');
    }
    if (msg.event === 'done') { w?.end('done'); waiting.delete(msg.id); }
    if (msg.event === 'error' && msg.id === undefined) log({ level: 'error', msg: 'sidecar error', err: msg.message });
  }

  function send(obj) {
    child?.stdin.write(JSON.stringify(obj) + '\n');
  }

  return {
    /** Starts the process and resolves once the model is loaded. */
    async warm() {
      if (!child) start();
      return ready;
    },
    async speak({ key, text }) {
      if (!child) start();
      if (!(await ready)) return { cancelled: true, error: 'sidecar not ready' };
      const id = nextId++;
      return new Promise((resolve) => {
        let end;
        const ended = new Promise((r) => { end = r; }); // resolves when the line has finished or been cut off
        waiting.set(id, { resolve, info: {}, ended, end });
        send({ op: 'speak', id, key, text });
      });
    },
    /** A confirmation tone, no speech. kind is 'muted' or 'unmuted'. Resolves like speak. */
    chime(kind) {
      return this.speak({ key: `_chime:${kind}`, text: 'chime' });
    },
    /** Render into the sidecar's audio cache without playing. Fire and forget. */
    render({ key, text }) {
      if (!child) start();
      ready.then((ok) => { if (ok) send({ op: 'render', id: nextId++, key, text }); });
    },
    /** Background render into the cache: queued behind nothing, never replaced by a newer one. Fire and forget. */
    prerender({ key, text }) {
      if (!child) start();
      ready.then((ok) => { if (ok) send({ op: 'prerender', id: nextId++, key, text }); });
    },
    /** Drop a cached line, for a closed pane or a newer revision. */
    evict(key) {
      if (child) send({ op: 'evict', key });
    },
    cancel() {
      if (child) send({ op: 'cancel' });
    },
    async close() {
      closed = true;
      if (child) { send({ op: 'quit' }); child.kill(); }
    },
  };
}
