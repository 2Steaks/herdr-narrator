// Exit time of hook/narrator-stop-hook.sh, 20 runs each, with the Narrator absent and present (a real hook server on a temp socket).
// Also times a bare `node -e 0` and a bare `sh -c :` so the numbers have a floor to compare with.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHookServer } from '../lib/hook-server.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '../hook/narrator-stop-hook.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-time-'));
const sock = path.join(dir, 'narrator.sock');
const JSON_IN = JSON.stringify({ session_id: 's', transcript_path: '/tmp/t.jsonl', hook_event_name: 'Stop' });

function time(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const t = performance.now();
    const c = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('close', (code) => resolve({ ms: performance.now() - t, code }));
    c.stdin.end(JSON_IN);
  });
}
async function many(label, cmd, args, env) {
  const ms = [];
  for (let i = 0; i < 20; i++) { const r = await time(cmd, args, env); if (r.code !== 0) console.log('non-zero exit', r.code); ms.push(r.ms); }
  ms.sort((a, b) => a - b);
  console.log(`${label.padEnd(34)} median ${ms[10].toFixed(1)} ms  min ${ms[0].toFixed(1)}  max ${ms[19].toFixed(1)}`);
}

await many('sh -c : (floor)', '/bin/sh', ['-c', ':']);
await many('node -e 0 (why not node)', process.execPath, ['-e', '0']);
await many('hook, the Narrator not running', '/bin/sh', [HOOK], { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' });
const server = createHookServer({ socketPath: sock, onHook: () => {} });
await server.start();
await many('hook, the Narrator running', '/bin/sh', [HOOK], { NARRATOR_SOCK: sock, HERDR_PANE_ID: 'w1:p1' });
await server.stop();
