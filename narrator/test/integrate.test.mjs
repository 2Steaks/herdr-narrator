import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addStopHook, addHerdrKeys, addAppKey } from '../integrate.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-'));
const f = (name, content) => { const p = path.join(dir, name); if (content !== undefined) fs.writeFileSync(p, content); return p; };
const HOOK = '/opt/narrator/hook/narrator-stop-hook.sh';

test('stop hook: created when there is no settings file', () => {
  const p = f('new/settings.json');
  assert.equal(addStopHook(p, HOOK), 'added');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).hooks.Stop[0].hooks[0], { type: 'command', command: HOOK, timeout: 2 });
});

test('stop hook: keeps other settings and other Stop hooks, backs up once, is idempotent', () => {
  const p = f('settings.json', JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/other.sh' }] }] } }));
  assert.equal(addStopHook(p, HOOK), 'added');
  assert.equal(addStopHook(p, HOOK), 'already there');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(p + '.bak-before-narrator', 'utf8')).hooks.Stop.length, 1);
});

test('stop hook: a moved checkout updates the path instead of adding a second hook', () => {
  const p = f('moved.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/old/narrator-stop-hook.sh', timeout: 2 }] }] } }));
  assert.equal(addStopHook(p, HOOK), 'updated the path');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.Stop[0].hooks[0].command, HOOK);
});

test('herdr keys: appended to an existing config, nothing else touched, idempotent', () => {
  const original = '[terminal]\ndefault_shell = "/bin/zsh"\n';
  const p = f('config.toml', original);
  assert.match(addHerdrKeys(p), /added 4 key/);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.startsWith(original));
  for (const a of ['mute', 'replay', 'start', 'quit']) assert.ok(text.includes(`command = "narrator.${a}"`));
  assert.equal(addHerdrKeys(p), 'already there');
  assert.equal(fs.readFileSync(p + '.bak-before-narrator', 'utf8'), original);
});

test('herdr keys: a key already bound to something else is left alone and reported', () => {
  const p = f('taken.toml', '[[keys.command]]\nkey = "prefix+m"\ntype = "command"\ncommand = "something"\n');
  const msg = addHerdrKeys(p);
  assert.match(msg, /added 3 key/);
  assert.match(msg, /prefix\+m is taken/);
  assert.equal((fs.readFileSync(p, 'utf8').match(/key = "prefix\+m"/g) ?? []).length, 1);
});

test('herdr keys: works when the file does not exist yet', () => {
  const p = f('fresh/config.toml');
  assert.match(addHerdrKeys(p), /added 4 key/);
});

test('app key: added to global, skipped when taken or missing, idempotent', () => {
  const p = f('keys.json', JSON.stringify({ global: { 'cmd-q': 'app.quit' } }));
  assert.equal(addAppKey(p), 'added cmd-shift-n');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).global['cmd-shift-n'], 'mod.open:narrator');
  assert.equal(addAppKey(p), 'already there');
  const taken = f('taken.json', JSON.stringify({ global: { 'cmd-shift-n': 'app.other' } }));
  assert.match(addAppKey(taken), /skipped: cmd-shift-n is taken/);
  assert.match(addAppKey(f('missing.json')), /skipped: no Herdr app keys file/);
});
