import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBedrock, isCredentialsError } from '../lib/bedrock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake BedrockRuntimeClient: send(command, { abortSignal }) returns a ConverseStream-shaped response. */
function fakeClient({ deltas = ['The API agent ', 'finished.'], firstDelayMs = 0, gapMs = 0, error } = {}) {
  const fake = {
    commands: [],
    async send(command, { abortSignal } = {}) {
      fake.commands.push(command);
      if (error) throw error;
      async function* stream() {
        await sleep(firstDelayMs);
        yield { messageStart: { role: 'assistant' } };
        for (const text of deltas) {
          if (abortSignal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
          await sleep(gapMs);
        }
        yield { messageStop: { stopReason: 'end_turn' } };
      }
      return { stream: stream() };
    },
  };
  return fake;
}

test('streams a Summary and reports time to first token', async () => {
  const client = fakeClient({ firstDelayMs: 30 });
  const bedrock = createBedrock({ client });
  const seen = [];
  const out = await bedrock.summarise({ text: 'synthetic reply', lastTool: 'Bash', onToken: (t) => seen.push(t) });
  assert.equal(out.text, 'The API agent finished.');
  assert.deepEqual(seen, ['The API agent ', 'finished.']);
  assert.ok(out.ttftMs >= 25 && out.ttftMs < 500, `ttft ${out.ttftMs}`);
});

test('sends the pinned model, a small token budget and the narrator prompt as system', async () => {
  const client = fakeClient();
  await createBedrock({ client }).summarise({ text: 'synthetic reply', lastTool: 'Edit' });
  const { input } = client.commands[0];
  assert.equal(input.modelId, 'eu.anthropic.claude-haiku-5-5');
  assert.equal(input.inferenceConfig.maxTokens, 60);
  assert.match(input.system[0].text, /third person/i);
  const user = input.messages[0].content[0].text;
  assert.match(user, /synthetic reply/);
  assert.match(user, /Edit/, 'last tool name travels with the text');
});

test('aborting stops the stream and rejects with AbortError', async () => {
  const client = fakeClient({ deltas: ['a', 'b', 'c', 'd'], gapMs: 40 });
  const ac = new AbortController();
  const p = createBedrock({ client }).summarise({ text: 'x', signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, { name: 'AbortError' });
});

test('classifies expired SSO credentials so callers can say so once', async () => {
  for (const name of ['ExpiredTokenException', 'CredentialsProviderError', 'UnrecognizedClientException', 'TokenProviderError']) {
    const client = fakeClient({ error: Object.assign(new Error('nope'), { name }) });
    await assert.rejects(createBedrock({ client }).summarise({ text: 'x' }), (e) => isCredentialsError(e));
  }
  const other = fakeClient({ error: Object.assign(new Error('slow down'), { name: 'ThrottlingException' }) });
  await assert.rejects(createBedrock({ client: other }).summarise({ text: 'x' }), (e) => !isCredentialsError(e));
});
