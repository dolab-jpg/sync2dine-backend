/**
 * Resolve the Vapi assistant `model` block � DeepSeek as main brain when org/env has it.
 */
import { DEFAULT_ORG_ID } from './data-store';
import { getHomeOrgId } from './home-org';
import {
  DEEPSEEK_BASE_URL,
  defaultChatModelForProvider,
  resolveBrainProvider,
  resolveDeepSeekApiKeyAsync,
} from './llm-connection';
import { ensureOrgAIBrainLoaded } from './organizations';
import { vapiFetch } from './vapi-client';

export type VapiModelBlock = {
  provider: string;
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
  tools: Array<Record<string, unknown>>;
  url?: string;
  /** Present when using a Vapi-stored BYOK credential */
  knowledgeBaseId?: string;
};

let cachedDeepSeekCredentialId: string | null | undefined;

async function ensureDeepSeekCredential(apiKey: string): Promise<string | undefined> {
  const fromEnv = process.env.VAPI_DEEPSEEK_CREDENTIAL_ID?.trim();
  if (fromEnv) return fromEnv;
  if (cachedDeepSeekCredentialId) return cachedDeepSeekCredentialId;

  try {
    const listed = await vapiFetch('/credential', { method: 'GET' });
    if (listed.ok) {
      const rows = Array.isArray(listed.json)
        ? listed.json
        : Array.isArray((listed.json as { data?: unknown }).data)
          ? ((listed.json as { data: unknown[] }).data)
          : [];
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const provider = String(r.provider || '').toLowerCase();
        if (provider === 'deep-seek' || provider === 'deepseek') {
          const id = String(r.id || '').trim();
          if (id) {
            cachedDeepSeekCredentialId = id;
            return id;
          }
        }
      }
    }

    const created = await vapiFetch('/credential', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'deep-seek',
        apiKey,
      }),
    });
    if (created.ok) {
      const id = String(created.json.id || '').trim();
      if (id) {
        cachedDeepSeekCredentialId = id;
        return id;
      }
    } else {
      console.warn(
        '[vapi-llm] deep-seek credential create failed',
        created.status,
        created.raw?.slice?.(0, 200),
      );
    }
  } catch (err) {
    console.warn('[vapi-llm] deep-seek credential error:', err instanceof Error ? err.message : err);
  }
  return undefined;
}

/**
 * Build the Vapi `model` object for an assistant.
 * Prefer DeepSeek when org AI brain provider is deepseek (or DEEPSEEK_API_KEY / VAPI_LLM_PROVIDER=deepseek).
 */
export async function buildVapiModelBlock(opts: {
  orgId?: string | null;
  instructions: string;
  tools: Array<Record<string, unknown>>;
  temperature?: number;
}): Promise<Record<string, unknown>> {
  const orgId = opts.orgId || getHomeOrgId() || DEFAULT_ORG_ID;
  try {
    await ensureOrgAIBrainLoaded(orgId);
  } catch {
    /* local/dev without cloud org is fine */
  }

  const envForce = String(process.env.VAPI_LLM_PROVIDER || '').trim().toLowerCase();
  const provider =
    envForce === 'deepseek' || envForce === 'deep-seek'
      ? 'deepseek'
      : envForce === 'openai'
        ? 'openai'
        : resolveBrainProvider(undefined, orgId);

  const preferredModel = process.env.VAPI_LLM_MODEL?.trim();
  const temperature = opts.temperature ?? 0.7;
  const base = {
    temperature,
    messages: [{ role: 'system', content: opts.instructions }],
    tools: opts.tools,
  };

  if (provider === 'deepseek') {
    const apiKey = await resolveDeepSeekApiKeyAsync(undefined, orgId);
    const model = defaultChatModelForProvider('deepseek', preferredModel);
    if (apiKey) {
      await ensureDeepSeekCredential(apiKey);
      // Native Vapi DeepSeek BYOK (credential on org) � also set url fallback via custom-llm if needed.
      return {
        provider: 'deep-seek',
        model,
        ...base,
      };
    }
    // No key: try custom-llm with env URL only if somehow credential already exists
    console.warn('[vapi-llm] DeepSeek selected but no API key � falling back to OpenAI for this call');
  }

  const openaiModelRaw = preferredModel && !preferredModel.startsWith('deepseek')
    ? preferredModel
    : defaultChatModelForProvider('openai', preferredModel);
  // Vapi no longer accepts gpt-4o* for assistant.model — use a currently allowed OpenAI model.
  const openaiModel = /^gpt-4o($|-)/.test(openaiModelRaw) || openaiModelRaw.startsWith('deepseek')
    ? 'gpt-4.1'
    : openaiModelRaw;

  return {
    provider: 'openai',
    model: openaiModel,
    ...base,
  };
}

/** Optional: custom-llm shape pointing at DeepSeek OpenAI-compatible API (unused unless native fails). */
export function buildDeepSeekCustomLlmModel(opts: {
  model: string;
  instructions: string;
  tools: Array<Record<string, unknown>>;
  temperature?: number;
}): Record<string, unknown> {
  return {
    provider: 'custom-llm',
    url: `${DEEPSEEK_BASE_URL}/v1`,
    model: opts.model,
    temperature: opts.temperature ?? 0.7,
    messages: [{ role: 'system', content: opts.instructions }],
    tools: opts.tools,
  };
}
