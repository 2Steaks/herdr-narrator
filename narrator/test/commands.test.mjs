// Plugin command lines on ~/.narrator/narrator.sock: {"cmd":"replay"} and {"cmd":"mute"}.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHookServer } from '../lib/hook-server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-'));
let n = 0;
let server;
afterEach(async () => { await server?.stop(); server = null; });

const send = (file, payload) => new Promise((resolve, reject) => {
  const c = net.createConnection(file, () => c.end(payload));
  c.on('close', resolve);
  c.on('error', reject);
});

test('a plugin command line (replay or mute) becomes onCommand, and unknown commands are dropped', async () => {
  const got = [];
  const file = path.join(dir, `g${n++}`, 'narrator.sock');
  server = createHookServer({ socketPath: file, onHook: () => assert.fail('not a hook'), onCommand: (c) => got.push(c) });
  await server.start();
  await send(file, '{"cmd":"replay"}\n');
  await send(file, '{"cmd":"mute"}\n');
  await send(file, '{"cmd":"rm -rf"}\n');
  await sleep(30);
  assert.deepEqual(got, ['replay', 'mute']);
});

test('a hook line still reaches onHook when commands are enabled', async () => {
  const hooks = [];
  const file = path.join(dir, `g${n++}`, 'narrator.sock');
  server = createHookServer({ socketPath: file, onHook: (h) => hooks.push(h), onCommand: () => assert.fail('not a command') });
  await server.start();
  await send(file, JSON.stringify({ pane_id: 'w1:p2', hook: { transcript_path: '/tmp/t.jsonl' } }) + '\n');
  await sleep(30);
  assert.deepEqual(hooks, [{ paneId: 'w1:p2', transcriptPath: '/tmp/t.jsonl' }]);
});
