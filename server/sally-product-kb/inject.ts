/**
 * Sally-only product knowledge inject (Supabase sally_knowledge_chunks).
 * Never reads Studio / Judie knowledgeChunks.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveOrgUuid } from '../supabase-admin';
import { debugLog } from '../debug-session-log';

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

/** Sync helper for prompt build — returns capped approved talking points. */
export async function buildSallyKnowledgePromptBlock(maxChars = 1200): Promise<string> {
  const sb = getAdmin();
  if (!sb) {
    // #region agent log
    debugLog('E', 'sally-product-kb/inject.ts', 'no supabase admin', {}, 'plan-gap-fix');
    // #endregion
    return '';
  }
  try {
    const orgId = await resolveOrgUuid(undefined);
    const { data, error } = await sb
      .from('sally_knowledge_chunks')
      .select('category,title,body,source_url')
      .eq('org_id', orgId)
      .eq('status', 'approved')
      .eq('active', true)
      .order('updated_at', { ascending: false })
      .limit(24);
    if (error) {
      // #region agent log
      debugLog('E', 'sally-product-kb/inject.ts', 'query error', { error: error.message }, 'plan-gap-fix');
      // #endregion
      return '';
    }
    const lines: string[] = [];
    let total = 0;
    for (const row of data || []) {
      const bit = `- [${row.category}] ${row.title ? `${row.title}: ` : ''}${String(row.body || '').trim()}`.slice(0, 280);
      if (!bit || bit.length < 8) continue;
      if (total + bit.length + 1 > maxChars) break;
      lines.push(bit);
      total += bit.length + 1;
    }
    const block = lines.length
      ? `SALLY PRODUCT KNOWLEDGE (approved — weave naturally, do not recite; prices still only via getOfferTerms):\n${lines.join('\n')}`
      : '';
    // #region agent log
    debugLog('E', 'sally-product-kb/inject.ts', 'inject block', {
      orgId,
      rows: data?.length ?? 0,
      bodyLen: block.length,
    }, 'plan-gap-fix');
    // #endregion
    return block;
  } catch (err) {
    // #region agent log
    debugLog('E', 'sally-product-kb/inject.ts', 'inject failed', {
      error: err instanceof Error ? err.message : String(err),
    }, 'plan-gap-fix');
    // #endregion
    return '';
  }
}

/** Sync wrapper used from buildSallyBrainPrompt (caches per process briefly). */
let cache: { at: number; body: string } | null = null;
const CACHE_MS = 60_000;

export function getSallyKnowledgePromptBlockCached(): string {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    // #region agent log
    debugLog('A', 'sally-product-kb/inject.ts:cached', 'cache hit', {
      bodyLen: cache.body.length,
      ageMs: now - cache.at,
    }, 'live-debug');
    // #endregion
    return cache.body;
  }
  // Kick async refresh; return previous or empty
  void buildSallyKnowledgePromptBlock().then((body) => {
    cache = { at: Date.now(), body };
  });
  const out = cache?.body || '';
  // #region agent log
  debugLog('A', 'sally-product-kb/inject.ts:cached', 'cache miss/stale', {
    bodyLen: out.length,
    hadCache: Boolean(cache),
  }, 'live-debug');
  // #endregion
  return out;
}

export async function warmSallyKnowledgeCache(): Promise<void> {
  const body = await buildSallyKnowledgePromptBlock();
  cache = { at: Date.now(), body };
  // #region agent log
  debugLog('A', 'sally-product-kb/inject.ts:warm', 'cache warmed', {
    bodyLen: body.length,
  }, 'live-debug');
  // #endregion
}
