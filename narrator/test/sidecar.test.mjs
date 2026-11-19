import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSidecar } from '../lib/sidecar.mjs';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stub-sidecar-child.mjs');
const make = (logs = []) => createSidecar({ command: process.execPath, args: [STUB], log: (e) => logs.push(e) });

test('speak resolves when audio starts, with render info', async () => {
  const sidecar = make();
  const res = await sidecar.speak({ key: 'hit', text: 'hello there' });
  assert.equal(res.cancelled, false);
  assert.equal(res.cached, true);
  assert.equal(res.renderMs, 5);
  assert.ok(res.startedAtMs > 0);
  await sidecar.close();
});

test('a sidecar that dies mid-line is logged, and the next speak respawns it', async () => {
  const logs = [];
  const sidecar = make(logs);
  const crashed = await sidecar.speak({ key: 'k', text: 'CRASH' });
  assert.equal(crashed.cancelled, true);
  assert.ok(logs.some((l) => l.msg === 'sidecar exited'));
  const res = await sidecar.speak({ key: 'k', text: 'back again' });
  assert.equal(res.cancelled, false);
  await sidecar.close();
});

test('an output device change reported by the sidecar is logged as one info line, names only', async () => {
  const logs = [];
  const sidecar = make(logs);
  await sidecar.speak({ key: 'k', text: 'DEVICE' });
  const lines = logs.filter((l) => l.msg === 'output device changed');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { level: 'info', msg: 'output device changed', from: 'MacBook Speakers', to: 'Headphones' });
  await sidecar.close();
});
