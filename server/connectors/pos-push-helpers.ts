/**
 * Enqueue POS push retries (Square) into connector_outbound_queue.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

export async function enqueuePosPushRetry(
  orgId: string,
  provider: string,
  orderId: string,
  lastError: string,
): Promise<void> {
  if (!orderId) return;
  const client = getAdmin();
  if (!client) return;
  const nextAttempt = new Date(Date.now() + 60_000).toISOString();
  await client.from('connector_outbound_queue').insert({
    org_id: orgId,
    provider,
    target_url: `pos://${provider}/push`,
    event_type: 'pos.push',
    body: { orderId, orgId, provider },
    signature: 'pos-push',
    attempts: 1,
    next_attempt_at: nextAttempt,
    last_error: lastError.slice(0, 500),
  });
}

export function isPosPushQueueRow(row: Record<string, unknown>): boolean {
  const url = String(row.target_url ?? '');
  const eventType = String(row.event_type ?? '');
  return url.startsWith('pos://') || eventType === 'pos.push';
}
