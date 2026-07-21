/**
 * Dual-write Sales Brain JSON ? Supabase (cloud source of truth).
 * JSON remains a fast local cache. Failures never block the phone path.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveOrgUuid } from '../supabase-admin';
import type {
  SalesBrainJob,
  SalesBrainRecommendation,
  SalesCallInsight,
  SalesPlaybookSnippet,
  StoreShape,
} from './store';

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

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function orgUuid(orgId: string): Promise<string> {
  try {
    return await resolveOrgUuid(orgId);
  } catch {
    return orgId;
  }
}

async function upsertJob(job: SalesBrainJob): Promise<void> {
  const sb = getAdmin();
  if (!sb) return;
  const org_id = await orgUuid(job.orgId);
  const row: Record<string, unknown> = {
    org_id,
    call_id: job.callId,
    status: job.status,
    attempts: job.attempts,
    error: job.error ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
  if (isUuid(job.id)) row.id = job.id;
  const { error } = await sb.from('sales_brain_jobs').upsert(row, {
    onConflict: 'org_id,call_id',
  });
  if (error) console.warn('[sales-brain] job upsert:', error.message);
}

async function upsertInsight(insight: SalesCallInsight): Promise<void> {
  const sb = getAdmin();
  if (!sb) return;
  const org_id = await orgUuid(insight.orgId);
  const row: Record<string, unknown> = {
    org_id,
    call_id: insight.callId,
    agent_persona: insight.agentPersona ?? null,
    aim: insight.aim ?? null,
    duration_sec: insight.durationSec ?? null,
    reached_dm: insight.reachedDm ?? null,
    rapport_score: insight.rapportScore ?? null,
    discovery_score: insight.discoveryScore ?? null,
    value_score: insight.valueScore ?? null,
    close_score: insight.closeScore ?? null,
    outcome: insight.outcome ?? null,
    objections: insight.objections ?? [],
    competitors: insight.competitors ?? [],
    what_worked: insight.whatWorked ?? null,
    what_failed: insight.whatFailed ?? null,
    next_step: insight.nextStep ?? null,
    upsell_potential: insight.upsellPotential ?? null,
    cross_sell_potential: insight.crossSellPotential ?? null,
    raw_json: insight,
    created_at: insight.createdAt,
  };
  if (isUuid(insight.id)) row.id = insight.id;
  const { error } = await sb.from('sales_call_insights').upsert(row, {
    onConflict: 'org_id,call_id',
  });
  if (error) console.warn('[sales-brain] insight upsert:', error.message);
}

async function upsertRecommendation(rec: SalesBrainRecommendation): Promise<void> {
  const sb = getAdmin();
  if (!sb) return;
  const org_id = await orgUuid(rec.orgId);
  const row: Record<string, unknown> = {
    org_id,
    type: rec.type,
    proposed_text: rec.proposedText,
    evidence_summary: rec.evidenceSummary ?? null,
    sample_size: rec.sampleSize,
    status: rec.status,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
  if (isUuid(rec.id)) {
    row.id = rec.id;
    const { error } = await sb.from('sales_brain_recommendations').upsert(row, { onConflict: 'id' });
    if (error) console.warn('[sales-brain] rec upsert:', error.message);
    return;
  }
  // Non-uuid local ids: insert once per org+type+status pending, else update latest
  const { data: existing } = await sb
    .from('sales_brain_recommendations')
    .select('id')
    .eq('org_id', org_id)
    .eq('type', rec.type)
    .eq('status', rec.status)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    const { error } = await sb
      .from('sales_brain_recommendations')
      .update({
        proposed_text: rec.proposedText,
        evidence_summary: rec.evidenceSummary ?? null,
        sample_size: rec.sampleSize,
        updated_at: rec.updatedAt,
      })
      .eq('id', existing.id);
    if (error) console.warn('[sales-brain] rec update:', error.message);
  } else {
    const { error } = await sb.from('sales_brain_recommendations').insert(row);
    if (error) console.warn('[sales-brain] rec insert:', error.message);
  }
}

async function upsertSnippet(snip: SalesPlaybookSnippet): Promise<void> {
  const sb = getAdmin();
  if (!sb) return;
  const org_id = await orgUuid(snip.orgId);
  const row: Record<string, unknown> = {
    org_id,
    slot: snip.slot,
    body: snip.body,
    active: snip.active,
    variant_id: snip.variantId ?? null,
    created_at: snip.createdAt,
    updated_at: snip.updatedAt,
  };
  if (isUuid(snip.id)) {
    row.id = snip.id;
    const { error } = await sb.from('sales_playbook_snippets').upsert(row, { onConflict: 'id' });
    if (error) console.warn('[sales-brain] snippet upsert:', error.message);
    return;
  }
  const { error } = await sb.from('sales_playbook_snippets').insert(row);
  if (error) console.warn('[sales-brain] snippet insert:', error.message);
}

/** Fire-and-forget full store sync to Supabase. */
export function dualWriteSalesBrainStore(store: StoreShape): void {
  if (!getAdmin()) return;
  void (async () => {
    try {
      for (const job of store.jobs.slice(-100)) await upsertJob(job);
      for (const insight of store.insights.slice(-100)) await upsertInsight(insight);
      for (const rec of store.recommendations.slice(-80)) await upsertRecommendation(rec);
      for (const snip of store.snippets.slice(-80)) await upsertSnippet(snip);
    } catch (err) {
      console.warn(
        '[sales-brain] dual-write failed:',
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** Pull cloud insights/snippets into empty or thin local cache (startup). */
export async function hydrateSalesBrainFromSupabase(
  local: StoreShape,
): Promise<StoreShape> {
  const sb = getAdmin();
  if (!sb) return local;
  try {
    const { data: insights } = await sb
      .from('sales_call_insights')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    const { data: snippets } = await sb
      .from('sales_playbook_snippets')
      .select('*')
      .eq('active', true)
      .limit(100);
    const { data: recs } = await sb
      .from('sales_brain_recommendations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (insights?.length && local.insights.length < insights.length) {
      const mapped: SalesCallInsight[] = insights.map((r) => ({
        id: String(r.id),
        orgId: String(r.org_id),
        callId: String(r.call_id),
        agentPersona: r.agent_persona ?? undefined,
        aim: r.aim ?? null,
        durationSec: r.duration_sec ?? undefined,
        reachedDm: r.reached_dm ?? undefined,
        rapportScore: r.rapport_score ?? undefined,
        discoveryScore: r.discovery_score ?? undefined,
        valueScore: r.value_score ?? undefined,
        closeScore: r.close_score ?? undefined,
        outcome: r.outcome ?? undefined,
        objections: Array.isArray(r.objections) ? r.objections : [],
        competitors: Array.isArray(r.competitors) ? r.competitors : [],
        whatWorked: r.what_worked ?? undefined,
        whatFailed: r.what_failed ?? undefined,
        nextStep: r.next_step ?? undefined,
        upsellPotential: r.upsell_potential ?? undefined,
        crossSellPotential: r.cross_sell_potential ?? undefined,
        createdAt: r.created_at ?? new Date().toISOString(),
      }));
      // Prefer cloud when richer
      const byCall = new Map(local.insights.map((i) => [`${i.orgId}:${i.callId}`, i]));
      for (const m of mapped) byCall.set(`${m.orgId}:${m.callId}`, m);
      local.insights = Array.from(byCall.values());
    }

    if (snippets?.length) {
      const cloudSnips: SalesPlaybookSnippet[] = snippets.map((r) => ({
        id: String(r.id),
        orgId: String(r.org_id),
        slot: String(r.slot || 'general'),
        body: String(r.body || ''),
        active: Boolean(r.active),
        variantId: r.variant_id ?? undefined,
        createdAt: r.created_at ?? new Date().toISOString(),
        updatedAt: r.updated_at ?? new Date().toISOString(),
      }));
      const byId = new Map(local.snippets.map((s) => [s.id, s]));
      for (const s of cloudSnips) byId.set(s.id, s);
      local.snippets = Array.from(byId.values());
    }

    if (recs?.length && local.recommendations.length < recs.length) {
      local.recommendations = recs.map((r) => ({
        id: String(r.id),
        orgId: String(r.org_id),
        type: String(r.type),
        proposedText: String(r.proposed_text),
        evidenceSummary: r.evidence_summary ?? undefined,
        sampleSize: Number(r.sample_size || 0),
        status: (r.status as SalesBrainRecommendation['status']) || 'pending',
        createdAt: r.created_at ?? new Date().toISOString(),
        updatedAt: r.updated_at ?? new Date().toISOString(),
      }));
    }
  } catch (err) {
    console.warn(
      '[sales-brain] hydrate failed:',
      err instanceof Error ? err.message : err,
    );
  }
  return local;
}
