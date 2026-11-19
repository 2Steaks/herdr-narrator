// narrator.mjs run as a script, the way start.sh launches it: stub sidecar, fake Herdr, temp HOME, no Bedrock.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeHerdr } from './fake-herdr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NARRATOR_MAIN = path.join(HERE, '../narrator.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let herdr; let child; let sidecarPid;
afterEach(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (sidecarPid && alive(sidecarPid)) process.kill(sidecarPid, 'SIGKILL');
  await herdr?.close();
  child = null; sidecarPid = null;
});

async function launch(env = {}) {
  herdr = await startFakeHerdr();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-proc-'));
  const pyStub = path.join(home, 'python-stub.sh');
  fs.writeFileSync(pyStub, `#!/bin/sh\necho $$ > ${JSON.stringify(path.join(home, 'sidecar.pid'))}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(HERE, 'stub-sidecar-child.mjs'))}\n`, { mode: 0o755 });
  const sock = path.join(home, '.narrator', 'narrator.sock');
  child = spawn(process.execPath, [NARRATOR_MAIN], {
    env: { PATH: process.env.PATH, HOME: home, NARRATOR_SOCK: sock, NARRATOR_STATE: path.join(home, 'state.json'), NARRATOR_PYTHON: pyStub, NARRATOR_NO_SUMMARISER: '1', HERDR_SOCKET_PATH: herdr.socketPath, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const until = async (pred, ms = 8000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error(`timeout; stderr so far: ${err}`); await sleep(25); } };
  await until(() => err.includes('narrator is listening') || child.exitCode !== null);
  if (fs.existsSync(path.join(home, 'sidecar.pid'))) sidecarPid = Number(fs.readFileSync(path.join(home, 'sidecar.pid'), 'utf8'));
  return { home, sock, exited, stderr: () => err };
}

const sendLine = (sock, line) => new Promise((resolve) => { const c = net.createConnection(sock, () => c.end(line + '\n')); c.on('close', resolve); c.on('error', resolve); });

test('it starts without HERDR_PANE_ID and says so on stderr', async () => {
  const g = await launch();
  assert.equal(child.exitCode, null, 'still running');
  assert.match(g.stderr(), /narrator is listening/);
  assert.doesNotMatch(g.stderr(), /must be set/);
  assert.ok(fs.existsSync(g.sock), 'its socket is up');
});

test('with HERDR_PANE_ID set it starts too', async () => {
  const g = await launch({ HERDR_PANE_ID: 'p-1' });
  assert.equal(child.exitCode, null);
  assert.match(g.stderr(), /"own_pane":"p-1"/);
});

test('HERDR_SOCKET_PATH is still required', async () => {
  const g = await launch({ HERDR_SOCKET_PATH: '' });
  assert.deepEqual(await g.exited, { code: 1, signal: null });
  assert.match(g.stderr(), /HERDR_SOCKET_PATH must be set/);
});

test('the quit command stops the sidecar, removes its socket and exits 0', async () => {
  const g = await launch();
  assert.ok(sidecarPid && alive(sidecarPid), 'sidecar is running');
  await sendLine(g.sock, '{"cmd":"quit"}');
  assert.deepEqual(await g.exited, { code: 0, signal: null });
  assert.equal(fs.existsSync(g.sock), false, 'socket removed');
  await sleep(100);
  assert.equal(alive(sidecarPid), false, 'sidecar is gone');
});

test('SIGTERM shuts its down the same way', async () => {
  const g = await launch();
  child.kill('SIGTERM');
  assert.deepEqual(await g.exited, { code: 0, signal: null });
  assert.equal(fs.existsSync(g.sock), false);
});
