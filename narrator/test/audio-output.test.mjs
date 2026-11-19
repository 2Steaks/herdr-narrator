// Runs the Python unit tests for the sidecar's output-device router (stdlib only, fake probe and streams, no audio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PY_TEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audio_output_test.py');

test('sidecar output router follows a default-device change between lines', () => {
  const r = spawnSync(process.env.NARRATOR_TEST_PYTHON ?? 'python3', [PY_TEST], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Ran 8 tests/);
});
