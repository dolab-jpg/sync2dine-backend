import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../shared/database.types.js';

type DatabaseWithRelationships = {
  public: Omit<Database['public'], 'Tables'> & {
    Tables: {
      [Name in keyof Database['public']['Tables']]:
        Database['public']['Tables'][Name] & { Relationships: [] };
    };
  };
};

let adminClient: SupabaseClient<DatabaseWithRelationships> | null = null;

export function getSupabaseAdmin(): SupabaseClient<DatabaseWithRelationships> {
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  adminClient = createClient<DatabaseWithRelationships>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

export function getSupabaseAnon(): SupabaseClient<DatabaseWithRelationships> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }
  return createClient<DatabaseWithRelationships>(url, key);
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
