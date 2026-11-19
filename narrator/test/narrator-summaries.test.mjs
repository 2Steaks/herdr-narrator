// Focus is playback only; background Summaries fill the cache. Whole Narrator against a fake Herdr, Bedrock and sidecar.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createNarrator } from '../narrator.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';
import { createFakeBedrock } from './fake-bedrock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(5); }
  assert.fail('condition not met in time: ' + fn);
}
const DEBOUNCE = 60;
const OWN = 'p-narrator';
let herdr, sidecar, bedrock, narrator, logs, dir, hookSock;

beforeEach(async () => {
  herdr = await startFakeHerdr();
  herdr.addPane('p-api', { tab: 't-api', agent: 'claude', text: 'api pane text' });
  herdr.addPane('p-web', { tab: 't-web', agent: 'codex', text: 'web pane text' });
  herdr.addPane(OWN, { tab: 't-narrator' });
  sidecar = createFakeSidecar();
  bedrock = createFakeBedrock({ reply: (n) => `Sentence number ${n}.` });
  logs = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-sum-'));
  hookSock = path.join(dir, 'narrator.sock');
  narrator = createNarrator({
    socketPath: herdr.socketPath, ownPaneId: OWN, sidecar, bedrock, hookSocketPath: hookSock,
    debounceMs: DEBOUNCE, log: (e) => logs.push(e),
    summariserOptions: { coalesceMs: 20, hookWaitMs: 100, hookPreferMs: 100 },
  });
  await narrator.start();
});
afterEach(async () => { await narrator.stop(); await herdr.close(); });

const prerenders = () => sidecar.calls.filter((c) => c.op === 'prerender');
const sendHook = (payload) => new Promise((resolve) => { const c = net.createConnection(hookSock, () => c.end(JSON.stringify(payload) + '\n')); c.on('close', resolve); });

test('a background agent going working to done updates $summary and says nothing', async () => {
  herdr.setFocused('p-api'); // focus is on p-api (no event: a focus event would start a live Summary); p-web is in the background
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => herdr.reports.length === 1);
  await sleep(100);
  assert.equal(herdr.reports[0].tokens.summary, 'Sentence number 1.');
  assert.deepEqual(sidecar.spoken, []);
  assert.equal(prerenders().length, 1);
});

test('focusing a pane plays its pre-rendered Summary by key, with no Herdr request on the way', async () => {
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => prerenders().length === 1);
  // The Summary is also mirrored into tokens.summary: that background write is not part of focusing.
  await until(() => herdr.requestsFor('pane.report_metadata').length >= 1);
  const before = herdr.state.requests.length;
  sidecar.calls.length = 0;
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 3);
  const [speak] = sidecar.calls.filter((c) => c.op === 'speak');
  assert.equal(speak.key, 'p-web#1', 'the key pre-rendering used');
  assert.equal(speak.text, 'Sentence number 1.');
  assert.deepEqual(herdr.state.requests.slice(before).map((r) => r.method), [], 'pane.focused names the pane, so playback needs no request');
});

test('a background Summary for the focused pane is spoken', async () => {
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 2);
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => sidecar.spoken.length === 1);
  assert.deepEqual(sidecar.spoken, ['Sentence number 1.']);
});

test('a background Summary is not spoken while focus is still settling', async () => {
  herdr.setFocused('p-web');
  herdr.focusPane('p-web'); // debounce now pending
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => prerenders().length === 1);
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['Sentence number 1.'], 'spoken once, by the focus path, not twice');
});

test('a new focus cancels a background Summary that is being spoken', async () => {
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 2);
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => sidecar.spoken.length === 1);
  sidecar.calls.length = 0;
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE / 4);
  assert.equal(sidecar.calls[0].op, 'cancel');
});

test('a Stop hook line on the socket summarises that pane from its transcript', async () => {
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests pass.' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
  ].join('\n'));
  await sendHook({ pane_id: 'p-api', hook: { transcript_path: file } });
  await until(() => herdr.reports.length === 1);
  assert.equal(herdr.reports[0].pane_id, 'p-api');
  assert.equal(bedrock.calls[0].lastTool, 'Bash');
  assert.equal(herdr.requestsFor('pane.read').length, 0);
});

test('a focused pane without a stored Summary still plays the Summary in tokens.summary', async () => {
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.focusPane('p-old');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['A stored summary.']);
});

test('the Narrator keeps running when Bedrock is down: focus playback still works', async () => {
  bedrock.failWith = Object.assign(new Error('boom'), { name: 'ServiceUnavailableException' });
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => logs.some((l) => l.level === 'error'));
  herdr.focusPane('p-old');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['A stored summary.']);
});
