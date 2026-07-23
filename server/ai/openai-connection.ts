import { ensureOrgOpenAIKeyLoaded, getOrgOpenAIApiKey, listOrganizations } from '../organizations';
import { getHomeOrgId } from '../home-org';

export type OpenAIConnectionReason = 'missing' | 'rejected';

export class OpenAIConnectionError extends Error {
  readonly code: OpenAIConnectionReason;

  constructor(message: string, code: OpenAIConnectionReason) {
    super(message);
    this.name = 'OpenAIConnectionError';
    this.code = code;
  }
}

/**
 * Resolve Company AI Brain OpenAI key: preferred org → home → any org key → env.
 */
export async function resolveCompanyAiBrainOpenAIKey(preferredOrgId?: string | null): Promise<{
  apiKey: string;
  orgId: string | null;
}> {
  const candidates = [
    preferredOrgId?.trim(),
    getHomeOrgId(),
    ...listOrganizations().map((o) => o.id),
  ].filter((id): id is string => Boolean(id && id !== 'default'));

  const seen = new Set<string>();
  for (const orgId of candidates) {
    if (seen.has(orgId)) continue;
    seen.add(orgId);
    await ensureOrgOpenAIKeyLoaded(orgId);
    const key = getOrgOpenAIApiKey(orgId);
    if (key) return { apiKey: key, orgId };
  }

  for (const orgId of [preferredOrgId?.trim(), getHomeOrgId()].filter(Boolean) as string[]) {
    if (seen.has(orgId)) continue;
    await ensureOrgOpenAIKeyLoaded(orgId);
    const key = getOrgOpenAIApiKey(orgId);
    if (key) return { apiKey: key, orgId };
  }

  const envKey = (process.env.OPENAI_API_KEY || '').trim();
  if (envKey) return { apiKey: envKey, orgId: preferredOrgId?.trim() || getHomeOrgId() || null };

  throw new OpenAIConnectionError(
    'OpenAI API key not configured — add a Company AI Brain key in Settings → Integrations.',
    'missing',
  );
}

export function sanitizeBodyApiKey(bodyApiKey?: string): string | undefined {
  const key = (bodyApiKey || '').trim();
  if (!key) return undefined;
  // Client may have stored a masked UI placeholder — never treat it as a real key.
  if (key.startsWith('••••')) return undefined;
  return key;
}

export function resolveOpenAIApiKey(bodyApiKey?: string, orgId?: string | null): string | undefined {
  if (orgId) {
    const orgKey = getOrgOpenAIApiKey(orgId);
    if (orgKey) return orgKey;
  }
  const key = (sanitizeBodyApiKey(bodyApiKey) || process.env.OPENAI_API_KEY || '').trim();
  return key || undefined;
}

export async function resolveOpenAIApiKeyAsync(
  bodyApiKey?: string,
  orgId?: string | null,
): Promise<string | undefined> {
  if (orgId) {
    await ensureOrgOpenAIKeyLoaded(orgId);
  }
  return resolveOpenAIApiKey(bodyApiKey, orgId);
}

export function requireOpenAIApiKey(bodyApiKey?: string, orgId?: string | null): string {
  const key = resolveOpenAIApiKey(bodyApiKey, orgId);
  if (!key) {
    if (orgId) {
      throw new OpenAIConnectionError(
        'OpenAI API key not configured for this company — add a key in Settings → Integrations → Company AI Brain (Super Admin).',
        'missing',
      );
    }
    throw new OpenAIConnectionError(
      'OpenAI not connected — add your API key in Settings → Integrations → Company AI Brain and Save.',
      'missing',
    );
  }
  return key;
}

export async function requireOpenAIApiKeyAsync(
  bodyApiKey?: string,
  orgId?: string | null,
): Promise<string> {
  const key = await resolveOpenAIApiKeyAsync(bodyApiKey, orgId);
  if (!key) {
    if (orgId) {
      throw new OpenAIConnectionError(
        'OpenAI API key not configured for this company — add a key in Settings → Integrations → Company AI Brain (Super Admin).',
        'missing',
      );
    }
    throw new OpenAIConnectionError(
      'OpenAI not connected — add your API key in Settings → Integrations → Company AI Brain and Save.',
      'missing',
    );
  }
  return key;
}

export function mapOpenAIError(err: unknown): OpenAIConnectionError {
  if (err instanceof OpenAIConnectionError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: number }).status)
      : undefined;

  if (status === 401 || /incorrect api key|invalid api key|authentication/i.test(message)) {
    return new OpenAIConnectionError(
      'OpenAI key rejected — check the key is correct and your OpenAI account has billing enabled.',
      'rejected',
    );
  }

  if (status === 429 || /insufficient_quota|billing|exceeded.*quota/i.test(message)) {
    return new OpenAIConnectionError(
      'OpenAI key rejected — your OpenAI account has no credit or has hit its usage limit.',
      'rejected',
    );
  }

  return new OpenAIConnectionError(message || 'OpenAI request failed.', 'rejected');
}

export async function probeOpenAIConnection(apiKey: string): Promise<void> {
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  await openai.models.list();
}

export async function createOpenAIClientForOrg(
  orgId: string | null,
  endpoint: string,
  bodyApiKey?: string,
) {
  // Specialist OpenAI client (vision/TTS/etc). Text brains prefer createLLMClientForOrg.
  const { createOpenAISpecialistClientForOrg } = await import('./llm-connection');
  return createOpenAISpecialistClientForOrg(orgId, endpoint, bodyApiKey);
}
