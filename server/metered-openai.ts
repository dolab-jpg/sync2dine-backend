import type OpenAI from 'openai';
import { assertWithinQuota, recordUsage } from './usage';

type ChatCompletionParams = Parameters<OpenAI['chat']['completions']['create']>[0];
type ChatCompletionResult = Awaited<ReturnType<OpenAI['chat']['completions']['create']>>;

function extractUsage(result: ChatCompletionResult) {
  if (!result || typeof result !== 'object' || !('usage' in result)) return null;
  const usage = (result as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
  return usage ?? null;
}

function extractModel(params: ChatCompletionParams): string {
  if (params && typeof params === 'object' && 'model' in params) {
    return String(params.model ?? 'unknown');
  }
  return 'unknown';
}

export function wrapOpenAIWithMetering(
  openai: OpenAI,
  orgId: string | null,
  endpoint: string,
): OpenAI {
  const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);

  openai.chat.completions.create = (async (
    params: ChatCompletionParams,
    options?: Parameters<OpenAI['chat']['completions']['create']>[1],
  ) => {
    if (orgId) await assertWithinQuota(orgId);
    const result = await originalCreate(params, options);
    if (orgId) {
      const usage = extractUsage(result);
      if (usage) {
        recordUsage(orgId, endpoint, extractModel(params), usage);
      }
    }
    return result;
  }) as typeof openai.chat.completions.create;

  return openai;
}

export async function meteredSpeechCreate(
  openai: OpenAI,
  orgId: string | null,
  endpoint: string,
  params: Parameters<OpenAI['audio']['speech']['create']>[0],
) {
  if (orgId) await assertWithinQuota(orgId);
  const result = await openai.audio.speech.create(params);
  if (orgId && params && typeof params === 'object' && 'input' in params) {
    const chars = String(params.input ?? '').length;
    const approxTokens = Math.ceil(chars / 4);
    recordUsage(orgId, endpoint, 'tts-1', {
      prompt_tokens: approxTokens,
      completion_tokens: 0,
      total_tokens: approxTokens,
    });
  }
  return result;
}
