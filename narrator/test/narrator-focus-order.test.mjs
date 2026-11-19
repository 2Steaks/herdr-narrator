// Real Herdr emits pane_focused and tab_focused in the same instant on every tab switch (measured against a live Herdr).
// Whichever arrives first, a tab speaks once: the Rollup for a multi-agent tab, the Summary for a one-agent tab.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrator } from '../narrator.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 50;
let herdr, narrator, sidecar;

async function boot() {
  herdr = await startFakeHerdr();
  herdr.addPane('p-narrator', { tab: 't-narrator' });
  herdr.addPane('p-one', { tab: 't-one', agent: 'claude', summary: 'The only agent finished its refactor.' });
  herdr.addPane('p-a', { tab: 't-multi', agent: 'claude', status: 'done', summary: 'Agent A pane summary.' });
  herdr.addPane('p-b', { tab: 't-multi', agent: 'codex', status: 'blocked' });
  sidecar = createFakeSidecar();
  narrator = createNarrator({ socketPath: herdr.socketPath, ownPaneId: 'p-narrator', sidecar, debounceMs: DEBOUNCE });
  await narrator.start();
}
afterEach(async () => { await narrator?.stop(); await herdr?.close(); });

/** One tab switch as real Herdr sends it: both events in the same tick, in the given order. */
function switchTab(order, tabId, paneId) {
  herdr.setFocused(paneId);
  for (const kind of order) {
    if (kind === 'pane') herdr.emit('pane.focused', { pane_id: paneId, workspace_id: 'w1' });
    else herdr.emit('tab.focused', { tab_id: tabId, workspace_id: 'w1' });
  }
}

for (const order of [['pane', 'tab'], ['tab', 'pane']]) {
  const name = order.join(' then ');

  test(`multi-agent tab, ${name} in the same tick: the Rollup is spoken exactly once`, async () => {
    await boot();
    switchTab(order, 't-multi', 'p-a');
    await sleep(DEBOUNCE * 5);
    assert.deepEqual(sidecar.spoken, ['One blocked, one done.']);
  });

  test(`one-agent tab, ${name} in the same tick: the Summary is spoken exactly once`, async () => {
    await boot();
    switchTab(order, 't-one', 'p-one');
    await sleep(DEBOUNCE * 5);
    assert.deepEqual(sidecar.spoken, ['The only agent finished its refactor.']);
  });
}
