import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrganizationById } from './organizations';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const USAGE_FILE = join(DATA_DIR, 'usage-events.json');

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

let memoryEvents: UsageEvent[] = [];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk(): UsageEvent[] {
  try {
    if (existsSync(USAGE_FILE)) {
      const parsed = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
      return Array.isArray(parsed) ? parsed as UsageEvent[] : [];
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
  };
  memoryEvents = [event, ...allEvents()];
  persist();
  return event;
}

export function getTokensUsedThisMonth(orgId: string): number {
  const monthStart = startOfMonth();
  return allEvents()
    .filter(e => e.orgId === orgId && new Date(e.createdAt).getTime() >= monthStart)
    .reduce((sum, e) => sum + e.totalTokens, 0);
}

export function getUsageSummaryForOrg(orgId: string) {
  const monthStart = startOfMonth();
  const events = allEvents().filter(
    e => e.orgId === orgId && new Date(e.createdAt).getTime() >= monthStart,
  );
  return {
    tokensUsed: events.reduce((s, e) => s + e.totalTokens, 0),
    costUsd: events.reduce((s, e) => s + e.costUsd, 0),
    requestCount: events.length,
    byEndpoint: events.reduce<Record<string, number>>((acc, e) => {
      acc[e.endpoint] = (acc[e.endpoint] ?? 0) + e.totalTokens;
      return acc;
    }, {}),
  };
}

export function getGlobalUsageThisMonth(): number {
  const monthStart = startOfMonth();
  return allEvents()
    .filter(e => new Date(e.createdAt).getTime() >= monthStart)
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
