import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { signPayload } from './hmac';
import type { ConnectorWebhookEvent } from './types';
import { getConnectorConfig } from './config-store';
import { logConnectorEvent } from './event-log';

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

async function postSigned(url: string, secret: string, event: ConnectorWebhookEvent): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(event);
  const signature = signPayload(secret, body);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-S2D-Signature': signature,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 300) || res.statusText };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

export async function enqueueOutboundWebhook(
  orgId: string,
  event: ConnectorWebhookEvent,
): Promise<{ queued: boolean; delivered?: boolean; error?: string }> {
  const config = await getConnectorConfig(orgId);
  if (!config?.enabled || !config.outboundUrl?.trim()) {
    return { queued: false, error: 'connector_not_configured' };
  }
  const secret = config.webhookSecret?.trim();
  if (!secret) return { queued: false, error: 'webhook_secret_missing' };

  const result = await postSigned(config.outboundUrl, secret, event);
  if (result.ok) {
    await logConnectorEvent({
      orgId,
      provider: config.provider,
      direction: 'outbound',
      eventType: event.event,
      status: 'ok',
      payload: event.data,
    });
    return { queued: true, delivered: true };
  }

  const client = getAdmin();
  const nextAttempt = new Date(Date.now() + 60_000).toISOString();
  const body = JSON.stringify(event);
  if (client) {
    await client.from('connector_outbound_queue').insert({
      org_id: orgId,
      provider: config.provider,
      target_url: config.outboundUrl,
      event_type: event.event,
      body: event,
      signature: signPayload(secret, body),
      attempts: 1,
      next_attempt_at: nextAttempt,
      last_error: result.error ?? 'delivery failed',
    });
  }

  await logConnectorEvent({
    orgId,
    provider: config.provider,
    direction: 'outbound',
    eventType: event.event,
    status: 'error',
    payload: event.data,
    error: result.error,
  });

  return { queued: true, delivered: false, error: result.error };
}

export async function processOutboundQueue(limit = 10): Promise<number> {
  const client = getAdmin();
  if (!client) return 0;
  const now = new Date().toISOString();
  const { data } = await client
    .from('connector_outbound_queue')
    .select('*')
    .is('delivered_at', null)
    .lte('next_attempt_at', now)
    .order('created_at', { ascending: true })
    .limit(limit);
  let delivered = 0;
  for (const row of (data as Array<Record<string, unknown>> | null) ?? []) {
    const url = String(row.target_url);
    const signature = String(row.signature);
    const body = JSON.stringify(row.body);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-S2D-Signature': signature },
        body,
      });
      if (res.ok) {
        await client.from('connector_outbound_queue').update({
          delivered_at: new Date().toISOString(),
          last_error: '',
        }).eq('id', row.id);
        delivered += 1;
      } else {
        const attempts = Number(row.attempts ?? 0) + 1;
        const max = Number(row.max_attempts ?? 5);
        await client.from('connector_outbound_queue').update({
          attempts,
          next_attempt_at: new Date(Date.now() + attempts * 60_000).toISOString(),
          last_error: `HTTP ${res.status}`,
          ...(attempts >= max ? { delivered_at: new Date().toISOString() } : {}),
        }).eq('id', row.id);
      }
    } catch (err) {
      const attempts = Number(row.attempts ?? 0) + 1;
      await client.from('connector_outbound_queue').update({
        attempts,
        next_attempt_at: new Date(Date.now() + attempts * 60_000).toISOString(),
        last_error: err instanceof Error ? err.message : 'fetch failed',
      }).eq('id', row.id);
    }
  }
  return delivered;
}

export async function emitOrderUpdatedWebhook(
  orgId: string,
  order: Record<string, unknown>,
): Promise<void> {
  const config = await getConnectorConfig(orgId);
  if (!config?.enabled) return;
  const event: ConnectorWebhookEvent = {
    event: 'order.updated',
    orgId,
    timestamp: new Date().toISOString(),
    data: {
      orderId: order.id,
      externalId: order.externalId,
      status: order.status,
      sourceStatus: order.sourceStatus,
      orderType: order.orderType,
      total: order.total,
      customerAllergies: order.customerAllergies,
    },
  };
  await enqueueOutboundWebhook(orgId, event);
}
