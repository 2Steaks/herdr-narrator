// Ticket 03 through the whole Narrator: live fallback, Rollup, Blocked alerts, no repeats, replay, mute,
// expired credentials, events_lost. Fake Herdr, fake Bedrock, fake sidecar.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createNarrator } from '../narrator.mjs';
import { createState } from '../lib/state.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';
import { createFakeBedrock } from './fake-bedrock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(5); }
  assert.fail('condition not met in time: ' + fn);
}
const DEBOUNCE = 50;
const OWN = 'p-narrator';
let herdr, sidecar, bedrock, narrator, logs, dir, hookSock, stateFile, authLapses;

async function boot({ bedrockOpts = {}, muted = false } = {}) {
  herdr = await startFakeHerdr();
  herdr.addPane('p-api', { tab: 't-api', agent: 'claude', text: 'api pane text' });
  herdr.addPane('p-web', { tab: 't-web', agent: 'codex', text: 'web pane text' });
  herdr.addPane('p-two', { tab: 't-web', agent: 'claude', text: 'second web pane text' });
  herdr.addPane('p-shell', { tab: 't-sh', agent: null, text: 'just a shell' });
  herdr.addPane(OWN, { tab: 't-narrator' });
  herdr.state.tabLabels = { 't-api': 'API', 't-web': 'Web', 't-sh': 'Shell', 't-narrator': 'the Narrator' };
  sidecar = createFakeSidecar();
  bedrock = createFakeBedrock({ reply: (n) => `Sentence number ${n}.`, ...bedrockOpts });
  logs = [];
  authLapses = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-eti-'));
  hookSock = path.join(dir, 'narrator.sock');
  stateFile = path.join(dir, 'state.json');
  if (muted) createState({ file: stateFile }).toggleMuted();
  narrator = createNarrator({
    socketPath: herdr.socketPath, ownPaneId: OWN, sidecar, bedrock, hookSocketPath: hookSock,
    state: createState({ file: stateFile }),
    debounceMs: DEBOUNCE, blockedWaitMs: 300, log: (e) => logs.push(e),
    onAuthLapsed: () => { authLapses++; },
    summariserOptions: { coalesceMs: 10, hookWaitMs: 50, hookPreferMs: 50 },
  });
  await narrator.start();
}
afterEach(async () => { await narrator?.stop(); await herdr?.close(); });

const sendLine = (obj) => new Promise((resolve) => { const c = net.createConnection(hookSock, () => c.end(JSON.stringify(obj) + '\n')); c.on('close', resolve); });
const chimes = () => sidecar.calls.filter((c) => c.op === 'chime').map((c) => c.kind);
const block = (id) => { herdr.setStatus(id, 'working'); herdr.setStatus(id, 'blocked'); };

// ---- Blocked alerts ---------------------------------------------------------------------------------

test('an unfocused pane going blocked gets one Blocked alert from the tab label and its fresh Summary', async () => {
  await boot();
  herdr.setFocused('p-api'); // focus context only, no event
  await sleep(DEBOUNCE * 2);
  block('p-web');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'Web needs you. Sentence number 1.');
});

test('one alert per blocked episode: repeats stay silent until the pane leaves blocked and blocks again', async () => {
  await boot();
  herdr.setFocused('p-api'); // focus context only, no event
  await sleep(DEBOUNCE * 2);
  block('p-web');
  await until(() => sidecar.spoken.length === 1);
  herdr.setStatus('p-web', 'blocked'); // still blocked: not a new episode
  herdr.setStatus('p-web', 'blocked');
  await sleep(300);
  assert.equal(sidecar.spoken.length, 1);
  herdr.setStatus('p-web', 'working'); // leaves blocked: the episode ends
  await sleep(50);
  herdr.setStatus('p-web', 'blocked');
  await until(() => sidecar.spoken.length === 2);
  assert.match(sidecar.spoken[1], /^Web needs you\./);
});

test('no alert for the focused pane or for the Narrator itself', async () => {
  await boot();
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 2);
  sidecar.calls.length = 0;
  block('p-web');
  herdr.setStatus(OWN, 'blocked');
  await sleep(500);
  assert.ok(!sidecar.spoken.some((t) => /needs you/.test(t)), 'the focused pane gets its Summary, not an alert');
});

test('a blocked pane whose Summary never arrives still gets a bare alert', async () => {
  await boot();
  bedrock.failWith = Object.assign(new Error('boom'), { name: 'ServiceUnavailableException' });
  herdr.setFocused('p-api'); // focus context only, no event
  await sleep(DEBOUNCE * 2);
  block('p-web');
  await until(() => sidecar.spoken.length === 1, 3000);
  assert.equal(sidecar.spoken[0], 'Web needs you.');
});

test('an alert never interrupts a line in progress; it waits for the line to end', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  sidecar.holdLines = true;
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.length === 1);
  block('p-web');
  await sleep(500); // long enough for the Summary to land and the alert to be due
  assert.deepEqual(sidecar.spoken, ['A stored summary.'], 'the alert is held, the line is not cut');
  assert.equal(sidecar.playing, true);
  sidecar.endCurrent();
  await until(() => sidecar.spoken.length === 2);
  assert.match(sidecar.spoken[1], /^Web needs you\./);
});

test('a second pane blocking while a line plays is announced after the first, once each', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  sidecar.holdLines = true;
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.length === 1);
  block('p-web');
  block('p-api');
  await sleep(500);
  assert.equal(sidecar.spoken.length, 1, 'both alerts wait for the line');
  sidecar.endCurrent();
  await until(() => sidecar.spoken.length === 2);
  sidecar.endCurrent();
  await until(() => sidecar.spoken.length === 3);
  sidecar.endCurrent();
  await sleep(300);
  const alerts = sidecar.spoken.filter((t) => /needs you/.test(t));
  assert.equal(alerts.length, 2, 'one alert per blocked pane, none repeated');
  assert.ok(alerts.some((t) => /^Web needs you/.test(t)) && alerts.some((t) => /^API needs you/.test(t)));
});

// ---- no repeats, replay ---------------------------------------------------------------------------------

test('refocusing an unchanged pane is silent, and the replay key then speaks it', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.length === 1);
  herdr.focusPane(OWN);
  await sleep(DEBOUNCE * 3);
  herdr.focusPane('p-old');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['A stored summary.'], 'second visit is silent');
  await sendLine({ cmd: 'replay' });
  await until(() => sidecar.spoken.length === 2);
  assert.equal(sidecar.spoken[1], 'A stored summary.');
});

test('a changed Summary speaks again on refocus', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.length === 1);
  herdr.focusPane(OWN);
  await sleep(DEBOUNCE * 3);
  herdr.state.panes['p-old'].tokens = { summary: 'And now something new.' };
  herdr.state.panes['p-old'].revision = 5;
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.length === 2);
  assert.equal(sidecar.spoken[1], 'And now something new.');
});

test('replay with nothing spoken yet plays the focused pane cached Summary', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.setFocused('p-old'); // focused before the Narrator started listening: no focus event
  await sendLine({ cmd: 'replay' });
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'A stored summary.');
});

// ---- mute -------------------------------------------------------------------------------------------

test('the mute command chimes, persists, silences focus lines and alerts, and Summaries still update', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  await sendLine({ cmd: 'mute' });
  await until(() => chimes().length === 1);
  assert.deepEqual(chimes(), ['muted']);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).NARRATOR_MUTED, true, 'written to state.json');

  herdr.focusPane('p-old');
  await sleep(DEBOUNCE * 3);
  herdr.setFocused('p-api'); // focus context only, no event
  await sleep(DEBOUNCE * 3);
  block('p-web');
  await until(() => herdr.reports.length === 1); // the Summary still lands in tokens.summary
  await sleep(400);
  assert.deepEqual(sidecar.spoken, [], 'nothing spoken while muted');
  assert.equal(herdr.reports[0].tokens.summary, 'Sentence number 1.');

  await sendLine({ cmd: 'mute' });
  await until(() => chimes().length === 2);
  assert.deepEqual(chimes(), ['muted', 'unmuted']);
});

test('mute survives a restart', async () => {
  await boot({ muted: true });
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.focusPane('p-old');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, []);
});

// ---- expired credentials ----------------------------------------------------------------------------

const expired = () => Object.assign(new Error('expired'), { name: 'ExpiredTokenException' });

test('expired credentials are announced once per expiry, then quiet until they return', async () => {
  await boot();
  bedrock.failWith = expired();
  herdr.setFocused('p-api'); // focus context only, no event
  await sleep(DEBOUNCE * 2);
  for (const id of ['p-web', 'p-two']) { herdr.setStatus(id, 'working'); herdr.setStatus(id, 'done'); }
  await sleep(200);
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await sleep(300);
  assert.equal(authLapses, 1, 'the summariser reports one lapse');
  const notices = sidecar.spoken.filter((t) => /AWS login/.test(t));
  assert.equal(notices.length, 1, 'one spoken notice');
  assert.equal(sidecar.spoken.length, 1, 'and nothing else is said');

  bedrock.failWith = null; // login restored, summaries work again
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => herdr.reports.length === 1);
  bedrock.failWith = expired(); // a second expiry is a new episode
  herdr.setStatus('p-two', 'working');
  herdr.setStatus('p-two', 'done');
  await until(() => sidecar.spoken.filter((t) => /AWS login/.test(t)).length === 2);
});

test('the expiry notice is not spoken while muted', async () => {
  await boot({ muted: true });
  bedrock.failWith = expired();
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => authLapses === 1);
  await sleep(100);
  assert.deepEqual(sidecar.spoken, []);
});

// ---- Rollup ----------------------------------------------------------------------------------------

test('focusing a tab speaks a Rollup from agent.list with no model call, and a repeat is silent', async () => {
  await boot();
  herdr.state.panes['p-web'].status = 'done';
  herdr.state.panes['p-two'].status = 'blocked';
  herdr.focusTab('t-web', 'p-web');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'One blocked, one done.');
  assert.equal(bedrock.calls.length, 0, 'no model call');
  assert.equal(herdr.requestsFor('agent.list').length, 1);

  herdr.focusTab('t-api', 'p-api');
  await sleep(DEBOUNCE * 3);
  herdr.focusTab('t-web', 'p-web');
  await sleep(DEBOUNCE * 3);
  assert.equal(sidecar.spoken.filter((t) => /blocked/.test(t)).length, 1, 'same Rollup again stays silent');
});

test('a Rollup with one blocked agent adds that agent cached Summary', async () => {
  await boot();
  herdr.state.panes['p-two'].status = 'idle';
  herdr.state.panes['p-web'].status = 'working';
  herdr.setFocused('p-api'); // focus context only, no event
  await sleep(DEBOUNCE * 2);
  herdr.setStatus('p-web', 'blocked'); // summary lands as Sentence number 1
  await until(() => herdr.reports.length === 1);
  await sleep(DEBOUNCE * 2);
  sidecar.calls.length = 0;
  herdr.focusTab('t-web', 'p-web');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'One blocked, one idle. Sentence number 1.');
});

test('a Rollup is rendered while the debounce settles', async () => {
  await boot();
  herdr.state.panes['p-web'].status = 'done';
  herdr.state.panes['p-two'].status = 'done';
  herdr.focusTab('t-web', 'p-web');
  await sleep(DEBOUNCE / 2);
  assert.ok(sidecar.calls.some((c) => c.op === 'render' && c.text === 'Two done.'));
  assert.deepEqual(sidecar.spoken, []);
});

test('a tab with a single agent behaves like focusing that pane', async () => {
  await boot();
  herdr.state.panes['p-api'].tokens = { summary: 'A stored summary.' };
  herdr.focusTab('t-api', 'p-api');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'A stored summary.');
});

test('a tab with only the Narrator or only shells says nothing', async () => {
  await boot();
  herdr.focusTab('t-narrator', OWN);
  herdr.focusTab('t-sh', 'p-shell');
  await sleep(DEBOUNCE * 4);
  assert.deepEqual(sidecar.spoken, []);
});

// ---- Live fallback ----------------------------------------------------------------------------------

test('focus with nothing cached summarises now and speaks the sentence', async () => {
  await boot();
  herdr.focusPane('p-api');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'Sentence number 1.');
  assert.equal(bedrock.calls[0].text, 'api pane text');
  assert.equal(bedrock.calls[0].label, 'API');
  await until(() => herdr.reports.length === 1); // and it is stored like any Summary
  assert.equal(herdr.reports[0].tokens.summary, 'Sentence number 1.');
});

test('sentences are spoken as they complete, one after the other', async () => {
  await boot({ bedrockOpts: { reply: () => 'First sentence here. Second one follows.' } });
  sidecar.holdLines = true;
  herdr.focusPane('p-api');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(sidecar.spoken[0], 'First sentence here.');
  sidecar.endCurrent();
  await until(() => sidecar.spoken.length === 2);
  assert.equal(sidecar.spoken[1], 'Second one follows.');
});

test('a live Summary is not spoken again by the background path, and a refocus is silent', async () => {
  await boot();
  herdr.focusPane('p-api');
  await until(() => sidecar.spoken.length === 1);
  await until(() => herdr.reports.length === 1);
  await sleep(100);
  assert.equal(sidecar.spoken.length, 1);
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 2);
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE * 3);
  assert.equal(sidecar.spoken.filter((t) => t === 'Sentence number 1.').length, 1, 'p-api spoke once');
});

test('moving focus aborts the live call and nothing from it is spoken later', async () => {
  await boot({ bedrockOpts: { delayMs: 200 } });
  herdr.focusPane('p-api');
  await until(() => bedrock.calls.length === 1);
  herdr.focusPane('p-shell'); // a pane with no agent: silent
  await sleep(500);
  assert.equal(bedrock.calls[0].aborted, true);
  assert.deepEqual(sidecar.spoken, []);
});

test('a pane with no agent is not summarised', async () => {
  await boot();
  herdr.focusPane('p-shell');
  await sleep(DEBOUNCE * 4);
  assert.equal(bedrock.calls.length, 0);
  assert.deepEqual(sidecar.spoken, []);
});

test('focusing a pane whose background Summary is on its way waits for it instead of asking twice', async () => {
  await boot({ bedrockOpts: { delayMs: 150 } });
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'done');
  await until(() => bedrock.calls.length === 1);
  herdr.focusPane('p-web');
  await until(() => sidecar.spoken.length === 1);
  assert.equal(bedrock.calls.length, 1, 'one call, no live duplicate');
});

test('muted: the live path still stores the Summary but says nothing', async () => {
  await boot({ muted: true });
  herdr.focusPane('p-api');
  await until(() => herdr.reports.length === 1);
  await sleep(100);
  assert.deepEqual(sidecar.spoken, []);
});

test('expired credentials on the live path: one notice, nothing else', async () => {
  await boot();
  bedrock.failWith = expired();
  herdr.focusPane('p-api');
  await until(() => authLapses === 1);
  await until(() => sidecar.spoken.length === 1);
  assert.match(sidecar.spoken[0], /AWS login/);
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 4);
  assert.equal(sidecar.spoken.length, 1);
});

// ---- events_lost and reconnect ----------------------------------------------------------------------

test('events_lost: resubscribes, waits for the acknowledgement, rebuilds from the snapshot, catches a missed change', async () => {
  await boot();
  herdr.focusPane('p-api');
  await until(() => sidecar.spoken.length === 1); // live summary of p-api
  sidecar.calls.length = 0;
  const snapshotsBefore = herdr.requestsFor('session.snapshot').length;
  herdr.loseEvents();
  herdr.setStatusQuietly('p-web', 'blocked'); // happened while the Narrator was blind
  await until(() => herdr.requestsFor('session.snapshot').length > snapshotsBefore, 4000);
  await until(() => herdr.statusSubscribers('p-web') === 1, 4000);
  await until(() => sidecar.spoken.some((t) => /^Web needs you/.test(t)), 4000);
  // and events flow again afterwards
  herdr.setStatus('p-two', 'working');
  herdr.setStatus('p-two', 'blocked');
  await until(() => sidecar.spoken.some((t) => /^Web needs you/.test(t)) && sidecar.spoken.length >= 2, 4000);
  assert.ok(logs.some((l) => l.msg === 'subscription error from herdr' && l.code === 'events_lost'));
});

test('a dropped Herdr connection reconnects with backoff and focus works again', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  herdr.dropConnections();
  await until(() => logs.filter((l) => l.msg === 'subscription restored').length >= 6, 4000); // focus, lifecycle, 4 panes
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.includes('A stored summary.'), 3000);
});

test('events_lost on a single pane connection still resyncs that pane', async () => {
  await boot();
  herdr.setFocused('p-api');
  herdr.loseEventsFor('p-web');
  herdr.setStatusQuietly('p-web', 'blocked');
  await until(() => sidecar.spoken.some((t) => /^Web needs you/.test(t)), 4000);
});

test('a closed pane forgets its blocked episode, so a reused id alerts again', async () => {
  await boot();
  herdr.setFocused('p-api');
  block('p-web');
  await until(() => sidecar.spoken.length === 1);
  herdr.closePane('p-web');
  await sleep(100);
  herdr.createPane('p-web', { tab: 't-web', agent: 'codex', text: 'new pane' });
  await until(() => herdr.statusSubscribers('p-web') === 1);
  block('p-web');
  await until(() => sidecar.spoken.length === 2, 3000);
});

test('the expiry notice is not lost behind a held Blocked alert', async () => {
  await boot();
  herdr.addPane('p-old', { tab: 't-old', summary: 'A stored summary.', revision: 4 });
  sidecar.holdLines = true;
  herdr.focusPane('p-old');
  await until(() => sidecar.spoken.length === 1);
  bedrock.failWith = expired();
  herdr.setStatus('p-web', 'working');
  herdr.setStatus('p-web', 'blocked'); // its Summary call fails: the alert goes out bare, and the notice follows
  await sleep(500);
  sidecar.endCurrent();
  await sleep(100);
  assert.ok(sidecar.spoken.some((t) => /AWS login/.test(t)), 'the notice was spoken');
});

test('a live sentence chain stops when an earlier sentence was cut off', async () => {
  await boot({ bedrockOpts: { reply: () => 'First sentence here. Second one follows. Third one too.' } });
  sidecar.holdLines = true;
  herdr.focusPane('p-api');
  await until(() => sidecar.spoken.length === 1);
  sidecar.cancel(); // something cut the first sentence off
  await sleep(150);
  assert.deepEqual(sidecar.spoken, ['First sentence here.'], 'the stale sentences are not spoken over whatever replaced it');
});
