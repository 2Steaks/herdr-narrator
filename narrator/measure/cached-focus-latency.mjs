// Ticket 02 done-when: focusing a pane whose Summary was produced and pre-rendered in the background plays it fast.
// Whole Narrator against a fake Herdr (100 ms per request, like the real one), the real Kokoro sidecar, and a
// stand-in for Bedrock that returns a fixed sentence. Each run: agent goes working to done, the summariser stores,
// mirrors and pre-renders; then focus lands on that pane (pane.focused, or tab.focused with --tab).
//
//   node measure/cached-focus-latency.mjs [--runs 10] [--debounce 400] [--audible] [--tab]
import { createNarrator } from '../narrator.mjs';
import { createSidecar } from '../lib/sidecar.mjs';
import { startFakeHerdr } from '../test/fake-herdr.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const runs = Number(arg('runs', 10));
const debounceMs = Number(arg('debounce', 400));
const audible = process.argv.includes('--audible');
const viaTab = process.argv.includes('--tab');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sum = (xs) => `median ${median(xs).toFixed(0)} ms, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SENTENCES = [
  'The API agent is waiting on a permission.',
  'The web agent finished the form tests and found nothing broken.',
  'Two tests failed in the settings loader.',
  'The build is green and the pull request is ready for review.',
  'The worker is still running the migration.',
  'Nothing needs you here; the agent is idle.',
  'The agent is asking which option you want.',
  'The deploy finished, and the smoke checks passed.',
  'The linter found three warnings, none serious.',
  'The agent hit a permission prompt.',
];
let nextText = SENTENCES[0];
const bedrock = { summarise: async () => ({ text: nextText, ttftMs: 0 }) };

const herdr = await startFakeHerdr();
for (const m of ['pane.current', 'session.snapshot', 'pane.read', 'pane.report_metadata']) herdr.delay(m, 100);
const spoke = [];
const sidecar = createSidecar({ env: audible ? {} : { NARRATOR_SIDECAR_SILENT: '1' } });
const narrator = createNarrator({
  socketPath: herdr.socketPath, ownPaneId: 'own', sidecar, bedrock, debounceMs,
  summariserOptions: { coalesceMs: 20 }, onSpoke: (m) => spoke.push(m),
});
herdr.addPane('own', { tab: 't-own' });
for (let i = 0; i < runs + 1; i++) herdr.addPane(`pane-${i}`, { tab: `t-${i}`, agent: 'codex', text: 'background output' });
await sidecar.warm();
await narrator.start();

async function background(i) {
  nextText = SENTENCES[i % SENTENCES.length];
  const before = herdr.reports.length;
  herdr.setStatus(`pane-${i}`, 'working');
  herdr.setStatus(`pane-${i}`, 'done');
  while (herdr.reports.length === before) await sleep(10);
  await sleep(900); // pre-render of one sentence takes about 430 ms
}

// Run 0 warms the model and the output stream, as a running the Narrator would have by then.
await background(0);
herdr.setFocused('pane-0'); herdr.focusPane('pane-0');
await sleep(debounceMs + 1500);
spoke.length = 0;

for (let i = 1; i <= runs; i++) {
  await background(i);
  const n = spoke.length;
  if (viaTab) herdr.focusTab(`t-${i}`, `pane-${i}`); else herdr.focusPane(`pane-${i}`);
  const deadline = Date.now() + 5000;
  while (spoke.length === n && Date.now() < deadline) await sleep(5);
  await sleep(audible ? 2500 : 300);
}

console.log(`${viaTab ? 'tab.focused' : 'pane.focused'}, debounce ${debounceMs} ms, ${spoke.length}/${runs} spoken, ${audible ? 'audible' : 'silent'}`);
console.log(`raw focus event to first audio:  ${sum(spoke.map((m) => m.startedAt - m.eventAt))}`);
console.log(`debounce settled to first audio: ${sum(spoke.map((m) => m.startedAt - m.settledAt))}`);
await narrator.stop();
await sidecar.close();
await herdr.close();
