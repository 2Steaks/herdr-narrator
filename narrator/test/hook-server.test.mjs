import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHookServer } from '../lib/hook-server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-server-'));
let n = 0;
const sockPath = () => path.join(dir, `g${n++}`, 'narrator.sock');
let server;
afterEach(async () => { await server?.stop(); server = null; });

const send = (file, payload) => new Promise((resolve, reject) => {
  const c = net.createConnection(file, () => c.end(payload));
  c.on('close', resolve);
  c.on('error', reject);
});

test('a hook line becomes onHook with the pane id and transcript path', async () => {
  const got = [];
  const file = sockPath();
  server = createHookServer({ socketPath: file, onHook: (h) => got.push(h) });
  await server.start();
  await send(file, JSON.stringify({ pane_id: 'w1:p2', hook: { transcript_path: '/tmp/t.jsonl', session_id: 's' } }) + '\n');
  await sleep(20);
  assert.deepEqual(got, [{ paneId: 'w1:p2', transcriptPath: '/tmp/t.jsonl' }]);
});

test('the socket is private to the user', async () => {
  const file = sockPath();
  server = createHookServer({ socketPath: file, onHook: () => {} });
  await server.start();
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
});

test('malformed or incomplete input is dropped without logging its content', async () => {
  const got = [];
  const logs = [];
  const file = sockPath();
  server = createHookServer({ socketPath: file, onHook: (h) => got.push(h), log: (e) => logs.push(e) });
  await server.start();
  await send(file, 'SECRET not json\n');
  await send(file, JSON.stringify({ hook: { transcript_path: '/x' } }) + '\n'); // no pane id
  await send(file, JSON.stringify({ pane_id: 'w1:p2', hook: 'SECRET' }) + '\n');
  await sleep(30);
  assert.deepEqual(got.filter((h) => h.transcriptPath), []);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});

test('a stale socket file from a crashed the Narrator is replaced', async () => {
  const file = sockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ''); // not a live socket
  server = createHookServer({ socketPath: file, onHook: () => {} });
  await server.start();
  assert.ok(fs.statSync(file).isSocket());
});

test('a second the Narrator does not steal the socket of a running one', async () => {
  const file = sockPath();
  server = createHookServer({ socketPath: file, onHook: () => {} });
  await server.start();
  const second = createHookServer({ socketPath: file, onHook: () => {} });
  await assert.rejects(second.start(), /already running/);
});

test('stop removes the socket file, so the hook sees the Narrator is not running', async () => {
  const file = sockPath();
  server = createHookServer({ socketPath: file, onHook: () => {} });
  await server.start();
  await server.stop();
  assert.equal(fs.existsSync(file), false);
});
