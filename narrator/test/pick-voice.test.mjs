// pick-voice.sh: list voices and write the chosen one to config.env. Uses a temp config and voices folder, never restarts
// (--no-restart), and points NARRATOR_VOICE_DIR at an empty folder so no Kokoro pack or Python is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../pick-voice.sh');

function sandbox(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-voice-'));
  const voices = path.join(home, 'voices');
  fs.mkdirSync(path.join(voices, 'rick'), { recursive: true });
  fs.writeFileSync(path.join(voices, 'rick', 'reference.wav'), '');
  fs.mkdirSync(path.join(voices, 'rick.bak-before-narrator'));
  fs.writeFileSync(path.join(voices, 'rick.bak-before-narrator', 'reference.wav'), '');
  fs.mkdirSync(path.join(voices, 'empty'));
  const cfg = path.join(home, 'config.env');
  fs.writeFileSync(cfg, config, { mode: 0o600 });
  const run = (...args) => spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home, NARRATOR_CONFIG: cfg, NARRATOR_QWEN_VOICES_DIR: voices, NARRATOR_VOICE_DIR: path.join(home, 'none') },
  });
  return { cfg, run };
}

test('--list names the presets and cloned voices, and skips backups and folders with no reference.wav', () => {
  const { run } = sandbox('NARRATOR_TTS=kokoro\n');
  const out = run('--list').stdout.split('\n');
  assert.ok(out.includes('qwen ryan'));
  assert.ok(out.includes('qwen rick'));
  assert.ok(!out.some((l) => l.includes('bak-before-narrator') || l.includes('empty')));
});

test('a cloned voice sets the qwen engine and speaker, keeps other lines, and saves a backup once', () => {
  const original = '# keep me\nNARRATOR_TTS=kokoro\nNARRATOR_VOICE=af_heart\nANTHROPIC_API_KEY=abc\n';
  const { cfg, run } = sandbox(original);
  const r = run('rick', '--no-restart');
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /^NARRATOR_TTS=qwen$/m);
  assert.match(text, /^NARRATOR_QWEN_VOICE=rick$/m);
  assert.match(text, /^# keep me$/m);
  assert.match(text, /^NARRATOR_VOICE=af_heart$/m);
  assert.match(text, /^ANTHROPIC_API_KEY=abc$/m);
  assert.equal(fs.readFileSync(`${cfg}.bak-before-narrator`, 'utf8'), original);
  run('ryan', '--no-restart');
  assert.equal(fs.readFileSync(`${cfg}.bak-before-narrator`, 'utf8'), original, 'the first backup stays');
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
});

test('an unknown voice fails and leaves the config alone', () => {
  const { cfg, run } = sandbox('NARRATOR_TTS=kokoro\n');
  const r = run('nope', '--no-restart');
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(cfg, 'utf8'), 'NARRATOR_TTS=kokoro\n');
});

test('--dry-run changes nothing', () => {
  const { cfg, run } = sandbox('NARRATOR_TTS=kokoro\n');
  run('rick', '--dry-run', '--no-restart');
  assert.equal(fs.readFileSync(cfg, 'utf8'), 'NARRATOR_TTS=kokoro\n');
  assert.ok(!fs.existsSync(`${cfg}.bak-before-narrator`));
});
