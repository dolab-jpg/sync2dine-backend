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

export function saveIntegrationSecrets(integrationId: string, values: Record<string, string>): void {
  const store = loadStore();
  store[integrationId] = { ...store[integrationId], ...values, updatedAt: new Date().toISOString() };
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
