/**
 * Central LLM factory — OpenAI primary, DeepSeek optional for text chat.
 * Vision / Whisper / Realtime / OpenAI TTS always use the OpenAI key.
 */
import {
  ensureOrgAIBrainLoaded,
  getOrgAIBrain,
  getOrgDeepSeekApiKey,
  getOrgOpenAIApiKey,
  type AIBrainProvider,
} from '../organizations';
import {
  OpenAIConnectionError,
  mapOpenAIError,
  requireOpenAIApiKeyAsync,
  resolveOpenAIApiKeyAsync,
  sanitizeBodyApiKey,
} from './openai-connection';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const OPENAI_CHAT_MODELS = ['gpt-4o', 'gpt-4o-mini'] as const;
export const DEEPSEEK_CHAT_MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const;

export type { AIBrainProvider };

export function resolveBrainProvider(
  bodyProvider?: string,
  orgId?: string | null,
): AIBrainProvider {
  if (bodyProvider === 'deepseek' || bodyProvider === 'openai') return bodyProvider;
  if (orgId) {
    const brain = getOrgAIBrain(orgId);
    if (brain.provider === 'deepseek' || brain.provider === 'openai') return brain.provider;
  }
  return 'openai';
}

export function resolveDeepSeekApiKey(bodyApiKey?: string, orgId?: string | null): string | undefined {
  if (orgId) {
    const orgKey = getOrgDeepSeekApiKey(orgId);
    if (orgKey) return orgKey;
  }
  const key = (sanitizeBodyApiKey(bodyApiKey) || process.env.DEEPSEEK_API_KEY || '').trim();
  return key || undefined;
}

export async function resolveDeepSeekApiKeyAsync(
  bodyApiKey?: string,
  orgId?: string | null,
): Promise<string | undefined> {
  if (orgId) await ensureOrgAIBrainLoaded(orgId);
  return resolveDeepSeekApiKey(bodyApiKey, orgId);
}

export function defaultChatModelForProvider(provider: AIBrainProvider, preferred?: string): string {
  if (provider === 'deepseek') {
    if (preferred && (DEEPSEEK_CHAT_MODELS as readonly string[]).includes(preferred)) return preferred;
    return 'deepseek-chat';
  }
  if (preferred && (OPENAI_CHAT_MODELS as readonly string[]).includes(preferred)) return preferred;
  // Map DeepSeek model ids back if provider is OpenAI
  if (preferred?.startsWith('deepseek')) return 'gpt-4o-mini';
  return preferred || 'gpt-4o-mini';
}

/** Text/orchestrator client — honours active brain provider. */
export async function createLLMClientForOrg(
  orgId: string | null,
  endpoint: string,
  options?: {
    bodyOpenAIApiKey?: string;
    bodyDeepSeekApiKey?: string;
    provider?: string;
  },
) {
  const { default: OpenAI } = await import('openai');
  const { wrapOpenAIWithMetering } = await import('./metered-openai');
  if (orgId) await ensureOrgAIBrainLoaded(orgId);

  const provider = resolveBrainProvider(options?.provider, orgId);

  if (provider === 'deepseek') {
    const apiKey = await resolveDeepSeekApiKeyAsync(options?.bodyDeepSeekApiKey, orgId);
    if (!apiKey) {
      throw new OpenAIConnectionError(
        'DeepSeek API key not configured — add it in Settings → Integrations → Company AI Brain, or switch provider to OpenAI.',
        'missing',
      );
    }
    const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
    return { client: wrapOpenAIWithMetering(client, orgId, endpoint), provider, apiKey };
  }

  const apiKey = await requireOpenAIApiKeyAsync(options?.bodyOpenAIApiKey, orgId);
  const client = new OpenAI({ apiKey });
  return { client: wrapOpenAIWithMetering(client, orgId, endpoint), provider: 'openai' as const, apiKey };
}

/** Vision / Whisper / TTS OpenAI-only client. */
export async function createOpenAISpecialistClientForOrg(
  orgId: string | null,
  endpoint: string,
  bodyApiKey?: string,
) {
  const { default: OpenAI } = await import('openai');
  const { wrapOpenAIWithMetering } = await import('./metered-openai');
  const apiKey = await requireOpenAIApiKeyAsync(bodyApiKey, orgId);
  const client = new OpenAI({ apiKey });
  return wrapOpenAIWithMetering(client, orgId, endpoint);
}

export async function probeLLMConnection(
  provider: AIBrainProvider,
  apiKey: string,
): Promise<void> {
  const { default: OpenAI } = await import('openai');
  const openai = provider === 'deepseek'
    ? new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL })
    : new OpenAI({ apiKey });
  await openai.models.list();
}

export {
  OpenAIConnectionError,
  mapOpenAIError,
  resolveOpenAIApiKeyAsync,
  requireOpenAIApiKeyAsync,
  getOrgOpenAIApiKey,
};
