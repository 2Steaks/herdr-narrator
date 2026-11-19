# Summaries come from a small streamed model call, behind a provider interface

The Narrator needs one spoken sentence about what an agent just did, and it needs the first token in well under a second or two. Spawning `claude -p` per call pays CLI startup every time, so the Narrator calls a small model (Claude Haiku) directly and streams the reply.

## Decision

A provider has one method, `summarise({ text, lastTool, label, signal, onToken })`, which resolves `{ text, ttftMs }`, plus `isAuthError(err)`. Three exist, chosen with `NARRATOR_LLM`:

- `anthropic` (default): the Messages API with an API key, over plain `fetch`.
- `openai`: any OpenAI-compatible chat endpoint, which covers local models through Ollama or LM Studio.
- `bedrock`: Claude Haiku through the AWS SDK, an optional dependency loaded on first use.

Bedrock came first, because the first user's organisation did not allow Anthropic API keys. It stopped being the default once the interface existed, since an API key is the common case.

## Considered options

- **Persistent `claude` process over stream-json.** Keeps the user's login and pays startup once, but adds the CLI's prompt overhead and a growing session. Kept as a fallback; never needed.
- **One hardcoded provider.** Rejected: it ties the project to one account type.
- **An SDK per provider.** Rejected for Anthropic and OpenAI-compatible: streaming SSE over `fetch` is short and keeps the install free of npm dependencies.

## Consequences

Credentials expire or get rejected. A provider says so through `isAuthError` (HTTP 401 and 403 for the `fetch` providers, expired-token errors for Bedrock), and the Narrator says once per episode that the login lapsed, then stays quiet until it recovers.

Bedrock time to first token, streamed `ConverseStream`, `maxTokens` 60, synthetic text, 10 interleaved runs per model after one warm-up call (`measure/bedrock-compare.mjs`, Nov 2026, one machine and one network):

| Model id | Median | Min | Max |
| --- | --- | --- | --- |
| `eu.anthropic.claude-haiku-5-5` | 1390 ms (second pass 1254 ms) | 1035 | 4294 |
| `global.anthropic.claude-haiku-5-5` | 1696 ms | 1150 | 7787 |
| `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | 649 ms (second pass 599 ms) | 455 | 1258 |

Haiku 4.5 was about twice as fast, and its one-sentence summaries read as well (shorter, equally faithful). The default model is nevertheless Haiku 5.5, accepting the slower first token. The uncached focus path (pane read, model call, voice render, first audio) measured a median of 1585 ms with Haiku 4.5 and sits nearer 2 s with 5.5, against a 2.5 s target (`measure/live-fallback-latency.mjs`). Summaries rendered in the background are unaffected. Override the model with `NARRATOR_LLM_MODEL`.
