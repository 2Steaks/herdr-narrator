// The Herdr plugin: manifest shape and the script each action runs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHookServer } from '../lib/hook-server.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugin');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
afterEach(async () => { await server?.stop(); server = null; });

const manifest = fs.readFileSync(path.join(PLUGIN, 'herdr-plugin.toml'), 'utf8');

test('the manifest declares plugin "narrator" with replay, mute and quit actions that run send.sh', () => {
  assert.match(manifest, /^id = "narrator"$/m);
  assert.match(manifest, /^min_herdr_version = "/m, 'required by Herdr');
  for (const action of ['replay', 'mute', 'quit']) {
    const block = manifest.split('[[actions]]').find((b) => new RegExp(`^id = "${action}"$`, 'm').test(b));
    assert.ok(block, `action ${action} is declared`);
    assert.match(block, new RegExp(`^command = \\["sh", "send\\.sh", "${action}"\\]$`, 'm'));
    assert.match(block, /^contexts = \["global"\]$/m);
  }
  assert.ok(fs.existsSync(path.join(PLUGIN, 'send.sh')), 'the script the commands run exists');
});

function run(arg, env) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [path.join(PLUGIN, 'send.sh'), arg], { cwd: PLUGIN, env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('each action sends its one line to Narrator', async () => {
  const got = [];
  const sock = path.join(dir, 'a', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: () => {}, onCommand: (c) => got.push(c) });
  await server.start();
  assert.deepEqual(await run('replay', { NARRATOR_SOCK: sock }), { code: 0, out: '' });
  assert.deepEqual(await run('mute', { NARRATOR_SOCK: sock }), { code: 0, out: '' });
  await sleep(30);
  assert.deepEqual(got, ['replay', 'mute']);
});

test('with the Narrator not running the action exits 0 and says nothing', async () => {
  assert.deepEqual(await run('mute', { NARRATOR_SOCK: path.join(dir, 'nope.sock') }), { code: 0, out: '' });
});

test('the quit action sends quit to Narrator', async () => {
  const got = [];
  const sock = path.join(dir, 'q', 'narrator.sock');
  server = createHookServer({ socketPath: sock, onHook: () => {}, onCommand: (c) => got.push(c) });
  await server.start();
  assert.deepEqual(await run('quit', { NARRATOR_SOCK: sock }), { code: 0, out: '' });
  await sleep(30);
  assert.deepEqual(got, ['quit']);
});

test('the manifest keeps the visible debug pane and the startup hook that runs start.sh', () => {
  const pane = manifest.split('[[panes]]')[1].split('[[startup]]')[0];
  assert.match(pane, /^id = "narrator"$/m);
  assert.match(pane, /^command = \["bash", "run-narrator\.sh"\]$/m);
  assert.match(manifest.split('[[startup]]')[1], /^command = \["sh", "start\.sh"\]$/m);
});

test('anything but replay, mute or quit is refused', async () => {
  assert.equal((await run('rm', { NARRATOR_SOCK: path.join(dir, 'nope.sock') })).code, 2);
});
