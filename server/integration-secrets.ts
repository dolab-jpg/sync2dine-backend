import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const SECRETS_FILE = join(DATA_DIR, 'integration-secrets.json');

export interface EmailOAuthSecrets {
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
  yahooClientId?: string;
  yahooClientSecret?: string;
  updatedAt?: string;
}

type SecretsStore = Record<string, Record<string, string>>;

function loadStore(): SecretsStore {
  try {
    if (!existsSync(SECRETS_FILE)) return {};
    return JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) as SecretsStore;
  } catch {
    return {};
  }
}

function saveStore(store: SecretsStore): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function isMaskedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  if (!v) return true;
  if (v.includes('•') || v.includes('*')) return true;
  if (/^x{4,}$/i.test(v) || /^your[-_]/i.test(v)) return true;
  return false;
}

/** Persist secrets to VPS JSON — never overwrite real values with UI masks. */
export function saveIntegrationSecrets(integrationId: string, values: Record<string, string>): void {
  const store = loadStore();
  const prev = store[integrationId] ?? {};
  const next: Record<string, string> = { ...prev };
  for (const [k, v] of Object.entries(values)) {
    if (isMaskedSecret(v)) continue;
    next[k] = String(v);
  }
  next.updatedAt = new Date().toISOString();
  store[integrationId] = next;
  saveStore(store);
}

export function getIntegrationSecrets(integrationId: string): Record<string, string> {
  return loadStore()[integrationId] ?? {};
}

export function getEmailOAuthSecrets(): EmailOAuthSecrets {
  const v = getIntegrationSecrets('email_oauth');
  return {
    googleClientId: v.googleClientId,
    googleClientSecret: v.googleClientSecret,
    microsoftClientId: v.microsoftClientId,
    microsoftClientSecret: v.microsoftClientSecret,
    microsoftTenantId: v.microsoftTenantId,
    yahooClientId: v.yahooClientId,
    yahooClientSecret: v.yahooClientSecret,
    updatedAt: v.updatedAt,
  };
}
