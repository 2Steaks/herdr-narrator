// run-narrator.sh names its own Herdr tab, then starts the Narrator. Everything here is stubbed:
// the script is copied beside a stub narrator.mjs and a stub herdr, so no real tab or the Narrator is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugin/run-narrator.sh');

function setup({ renameExit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-narrator-'));
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(plugin);
  fs.copyFileSync(SCRIPT, path.join(plugin, 'run-narrator.sh'));
  fs.writeFileSync(path.join(root, 'narrator.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(path.join(root, 'started'))}, 'started\\n');\n`);
  const herdr = path.join(root, 'herdr-stub.sh');
  fs.writeFileSync(herdr, `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(path.join(root, 'calls'))}\necho >> ${JSON.stringify(path.join(root, 'calls'))}\nexit ${renameExit}\n`, { mode: 0o755 });
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
  const run = (env) => spawnSync('/bin/bash', [path.join(plugin, 'run-narrator.sh')], {
    cwd: plugin, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: root, NARRATOR_LOG: path.join(root, 'log'), ...env },
  });
  return { herdr, read, run };
}

test('renames its own tab to Narrator with the tab id, then starts the Narrator', () => {
  const t = setup();
  const r = t.run({ HERDR_BIN_PATH: t.herdr, HERDR_TAB_ID: 'tab-7' });
  assert.equal(r.status, 0);
  assert.equal(t.read('calls').trim(), 'tab|rename|tab-7|Narrator|');
  assert.equal(t.read('started'), 'started\n');
});

test('a failing rename still starts the Narrator', () => {
  const t = setup({ renameExit: 1 });
  const r = t.run({ HERDR_BIN_PATH: t.herdr, HERDR_TAB_ID: 'tab-7' });
  assert.equal(r.status, 0);
  assert.match(t.read('calls'), /tab\|rename\|tab-7\|Narrator\|/);
  assert.equal(t.read('started'), 'started\n');
});

test('a missing herdr binary still starts the Narrator', () => {
  const t = setup();
  const r = t.run({ HERDR_BIN_PATH: '/nonexistent/herdr', HERDR_TAB_ID: 'tab-7' });
  assert.equal(r.status, 0);
  assert.equal(t.read('started'), 'started\n');
});

test('missing env skips the rename and still starts the Narrator', () => {
  const t = setup();
  const r = t.run({});
  assert.equal(r.status, 0);
  assert.equal(t.read('calls'), '');
  assert.equal(t.read('started'), 'started\n');
  const half = setup();
  half.run({ HERDR_BIN_PATH: half.herdr });
  assert.equal(half.read('calls'), '', 'no tab id, no rename');
  assert.equal(half.read('started'), 'started\n');
});
