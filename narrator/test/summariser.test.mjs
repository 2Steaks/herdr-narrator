import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHerdrClient } from '../lib/herdr.mjs';
import { createSummariser } from '../lib/summariser.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';
import { createFakeBedrock } from './fake-bedrock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(5); }
  assert.fail('condition not met in time: ' + fn);
}
const OWN = 'p-narrator';
const PANE_TEXT = 'SECRET-PANE-TEXT the build failed in the checkout form';
const HOOK_TEXT = 'SECRET-TRANSCRIPT-TEXT all green';

let herdr, client, sidecar, bedrock, summariser, logs, summaries, lapsed, dir;

async function setup(bedrockOpts, summariserOpts = {}) {
  herdr = await startFakeHerdr();
  herdr.addPane('p-api', { tab: 't-api', agent: 'claude', text: PANE_TEXT });
  herdr.addPane('p-shell', { tab: 't-shell', agent: 'codex', text: PANE_TEXT });
  herdr.addPane(OWN, { tab: 't-narrator', agent: 'claude', text: 'own pane' });
  herdr.state.tabLabels['t-api'] = 'API';
  client = createHerdrClient({ socketPath: herdr.socketPath });
  sidecar = createFakeSidecar();
  bedrock = createFakeBedrock(bedrockOpts);
  logs = [];
  summaries = [];
  lapsed = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summariser-'));
  summariser = createSummariser({
    herdr: client,
    bedrock,
    sidecar,
    ownPaneId: OWN,
    coalesceMs: 30,
    hookWaitMs: 150,
    hookPreferMs: 150,
    log: (e) => logs.push(e),
    onSummary: (s) => summaries.push(s),
    onAuthLapsed: () => { lapsed++; },
    ...summariserOpts,
  });
  await summariser.start();
}
const transcript = (text, tool = 'Bash') => {
  const file = path.join(dir, `t${Math.random()}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: tool, input: {} }] } }),
  ].join('\n') + '\n');
  return file;
};
const rendered = () => sidecar.calls.filter((c) => c.op === 'prerender');
const evicted = () => sidecar.calls.filter((c) => c.op === 'evict').map((c) => c.key);

afterEach(async () => {
  await summariser?.stop();
  client?.close();
  await herdr?.close();
});

test('a background agent going working to done updates $summary and pre-renders audio, without speaking', async () => {
  await setup({ reply: 'The shell agent finished the checkout form fix.' });
  herdr.setStatus('p-shell', 'working');
  herdr.setStatus('p-shell', 'done');
  await until(() => herdr.reports.length === 1);
  const report = herdr.reports[0];
  assert.equal(report.pane_id, 'p-shell');
  assert.equal(report.source, 'narrator');
  assert.equal(report.tokens.summary, 'The shell agent finished the checkout form fix.');
  assert.ok(report.ttl_ms > 0);
  await until(() => rendered().length === 1);
  assert.equal(rendered()[0].text, 'The shell agent finished the checkout form fix.');
  assert.equal(rendered()[0].key, 'p-shell#1');
  assert.deepEqual(sidecar.spoken, [], 'the summariser never speaks; focus playback does');
  assert.equal(summariser.get('p-shell').revision, 1);
});

test('non-claude panes are read with pane.read recent_unwrapped, about 80 lines', async () => {
  await setup();
  herdr.setStatus('p-shell', 'working');
  herdr.setStatus('p-shell', 'done');
  await until(() => bedrock.calls.length === 1);
  const [read] = herdr.requestsFor('pane.read');
  assert.equal(read.params.pane_id, 'p-shell');
  assert.equal(read.params.source, 'recent_unwrapped');
  assert.equal(read.params.lines, 80);
  assert.match(bedrock.calls[0].text, /build failed/);
});

test('the tokens.summary mirror is capped at 80 characters, cut at a word', async () => {
  await setup({ reply: 'The shell agent finished the checkout form fix and is now waiting for you to review every changed file.' });
  herdr.setStatus('p-shell', 'working');
  herdr.setStatus('p-shell', 'done');
  await until(() => herdr.reports.length === 1);
  const mirrored = herdr.reports[0].tokens.summary;
  assert.ok(mirrored.length <= 80, mirrored.length);
  assert.match(mirrored, /^The shell agent finished the checkout form fix and is now waiting for you to\.?$/);
  assert.match(summariser.get('p-shell').text, /review every changed file\.$/, 'the stored Summary keeps the full sentence for speech');
});

test('statuses that are not an outcome do not summarise, and neither does the Narrator\'s own pane', async () => {
  await setup();
  herdr.setStatus('p-shell', 'working');
  herdr.setStatus('p-shell', 'unknown');
  await sleep(120);
  assert.equal(bedrock.calls.length, 0);
  assert.equal(herdr.statusSubscribers(OWN), 0, 'no subscription for its own pane');
});

test('a burst of status changes on one pane makes one Bedrock call', async () => {
  await setup();
  for (const s of ['working', 'done', 'working', 'blocked', 'working', 'done']) herdr.setStatus('p-shell', s);
  await until(() => summaries.length >= 1);
  await sleep(100);
  assert.equal(bedrock.calls.length, 1);
});

test('at most one Summary in flight per pane: a newer trigger aborts the older call', async () => {
  await setup({ delayMs: 200 });
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => bedrock.calls.length === 1);
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => summaries.length === 1);
  await sleep(100);
  assert.equal(bedrock.calls.length, 2);
  assert.equal(bedrock.calls[0].aborted, true);
  assert.equal(summaries.length, 1);
  assert.equal(summariser.get('p-shell').revision, 1);
  assert.equal(summariser.get('p-shell').text, 'Summary number 2.');
});

test('a stale result that ignores the abort is skipped, never stored', async () => {
  await setup({ delayMs: 120, ignoreAbort: true, reply: (n) => `Reply ${n}.` });
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => bedrock.calls.length === 1);
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => summaries.length >= 1);
  await sleep(250);
  assert.deepEqual(summaries.map((s) => s.text), ['Reply 2.']);
  assert.deepEqual(herdr.reports.map((r) => r.tokens.summary), ['Reply 2.']);
});

test('a pane that closes mid-Summary is never stored, mirrored or rendered', async () => {
  await setup({ delayMs: 150, ignoreAbort: true });
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => bedrock.calls.length === 1);
  herdr.closePane('p-shell');
  await sleep(300);
  assert.equal(summaries.length, 0);
  assert.equal(herdr.reports.length, 0);
  assert.equal(rendered().length, 0);
  assert.equal(summariser.get('p-shell'), undefined);
});

test('closing a pane evicts its cached audio and drops its subscription', async () => {
  await setup();
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => rendered().length === 1);
  herdr.closePane('p-shell');
  await until(() => evicted().includes('p-shell#1'));
  await until(() => herdr.statusSubscribers('p-shell') === 0);
  assert.equal(summariser.get('p-shell'), undefined);
});

test('a newer Summary evicts the audio of the older revision', async () => {
  await setup();
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => rendered().length === 1);
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => rendered().length === 2);
  assert.equal(rendered()[1].key, 'p-shell#2');
  assert.deepEqual(evicted(), ['p-shell#1']);
});

test('subscribes per pane from the snapshot and again on pane.created', async () => {
  await setup();
  assert.equal(herdr.statusSubscribers('p-api'), 1);
  assert.equal(herdr.statusSubscribers('p-shell'), 1);
  herdr.createPane('p-new', { tab: 't-new', agent: 'codex', text: PANE_TEXT });
  await until(() => herdr.statusSubscribers('p-new') === 1);
  herdr.setStatus('p-new', 'working'); herdr.setStatus('p-new', 'done');
  await until(() => summaries.some((s) => s.paneId === 'p-new'));
});

test('a Claude Stop hook summarises from the transcript tail and the last tool, not pane.read', async () => {
  await setup();
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT, 'Edit') });
  await until(() => summaries.length === 1);
  assert.equal(herdr.requestsFor('pane.read').length, 0);
  assert.match(bedrock.calls[0].text, /all green/);
  assert.equal(bedrock.calls[0].lastTool, 'Edit');
  assert.equal(bedrock.calls[0].label, 'API', 'the tab label names the agent');
});

test('hook versus status: when both fire for a Claude pane within the window, the hook wins', async () => {
  await setup({ delayMs: 200 });
  herdr.setStatus('p-api', 'working'); herdr.setStatus('p-api', 'done');
  await until(() => bedrock.calls.length === 1); // the status-driven call is in flight
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  await until(() => summaries.length === 1);
  await sleep(100);
  assert.equal(bedrock.calls.length, 2);
  assert.equal(bedrock.calls[0].aborted, true, 'the status-driven call was dropped');
  assert.match(bedrock.calls[1].text, /all green/);
  assert.equal(summaries.length, 1);
});

test('hook versus status: a status change right after a hook adds no second call', async () => {
  await setup();
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  await until(() => bedrock.calls.length === 1);
  herdr.setStatus('p-api', 'working'); herdr.setStatus('p-api', 'done');
  await sleep(250);
  assert.equal(bedrock.calls.length, 1);
});

test('hook versus status: on a pane with a working hook, the status path waits and the hook cancels it', async () => {
  await setup();
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  await until(() => summaries.length === 1);
  await sleep(200); // out of the "right after" window
  herdr.setStatus('p-api', 'working'); herdr.setStatus('p-api', 'done');
  await sleep(60); // status path is waiting for the hook, so no call yet
  assert.equal(bedrock.calls.length, 1);
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  await until(() => summaries.length === 2);
  await sleep(250);
  assert.equal(bedrock.calls.length, 2, 'one call for the second turn, not two');
});

test('the status path still fires on a hook pane if the hook never comes', async () => {
  await setup();
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  await until(() => summaries.length === 1);
  await sleep(200);
  herdr.setStatus('p-api', 'working'); herdr.setStatus('p-api', 'done');
  await until(() => summaries.length === 2, 800);
  assert.equal(herdr.requestsFor('pane.read').length, 1);
});

test('a hook for an unknown pane is ignored; an unreadable transcript falls back to pane.read', async () => {
  await setup();
  summariser.onHook({ paneId: 'p-gone', transcriptPath: transcript(HOOK_TEXT) });
  summariser.onHook({ paneId: undefined, transcriptPath: undefined });
  await sleep(150);
  assert.equal(bedrock.calls.length, 0);
  summariser.onHook({ paneId: 'p-api', transcriptPath: path.join(dir, 'missing.jsonl') });
  await until(() => summaries.length === 1);
  assert.equal(herdr.requestsFor('pane.read').length, 1, 'the turn is not lost when the transcript is not there yet');
});

test('a Bedrock call that hangs is abandoned so it cannot block the status path', async () => {
  await setup({ delayMs: 400, ignoreAbort: true }, { bedrockTimeoutMs: 50 });
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  await until(() => bedrock.calls.length === 1);
  await sleep(150);
  assert.equal(bedrock.calls[0].aborted, true);
});

test('expired AWS credentials are reported once, then the Narrator stays quiet until they return', async () => {
  await setup();
  bedrock.failWith = Object.assign(new Error('token expired'), { name: 'ExpiredTokenException' });
  for (let i = 0; i < 3; i++) {
    herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
    await until(() => bedrock.calls.length === i + 1);
    await sleep(60);
  }
  assert.equal(lapsed, 1);
  bedrock.failWith = null;
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => summaries.length === 1);
  bedrock.failWith = Object.assign(new Error('token expired'), { name: 'ExpiredTokenException' });
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => lapsed === 2);
});

test('raw pane and transcript text never reach the logs or the tokens', async () => {
  await setup({ reply: 'The shell agent is done.' });
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  summariser.onHook({ paneId: 'p-api', transcriptPath: transcript(HOOK_TEXT) });
  bedrock.failWith = null;
  await until(() => summaries.length >= 2);
  const everything = JSON.stringify(logs) + JSON.stringify(herdr.reports);
  assert.doesNotMatch(everything, /SECRET/);
});

test('a Bedrock failure other than credentials is logged and the pane keeps its old Summary', async () => {
  await setup();
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => summaries.length === 1);
  bedrock.failWith = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
  herdr.setStatus('p-shell', 'working'); herdr.setStatus('p-shell', 'done');
  await until(() => logs.some((l) => l.level === 'error' && /summar/i.test(l.msg)));
  assert.equal(summariser.get('p-shell').revision, 1);
  assert.equal(lapsed, 0);
});
