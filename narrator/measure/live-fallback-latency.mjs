// Ticket 03: focus on a pane with nothing cached summarises now and speaks. Target under 2.5 s median of 10 runs,
// measured from the end of the debounce to the first audio sample (the raw event number is reported too).
//
// Whole Narrator against a fake Herdr (100 ms per request, like the real one), the REAL Bedrock client and the REAL
// Kokoro sidecar. The pane text is synthetic: real pane or transcript text must never go to Bedrock.
//
//   node measure/live-fallback-latency.mjs [--runs 10] [--debounce 400] [--audible]
import { createNarrator } from '../narrator.mjs';
import { createSidecar } from '../lib/sidecar.mjs';
import { createBedrock } from '../lib/bedrock.mjs';
import { startFakeHerdr } from '../test/fake-herdr.mjs';
import { createState } from '../lib/state.mjs';
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

const SYNTHETIC = [
  'I ran the unit tests for the invoice module. Eleven passed and two failed because the fixture dates are out of range. Do you want me to fix the fixtures or skip those two cases?',
  'The migration finished and the new column is in place. I backfilled it in batches and nothing timed out. The deploy script is untouched.',
  'I need permission to run the formatter across the repository before I continue with the rename.',
  'The build is green. I pushed the branch and the checks are running. I will report back when they finish.',
];

const herdr = await startFakeHerdr();
for (const m of ['pane.current', 'session.snapshot', 'pane.read', 'pane.report_metadata']) herdr.delay(m, 100);
const spoke = [];
const sidecar = createSidecar({ env: audible ? {} : { NARRATOR_SIDECAR_SILENT: '1' } });
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-lat-')), 'state.json');
const narrator = createNarrator({
  socketPath: herdr.socketPath, ownPaneId: 'own', sidecar, bedrock: createBedrock(), debounceMs,
  state: createState({ file: stateFile }), onSpoke: (m) => spoke.push(m),
  log: (e) => { if (e.level === 'error') console.error(JSON.stringify(e)); },
});
herdr.addPane('own', { tab: 't-own' });
for (let i = 0; i < runs + 1; i++) herdr.addPane(`pane-${i}`, { tab: `t-${i}`, agent: 'claude', text: SYNTHETIC[i % SYNTHETIC.length] });
herdr.state.tabLabels = Object.fromEntries(Array.from({ length: runs + 1 }, (_, i) => [`t-${i}`, 'API']));
await sidecar.warm();
await narrator.start();

// Run 0 warms the Bedrock client and the output stream, as a running the Narrator would have by then.
herdr.focusPane('pane-0');
await sleep(debounceMs + 4000);
spoke.length = 0;

for (let i = 1; i <= runs; i++) {
  const n = spoke.length;
  herdr.focusPane(`pane-${i}`);
  const deadline = Date.now() + 10_000;
  while (spoke.length === n && Date.now() < deadline) await sleep(5);
  await sleep(audible ? 3500 : 800); // let the line finish and the Summary commit
}

console.log(`live fallback, debounce ${debounceMs} ms, ${spoke.length}/${runs} spoken, ${audible ? 'audible' : 'silent'}`);
console.log(`debounce settled to first audio: ${sum(spoke.map((m) => m.startedAt - m.settledAt))}`);
console.log(`raw focus event to first audio:  ${sum(spoke.map((m) => m.startedAt - m.eventAt))}`);
console.log('settled runs (ms):', spoke.map((m) => m.startedAt - m.settledAt).join(' '));
await narrator.stop();
await sidecar.close();
await herdr.close();
