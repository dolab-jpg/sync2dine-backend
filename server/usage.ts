import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrganizationById } from './organizations';
import { getHomeOrgId } from './home-org';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const USAGE_FILE = join(DATA_DIR, 'usage-events.json');

/** Map legacy `default` to configured home org UUID so metering matches Settings/CRM. */
export function normalizeUsageOrgId(orgId: string | null | undefined): string {
  const raw = (orgId || '').trim();
  if (!raw || raw === 'default') return getHomeOrgId() || 'default';
  return raw;
}

export type UsageProvider =
  | 'openai'
  | 'deepseek'
  | 'elevenlabs'
  | 'phone'
  | 'soho66'
  | string;

export type UsageUnit = 'tokens' | 'characters' | 'seconds' | 'messages' | string;

export interface UsageEvent {
  id: string;
  orgId: string;
  userId?: string;
  endpoint: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: string;
  provider?: UsageProvider;
  unit?: UsageUnit;
  quantity?: number;
  metadata?: Record<string, unknown>;
}

/** USD per 1M tokens (approximate OpenAI pricing) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'tts-1': { input: 15, output: 0 },
  'whisper-1': { input: 0.006, output: 0 },
};

/** Approx ElevenLabs turbo USD per 1k characters */
const ELEVENLABS_USD_PER_1K_CHARS = 0.18;

let memoryEvents: UsageEvent[] = [];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk(): UsageEvent[] {
  try {
    if (existsSync(USAGE_FILE)) {
      const parsed = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as UsageEvent[]) : [];
    }
  } catch {
    // ignore
  }
  return [];
}

function persist() {
  ensureDir();
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(memoryEvents, null, 2));
  } catch {
    // ignore
  }
}

function allEvents(): UsageEvent[] {
  if (memoryEvents.length === 0) memoryEvents = loadFromDisk();
  return memoryEvents;
}

function startOfMonth(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['gpt-4o-mini'];
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

function estimateElevenLabsCostUsd(characters: number): number {
  return Math.round((characters / 1000) * ELEVENLABS_USD_PER_1K_CHARS * 1_000_000) / 1_000_000;
}

async function persistUsageToSupabase(event: UsageEvent): Promise<void> {
  try {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) return;
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await supabase.from('usage_events').insert({
      org_id: event.orgId,
      user_id: event.userId || null,
      model: event.model,
      prompt_tokens: event.promptTokens,
      completion_tokens: event.completionTokens,
      total_tokens: event.totalTokens,
      route: event.endpoint,
      provider: event.provider ?? 'openai',
      unit: event.unit ?? 'tokens',
      quantity: event.quantity ?? event.totalTokens,
      cost_usd: event.costUsd,
      metadata: event.metadata ?? {},
      created_at: event.createdAt,
    });
  } catch {
    // Supabase optional — local JSON is source of truth fallback
  }
}

export function recordUsage(
  orgId: string,
  endpoint: string,
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
  userId?: string,
): UsageEvent {
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const event: UsageEvent = {
    id: `use_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    orgId,
    userId,
    endpoint,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: estimateCostUsd(model, promptTokens, completionTokens),
    createdAt: new Date().toISOString(),
    provider: 'openai',
    unit: 'tokens',
    quantity: totalTokens,
  };
  memoryEvents = [event, ...allEvents()];
  persist();
  void persistUsageToSupabase(event);
  return event;
}

export function recordProviderUsage(input: {
  orgId: string;
  provider: UsageProvider;
  unit: UsageUnit;
  quantity: number;
  endpoint: string;
  model?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  costUsd?: number;
}): UsageEvent {
  const quantity = Math.max(0, Number(input.quantity) || 0);
  let costUsd = input.costUsd;
  if (costUsd === undefined) {
    if (input.provider === 'elevenlabs' && input.unit === 'characters') {
      costUsd = estimateElevenLabsCostUsd(quantity);
    } else {
      costUsd = 0;
    }
  }
  const event: UsageEvent = {
    id: `use_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    orgId: normalizeUsageOrgId(input.orgId),
    userId: input.userId,
    endpoint: input.endpoint,
    model: input.model ?? input.provider,
    promptTokens: input.unit === 'tokens' ? quantity : 0,
    completionTokens: 0,
    totalTokens: input.unit === 'tokens' ? quantity : 0,
    costUsd,
    createdAt: new Date().toISOString(),
    provider: input.provider,
    unit: input.unit,
    quantity,
    metadata: input.metadata,
  };
  memoryEvents = [event, ...allEvents()];
  persist();
  void persistUsageToSupabase(event);
  return event;
}

export function getProviderEventsThisMonth(orgId: string, provider: UsageProvider): UsageEvent[] {
  const monthStart = startOfMonth();
  const oid = normalizeUsageOrgId(orgId);
  return allEvents().filter(
    (e) =>
      e.orgId === oid &&
      (e.provider === provider || (!e.provider && provider === 'openai')) &&
      new Date(e.createdAt).getTime() >= monthStart,
  );
}

export function getProviderQuantityThisMonth(orgId: string, provider: UsageProvider): number {
  return getProviderEventsThisMonth(orgId, provider).reduce(
    (sum, e) => sum + Number(e.quantity ?? e.totalTokens ?? 0),
    0,
  );
}

export function getTokensUsedThisMonth(orgId: string): number {
  const monthStart = startOfMonth();
  const oid = normalizeUsageOrgId(orgId);
  return allEvents()
    .filter(
      (e) =>
        e.orgId === oid &&
        new Date(e.createdAt).getTime() >= monthStart &&
        (!e.provider || e.provider === 'openai' || e.provider === 'deepseek') &&
        (!e.unit || e.unit === 'tokens'),
    )
    .reduce((sum, e) => sum + e.totalTokens, 0);
}

export function getUsageSummaryForOrg(orgId: string) {
  const monthStart = startOfMonth();
  const oid = normalizeUsageOrgId(orgId);
  const events = allEvents().filter(
    (e) => e.orgId === oid && new Date(e.createdAt).getTime() >= monthStart,
  );
  const tokenEvents = events.filter((e) => !e.provider || e.provider === 'openai' || e.provider === 'deepseek');
  const elevenlabsChars = getProviderQuantityThisMonth(orgId, 'elevenlabs');
  const phoneSeconds = getProviderQuantityThisMonth(orgId, 'phone');
  return {
    tokensUsed: tokenEvents.reduce((s, e) => s + e.totalTokens, 0),
    costUsd: events.reduce((s, e) => s + e.costUsd, 0),
    requestCount: events.length,
    byEndpoint: events.reduce<Record<string, number>>((acc, e) => {
      acc[e.endpoint] = (acc[e.endpoint] ?? 0) + Number(e.quantity ?? e.totalTokens ?? 0);
      return acc;
    }, {}),
    elevenlabsCharacters: elevenlabsChars,
    phoneOutboundSeconds: phoneSeconds,
    phoneOutboundMinutes: Math.round((phoneSeconds / 60) * 100) / 100,
    byProvider: {
      openai: getTokensUsedThisMonth(orgId),
      elevenlabs: elevenlabsChars,
      phone: phoneSeconds,
    },
  };
}

export function getGlobalUsageThisMonth(): number {
  const monthStart = startOfMonth();
  return allEvents()
    .filter(
      (e) =>
        new Date(e.createdAt).getTime() >= monthStart &&
        (!e.provider || e.provider === 'openai' || e.provider === 'deepseek'),
    )
    .reduce((sum, e) => sum + e.totalTokens, 0);
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export function assertWithinQuota(orgId: string): void {
  const org = getOrganizationById(orgId);
  if (!org) return;
  if (org.status === 'suspended' || org.status === 'cancelled') {
    throw new QuotaExceededError(`Organization "${org.name}" is ${org.status}. AI access is disabled.`);
  }
  const used = getTokensUsedThisMonth(orgId);
  if (used >= org.monthlyTokenCap) {
    throw new QuotaExceededError(
      `Monthly token cap reached for "${org.name}" (${used.toLocaleString()} / ${org.monthlyTokenCap.toLocaleString()}).`,
    );
  }
}
