// The sidecar client reports when a line has finished or been cut off, and plays chimes by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSidecar } from '../lib/sidecar.mjs';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stub-sidecar-child.mjs');
const make = () => createSidecar({ command: process.execPath, args: [STUB] });

test('ended resolves done when the line finishes on its own', async () => {
  const sidecar = make();
  const res = await sidecar.speak({ key: 'k', text: 'short line' });
  assert.equal(await res.ended, 'done');
  await sidecar.close();
});

test('ended resolves cancelled when the line is cut off', async () => {
  const sidecar = make();
  const res = await sidecar.speak({ key: 'k', text: 'LONG' });
  sidecar.cancel();
  assert.equal(await res.ended, 'cancelled');
  await sidecar.close();
});

test('a newer speak cuts the older line off', async () => {
  const sidecar = make();
  const first = await sidecar.speak({ key: 'a', text: 'LONG' });
  const second = await sidecar.speak({ key: 'b', text: 'short line' });
  assert.equal(await first.ended, 'cancelled');
  assert.equal(await second.ended, 'done');
  await sidecar.close();
});

test('chime speaks the reserved chime key', async () => {
  const sidecar = make();
  const res = await sidecar.chime('muted');
  assert.equal(res.cancelled, false);
  await sidecar.close();
});
