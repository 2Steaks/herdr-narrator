// Stand-in for kokoro_sidecar.py: same stdio protocol, no audio. Used by sidecar.test.mjs.
// A line "plays" for 40 ms, then emits done; text LONG plays until cancelled.
import readline from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ event: 'ready', load_ms: 1 });
let current = null;
let finish = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.op === 'cancel' && current !== null) { clearTimeout(finish); out({ event: 'cancelled', id: current }); current = null; }
  if (msg.op === 'speak') {
    if (msg.text === 'CRASH') process.exit(3);
    if (current !== null) { clearTimeout(finish); out({ event: 'cancelled', id: current }); }
    const id = msg.id;
    current = id;
    if (msg.text === 'DEVICE') out({ event: 'log', level: 'info', msg: 'output device changed', from: 'MacBook Speakers', to: 'Headphones' });
    out({ event: 'render', id, render_ms: 5, cached: msg.key === 'hit' });
    out({ event: 'started', id, t_ms: Date.now(), key: msg.key });
    if (msg.text !== 'LONG') finish = setTimeout(() => { if (current === id) { out({ event: 'done', id }); current = null; } }, 40);
  }
  if (msg.op === 'quit') process.exit(0);
});
