import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastTurn } from '../lib/transcript.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
let n = 0;
const write = (lines) => {
  const file = path.join(dir, `t${n++}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};
const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const tool = (name) => ({ type: 'tool_use', name, input: {} });
const result = () => user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]);

test('takes the assistant text blocks of the last turn and the last tool name', async () => {
  const file = write([
    user('earlier prompt'),
    assistant(text('Old turn text.')),
    user('run the tests'),
    assistant(text('Running them now.'), tool('Bash')),
    result(),
    { type: 'attachment' },
    assistant({ type: 'thinking', thinking: 'hmm' }, text('All green.'), tool('Edit')),
    result(),
    assistant(text('Done, tests pass.')),
  ]);
  const turn = await readLastTurn(file);
  assert.equal(turn.text, 'Running them now.\n\nAll green.\n\nDone, tests pass.');
  assert.equal(turn.lastTool, 'Edit');
});

test('ignores sidechain (subagent) entries and bookkeeping lines', async () => {
  const file = write([
    user('go'),
    assistant(text('Main thread text.')),
    { ...assistant(text('Subagent chatter.')), isSidechain: true },
    { type: 'system', subtype: 'x' },
  ]);
  assert.equal((await readLastTurn(file)).text, 'Main thread text.');
});

test('reads only the last 64 KB and drops the partial first line', async () => {
  const filler = assistant(text('x'.repeat(1000)));
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(filler); // about 100 KB
  lines.push(user('now'), assistant(text('Final words.')));
  const file = write(lines);
  const turn = await readLastTurn(file, { maxBytes: 64 * 1024 });
  assert.equal(turn.text, 'Final words.');
});

test('a missing file, empty file or garbage returns null instead of throwing', async () => {
  assert.equal(await readLastTurn(path.join(dir, 'nope.jsonl')), null);
  assert.equal(await readLastTurn(write(['not json', '{"broken'])), null);
  assert.equal(await readLastTurn(write([user('only a prompt')])), null);
});

test('caps the text it returns, keeping the end of the turn', async () => {
  const file = write([user('go'), assistant(text('a'.repeat(5000) + 'THE END'))]);
  const turn = await readLastTurn(file, { maxChars: 4000 });
  assert.equal(turn.text.length, 4000);
  assert.ok(turn.text.endsWith('THE END'));
});
