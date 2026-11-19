import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHookServer } from '../lib/hook-server.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '../hook/narrator-stop-hook.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let server;
afterEach(async () => { await server?.stop(); server = null; });

/** Runs the hook with `stdin`, resolves { code, out, ms }. */
function run(stdin, env) {
  return new Promise((resolve) => {
    const t = performance.now();
    const child = spawn('/bin/sh', [HOOK], { env: { PATH: process.env.PATH, HOME: dir, NARRATOR_AUTOSTART: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: performance.now() - t }));
    child.stdin.end(stdin);
  });
}
const HOOK_JSON = JSON.stringify({ session_id: 's1', transcript_path: '/tmp/t.jsonl', hook_event_name: 'Stop', stop_hook_active: false }) + '\n';

test('hook JSON plus HERDR_PANE_ID reach the Narrator, and the hook exits 0 silently', async () => {
  const got = [];
  const sock = path.join(dir, 'a', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: (h) => got.push(h) });
  await server.start();
  const res = await run(HOOK_JSON, { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w2B:pK' });
  await sleep(30);
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
  assert.deepEqual(got, [{ paneId: 'w2B:pK', transcriptPath: '/tmp/t.jsonl' }]);
});

test('multi-line hook JSON still arrives as one message', async () => {
  const got = [];
  const sock = path.join(dir, 'b', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: (h) => got.push(h) });
  await server.start();
  await run(JSON.stringify({ transcript_path: '/tmp/x.jsonl', cwd: '/a' }, null, 2), { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' });
  await sleep(30);
  assert.deepEqual(got, [{ paneId: 'w1:p1', transcriptPath: '/tmp/x.jsonl' }]);
});

test('a hostile HERDR_PANE_ID cannot break out of the JSON line', async () => {
  const got = [];
  const sock = path.join(dir, 'c', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: (h) => got.push(h) });
  await server.start();
  await run(HOOK_JSON, { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1","x":"' });
  await sleep(30);
  assert.deepEqual(got.map((g) => g.paneId), ['w1:p1x:']);
});

test('the Narrator not running: exits 0 within 50 ms and does nothing (no socket, and a stale socket file)', async () => {
  const missing = path.join(dir, 'nope.sock');
  const stale = path.join(dir, 'stale.sock');
  fs.writeFileSync(stale, '');
  for (const sock of [missing, stale]) {
    const times = [];
    for (let i = 0; i < 7; i++) {
      const res = await run(HOOK_JSON, { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' });
      assert.equal(res.code, 0);
      assert.equal(res.out, '');
      times.push(res.ms);
    }
    assert.ok(median(times) < 50, `median ${median(times)} ms for ${path.basename(sock)}`);
  }
});

test('a dead socket (file left by a crashed the Narrator) is also a quick no-op', async () => {
  const sock = path.join(dir, 'dead.sock');
  await new Promise((resolve) => { const s = net.createServer().listen(sock, () => { s.close(); resolve(); }); });
  // net closes the listener but leaves the socket inode behind on some platforms; make sure one exists
  if (!fs.existsSync(sock)) fs.writeFileSync(sock, '');
  const res = await run(HOOK_JSON, { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' });
  assert.equal(res.code, 0);
  assert.ok(res.ms < 50, `${res.ms} ms`);
});

test('with the Narrator running the hook still exits within 50 ms (median of 7)', async () => {
  const sock = path.join(dir, 'd', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: () => {} });
  await server.start();
  const times = [];
  for (let i = 0; i < 7; i++) times.push((await run(HOOK_JSON, { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' })).ms);
  assert.ok(median(times) < 50, `median ${median(times)} ms`);
});

test('a wedged the Narrator (accepts, never reads) cannot hold the hook: exits within 100 ms, nothing printed', async () => {
  const sock = path.join(dir, 'wedged.sock');
  const conns = new Set();
  const wedged = net.createServer((c) => { conns.add(c); c.on('error', () => {}); }); // accepts, never reads
  await new Promise((r) => wedged.listen(sock, r));
  try {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const res = await run(HOOK_JSON, { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' });
      assert.equal(res.code, 0);
      assert.equal(res.out, '');
      times.push(res.ms);
    }
    assert.ok(Math.max(...times) < 100, `slowest ${Math.max(...times)} ms`);
  } finally {
    for (const c of conns) c.destroy();
    await new Promise((r) => wedged.close(r));
  }
});

/** A stand-in for plugin/start.sh: records that it ran. */
function fakeStart(name) {
  const file = path.join(dir, `${name}-start.sh`);
  const mark = path.join(dir, `${name}-started`);
  fs.writeFileSync(file, `#!/bin/sh\necho run >> ${JSON.stringify(mark)}\n`, { mode: 0o755 });
  return { file, runs: () => (fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim().split('\n').length : 0) };
}

test('the Narrator down: the hook exits fast, starts it, and the line arrives once it is up', async () => {
  const got = [];
  const sock = path.join(dir, 'auto', 'narrator.sock');
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const start = fakeStart('auto');
  const res = await run(HOOK_JSON, { NARRATOR_SOCK: sock, NARRATOR_AUTOSTART: '1', NARRATOR_START: start.file, HERDR_PANE_ID: 'w1:p1' });
  assert.equal(res.code, 0);
  assert.equal(res.out, '');
  assert.ok(res.ms < 100, `${res.ms} ms`);
  await sleep(300); // The Narrator takes a moment to come up
  server = createHookServer({ socketPath: sock, onHook: (h) => got.push(h) });
  await server.start();
  await sleep(600);
  assert.equal(start.runs(), 1);
  assert.deepEqual(got, [{ paneId: 'w1:p1', transcriptPath: '/tmp/t.jsonl' }]);
});

test('the Narrator up: the hook never runs start.sh', async () => {
  const sock = path.join(dir, 'up', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: () => {} });
  await server.start();
  const start = fakeStart('up');
  await run(HOOK_JSON, { NARRATOR_SOCK: sock, NARRATOR_AUTOSTART: '1', NARRATOR_START: start.file, HERDR_PANE_ID: 'w1:p1' });
  await sleep(200);
  assert.equal(start.runs(), 0);
});

test('NARRATOR_AUTOSTART=0 keeps the old behaviour: the Narrator down means nothing starts', async () => {
  const sock = path.join(dir, 'off', 'narrator.sock');
  const start = fakeStart('off');
  const res = await run(HOOK_JSON, { NARRATOR_SOCK: sock, NARRATOR_AUTOSTART: '0', NARRATOR_START: start.file, HERDR_PANE_ID: 'w1:p1' });
  await sleep(200);
  assert.equal(res.code, 0);
  assert.equal(start.runs(), 0);
});

test('two hooks while the Narrator is down start it once', async () => {
  const sock = path.join(dir, 'two', 'narrator.sock');
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const slow = path.join(dir, 'two-start.sh');
  const mark = path.join(dir, 'two-started');
  fs.writeFileSync(slow, `#!/bin/sh\necho run >> ${JSON.stringify(mark)}\nsleep 0.5\n`, { mode: 0o755 });
  const env = { NARRATOR_SOCK: sock, NARRATOR_AUTOSTART: '1', NARRATOR_START: slow, HERDR_PANE_ID: 'w1:p1' };
  await Promise.all([run(HOOK_JSON, env), run(HOOK_JSON, env)]);
  await sleep(900);
  assert.equal(fs.readFileSync(mark, 'utf8').trim().split('\n').length, 1);
});
