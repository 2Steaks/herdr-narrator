// Read-only live listener: subscribes like the summariser does (per-pane status, pane.created/closed, focus) and
// prints the envelope shape of each event, never any pane text. Usage: node measure/live-events.mjs [seconds=300]
import { createHerdrClient } from '../lib/herdr.mjs';

const seconds = Number(process.argv[2] ?? 300);
const h = createHerdrClient({ socketPath: process.env.HERDR_SOCKET_PATH });
const t0 = Date.now();
const show = (label) => (msg) => {
  const d = msg.data ?? {};
  const extra = ['pane_id', 'tab_id', 'agent_status', 'agent'].filter((k) => k in d).map((k) => `${k}=${d[k]}`).join(' ');
  console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s [${label}] event=${msg.event} top=${Object.keys(msg).join(',')} data=${Object.keys(d).join(',')} ${extra}`);
};
const snap = (await h.request('session.snapshot')).snapshot;
await h.subscribe([{ type: 'pane.created' }, { type: 'pane.closed' }, { type: 'pane.focused' }, { type: 'tab.focused' }], show('lifecycle+focus'));
for (const p of snap.panes) await h.subscribe([{ type: 'pane.agent_status_changed', pane_id: p.pane_id }], show(`status ${p.pane_id}`));
console.log(`listening ${seconds}s on ${snap.panes.length} panes`);
setTimeout(() => { h.close(); process.exit(0); }, seconds * 1000);
