// Picks the summary provider from NARRATOR_LLM: anthropic (default, an API key), bedrock, or openai (any OpenAI-compatible server).
// Every provider has summarise({ text, lastTool, label, signal, onToken }) -> { text, ttftMs } and isAuthError(err).
import { createBedrock } from './bedrock.mjs';
import { createAnthropic } from './llm-anthropic.mjs';
import { createOpenAi } from './llm-openai.mjs';

const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); // unset keys fall back to defaults

export const PROVIDERS = {
  bedrock: (env) => createBedrock(drop({ modelId: env.NARRATOR_LLM_MODEL })),
  anthropic: (env) => createAnthropic(drop({ apiKey: env.ANTHROPIC_API_KEY ?? '', baseUrl: env.NARRATOR_LLM_BASE_URL, modelId: env.NARRATOR_LLM_MODEL })),
  openai: (env) => createOpenAi(drop({ apiKey: env.NARRATOR_LLM_API_KEY, baseUrl: env.NARRATOR_LLM_BASE_URL, modelId: env.NARRATOR_LLM_MODEL ?? '' })),
};

export function createLlm(env = process.env) {
  const name = env.NARRATOR_LLM || 'anthropic';
  const make = PROVIDERS[name];
  if (!make) throw new Error(`NARRATOR_LLM=${name} is not a provider (use ${Object.keys(PROVIDERS).join(', ')})`);
  return make(env);
}
