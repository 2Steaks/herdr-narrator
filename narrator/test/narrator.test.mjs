import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrator } from '../narrator.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 60;
const OWN = 'p-narrator';

let herdr, sidecar, narrator, logs;

beforeEach(async () => {
  herdr = await startFakeHerdr();
  herdr.addPane('p-api', { tab: 't-api', summary: 'The API agent is waiting on a permission.', revision: 7 });
  herdr.addPane('p-web', { tab: 't-web', summary: 'The web agent finished the form tests.', revision: 3 });
  herdr.addPane('p-bare', { tab: 't-bare' }); // no Summary cached
  herdr.addPane(OWN, { tab: 't-narrator', summary: 'Should never be spoken.' });
  sidecar = createFakeSidecar();
  logs = [];
  narrator = createNarrator({
    socketPath: herdr.socketPath,
    ownPaneId: OWN,
    sidecar,
    debounceMs: DEBOUNCE,
    log: (entry) => logs.push(entry),
  });
  await narrator.start();
});

afterEach(async () => {
  await narrator.stop();
  await herdr.close();
});

test('focusing a pane speaks its cached Summary once focus settles', async () => {
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE / 2);
  assert.deepEqual(sidecar.spoken, [], 'nothing before the debounce expires');
  await sleep(DEBOUNCE * 2);
  assert.deepEqual(sidecar.spoken, ['The API agent is waiting on a permission.']);
});

test('audio is rendered while focus settles, so speech can start the moment it does', async () => {
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE / 2);
  assert.deepEqual(sidecar.calls.filter((c) => c.op === 'render').map((c) => c.text), ['The API agent is waiting on a permission.']);
  assert.deepEqual(sidecar.spoken, []);
  await sleep(DEBOUNCE * 2);
  const [render] = sidecar.calls.filter((c) => c.op === 'render');
  const [speak] = sidecar.calls.filter((c) => c.op === 'speak');
  assert.equal(speak.key, render.key, 'speech reuses the rendered audio by key');
  assert.equal(speak.key, 'p-api:7', 'key is pane id and revision');
});

test('one Herdr request per focus: pane.current already carries tokens.summary', async () => {
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE * 3);
  assert.equal(herdr.requestsFor('pane.current').length, 1);
  assert.equal(herdr.requestsFor('pane.get').length, 0, 'real Herdr takes about 100 ms per request, so do not ask twice');
});

test('the Narrator\'s own pane is never rendered', async () => {
  herdr.focusPane(OWN);
  await sleep(DEBOUNCE * 3);
  assert.equal(sidecar.calls.filter((c) => c.op === 'render').length, 0);
});

test('focusing the Narrator\'s own pane is silent', async () => {
  herdr.focusPane(OWN);
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, []);
});

test('flicking through panes speaks once, for the last one', async () => {
  for (const id of ['p-api', 'p-bare', 'p-web']) {
    herdr.focusPane(id);
    await sleep(DEBOUNCE / 4);
  }
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['The web agent finished the form tests.']);
});

test('flicking past a pane and landing on Narrator\'s own pane stays silent', async () => {
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE / 4);
  herdr.focusPane(OWN);
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, []);
});

test('focus that moves while Herdr is still answering never speaks the stale pane', async () => {
  herdr.delay('pane.current', DEBOUNCE * 2);
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE * 1.5); // debounce fired, pane.current in flight
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 6);
  assert.deepEqual(sidecar.spoken, ['The web agent finished the form tests.']);
});

test('a new focus cancels the line that is playing, before the debounce ends', async () => {
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE * 2);
  assert.equal(sidecar.spoken.length, 1);
  sidecar.calls.length = 0;
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE / 4);
  assert.equal(sidecar.calls[0].op, 'cancel', 'cancel is the first thing that happens');
  assert.equal(sidecar.calls.filter((c) => c.op === 'speak').length, 0, 'no speech before the debounce ends');
  await sleep(DEBOUNCE * 2);
  assert.deepEqual(sidecar.spoken, ['The web agent finished the form tests.']);
});

test('malformed lines are logged and skipped, and later events still work', async () => {
  herdr.emitRaw('{not json');
  herdr.emitRaw('42');
  herdr.emitRaw('{"event":"workspace_created","data":{}}'); // valid JSON, not a focus event: ignored
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['The web agent finished the form tests.']);
  assert.ok(logs.some((l) => l.msg.includes('malformed')), 'malformed line is logged');
  assert.ok(!JSON.stringify(logs).includes('not json'), 'raw line content is not logged');
});

test('a pane with no Summary stays silent', async () => {
  herdr.focusPane('p-bare');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, []);
});

test('tab focus speaks the Summary of the pane that is now focused', async () => {
  herdr.focusTab('t-web', 'p-web');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['The web agent finished the form tests.']);
});

test('a dropped subscription reconnects and keeps speaking', async () => {
  herdr.dropConnections();
  await sleep(400);
  herdr.focusPane('p-web');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['The web agent finished the form tests.']);
});
