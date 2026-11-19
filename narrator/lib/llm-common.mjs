// Shared by every summary provider (bedrock.mjs, llm-anthropic.mjs, llm-openai.mjs): the prompt, the user message, SSE reading.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW_PROMPT = fs.readFileSync(fileURLToPath(new URL('../prompt.md', import.meta.url)), 'utf8').trim();

/** prompt.md with {{user}} filled in from NARRATOR_USER_NAME (default "the user"). */
export const promptFor = (userName = process.env.NARRATOR_USER_NAME) => RAW_PROMPT.replaceAll('{{user}}', userName || 'the user');
export const PROMPT = promptFor();

/** The one user message every provider sends: optional label, optional last tool, then the agent's latest reply. */
export function userMessage({ text, lastTool, label }) {
  const lines = [];
  if (label) lines.push(`Agent label: ${label}`);
  if (lastTool) lines.push(`Last tool used: ${lastTool}`);
  lines.push('Latest reply:', text);
  return lines.join('\n');
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** Yields the `data:` payload (a string) of each server-sent event in a fetch Response. */
export async function* sseData(res, signal) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    if (signal?.aborted) throw abortError();
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}

/** Throws an Error named for the HTTP status; 401 and 403 are named AuthenticationError so the Narrator says its login lapsed. */
export async function throwHttpError(res) {
  const err = new Error(`HTTP ${res.status}`);
  err.name = res.status === 401 || res.status === 403 ? 'AuthenticationError' : 'HttpError';
  err.status = res.status;
  err.$metadata = { httpStatusCode: res.status };
  await res.body?.cancel().catch(() => {}); // the body may hold the key echoed back or the prompt: never read or log it
  throw err;
}

/** Runs one streamed request. `pick(json)` returns the text delta in a parsed event (or ''). Resolves { text, ttftMs }. */
export async function streamSummary({ url, headers, body, pick, signal, onToken }) {
  const started = performance.now();
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) await throwHttpError(res);
  let out = '';
  let ttftMs = null;
  for await (const data of sseData(res, signal)) {
    if (data === '[DONE]') break;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    const delta = pick(json);
    if (!delta) continue;
    if (ttftMs === null) ttftMs = Math.round(performance.now() - started);
    out += delta;
    onToken?.(delta);
  }
  return { text: out.trim(), ttftMs };
}

export const isAuthenticationError = (err) => err?.name === 'AuthenticationError';
