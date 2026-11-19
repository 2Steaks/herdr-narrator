import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRollup, rollupSignature } from '../lib/rollup.mjs';

test('counts by state, blocked first, in words', () => {
  const line = buildRollup([{ status: 'done' }, { status: 'done' }, { status: 'blocked' }]);
  assert.equal(line, 'One blocked, two done.');
});

test('one blocked agent with a cached Summary adds its reason', () => {
  const line = buildRollup([{ status: 'done' }, { status: 'blocked', summary: 'The API agent is waiting on a permission.' }]);
  assert.equal(line, 'One blocked, one done. The API agent is waiting on a permission.');
});

test('two blocked agents do not read out either Summary', () => {
  const line = buildRollup([
    { status: 'blocked', summary: 'First reason.' },
    { status: 'blocked', summary: 'Second reason.' },
  ]);
  assert.equal(line, 'Two blocked.');
});

test('working and idle agents are named too; unknown ones are left out', () => {
  assert.equal(buildRollup([{ status: 'working' }, { status: 'idle' }, { status: 'unknown' }]), 'One working, one idle.');
});

test('large counts fall back to digits; nothing to say gives null', () => {
  assert.equal(buildRollup(Array.from({ length: 12 }, () => ({ status: 'done' }))), '12 done.');
  assert.equal(buildRollup([{ status: 'unknown' }]), null);
  assert.equal(buildRollup([]), null);
});

test('the signature changes with states or Summary revisions and ignores order', () => {
  const a = [{ paneId: 'p1', status: 'done', revision: 1 }, { paneId: 'p2', status: 'blocked', revision: 2 }];
  const b = [...a].reverse();
  assert.equal(rollupSignature(a), rollupSignature(b));
  assert.notEqual(rollupSignature(a), rollupSignature([{ ...a[0], status: 'working' }, a[1]]));
  assert.notEqual(rollupSignature(a), rollupSignature([a[0], { ...a[1], revision: 3 }]));
});
