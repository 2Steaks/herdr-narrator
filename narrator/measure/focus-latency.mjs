// Focus-to-first-audio latency, N runs, against the real sidecar (real Kokoro) and a fake Herdr socket.
// Real Herdr focus events cannot be injected without moving the user's focus, so events come from the fake server;
// real Herdr request latency is measured separately with --real-rtt (read-only pane.current / pane.get).
//
//   node measure/focus-latency.mjs [--runs 10] [--debounce 400] [--herdr-latency 100] [--audible] [--real-rtt]
import { createNarrator } from '../narrator.mjs';
import { createSidecar } from '../lib/sidecar.mjs';
import { startFakeHerdr } from '../test/fake-herdr.mjs';
import { createHerdrClient } from '../lib/herdr.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const runs = Number(arg('runs', 10));
const debounceMs = Number(arg('debounce', 400));
const audible = process.argv.includes('--audible');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sum = (xs) => `median ${median(xs).toFixed(0)} ms, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}`;

if (process.argv.includes('--real-rtt') && process.env.HERDR_SOCKET_PATH) {
  const client = createHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH });
  const cur = [];
  const get = [];
  let paneId;
  for (let i = 0; i < 20; i++) {
    let t = performance.now();
    paneId = (await client.request('pane.current')).pane.pane_id;
    cur.push(performance.now() - t);
    t = performance.now();
    await client.request('pane.get', { pane_id: paneId });
    get.push(performance.now() - t);
  }
  console.log(`real Herdr pane.current (20 reads): ${sum(cur)}`);
  console.log(`real Herdr pane.get (20 reads): ${sum(get)}`);
  client.close();
}

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

const herdr = await startFakeHerdr();
herdr.delay('pane.current', Number(arg('herdr-latency', 100))); // real Herdr answers in about 100 ms
const spoke = [];
const sidecar = createSidecar({ env: audible ? {} : { NARRATOR_SIDECAR_SILENT: '1' } });
const narrator = createNarrator({ socketPath: herdr.socketPath, ownPaneId: 'own', sidecar, debounceMs, onSpoke: (m) => spoke.push(m) });
await sidecar.warm();
await narrator.start();
// warm the model's first render, as a running the Narrator would have by the second focus
herdr.addPane('warm', { summary: 'Warm up.', revision: 1 });
herdr.focusPane('warm');
await new Promise((r) => setTimeout(r, debounceMs + 1500));
spoke.length = 0;

for (let i = 0; i < runs; i++) {
  const id = `pane-${i}`;
  herdr.addPane(id, { summary: SENTENCES[i % SENTENCES.length], revision: i + 1 });
  const n = spoke.length;
  herdr.focusPane(id);
  const deadline = Date.now() + 5000;
  while (spoke.length === n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, audible ? 2500 : 300)); // let the line end or be cut by the next focus
}

const eventToAudio = spoke.map((m) => m.startedAt - m.eventAt);
const settleToAudio = spoke.map((m) => m.startedAt - m.settledAt);
console.log(`debounce ${debounceMs} ms, ${spoke.length}/${runs} lines spoken, ${audible ? 'audible' : 'silent'}`);
console.log(`focus event to first audio: ${sum(eventToAudio)}`);
console.log(`debounce settled to first audio: ${sum(settleToAudio)}`);
await narrator.stop();
await sidecar.close();
await herdr.close();
