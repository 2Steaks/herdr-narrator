// The hook server's quit command, and createNarrator handing it to onQuit.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookServer } from '../lib/hook-server.mjs';
import { createNarrator } from '../narrator.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quit-'));
const sendLine = (sock, line) => new Promise((resolve) => { const c = net.createConnection(sock, () => c.end(line + '\n')); c.on('close', resolve); c.on('error', resolve); });
let server; let narrator; let herdr;
afterEach(async () => { await server?.stop(); await narrator?.stop(); await herdr?.close(); server = narrator = herdr = null; });

test('the hook server hands "quit" to onCommand', async () => {
  const got = [];
  const sock = path.join(dir, 'a', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: () => {}, onCommand: (c) => got.push(c) });
  await server.start();
  await sendLine(sock, '{"cmd":"quit"}');
  await sleep(30);
  assert.deepEqual(got, ['quit']);
});

test('replay and mute still arrive, and an unknown command still does not', async () => {
  const got = [];
  const sock = path.join(dir, 'b', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: () => {}, onCommand: (c) => got.push(c) });
  await server.start();
  for (const c of ['replay', 'mute', 'explode']) await sendLine(sock, JSON.stringify({ cmd: c }));
  await sleep(30);
  assert.deepEqual(got, ['replay', 'mute']);
});

test('createNarrator calls onQuit when the quit command arrives', async () => {
  herdr = await startFakeHerdr();
  let quits = 0;
  const sock = path.join(dir, 'c', 'narrator.sock');
  narrator = createNarrator({ socketPath: herdr.socketPath, sidecar: createFakeSidecar(), hookSocketPath: sock, onQuit: () => { quits++; } });
  await narrator.start();
  await sendLine(sock, '{"cmd":"quit"}');
  await sleep(50);
  assert.equal(quits, 1);
});
