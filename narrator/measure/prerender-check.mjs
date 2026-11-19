// Real Kokoro sidecar, silent: pre-render three lines, check they land in the cache without replacing each other,
// that a cached speak starts at once even while another pre-render runs, and that evict drops a line.
// Usage: NARRATOR_SIDECAR_SILENT=1 node measure/prerender-check.mjs
import { createSidecar } from '../lib/sidecar.mjs';

process.env.NARRATOR_SIDECAR_SILENT ??= '1';
const sidecar = createSidecar({ log: (e) => e.level === 'error' && console.log('log', e) });
await sidecar.warm();
const lines = ['The API agent finished the form tests.', 'The web agent is waiting on a permission.', 'The docs agent has two questions for you.'];
const t0 = performance.now();
lines.forEach((text, i) => sidecar.prerender({ key: `m${i}#1`, text }));
// Speak line 0 as soon as it is likely cached, while lines 1 and 2 are still rendering.
await new Promise((r) => setTimeout(r, 700));
const t1 = performance.now();
const hit = await sidecar.speak({ key: 'm0#1', text: lines[0] });
console.log(`speak of a pre-rendered line while others render: cached=${hit.cached}, to audio ${Math.round(performance.now() - t1)} ms`);
await new Promise((r) => setTimeout(r, 1500));
const all = [];
for (const [i, text] of lines.entries()) all.push(await sidecar.speak({ key: `m${i}#1`, text }));
console.log('all three cached after prerender:', all.map((r) => r.cached).join(','), `(elapsed ${Math.round(performance.now() - t0)} ms)`);
sidecar.evict('m1#1');
await new Promise((r) => setTimeout(r, 100));
const after = await sidecar.speak({ key: 'm1#1', text: lines[1] });
console.log('after evict, line 1 cached:', after.cached);
await sidecar.close();
