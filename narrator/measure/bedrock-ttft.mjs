// Node time to first token for the Narrator's Bedrock call. Synthetic text only: never feed it real pane or transcript text.
// Usage: node measure/bedrock-ttft.mjs [runs=10]
import { createBedrock, createDefaultClient } from '../lib/bedrock.mjs';

const runs = Number(process.argv[2] ?? 10);
const SYNTHETIC = [
  'I ran the unit tests for the invoice module. Eleven passed and two failed because the fixture dates are out of range. I have not touched the integration suite. Do you want me to fix the fixtures or skip those two cases?',
  'The migration finished and the new column is in place. I backfilled it in batches and nothing timed out. The deploy script is untouched.',
  'I need permission to run the formatter across the repository before I continue with the rename.',
];
const bedrock = createBedrock({ client: createDefaultClient() });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const t0 = performance.now();
const cold = await bedrock.summarise({ text: SYNTHETIC[0], lastTool: 'Bash', label: 'API' });
console.log(`first call (new client, credential resolution included): ttft ${cold.ttftMs} ms, total ${Math.round(performance.now() - t0)} ms`);

const ttfts = [];
const totals = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  const r = await bedrock.summarise({ text: SYNTHETIC[i % SYNTHETIC.length], lastTool: 'Bash', label: 'API' });
  ttfts.push(r.ttftMs);
  totals.push(Math.round(performance.now() - t));
  console.log(`run ${i + 1}: ttft ${r.ttftMs} ms, total ${totals.at(-1)} ms, ${r.text.split(/\s+/).length} words`);
}
console.log(`warm ttft: median ${median(ttfts)} ms, min ${Math.min(...ttfts)}, max ${Math.max(...ttfts)}; total median ${median(totals)} ms`);
