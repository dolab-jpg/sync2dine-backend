import { getOrgOpenAIApiKey } from './organizations';

export type OpenAIConnectionReason = 'missing' | 'rejected';

export class OpenAIConnectionError extends Error {
  readonly code: OpenAIConnectionReason;

  constructor(message: string, code: OpenAIConnectionReason) {
    super(message);
    this.name = 'OpenAIConnectionError';
    this.code = code;
  }
}

export function resolveOpenAIApiKey(bodyApiKey?: string, orgId?: string | null): string | undefined {
  if (orgId) {
    const orgKey = getOrgOpenAIApiKey(orgId);
    if (orgKey) return orgKey;
  }
  const key = (bodyApiKey || process.env.OPENAI_API_KEY || '').trim();
  return key || undefined;
}

export function requireOpenAIApiKey(bodyApiKey?: string, orgId?: string | null): string {
  const key = resolveOpenAIApiKey(bodyApiKey, orgId);
  if (!key) {
    if (orgId) {
      throw new OpenAIConnectionError(
        'OpenAI API key not configured for this client — add a key in Platform → Clients.',
        'missing',
      );
    }
    throw new OpenAIConnectionError(
      'OpenAI not connected — add your API key in Settings → Integrations → OpenAI and Save.',
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
  const { default: OpenAI } = await import('openai');
  const { wrapOpenAIWithMetering } = await import('./metered-openai');
  const apiKey = requireOpenAIApiKey(bodyApiKey, orgId);
  const openai = new OpenAI({ apiKey });
  return wrapOpenAIWithMetering(openai, orgId, endpoint);
}
