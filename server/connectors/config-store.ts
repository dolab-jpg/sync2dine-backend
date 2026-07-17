import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { defaultStatusMap } from './status-map';
import type { ConnectorConfig, ConnectorProvider } from './types';
import { resolveOrdersOrgId } from '../supabase-orders';

function squareConnectionStatus(config: ConnectorConfig): 'not_connected' | 'connected' | 'token_expired' {
  if (!config.oauthAccessToken?.trim()) return 'not_connected';
  const expiresAt = config.oauthExpiresAt ? Date.parse(config.oauthExpiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt < Date.now() && !config.oauthRefreshToken?.trim()) {
    return 'token_expired';
  }
  return 'connected';
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DISK_FILE = join(DATA_DIR, 'connector-configs.json');

let admin: SupabaseClient | null | undefined;

function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    admin = null;
    return null;
  }
  admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return admin;
}

function loadDisk(): Record<string, ConnectorConfig> {
  try {
    if (!existsSync(DISK_FILE)) return {};
    return JSON.parse(readFileSync(DISK_FILE, 'utf8')) as Record<string, ConnectorConfig>;
  } catch {
    return {};
  }
}

function saveDisk(store: Record<string, ConnectorConfig>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DISK_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function maskToken(secret: string): string {
  if (!secret) return '';
  return secret.length > 4 ? `${'*'.repeat(Math.min(12, secret.length - 4))}${secret.slice(-4)}` : '****';
}

function rowToConfig(orgId: string, row: Record<string, unknown>): ConnectorConfig {
  return {
    orgId,
    provider: (String(row.provider ?? 'mock')) as ConnectorProvider,
    enabled: row.enabled === true,
    direction: (String(row.direction ?? 'inbound')) as ConnectorConfig['direction'],
    outboundUrl: String(row.outbound_url ?? row.outboundUrl ?? ''),
    webhookSecret: String(row.webhook_secret ?? row.webhookSecret ?? ''),
    statusMap: (row.status_map && typeof row.status_map === 'object')
      ? row.status_map as Record<string, string>
      : defaultStatusMap(),
    deliverectAccountId: String(row.deliverect_account_id ?? row.deliverectAccountId ?? '') || undefined,
    deliverectLocationId: String(row.deliverect_location_id ?? row.deliverectLocationId ?? '') || undefined,
    squareLocationId: String(row.square_location_id ?? row.squareLocationId ?? '') || undefined,
    squareMerchantId: String(row.square_merchant_id ?? row.squareMerchantId ?? '') || undefined,
    oauthAccessToken: String(row.oauth_access_token ?? row.oauthAccessToken ?? '') || undefined,
    oauthRefreshToken: String(row.oauth_refresh_token ?? row.oauthRefreshToken ?? '') || undefined,
    oauthExpiresAt: row.oauth_expires_at != null || row.oauthExpiresAt != null
      ? String(row.oauth_expires_at ?? row.oauthExpiresAt)
      : undefined,
    defaultPickupName: String(row.default_pickup_name ?? row.defaultPickupName ?? '') || undefined,
    defaultPickupPhone: String(row.default_pickup_phone ?? row.defaultPickupPhone ?? '') || undefined,
    fulfillmentAddressLine1: String(row.fulfillment_address_line1 ?? row.fulfillmentAddressLine1 ?? '') || undefined,
    fulfillmentAddressCity: String(row.fulfillment_address_city ?? row.fulfillmentAddressCity ?? '') || undefined,
    fulfillmentAddressPostcode: String(row.fulfillment_address_postcode ?? row.fulfillmentAddressPostcode ?? '') || undefined,
    fulfillmentAddressCountry: String(row.fulfillment_address_country ?? row.fulfillmentAddressCountry ?? 'GB') || 'GB',
    lastTestPushAt: row.last_test_push_at != null || row.lastTestPushAt != null
      ? String(row.last_test_push_at ?? row.lastTestPushAt)
      : undefined,
    lastTestPushOk: row.last_test_push_ok === true || row.lastTestPushOk === true
      ? true
      : row.last_test_push_ok === false || row.lastTestPushOk === false
        ? false
        : undefined,
    lastMenuSyncAt: row.last_menu_sync_at != null ? String(row.last_menu_sync_at) : undefined,
    menuVersion: row.menu_version != null ? String(row.menu_version) : undefined,
    lastInboundAt: row.last_inbound_at != null ? String(row.last_inbound_at) : undefined,
    lastOutboundAt: row.last_outbound_at != null ? String(row.last_outbound_at) : undefined,
    lastError: row.last_error != null ? String(row.last_error) : undefined,
    updatedAt: row.updated_at != null ? String(row.updated_at) : undefined,
  };
}

export async function getConnectorConfig(orgIdHint?: string | null): Promise<ConnectorConfig | null> {
  const orgId = resolveOrdersOrgId(orgIdHint);
  if (!orgId) return null;
  const client = getAdmin();
  if (client) {
    const { data } = await client.from('connector_configs').select('*').eq('org_id', orgId).maybeSingle();
    if (data) return rowToConfig(orgId, data as Record<string, unknown>);
  }
  return loadDisk()[orgId] ?? null;
}

export async function saveConnectorConfig(
  orgIdHint: string | null | undefined,
  patch: Partial<ConnectorConfig>,
): Promise<ConnectorConfig> {
  const orgId = resolveOrdersOrgId(orgIdHint ?? patch.orgId);
  if (!orgId) throw new Error('no org id');
  const existing = (await getConnectorConfig(orgId)) ?? {
    orgId,
    provider: 'mock' as ConnectorProvider,
    enabled: false,
    direction: 'inbound',
    outboundUrl: '',
    webhookSecret: '',
    statusMap: defaultStatusMap(),
  };
  const merged: ConnectorConfig = {
    ...existing,
    ...patch,
    orgId,
    statusMap: { ...existing.statusMap, ...(patch.statusMap ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  // Allow explicit clear of tokens via empty string in patch
  if (patch.oauthAccessToken === '') {
    merged.oauthAccessToken = '';
    merged.oauthRefreshToken = '';
    merged.oauthExpiresAt = undefined;
  } else if (patch.oauthRefreshToken === '') {
    merged.oauthRefreshToken = '';
  }

  const client = getAdmin();
  if (client) {
    await client.from('connector_configs').upsert({
      org_id: orgId,
      provider: merged.provider,
      enabled: merged.enabled,
      direction: merged.direction,
      outbound_url: merged.outboundUrl,
      webhook_secret: merged.webhookSecret,
      status_map: merged.statusMap,
      deliverect_account_id: merged.deliverectAccountId ?? '',
      deliverect_location_id: merged.deliverectLocationId ?? '',
      square_location_id: merged.squareLocationId ?? '',
      square_merchant_id: merged.squareMerchantId ?? '',
      oauth_access_token: merged.oauthAccessToken ?? '',
      oauth_refresh_token: merged.oauthRefreshToken ?? '',
      oauth_expires_at: merged.oauthExpiresAt ?? null,
      default_pickup_name: merged.defaultPickupName ?? '',
      default_pickup_phone: merged.defaultPickupPhone ?? '',
      fulfillment_address_line1: merged.fulfillmentAddressLine1 ?? '',
      fulfillment_address_city: merged.fulfillmentAddressCity ?? '',
      fulfillment_address_postcode: merged.fulfillmentAddressPostcode ?? '',
      fulfillment_address_country: merged.fulfillmentAddressCountry ?? 'GB',
      last_test_push_at: merged.lastTestPushAt ?? null,
      last_test_push_ok: merged.lastTestPushOk ?? null,
      last_menu_sync_at: merged.lastMenuSyncAt ?? null,
      menu_version: merged.menuVersion ?? '',
      last_inbound_at: merged.lastInboundAt ?? null,
      last_outbound_at: merged.lastOutboundAt ?? null,
      last_error: merged.lastError ?? '',
      updated_at: merged.updatedAt,
    });
  }
  const disk = loadDisk();
  disk[orgId] = merged;
  saveDisk(disk);
  return merged;
}

/** Masked config for API responses (never expose full secrets / tokens). */
export function maskConnectorConfig(config: ConnectorConfig): Record<string, unknown> {
  const secret = config.webhookSecret ?? '';
  const masked = secret.length > 4 ? `${'*'.repeat(secret.length - 4)}${secret.slice(-4)}` : secret ? '****' : '';
  const token = config.oauthAccessToken ?? '';
  const connectionStatus = config.provider === 'square'
    ? squareConnectionStatus(config)
    : token
      ? 'connected'
      : 'not_connected';
  return {
    orgId: config.orgId,
    provider: config.provider,
    enabled: config.enabled,
    direction: config.direction,
    outboundUrl: config.outboundUrl,
    webhookSecretMasked: masked,
    hasWebhookSecret: Boolean(secret),
    hasSecret: Boolean(secret),
    secretMasked: masked,
    statusMap: config.statusMap,
    deliverectAccountId: config.deliverectAccountId ?? '',
    deliverectLocationId: config.deliverectLocationId ?? '',
    squareLocationId: config.squareLocationId ?? '',
    squareMerchantId: config.squareMerchantId
      ? maskToken(config.squareMerchantId)
      : '',
    squareMerchantIdRawMasked: config.squareMerchantId
      ? maskToken(config.squareMerchantId)
      : '',
    hasSquareToken: Boolean(token),
    squareTokenMasked: token ? maskToken(token) : '',
    squareConnectionStatus: connectionStatus,
    oauthExpiresAt: config.oauthExpiresAt,
    defaultPickupName: config.defaultPickupName ?? '',
    defaultPickupPhone: config.defaultPickupPhone ?? '',
    fulfillmentAddressLine1: config.fulfillmentAddressLine1 ?? '',
    fulfillmentAddressCity: config.fulfillmentAddressCity ?? '',
    fulfillmentAddressPostcode: config.fulfillmentAddressPostcode ?? '',
    fulfillmentAddressCountry: config.fulfillmentAddressCountry ?? 'GB',
    lastTestPushAt: config.lastTestPushAt,
    lastTestPushOk: config.lastTestPushOk,
    lastMenuSyncAt: config.lastMenuSyncAt,
    menuVersion: config.menuVersion,
    lastInboundAt: config.lastInboundAt,
    lastOutboundAt: config.lastOutboundAt,
    lastError: config.lastError,
    updatedAt: config.updatedAt,
  };
}

export function resolveConnectorSecret(
  config: ConnectorConfig | null,
  provider: string,
): string {
  if (config?.webhookSecret?.trim()) return config.webhookSecret.trim();
  const envKey = `CONNECTOR_${provider.toUpperCase()}_SECRET`;
  return process.env[envKey]?.trim() || process.env.CONNECTOR_WEBHOOK_SECRET?.trim() || '';
}
