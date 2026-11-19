// Real-setup measurement of the Kokoro sidecar: cold start, warm per-sentence render, cached replay, cancel.
// Usage: node measure/sidecar-latency.mjs [--audible]   (silent by default: no sound, same timing up to the device)
import { createSidecar } from '../lib/sidecar.mjs';

const audible = process.argv.includes('--audible');
const SENTENCES = [
  'The API agent is waiting on a permission.',
  'The web agent finished the form tests and found nothing broken.',
  'Two tests failed in the settings loader, and the fix is a one line change.',
  'The build is green and the pull request is ready for your review.',
  'The worker is still running the migration, so give it a minute.',
  'Nothing needs you here; the agent is idle.',
  'The agent is asking which of the two options you want.',
  'The deploy finished, and the smoke checks passed.',
  'The linter found three warnings, none of them serious.',
  'The agent hit a permission prompt for a shell command.',
];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const logs = [];
const sidecar = createSidecar({ env: audible ? {} : { NARRATOR_SIDECAR_SILENT: '1' }, log: (e) => logs.push(e) });

const t0 = performance.now();
await sidecar.warm();
const coldMs = performance.now() - t0;
console.log(`cold start (spawn to ready): ${coldMs.toFixed(0)} ms, sidecar-reported model load: ${logs.find((l) => l.msg === 'sidecar ready')?.load_ms} ms`);

// first render after load (includes onnx warm-up)
let t = performance.now();
let r = await sidecar.speak({ key: 'first', text: 'Warm up line.' });
console.log(`first speak after load: ${(performance.now() - t).toFixed(0)} ms (render ${r.renderMs})`);
sidecar.cancel();

const warm = [];
for (const [i, text] of SENTENCES.entries()) {
  t = performance.now();
  r = await sidecar.speak({ key: `warm-${i}`, text });
  warm.push(performance.now() - t);
  sidecar.cancel(); // do not wait for the sentence to finish playing
  await new Promise((res) => setTimeout(res, 150));
}
console.log(`warm render+start, 10 sentences: median ${median(warm).toFixed(0)} ms, min ${Math.min(...warm).toFixed(0)}, max ${Math.max(...warm).toFixed(0)}`);

const cached = [];
for (const [i] of SENTENCES.entries()) {
  t = performance.now();
  r = await sidecar.speak({ key: `warm-${i}`, text: SENTENCES[i] });
  cached.push(performance.now() - t);
  if (!r.cached) console.log('  (miss on replay: cache did not hold the entry)');
  sidecar.cancel();
  await new Promise((res) => setTimeout(res, 150));
}
console.log(`cached replay to start, 10 sentences: median ${median(cached).toFixed(0)} ms, min ${Math.min(...cached).toFixed(0)}, max ${Math.max(...cached).toFixed(0)}`);

await sidecar.close();
