// plugin/start.sh: launch the Narrator detached and exit at once. Everything is stubbed: a fake `node` that records
// how it was started, a temp HOME, a stripped environment (no nvm, no shell profile), a fake the Narrator socket.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SYSTEM_PATH = '/usr/bin:/bin';

let cleanup = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'start-sh-'));
  const marks = path.join(home, 'marks');
  fs.mkdirSync(marks);
  /** A fake node at `file`: records who it is, its args, pid, process group and whether HERDR_PANE_ID leaked in, then idles. */
  const fakeNode = (file, label) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh
d=${JSON.stringify(marks)}
echo ${label} > "$d/label"
echo "$@" > "$d/args"
echo $$ > "$d/pid"
ps -o pgid= -p $$ | tr -d ' ' > "$d/pgid"
echo "pane=\${HERDR_PANE_ID-unset} sock=\${HERDR_SOCKET_PATH-unset}" > "$d/env"
echo "to stdout"
echo "to stderr" >&2
exec sleep 30
`, { mode: 0o755 });
    return file;
  };
  const read = (f) => (fs.existsSync(path.join(marks, f)) ? fs.readFileSync(path.join(marks, f), 'utf8').trim() : null);
  const waitFor = async (f, ms = 5000) => { const t = Date.now(); while (read(f) === null) { if (Date.now() - t > ms) throw new Error(`${f} never appeared`); await sleep(25); } return read(f); };
  const logFile = path.join(home, '.narrator', 'narrator.log');
  const sock = path.join(home, '.narrator', 'narrator.sock');
  cleanup.push(() => { const pid = Number(read('pid')); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); });
  const run = (env = {}, { detached = false } = {}) => new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('/bin/sh', [path.join(PLUGIN, 'start.sh')], {
      cwd: PLUGIN, detached, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: SYSTEM_PATH, HERDR_SOCKET_PATH: '/fake/herdr.sock', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0, pgid: child.pid }));
  });
  return { home, marks, fakeNode, read, waitFor, logFile, sock, run };
}

const logText = (s) => (fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, 'utf8') : '');

test('launches the Narrator with the node on PATH, exits 0 at once and prints nothing', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  const r = await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(r.ms < 3000, `exited in ${r.ms} ms`);
  assert.equal(await s.waitFor('label'), 'path');
  assert.equal(await s.waitFor('args'), fs.realpathSync(path.join(PLUGIN, '../narrator.mjs')));
});

test('the Narrator gets Herdr\'s socket but not a pane id: a hidden Narrator has no pane of its own', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}`, HERDR_PANE_ID: 'w1:p9' });
  assert.equal(await s.waitFor('env'), 'pane=unset sock=/fake/herdr.sock');
});

test('stdout and stderr are appended to the log', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  fs.mkdirSync(path.dirname(s.logFile), { recursive: true });
  fs.writeFileSync(s.logFile, 'earlier line\n');
  await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` });
  await s.waitFor('env');
  await sleep(150);
  const text = logText(s);
  assert.match(text, /^earlier line\n/);
  assert.match(text, /to stdout/);
  assert.match(text, /to stderr/);
});

test('it survives the start hook exiting and its process group being killed', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  const r = await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` }, { detached: true }); // detached: the hook is its own group leader
  assert.equal(r.code, 0);
  const pid = Number(await s.waitFor('pid'));
  assert.notEqual(Number(await s.waitFor('pgid')), r.pgid, 'the Narrator is in a group of its own');
  try { process.kill(-r.pgid, 'SIGKILL'); } catch { /* the group may be empty already */ }
  await sleep(200);
  assert.ok(alive(pid), 'the Narrator is still running');
});

test('does not start a second the Narrator while one answers on the socket', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  fs.mkdirSync(path.dirname(s.sock), { recursive: true });
  const server = net.createServer((c) => c.on('error', () => {}).end());
  await new Promise((resolve) => server.listen(s.sock, resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const r = await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` });
  assert.equal(r.code, 0);
  await sleep(400);
  assert.equal(s.read('label'), null, 'node was never run');
});

test('a stale socket file does not count as a running the Narrator', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  fs.mkdirSync(path.dirname(s.sock), { recursive: true });
  fs.writeFileSync(s.sock, '');
  await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` });
  assert.equal(await s.waitFor('label'), 'path');
});

test('node is looked up on PATH first, then NARRATOR_NODE, then the newest nvm node', async () => {
  const s = sandbox();
  const nvm = (v) => path.join(s.home, '.nvm', 'versions', 'node', v, 'bin', 'node');
  s.fakeNode(nvm('v9.11.2'), 'nvm-v9');
  s.fakeNode(nvm('v24.1.0'), 'nvm-v24.1.0');
  s.fakeNode(nvm('v24.10.0'), 'nvm-v24.10.0');
  s.fakeNode(nvm('v18.20.4'), 'nvm-v18');
  const custom = s.fakeNode(path.join(s.home, 'custom', 'node'), 'narrator-node');
  const pathNode = path.join(s.home, 'bin', 'node');
  const labelOf = async (env) => {
    fs.rmSync(path.join(s.marks, 'label'), { force: true });
    const pid = Number(s.read('pid'));
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(path.join(s.marks, 'pid'), { force: true });
    await s.run(env);
    return s.waitFor('label');
  };
  assert.equal(await labelOf({}), 'nvm-v24.10.0', 'newest by version number, not by name');
  assert.equal(await labelOf({ NARRATOR_NODE: custom }), 'narrator-node', 'NARRATOR_NODE beats nvm');
  s.fakeNode(pathNode, 'path');
  assert.equal(await labelOf({ NARRATOR_NODE: custom, PATH: `${path.dirname(pathNode)}:${SYSTEM_PATH}` }), 'path', 'PATH beats NARRATOR_NODE');
  assert.equal(await labelOf({ NARRATOR_NODE: '/nonexistent/node' }), 'nvm-v24.10.0', 'a bad NARRATOR_NODE falls through');
});

test('with no node anywhere: one clear log line, exit 0, nothing launched', async () => {
  const s = sandbox();
  const r = await s.run({});
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  await sleep(300);
  assert.equal(s.read('label'), null);
  const lines = logText(s).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no node found/);
  assert.match(lines[0], /NARRATOR_NODE/);
});

test('a log over 5 MB is rotated to .1 at launch, keeping one copy', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  fs.mkdirSync(path.dirname(s.logFile), { recursive: true });
  fs.writeFileSync(s.logFile, 'x'.repeat(5 * 1024 * 1024 + 1));
  fs.writeFileSync(`${s.logFile}.1`, 'older copy');
  await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` });
  await s.waitFor('env');
  await sleep(150);
  assert.equal(fs.statSync(`${s.logFile}.1`).size, 5 * 1024 * 1024 + 1, 'the big log became .1 and the older copy is gone');
  assert.ok(!logText(s).includes('xxxx'), 'the new log starts empty');
  assert.match(logText(s), /to stdout/);
});

test('a log at or under 5 MB is left alone', async () => {
  const s = sandbox();
  s.fakeNode(path.join(s.home, 'bin', 'node'), 'path');
  fs.mkdirSync(path.dirname(s.logFile), { recursive: true });
  fs.writeFileSync(s.logFile, 'x'.repeat(5 * 1024 * 1024));
  await s.run({ PATH: `${path.join(s.home, 'bin')}:${SYSTEM_PATH}` });
  await s.waitFor('env');
  assert.ok(!fs.existsSync(`${s.logFile}.1`));
});
