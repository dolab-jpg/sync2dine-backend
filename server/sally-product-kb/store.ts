/**
 * Supabase CRUD for Sally product knowledge (not Studio / Judie).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveOrgUuid } from '../supabase-admin';
import { getHomeOrgId } from '../home-org';

let admin: SupabaseClient | null | undefined;

function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.SUPABASE_URL?.trim();
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

export type SallyChunkCategory =
  | 'elevator' | 'usp' | 'faq' | 'objection' | 'success'
  | 'pain' | 'profile' | 'competitor' | 'other';

export type SallyChunkStatus = 'pending' | 'approved' | 'rejected';

export async function resolveSallyOrgId(): Promise<string> {
  try {
    return await resolveOrgUuid(getHomeOrgId());
  } catch {
    return getHomeOrgId();
  }
}

export async function listSallySources() {
  const sb = getAdmin();
  if (!sb) return [];
  const orgId = await resolveSallyOrgId();
  const { data } = await sb
    .from('sally_knowledge_sources')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  return data || [];
}

export async function upsertSallySource(row: {
  id?: string;
  kind: 'url' | 'paste';
  url?: string;
  title?: string;
  raw_text?: string;
  enabled?: boolean;
}) {
  const sb = getAdmin();
  if (!sb) throw new Error('supabase_not_configured');
  const orgId = await resolveSallyOrgId();
  const payload = {
    org_id: orgId,
    kind: row.kind,
    url: row.url || null,
    title: row.title || null,
    raw_text: row.raw_text || null,
    enabled: row.enabled !== false,
    updated_at: new Date().toISOString(),
  };
  if (row.id) {
    const { data, error } = await sb
      .from('sally_knowledge_sources')
      .update(payload)
      .eq('id', row.id)
      .eq('org_id', orgId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }
  const { data, error } = await sb
    .from('sally_knowledge_sources')
    .insert(payload)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function listSallyChunks(opts?: { status?: SallyChunkStatus }) {
  const sb = getAdmin();
  if (!sb) return [];
  const orgId = await resolveSallyOrgId();
  let q = sb
    .from('sally_knowledge_chunks')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (opts?.status) q = q.eq('status', opts.status);
  const { data } = await q;
  return data || [];
}

export async function decideSallyChunk(id: string, decision: 'approve' | 'reject') {
  const sb = getAdmin();
  if (!sb) throw new Error('supabase_not_configured');
  const orgId = await resolveSallyOrgId();
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const { data, error } = await sb
    .from('sally_knowledge_chunks')
    .update({
      status,
      active: decision === 'approve',
      approved_at: decision === 'approve' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('org_id', orgId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function insertPendingChunks(
  chunks: Array<{
    category: SallyChunkCategory;
    title: string;
    body: string;
    source_id?: string | null;
    source_url?: string | null;
    evidence_note?: string | null;
  }>,
) {
  const sb = getAdmin();
  if (!sb) throw new Error('supabase_not_configured');
  const orgId = await resolveSallyOrgId();
  const rows = chunks.map((c) => ({
    org_id: orgId,
    category: c.category,
    title: c.title,
    body: c.body,
    source_id: c.source_id || null,
    source_url: c.source_url || null,
    evidence_note: c.evidence_note || null,
    status: 'pending' as const,
    active: false,
  }));
  if (!rows.length) return [];
  const { data, error } = await sb.from('sally_knowledge_chunks').insert(rows).select('*');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createIngestJob(): Promise<string> {
  const sb = getAdmin();
  if (!sb) throw new Error('supabase_not_configured');
  const orgId = await resolveSallyOrgId();
  const { data, error } = await sb
    .from('sally_knowledge_ingest_jobs')
    .insert({ org_id: orgId, status: 'queued' })
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return String(data!.id);
}

export async function updateIngestJob(
  id: string,
  patch: { status: string; error?: string | null },
) {
  const sb = getAdmin();
  if (!sb) return;
  await sb
    .from('sally_knowledge_ingest_jobs')
    .update({
      status: patch.status,
      error: patch.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

export async function listIngestJobs(limit = 20) {
  const sb = getAdmin();
  if (!sb) return [];
  const orgId = await resolveSallyOrgId();
  const { data } = await sb
    .from('sally_knowledge_ingest_jobs')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

export async function markSourceFetched(id: string) {
  const sb = getAdmin();
  if (!sb) return;
  await sb
    .from('sally_knowledge_sources')
    .update({ last_fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
}

export function isSallyKbConfigured(): boolean {
  return Boolean(getAdmin());
}

/** Default allowlisted Sync2Dine marketing URLs. */
export const DEFAULT_SALLY_SOURCES: Array<{ kind: 'url'; url: string; title: string }> = [
  { kind: 'url', url: 'https://sync2dine.io/', title: 'Sync2Dine home' },
  { kind: 'url', url: 'https://sync2dine.io/pricing/', title: 'Pricing (marketing)' },
  { kind: 'url', url: 'https://app.sync2dine.io/pricing', title: 'Pricing (app)' },
  { kind: 'url', url: 'https://app.sync2dine.io/judie', title: 'Judie product' },
  { kind: 'url', url: 'https://app.sync2dine.io/atmosphere', title: 'Atmosphere product' },
];
