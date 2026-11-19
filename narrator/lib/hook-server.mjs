// Receives Stop-hook lines on ~/.narrator/narrator.sock. The hook script sends one JSON line per Stop:
//   {"pane_id": "<HERDR_PANE_ID>", "hook": { ...Claude Code's hook JSON... }}
// The Herdr plugin (plugin/) sends {"cmd": "replay"}, {"cmd": "mute"} or {"cmd": "quit"} on the same socket.
// Only the pane id and transcript path are used. Nothing from the payload is logged.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SOCKET = process.env.NARRATOR_SOCK ?? path.join(os.homedir(), '.narrator', 'narrator.sock');
const MAX_BYTES = 1024 * 1024;
const COMMANDS = new Set(['replay', 'mute', 'quit']);

const isLive = (file) => new Promise((resolve) => {
  const c = net.createConnection(file);
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

export function createHookServer({ socketPath = DEFAULT_SOCKET, onHook, onCommand = () => {}, log = () => {} }) {
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let handled = false;
    const finish = () => {
      if (handled) return;
      handled = true;
      handle(buf);
      sock.destroy();
    };
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_BYTES) { handled = true; sock.destroy(); return log({ level: 'warn', msg: 'hook payload too large' }); }
      if (buf.includes('\n')) finish(); // one line is the whole message; reply nothing and let the hook exit
    });
    sock.on('end', finish);
    sock.on('error', () => {});
  });

  function handle(raw) {
    let msg;
    try { msg = JSON.parse(raw.split('\n')[0]); } catch { return log({ level: 'warn', msg: 'malformed hook line', len: raw.length }); }
    if (typeof msg?.cmd === 'string') { // a Herdr plugin action (replay, mute, quit), not a Stop hook
      if (COMMANDS.has(msg.cmd)) onCommand(msg.cmd);
      else log({ level: 'warn', msg: 'unknown command', len: msg.cmd.length });
      return;
    }
    const paneId = typeof msg?.pane_id === 'string' ? msg.pane_id : '';
    const transcriptPath = typeof msg?.hook?.transcript_path === 'string' ? msg.hook.transcript_path : '';
    if (!paneId) return log({ level: 'warn', msg: 'hook without a pane id; is HERDR_PANE_ID set where the hook runs?' });
    onHook({ paneId, transcriptPath: transcriptPath || undefined });
  }

  let started = false;
  return {
    async start() {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(socketPath)) {
        if (await isLive(socketPath)) throw new Error(`the Narrator is already running (${socketPath} is live)`);
        fs.rmSync(socketPath, { force: true });
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      fs.chmodSync(socketPath, 0o600);
      started = true;
    },
    async stop() {
      if (!started) return; // never remove the socket of another Narrator
      started = false;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    },
  };
}
