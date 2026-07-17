import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { resolveOrdersOrgId } from '../supabase-orders';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const EVENTS_FILE = join(DATA_DIR, 'connector-events.json');
const IDEM_FILE = join(DATA_DIR, 'connector-idempotency.json');

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

export interface ConnectorEvent {
  id: string;
  orgId: string;
  provider: string;
  direction: 'inbound' | 'outbound';
  eventType: string;
  idempotencyKey?: string;
  externalId?: string;
  status: 'ok' | 'error' | 'duplicate';
  payload: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

function loadEvents(): ConnectorEvent[] {
  try {
    if (!existsSync(EVENTS_FILE)) return [];
    return JSON.parse(readFileSync(EVENTS_FILE, 'utf8')) as ConnectorEvent[];
  } catch {
    return [];
  }
}

function saveEvents(events: ConnectorEvent[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(0, 500), null, 2), 'utf8');
}

function loadIdem(): Record<string, string> {
  try {
    if (!existsSync(IDEM_FILE)) return {};
    return JSON.parse(readFileSync(IDEM_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveIdem(store: Record<string, string>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(IDEM_FILE, JSON.stringify(store, null, 2), 'utf8');
}

export async function logConnectorEvent(event: Omit<ConnectorEvent, 'id' | 'createdAt'>): Promise<ConnectorEvent> {
  const row: ConnectorEvent = {
    ...event,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const client = getAdmin();
  if (client) {
    await client.from('connector_events').insert({
      id: row.id,
      org_id: row.orgId,
      provider: row.provider,
      direction: row.direction,
      event_type: row.eventType,
      idempotency_key: row.idempotencyKey ?? null,
      external_id: row.externalId ?? null,
      status: row.status,
      payload: row.payload,
      error: row.error ?? '',
      created_at: row.createdAt,
    });
  }
  const events = loadEvents();
  events.unshift(row);
  saveEvents(events);
  return row;
}

export async function listConnectorEvents(
  orgIdHint?: string | null,
  limit = 50,
): Promise<ConnectorEvent[]> {
  const orgId = resolveOrdersOrgId(orgIdHint);
  const client = getAdmin();
  if (client && orgId) {
    const { data } = await client
      .from('connector_events')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (data) {
      return (data as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        orgId: String(r.org_id),
        provider: String(r.provider),
        direction: r.direction as ConnectorEvent['direction'],
        eventType: String(r.event_type),
        idempotencyKey: r.idempotency_key != null ? String(r.idempotency_key) : undefined,
        externalId: r.external_id != null ? String(r.external_id) : undefined,
        status: r.status as ConnectorEvent['status'],
        payload: (r.payload ?? {}) as Record<string, unknown>,
        error: r.error != null ? String(r.error) : undefined,
        createdAt: String(r.created_at),
      }));
    }
  }
  const events = loadEvents();
  return orgId ? events.filter((e) => e.orgId === orgId).slice(0, limit) : events.slice(0, limit);
}

export async function checkIdempotency(
  orgId: string,
  provider: string,
  key: string,
): Promise<{ duplicate: boolean; orderId?: string }> {
  if (!key?.trim()) return { duplicate: false };
  const composite = `${orgId}:${provider}:${key.trim()}`;
  const client = getAdmin();
  if (client) {
    const { data } = await client
      .from('connector_events')
      .select('payload')
      .eq('org_id', orgId)
      .eq('provider', provider)
      .eq('idempotency_key', key.trim())
      .eq('status', 'ok')
      .maybeSingle();
    if (data) {
      const payload = (data as { payload?: Record<string, unknown> }).payload ?? {};
      return { duplicate: true, orderId: payload.orderId != null ? String(payload.orderId) : undefined };
    }
  }
  const disk = loadIdem();
  if (disk[composite]) return { duplicate: true, orderId: disk[composite] };
  return { duplicate: false };
}

export async function recordIdempotency(
  orgId: string,
  provider: string,
  key: string,
  orderId: string,
): Promise<void> {
  if (!key?.trim()) return;
  const disk = loadIdem();
  disk[`${orgId}:${provider}:${key.trim()}`] = orderId;
  saveIdem(disk);
}
