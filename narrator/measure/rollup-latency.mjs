// Ticket 03: tab.focused speaks a Rollup. Target under 300 ms median of 10 runs from the end of the debounce.
// Whole Narrator against a fake Herdr (100 ms per request, like the real one) and the real Kokoro sidecar.
// agent.list is read when the event arrives and the line is rendered while the debounce settles.
//
//   node measure/rollup-latency.mjs [--runs 10] [--debounce 400] [--audible]
import { createNarrator } from '../narrator.mjs';
import { createSidecar } from '../lib/sidecar.mjs';
import { createState } from '../lib/state.mjs';
import { startFakeHerdr } from '../test/fake-herdr.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const runs = Number(arg('runs', 10));
const debounceMs = Number(arg('debounce', 400));
const audible = process.argv.includes('--audible');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sum = (xs) => `median ${median(xs).toFixed(0)} ms, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATUSES = [['done', 'done', 'blocked'], ['working', 'done', 'idle'], ['blocked', 'blocked', 'done'], ['done', 'working', 'working']];

const herdr = await startFakeHerdr();
herdr.delay('agent.list', 100);
herdr.delay('pane.current', 100);
const spoke = [];
const sidecar = createSidecar({ env: audible ? {} : { NARRATOR_SIDECAR_SILENT: '1' } });
const narrator = createNarrator({
  socketPath: herdr.socketPath, ownPaneId: 'own', sidecar, debounceMs,
  state: createState({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-lat-')), 'state.json') }),
  onSpoke: (m) => spoke.push(m),
});
herdr.addPane('own', { tab: 't-own' });
for (let i = 0; i < runs + 1; i++) {
  STATUSES[i % STATUSES.length].forEach((status, j) => herdr.addPane(`p-${i}-${j}`, { tab: `t-${i}`, agent: 'claude', status }));
}
await sidecar.warm();
await narrator.start();

herdr.focusTab('t-0', 'p-0-0'); // warm-up
await sleep(debounceMs + 1500);
spoke.length = 0;
for (let i = 1; i <= runs; i++) {
  const n = spoke.length;
  herdr.focusTab(`t-${i}`, `p-${i}-0`);
  const deadline = Date.now() + 5000;
  while (spoke.length === n && Date.now() < deadline) await sleep(5);
  await sleep(audible ? 2500 : 300);
}
console.log(`rollup, debounce ${debounceMs} ms, ${spoke.length}/${runs} spoken, ${audible ? 'audible' : 'silent'}`);
console.log(`debounce settled to first audio: ${sum(spoke.map((m) => m.startedAt - m.settledAt))}`);
console.log(`raw focus event to first audio:  ${sum(spoke.map((m) => m.startedAt - m.eventAt))}`);
await narrator.stop();
await sidecar.close();
await herdr.close();
