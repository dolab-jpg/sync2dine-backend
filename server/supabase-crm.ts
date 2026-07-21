/**
 * Mirror CRM records into Supabase (service role) so UI / phones / WhatsApp share one store.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getHomeOrgId, isOrgUuid, sanitizeOrgId } from './home-org';

let admin: SupabaseClient | null | undefined;

function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    admin = null;
    return null;
  }
  admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return admin;
}

export function resolveCrmOrgId(orgId?: string | null): string | null {
  const sanitized = sanitizeOrgId(orgId);
  if (sanitized) return sanitized;
  const home = getHomeOrgId();
  return isOrgUuid(home) ? home : null;
}

/** Upsert one CRM customer into public.customers (JSONB `data` column). */
export async function mirrorCustomerToSupabase(
  customer: Record<string, unknown>,
  orgIdHint?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const client = getAdmin();
  if (!client) {
    return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  }
  const orgId = resolveCrmOrgId(orgIdHint);
  if (!orgId) {
    return { ok: false, error: 'no org id for customer mirror' };
  }
  const id = String(customer.id ?? '').trim();
  if (!id) {
    return { ok: false, error: 'customer id required' };
  }
  const { id: _drop, ...rest } = customer;
  const { error } = await client.from('customers').upsert(
    {
      id,
      org_id: orgId,
      data: rest,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id,id' },
  );
  if (error) {
    console.warn('[supabase-crm] customer mirror failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Fire-and-forget mirror — never throws into callers. */
export function mirrorCustomerToSupabaseAsync(
  customer: Record<string, unknown>,
  orgIdHint?: string | null,
): void {
  void mirrorCustomerToSupabase(customer, orgIdHint).then((r) => {
    if (!r.ok) {
      console.warn('[supabase-crm] async mirror skipped/failed:', r.error);
    }
  });
}

function normalizePhoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('44')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

/**
 * Find a CRM customer by phone for inbound Judie (UI often writes specials only to Supabase).
 */
export async function findCustomerByPhoneFromSupabase(
  phone: string,
  orgIdHint?: string | null,
): Promise<Record<string, unknown> | null> {
  const client = getAdmin();
  if (!client) return null;
  const orgId = resolveCrmOrgId(orgIdHint);
  if (!orgId) return null;
  const normalized = normalizePhoneDigits(phone);
  if (!normalized) return null;

  const { data, error } = await client
    .from('customers')
    .select('id, data')
    .eq('org_id', orgId)
    .limit(500);
  if (error || !data?.length) return null;

  for (const row of data) {
    const payload = (row.data && typeof row.data === 'object')
      ? (row.data as Record<string, unknown>)
      : {};
    const rowPhone = normalizePhoneDigits(String(payload.phone ?? ''));
    if (rowPhone && rowPhone === normalized) {
      return { ...payload, id: String(row.id) };
    }
  }
  return null;
}
