// Fake Bedrock: same interface as lib/bedrock.mjs, records calls, makes no network request.
import { isCredentialsError } from '../lib/bedrock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFakeBedrock({ reply = (n) => `Summary number ${n}.`, delayMs = 0, ignoreAbort = false } = {}) {
  const fake = {
    calls: [], // { text, lastTool, label, aborted }
    failWith: null, // set to an Error to make the next calls fail
    async summarise({ text, lastTool, label, signal, onToken }) {
      const call = { text, lastTool, label, get aborted() { return signal?.aborted ?? false; } };
      fake.calls.push(call);
      const n = fake.calls.length;
      if (fake.failWith) throw fake.failWith;
      await sleep(delayMs);
      if (!ignoreAbort && signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const out = typeof reply === 'function' ? reply(n, text) : reply;
      for (const piece of out.match(/\S+\s*/g) ?? []) onToken?.(piece); // word-sized deltas, like a stream
      return { text: out, ttftMs: delayMs };
    },
  };
  return fake;
}

export { isCredentialsError };
