import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLlm } from '../lib/llm.mjs';
import { createAnthropic } from '../lib/llm-anthropic.mjs';
import { createOpenAi } from '../lib/llm-openai.mjs';
import { promptFor } from '../lib/llm-common.mjs';

const requests = [];
let respond = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    respond(res);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const sse = (res, events, { chunked = false } = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payload = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  if (chunked) { for (let i = 0; i < payload.length; i += 7) res.write(payload.slice(i, i + 7)); } else res.write(payload);
  res.end();
};

test('anthropic: streams deltas, sends key, model, system and the user message', async () => {
  respond = (res) => sse(res, [
    { type: 'message_start', message: {} },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The API agent ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'finished.' } },
    { type: 'message_stop' },
  ], { chunked: true });
  const llm = createAnthropic({ apiKey: 'k-123', baseUrl: base, modelId: 'm-1', system: 'SYS' });
  const seen = [];
  const out = await llm.summarise({ text: 'the reply', lastTool: 'Bash', label: 'API', onToken: (t) => seen.push(t) });
  assert.equal(out.text, 'The API agent finished.');
  assert.deepEqual(seen, ['The API agent ', 'finished.']);
  assert.ok(out.ttftMs >= 0);
  const r = requests.at(-1);
  assert.equal(r.url, '/v1/messages');
  assert.equal(r.headers['x-api-key'], 'k-123');
  assert.equal(r.body.model, 'm-1');
  assert.equal(r.body.system, 'SYS');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.messages[0].content, 'Agent label: API\nLast tool used: Bash\nLatest reply:\nthe reply');
});

test('openai-compatible: streams deltas, stops at [DONE], no auth header without a key', async () => {
  respond = (res) => sse(res, [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: 'Tests ' } }] },
    { choices: [{ delta: { content: 'passed.' } }] },
    '[DONE]',
  ]);
  const llm = createOpenAi({ baseUrl: `${base}/v1`, modelId: 'llama3.2', system: 'SYS' });
  const out = await llm.summarise({ text: 'x' });
  assert.equal(out.text, 'Tests passed.');
  const r = requests.at(-1);
  assert.equal(r.url, '/v1/chat/completions');
  assert.equal(r.headers.authorization, undefined);
  assert.deepEqual(r.body.messages.map((m) => m.role), ['system', 'user']);
});

test('openai-compatible: sends a bearer key when given one', async () => {
  respond = (res) => sse(res, [{ choices: [{ delta: { content: 'Ok.' } }] }, '[DONE]']);
  await createOpenAi({ baseUrl: base, modelId: 'm', apiKey: 'sk-1' }).summarise({ text: 'x' });
  assert.equal(requests.at(-1).headers.authorization, 'Bearer sk-1');
});

test('a 401 is an auth error, any other failure is not', async () => {
  const llm = createAnthropic({ apiKey: 'bad', baseUrl: base });
  respond = (res) => { res.writeHead(401).end('{"error":"nope"}'); };
  const err = await llm.summarise({ text: 'x' }).catch((e) => e);
  assert.equal(err.name, 'AuthenticationError');
  assert.equal(llm.isAuthError(err), true);
  assert.equal(err.message.includes('nope'), false, 'the response body is never kept');
  respond = (res) => { res.writeHead(500).end('x'); };
  const err2 = await llm.summarise({ text: 'x' }).catch((e) => e);
  assert.equal(llm.isAuthError(err2), false);
  assert.equal(err2.$metadata.httpStatusCode, 500);
});

test('abort stops a stream', async () => {
  respond = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'); };
  const ac = new AbortController();
  const p = createOpenAi({ baseUrl: base, modelId: 'm' }).summarise({ text: 'x', signal: ac.signal, onToken: () => ac.abort() });
  const err = await p.catch((e) => e);
  assert.equal(err.name, 'AbortError');
});

test('createLlm: anthropic is the default, and misconfiguration says what is missing', () => {
  assert.equal(createLlm({ ANTHROPIC_API_KEY: 'k' }).name, 'anthropic');
  assert.equal(createLlm({ NARRATOR_LLM: 'openai', NARRATOR_LLM_MODEL: 'm' }).name, 'openai');
  assert.equal(createLlm({ NARRATOR_LLM: 'bedrock' }).name, 'bedrock');
  assert.throws(() => createAnthropic({ apiKey: '' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => createOpenAi({ modelId: '' }), /NARRATOR_LLM_MODEL/);
  assert.throws(() => createLlm({ NARRATOR_LLM: 'nope' }), /not a provider/);
});

test('the prompt names the user from NARRATOR_USER_NAME and has no leftover placeholder', () => {
  assert.match(promptFor('Sam'), /one of Sam's terminal panes/);
  assert.match(promptFor(''), /one of the user's terminal panes/);
  assert.equal(promptFor('Sam').includes('{{'), false);
});
