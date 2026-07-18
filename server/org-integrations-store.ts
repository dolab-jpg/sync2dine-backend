import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decryptSecret, encryptSecret } from './crypto';
import {
  isMaskedOrPlaceholder,
  isSecretFieldKey,
  maskSecretHint,
} from './integration-secret-fields';

export type IntegrationStatus = 'not_configured' | 'mock' | 'connected' | 'error';

export interface OrgIntegrationRow {
  integrationId: string;
  enabled: boolean;
  mockMode: boolean;
  status: IntegrationStatus;
  /** Decrypted plaintext values (server-only). */
  values: Record<string, string>;
  updatedAt: string;
}

export interface OrgIntegrationPublic {
  integrationId: string;
  enabled: boolean;
  mockMode: boolean;
  status: IntegrationStatus;
  /** Non-secret field values only. */
  values: Record<string, string>;
  /** Secret fields that have a stored value (masked hint). */
  configuredFields: Record<string, string>;
  hasSecrets: boolean;
  updatedAt?: string;
  source?: 'supabase' | 'memory' | 'none';
}

/** In-memory fallback when Supabase service role is unavailable. */
const memoryStore = new Map<string, Map<string, OrgIntegrationRow>>();

function memoryKey(orgId: string): Map<string, OrgIntegrationRow> {
  let m = memoryStore.get(orgId);
  if (!m) {
    m = new Map();
    memoryStore.set(orgId, m);
  }
  return m;
}

function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function encryptValuesMap(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v == null || v === '') continue;
    if (isSecretFieldKey(k)) {
      // Already encrypted blob
      if (String(v).startsWith('v1:')) {
        out[k] = String(v);
      } else {
        out[k] = encryptSecret(String(v));
      }
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function decryptValuesMap(stored: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, raw] of Object.entries(stored)) {
    if (raw == null) continue;
    const v = String(raw);
    if (!v) continue;
    if (isSecretFieldKey(k) && v.startsWith('v1:')) {
      try {
        out[k] = decryptSecret(v);
      } catch {
        out[k] = '';
      }
    } else if (isSecretFieldKey(k) && !v.startsWith('v1:')) {
      // Legacy plaintext in DB — treat as plaintext until next save encrypts it
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toPublic(row: OrgIntegrationRow, source: OrgIntegrationPublic['source']): OrgIntegrationPublic {
  const values: Record<string, string> = {};
  const configuredFields: Record<string, string> = {};
  let hasSecrets = false;
  for (const [k, v] of Object.entries(row.values)) {
    if (!v?.trim()) continue;
    if (isSecretFieldKey(k)) {
      hasSecrets = true;
      configuredFields[k] = maskSecretHint(v);
    } else {
      values[k] = v;
    }
  }
  return {
    integrationId: row.integrationId,
    enabled: row.enabled,
    mockMode: row.mockMode,
    status: row.status,
    values,
    configuredFields,
    hasSecrets,
    updatedAt: row.updatedAt,
    source,
  };
}

function parseDbRow(row: {
  integration_id: string;
  enabled?: boolean | null;
  mock_mode?: boolean | null;
  status?: string | null;
  values_encrypted?: Record<string, unknown> | null;
  values?: Record<string, unknown> | null;
  updated_at?: string | null;
}): OrgIntegrationRow {
  const stored = (row.values_encrypted ?? row.values ?? {}) as Record<string, unknown>;
  const statusRaw = row.status || 'not_configured';
  const status: IntegrationStatus =
    statusRaw === 'connected' || statusRaw === 'error' || statusRaw === 'mock' || statusRaw === 'not_configured'
      ? statusRaw
      : 'not_configured';
  return {
    integrationId: row.integration_id,
    enabled: row.enabled ?? false,
    mockMode: row.mock_mode ?? false,
    status,
    values: decryptValuesMap(stored),
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

export async function listOrgIntegrations(orgId: string): Promise<OrgIntegrationPublic[]> {
  const supabase = getServiceClient();
  if (supabase) {
    const { data, error } = await supabase
      .from('integrations')
      .select('integration_id, enabled, mock_mode, status, values_encrypted, values, updated_at')
      .eq('org_id', orgId);
    if (!error && data) {
      return data.map((row) => toPublic(parseDbRow(row as Parameters<typeof parseDbRow>[0]), 'supabase'));
    }
    if (error) {
      // values column may not exist — retry without it
      const retry = await supabase
        .from('integrations')
        .select('integration_id, enabled, mock_mode, status, values_encrypted, updated_at')
        .eq('org_id', orgId);
      if (!retry.error && retry.data) {
        return retry.data.map((row) => toPublic(parseDbRow(row as Parameters<typeof parseDbRow>[0]), 'supabase'));
      }
      console.warn('[org-integrations] list failed:', error.message, retry.error?.message);
    }
  }

  const mem = memoryKey(orgId);
  return [...mem.values()].map((r) => toPublic(r, 'memory'));
}

export async function getOrgIntegrationDecrypted(
  orgId: string,
  integrationId: string,
): Promise<OrgIntegrationRow | null> {
  const supabase = getServiceClient();
  if (supabase) {
    const { data, error } = await supabase
      .from('integrations')
      .select('integration_id, enabled, mock_mode, status, values_encrypted, values, updated_at')
      .eq('org_id', orgId)
      .eq('integration_id', integrationId)
      .maybeSingle();
    if (!error && data) return parseDbRow(data as Parameters<typeof parseDbRow>[0]);
    if (error) {
      const retry = await supabase
        .from('integrations')
        .select('integration_id, enabled, mock_mode, status, values_encrypted, updated_at')
        .eq('org_id', orgId)
        .eq('integration_id', integrationId)
        .maybeSingle();
      if (!retry.error && retry.data) return parseDbRow(retry.data as Parameters<typeof parseDbRow>[0]);
    }
  }
  return memoryKey(orgId).get(integrationId) ?? null;
}

export async function upsertOrgIntegration(
  orgId: string,
  integrationId: string,
  input: {
    enabled?: boolean;
    mockMode?: boolean;
    status?: IntegrationStatus;
    values?: Record<string, string>;
  },
): Promise<{ public: OrgIntegrationPublic; syncedToCloud: boolean; warning?: string }> {
  const existing = await getOrgIntegrationDecrypted(orgId, integrationId);
  const mergedValues: Record<string, string> = { ...(existing?.values ?? {}) };

  if (input.values) {
    for (const [k, raw] of Object.entries(input.values)) {
      const v = raw == null ? '' : String(raw);
      if (isSecretFieldKey(k)) {
        // Skip placeholders so we do not wipe stored secrets
        if (isMaskedOrPlaceholder(v)) continue;
        mergedValues[k] = v.trim();
      } else {
        mergedValues[k] = v;
      }
    }
  }

  const enabled = input.enabled ?? existing?.enabled ?? false;
  const mockMode = input.mockMode ?? existing?.mockMode ?? false;
  let status: IntegrationStatus = input.status ?? existing?.status ?? 'not_configured';
  const hasAnySecret = Object.entries(mergedValues).some(
    ([k, v]) => isSecretFieldKey(k) && Boolean(v?.trim()),
  );
  const hasAnyValue = Object.values(mergedValues).some((v) => Boolean(v?.trim()));
  if (!input.status) {
    if (hasAnySecret || (integrationId === 'company' && hasAnyValue)) {
      status = enabled && !mockMode ? 'connected' : status === 'not_configured' ? 'connected' : status;
    } else if (!hasAnyValue) {
      status = 'not_configured';
    }
  }

  const updatedAt = new Date().toISOString();
  const row: OrgIntegrationRow = {
    integrationId,
    enabled,
    mockMode,
    status,
    values: mergedValues,
    updatedAt,
  };

  memoryKey(orgId).set(integrationId, row);

  const encrypted = encryptValuesMap(mergedValues);
  const supabase = getServiceClient();
  if (!supabase) {
    return {
      public: toPublic(row, 'memory'),
      syncedToCloud: false,
      warning: 'Saved in server memory only (missing SUPABASE_SERVICE_ROLE_KEY).',
    };
  }

  const payload = {
    org_id: orgId,
    integration_id: integrationId,
    enabled,
    mock_mode: mockMode,
    status,
    values_encrypted: encrypted,
    updated_at: updatedAt,
  };

  const { error } = await supabase.from('integrations').upsert(payload, {
    onConflict: 'org_id,integration_id',
  });

  if (error) {
    console.warn('[org-integrations] upsert failed:', error.message);
    return {
      public: toPublic(row, 'memory'),
      syncedToCloud: false,
      warning: `Saved in memory, cloud sync failed: ${error.message}`,
    };
  }

  return { public: toPublic(row, 'supabase'), syncedToCloud: true };
}

export async function updateOrgIntegrationStatus(
  orgId: string,
  integrationId: string,
  status: IntegrationStatus,
): Promise<void> {
  const existing = await getOrgIntegrationDecrypted(orgId, integrationId);
  await upsertOrgIntegration(orgId, integrationId, {
    enabled: existing?.enabled ?? status === 'connected',
    mockMode: existing?.mockMode ?? false,
    status,
    values: existing?.values,
  });
}
