/**
 * Fetch allowlisted sources and distill into pending Sally knowledge chunks.
 */
import { createLLMClientForOrg } from '../llm-connection';
import { getHomeOrgId } from '../home-org';
import { debugLog } from '../debug-session-log';
import {
  DEFAULT_SALLY_SOURCES,
  insertPendingChunks,
  listSallySources,
  markSourceFetched,
  type SallyChunkCategory,
  upsertSallySource,
  updateIngestJob,
} from './store';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

async function fetchUrlText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Sync2Dine-SallyKB/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ct = res.headers.get('content-type') || '';
  const body = await res.text();
  if (ct.includes('html') || body.trim().startsWith('<')) return stripHtml(body);
  return body.slice(0, 12000);
}

type Distilled = {
  category: SallyChunkCategory;
  title: string;
  body: string;
  evidence_note?: string;
};

async function distillSource(opts: {
  title: string;
  url?: string;
  text: string;
}): Promise<Distilled[]> {
  const orgId = getHomeOrgId();
  const { client, provider } = await createLLMClientForOrg(orgId, 'sally_kb_distill');
  const model = provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini';
  const system = [
    'You extract Sync2Dine SALES intelligence for Sally (sales AI).',
    'Do NOT memorise website copy. Distil concise evidence-based talking points.',
    'Identify: core value proposition, target customers, differentiators, measurable benefits, recurring themes.',
    'Never invent prices, patents, or stats not in the source text.',
    'Return JSON only: { "chunks": [ { "category": "elevator|usp|faq|objection|success|pain|profile|competitor|other", "title": "...", "body": "1-2 sentences", "evidence_note": "optional" } ] }',
    'Max 8 chunks. Prefer outcomes over features.',
  ].join('\n');
  const user = `Source: ${opts.title}\nURL: ${opts.url || 'paste'}\n\nTEXT:\n${opts.text.slice(0, 10000)}`;
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed: { chunks?: Distilled[] } = {};
  try {
    parsed = JSON.parse(raw) as { chunks?: Distilled[] };
  } catch {
    return [];
  }
  const allowed = new Set([
    'elevator', 'usp', 'faq', 'objection', 'success', 'pain', 'profile', 'competitor', 'other',
  ]);
  return (parsed.chunks || [])
    .filter((c) => c && c.body && allowed.has(String(c.category)))
    .slice(0, 8)
    .map((c) => ({
      category: c.category as SallyChunkCategory,
      title: String(c.title || c.category).slice(0, 120),
      body: String(c.body).slice(0, 500),
      evidence_note: c.evidence_note ? String(c.evidence_note).slice(0, 200) : undefined,
    }));
}

export async function ensureDefaultSallySources(): Promise<number> {
  const existing = await listSallySources();
  const urls = new Set(
    existing.filter((s) => s.kind === 'url' && s.url).map((s) => String(s.url)),
  );
  let added = 0;
  for (const d of DEFAULT_SALLY_SOURCES) {
    if (urls.has(d.url)) continue;
    await upsertSallySource(d);
    added += 1;
  }
  return added;
}

/** Run one ingest job: fetch enabled sources ? distill ? pending chunks. */
export async function runSallyKnowledgeIngest(jobId: string): Promise<{
  sources: number;
  chunks: number;
}> {
  await updateIngestJob(jobId, { status: 'running' });
  try {
    await ensureDefaultSallySources();
    const sources = (await listSallySources()).filter((s) => s.enabled !== false);
    let chunkCount = 0;
    for (const src of sources) {
      let text = '';
      const url = src.url ? String(src.url) : undefined;
      if (src.kind === 'paste' && src.raw_text) {
        text = String(src.raw_text);
      } else if (url) {
        text = await fetchUrlText(url);
      }
      if (text.length < 80) continue;
      const distilled = await distillSource({
        title: String(src.title || url || 'source'),
        url,
        text,
      });
      if (!distilled.length) continue;
      await insertPendingChunks(
        distilled.map((d) => ({
          ...d,
          source_id: src.id,
          source_url: url || null,
        })),
      );
      chunkCount += distilled.length;
      if (src.id) await markSourceFetched(String(src.id));
    }
    await updateIngestJob(jobId, { status: 'done' });
    // #region agent log
    debugLog('E', 'sally-product-kb/ingest.ts', 'ingest done', {
      jobId,
      sources: sources.length,
      chunks: chunkCount,
    }, 'full-spec');
    // #endregion
    return { sources: sources.length, chunks: chunkCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    await updateIngestJob(jobId, { status: 'failed', error: msg });
    // #region agent log
    debugLog('E', 'sally-product-kb/ingest.ts', 'ingest failed', { jobId, error: msg }, 'full-spec');
    // #endregion
    throw err;
  }
}
