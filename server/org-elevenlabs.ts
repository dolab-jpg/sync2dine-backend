/**
 * Hybrid ElevenLabs API keys per org (override → platform env).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { decryptSecret, encryptSecret } from './crypto';
import { maskOpenAIApiKeyHint } from './organizations';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = join(DATA_DIR, 'org-elevenlabs.json');

interface OrgElevenLabsRow {
  orgId: string;
  apiKeyEncrypted: string;
  voiceId?: string;
  monthlyCharCap?: number;
  updatedAt: string;
}

let memory: Record<string, OrgElevenLabsRow> = {};
const keyCache = new Map<string, string>();

function load() {
  if (Object.keys(memory).length) return;
  try {
    if (existsSync(FILE)) {
      memory = JSON.parse(readFileSync(FILE, 'utf-8')) as Record<string, OrgElevenLabsRow>;
    }
  } catch {
    memory = {};
  }
}

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  try {
    writeFileSync(FILE, JSON.stringify(memory, null, 2));
  } catch {
    /* ignore */
  }
}

export function getOrgElevenLabsApiKey(orgId: string): string | undefined {
  const cached = keyCache.get(orgId);
  if (cached) return cached;
  load();
  const row = memory[orgId];
  if (!row?.apiKeyEncrypted) return undefined;
  const key = decryptSecret(row.apiKeyEncrypted).trim();
  if (key) keyCache.set(orgId, key);
  return key || undefined;
}

/** Resolve: org override → platform env */
export function resolveElevenLabsApiKey(orgId?: string | null): string | undefined {
  if (orgId) {
    const orgKey = getOrgElevenLabsApiKey(orgId);
    if (orgKey) return orgKey;
  }
  return process.env.ELEVENLABS_API_KEY?.trim() || undefined;
}

export function setOrgElevenLabsApiKey(
  orgId: string,
  apiKey: string,
  opts?: { voiceId?: string; monthlyCharCap?: number },
): { configured: boolean; maskedHint?: string; voiceId?: string; monthlyCharCap?: number } {
  load();
  const trimmed = apiKey.trim();
  if (trimmed) {
    memory[orgId] = {
      orgId,
      apiKeyEncrypted: encryptSecret(trimmed),
      voiceId: opts?.voiceId ?? memory[orgId]?.voiceId,
      monthlyCharCap: opts?.monthlyCharCap ?? memory[orgId]?.monthlyCharCap,
      updatedAt: new Date().toISOString(),
    };
    keyCache.set(orgId, trimmed);
  } else if (memory[orgId]) {
    memory[orgId] = {
      ...memory[orgId],
      voiceId: opts?.voiceId ?? memory[orgId].voiceId,
      monthlyCharCap: opts?.monthlyCharCap ?? memory[orgId].monthlyCharCap,
      updatedAt: new Date().toISOString(),
    };
  } else if (opts) {
    memory[orgId] = {
      orgId,
      apiKeyEncrypted: '',
      voiceId: opts.voiceId,
      monthlyCharCap: opts.monthlyCharCap,
      updatedAt: new Date().toISOString(),
    };
  }
  persist();
  return getOrgElevenLabsStatus(orgId);
}

export function getOrgElevenLabsStatus(orgId: string): {
  configured: boolean;
  maskedHint?: string;
  source: 'org' | 'platform' | 'none';
  voiceId?: string;
  monthlyCharCap?: number;
} {
  load();
  const orgKey = getOrgElevenLabsApiKey(orgId);
  if (orgKey) {
    return {
      configured: true,
      maskedHint: maskOpenAIApiKeyHint(orgKey),
      source: 'org',
      voiceId: memory[orgId]?.voiceId,
      monthlyCharCap: memory[orgId]?.monthlyCharCap,
    };
  }
  const platform = process.env.ELEVENLABS_API_KEY?.trim();
  if (platform) {
    return {
      configured: true,
      maskedHint: maskOpenAIApiKeyHint(platform),
      source: 'platform',
      voiceId: memory[orgId]?.voiceId || process.env.ELEVENLABS_VOICE_ID?.trim(),
      monthlyCharCap: memory[orgId]?.monthlyCharCap,
    };
  }
  return { configured: false, source: 'none', monthlyCharCap: memory[orgId]?.monthlyCharCap };
}
