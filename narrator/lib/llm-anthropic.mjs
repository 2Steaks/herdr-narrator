// Anthropic API provider: streamed Messages call with an API key (NARRATOR_LLM=anthropic, ANTHROPIC_API_KEY).
import { PROMPT, userMessage, streamSummary, isAuthenticationError } from './llm-common.mjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export function createAnthropic({
  apiKey = process.env.ANTHROPIC_API_KEY,
  baseUrl = process.env.NARRATOR_LLM_BASE_URL ?? 'https://api.anthropic.com',
  modelId = process.env.NARRATOR_LLM_MODEL ?? DEFAULT_MODEL,
  maxTokens = 60,
  system = PROMPT,
} = {}) {
  if (!apiKey) throw new Error('NARRATOR_LLM=anthropic needs ANTHROPIC_API_KEY');
  return {
    name: 'anthropic',
    isAuthError: isAuthenticationError,
    authNotice: "My Anthropic API key was rejected. I'll stay quiet until it's fixed.",
    authHint: 'check ANTHROPIC_API_KEY in ~/.narrator/config.env',
    summarise({ text, lastTool, label, signal, onToken }) {
      return streamSummary({
        url: `${baseUrl.replace(/\/$/, '')}/v1/messages`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: modelId, max_tokens: maxTokens, stream: true, system, messages: [{ role: 'user', content: userMessage({ text, lastTool, label }) }] },
        pick: (e) => (e.type === 'content_block_delta' ? e.delta?.text : ''),
        signal,
        onToken,
      });
    },
  };
}
