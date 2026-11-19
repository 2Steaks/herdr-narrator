// Read-only peek at live Herdr: prints key shapes and agent metadata (ids, statuses), never pane text.
import net from 'node:net';

const call = (method, params = {}) => new Promise((resolve, reject) => {
  const s = net.createConnection(process.env.HERDR_SOCKET_PATH);
  let b = '';
  s.setEncoding('utf8');
  s.on('data', (d) => { b += d; if (b.includes('\n')) { s.destroy(); resolve(JSON.parse(b.split('\n')[0])); } });
  s.on('error', reject);
  s.write(JSON.stringify({ id: 'peek', method, params }) + '\n');
});
const shape = (v, d = 0) => (v && typeof v === 'object'
  ? (Array.isArray(v) ? `[${v.length}]${v.length ? shape(v[0], d + 1) : ''}` : `{${Object.entries(v).map(([k, x]) => `${k}:${d < 3 ? shape(x, d + 1) : typeof x}`).join(',')}}`)
  : v === null ? 'null' : typeof v);

const al = await call('agent.list');
console.log('agent.list', shape(al.result ?? al.error));
for (const a of al.result?.agents ?? []) console.log(' agent', a.pane_id, a.tab_id, a.agent, a.agent_status);
const sn = await call('session.snapshot');
for (const p of sn.result?.snapshot?.panes ?? []) console.log(' pane', p.pane_id, p.tab_id, 'agent=', p.agent, p.agent_status);
