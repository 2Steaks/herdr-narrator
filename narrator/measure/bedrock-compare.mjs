// Node time to first token for several Bedrock model ids, interleaved so time-of-day noise hits all equally.
// Synthetic text only: never feed it real pane or transcript text.
// Usage: node measure/bedrock-compare.mjs [runs=10] [modelId ...]
import { createBedrock, createDefaultClient } from '../lib/bedrock.mjs';

const runs = Number(process.argv[2] ?? 10);
const models = process.argv.slice(3).length ? process.argv.slice(3) : ['eu.anthropic.claude-haiku-5-5', 'global.anthropic.claude-haiku-5-5', 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'];
const SYNTHETIC = [
  'I ran the unit tests for the invoice module. Eleven passed and two failed because the fixture dates are out of range. I have not touched the integration suite. Do you want me to fix the fixtures or skip those two cases?',
  'The migration finished and the new column is in place. I backfilled it in batches and nothing timed out. The deploy script is untouched.',
  'I need permission to run the formatter across the repository before I continue with the rename.',
];
const client = createDefaultClient();
const bedrocks = Object.fromEntries(models.map((m) => [m, createBedrock({ client, modelId: m })]));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stats = Object.fromEntries(models.map((m) => [m, { ttft: [], total: [], errors: 0, words: [], samples: [] }]));

for (const m of models) { // one warm-up call each (client and connection setup), not counted
  try { await bedrocks[m].summarise({ text: SYNTHETIC[0], lastTool: 'Bash', label: 'API' }); } catch (e) { console.log(`${m}: warm-up failed: ${e.name}`); }
}
for (let i = 0; i < runs; i++) {
  for (const m of models) {
    const t = performance.now();
    try {
      const r = await bedrocks[m].summarise({ text: SYNTHETIC[i % SYNTHETIC.length], lastTool: 'Bash', label: 'API' });
      const s = stats[m];
      s.ttft.push(r.ttftMs);
      s.total.push(Math.round(performance.now() - t));
      s.words.push(r.text.split(/\s+/).length);
      if (i < SYNTHETIC.length) s.samples.push(r.text);
    } catch (e) {
      stats[m].errors++;
      console.log(`${m} run ${i + 1}: ${e.name}`);
    }
  }
}
for (const m of models) {
  const s = stats[m];
  if (!s.ttft.length) { console.log(`${m}: no successful runs (${s.errors} errors)`); continue; }
  console.log(`${m}: ttft median ${median(s.ttft)} ms (min ${Math.min(...s.ttft)}, max ${Math.max(...s.ttft)}), total median ${median(s.total)} ms, words median ${median(s.words)}, errors ${s.errors}`);
  console.log('  ttft runs:', s.ttft.join(' '));
  for (const x of s.samples) console.log('  >', x);
}
