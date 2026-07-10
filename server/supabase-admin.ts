import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../shared/database.types.js';

let adminClient: SupabaseClient<Database> | null = null;

export function getSupabaseAdmin(): SupabaseClient<Database> {
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  adminClient = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

export function getSupabaseAnon(): SupabaseClient<Database> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }
  return createClient<Database>(url, key);
}

export const DEFAULT_ORG_UUID = '00000000-0000-0000-0000-000000000001';

export async function resolveOrgUuid(orgId?: string | null): Promise<string> {
  if (!orgId || orgId === 'default') return DEFAULT_ORG_UUID;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('organizations')
    .select('id')
    .or(`id.eq.${orgId},legacy_id.eq.${orgId}`)
    .maybeSingle();
  return data?.id ?? DEFAULT_ORG_UUID;
}
