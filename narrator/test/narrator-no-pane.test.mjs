// The Narrator runs hidden, so HERDR_PANE_ID is optional: with no own pane there is nothing to ignore.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrator } from '../narrator.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 60;

let herdr, sidecar, narrator;

async function boot(ownPaneId) {
  herdr = await startFakeHerdr();
  herdr.addPane('p-api', { tab: 't-api', summary: 'The API agent is waiting on a permission.', revision: 7 });
  herdr.addPane('p-shell', { tab: 't-shell', summary: 'A pane that would have been its own.' });
  sidecar = createFakeSidecar();
  narrator = createNarrator({ socketPath: herdr.socketPath, ownPaneId, sidecar, debounceMs: DEBOUNCE });
  await narrator.start();
}

afterEach(async () => {
  await narrator?.stop();
  await herdr?.close();
});

test('with no own pane id it starts and speaks a focused pane', async () => {
  await boot(undefined);
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['The API agent is waiting on a permission.']);
});

test('with no own pane id no pane is skipped: every pane is spoken', async () => {
  await boot(undefined);
  herdr.focusPane('p-shell');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['A pane that would have been its own.']);
});

test('an empty own pane id counts as none', async () => {
  await boot('');
  herdr.focusPane('p-shell');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['A pane that would have been its own.']);
});

test('with an own pane id set it still ignores that pane', async () => {
  await boot('p-shell');
  herdr.focusPane('p-shell');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, []);
  herdr.focusPane('p-api');
  await sleep(DEBOUNCE * 3);
  assert.deepEqual(sidecar.spoken, ['The API agent is waiting on a permission.']);
});
