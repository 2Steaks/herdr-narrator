// Bedrock client for the Narrator (ADR 0001): streamed ConverseStream to Haiku in eu-west-1, abortable.
import { PROMPT, userMessage } from './llm-common.mjs';

export const MODEL_ID = 'eu.anthropic.claude-haiku-5-5';
export const REGION = 'eu-west-1';

const CREDENTIAL_ERRORS = new Set([
  'ExpiredTokenException', 'ExpiredToken', 'CredentialsProviderError', 'TokenProviderError',
  'UnrecognizedClientException', 'InvalidSignatureException',
]);

/** True when the failure means the AWS login lapsed (so the Narrator says so once), false for everything else. */
export const isCredentialsError = (err) => CREDENTIAL_ERRORS.has(err?.name) || CREDENTIAL_ERRORS.has(err?.Code);

/** The AWS SDK is an optional dependency, loaded on first use, so people on another provider never install it. */
export async function createDefaultClient({ profile = process.env.NARRATOR_AWS_PROFILE ?? 'default', region = process.env.NARRATOR_AWS_REGION ?? REGION } = {}) {
  const [{ BedrockRuntimeClient }, { fromIni }] = await Promise.all([
    import('@aws-sdk/client-bedrock-runtime'),
    import('@aws-sdk/credential-providers'),
  ]);
  return new BedrockRuntimeClient({ region, credentials: fromIni({ profile }) });
}

export function createBedrock({
  client = null,
  modelId = process.env.NARRATOR_LLM_MODEL ?? MODEL_ID,
  maxTokens = 60,
  system = PROMPT,
} = {}) {
  let clientPromise = client ? Promise.resolve(client) : null;
  return {
    name: 'bedrock',
    isAuthError: isCredentialsError,
    authNotice: "My AWS login lapsed. I'll stay quiet until you log in again.",
    authHint: 'run `aws sso login`',
    /**
     * Streams one Summary. Resolves { text, ttftMs } (ttft counted from the call, so it includes the request).
     * Rejects with AbortError when `signal` fires. The input text is never logged here or anywhere.
     */
    async summarise({ text, lastTool, label, signal, onToken }) {
      const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
      clientPromise ??= createDefaultClient();
      const command = new ConverseStreamCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content: [{ text: userMessage({ text, lastTool, label }) }] }],
        // No temperature: this model rejects it.
        inferenceConfig: { maxTokens },
      });
      const started = performance.now();
      const res = await (await clientPromise).send(command, { abortSignal: signal });
      let out = '';
      let ttftMs = null;
      for await (const part of res.stream) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const delta = part.contentBlockDelta?.delta?.text;
        if (!delta) continue;
        if (ttftMs === null) ttftMs = Math.round(performance.now() - started);
        out += delta;
        onToken?.(delta);
      }
      return { text: out.trim(), ttftMs };
    },
  };
}
