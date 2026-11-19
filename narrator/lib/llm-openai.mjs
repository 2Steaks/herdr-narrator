// OpenAI-compatible provider: streamed chat completions. Covers Ollama, LM Studio, llama.cpp's server, OpenAI and most gateways.
// NARRATOR_LLM=openai, NARRATOR_LLM_MODEL (required), NARRATOR_LLM_BASE_URL (default Ollama), NARRATOR_LLM_API_KEY (optional for local servers).
import { PROMPT, userMessage, streamSummary, isAuthenticationError } from './llm-common.mjs';

export function createOpenAi({
  baseUrl = process.env.NARRATOR_LLM_BASE_URL ?? 'http://localhost:11434/v1',
  apiKey = process.env.NARRATOR_LLM_API_KEY,
  modelId = process.env.NARRATOR_LLM_MODEL,
  maxTokens = 60,
  system = PROMPT,
} = {}) {
  if (!modelId) throw new Error('NARRATOR_LLM=openai needs NARRATOR_LLM_MODEL (for Ollama, a pulled model such as llama3.2)');
  return {
    name: 'openai',
    isAuthError: isAuthenticationError,
    authNotice: "My model server rejected my API key. I'll stay quiet until it's fixed.",
    authHint: 'check NARRATOR_LLM_API_KEY in ~/.narrator/config.env',
    summarise({ text, lastTool, label, signal, onToken }) {
      return streamSummary({
        url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: {
          model: modelId, max_tokens: maxTokens, stream: true,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage({ text, lastTool, label }) }],
        },
        pick: (e) => e.choices?.[0]?.delta?.content,
        signal,
        onToken,
      });
    },
  };
}
