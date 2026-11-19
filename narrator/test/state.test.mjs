import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createState } from '../lib/state.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-state-')), '.narrator', 'state.json');

test('the Narrator starts unmuted when there is no state file', () => {
  assert.equal(createState({ file: tmp() }).muted, false);
});

test('NARRATOR_MUTED survives a restart', () => {
  const file = tmp();
  const first = createState({ file });
  assert.equal(first.toggleMuted(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).NARRATOR_MUTED, true);
  assert.equal(createState({ file }).muted, true, 'a new process reads it back');
  const second = createState({ file });
  assert.equal(second.toggleMuted(), false);
  assert.equal(createState({ file }).muted, false);
});

test('other keys in the state file are kept when muting', () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ SOMETHING_ELSE: 1 }));
  createState({ file }).toggleMuted();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { SOMETHING_ELSE: 1, NARRATOR_MUTED: true });
});

test('a corrupt state file reads as unmuted and does not throw', () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const state = createState({ file });
  assert.equal(state.muted, false);
  assert.equal(state.toggleMuted(), true, 'and can still write');
});

test('the state file is private to the user', () => {
  const file = tmp();
  createState({ file }).toggleMuted();
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});
