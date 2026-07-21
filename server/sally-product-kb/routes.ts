import type { IncomingMessage, ServerResponse } from 'http';
import {
  decideSallyChunk,
  isSallyKbConfigured,
  listIngestJobs,
  listSallyChunks,
  listSallySources,
  upsertSallySource,
} from './store';
import { ensureDefaultSallySources } from './ingest';
import { enqueueSallyKnowledgeIngest } from './worker';
import { warmSallyKnowledgeCache } from './inject';
import { debugLog } from '../debug-session-log';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** GET/POST /api/sally-knowledge/* */
export async function handleSallyKnowledgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/sally-knowledge')) return false;

  // #region agent log
  debugLog('C', 'sally-product-kb/routes.ts', 'route hit', {
    method: req.method || '',
    pathname,
    configured: isSallyKbConfigured(),
  }, 'live-debug');
  // #endregion

  if (!isSallyKbConfigured()) {
    sendJson(res, 503, { ok: false, error: 'supabase_not_configured' });
    return true;
  }

  if (pathname === '/api/sally-knowledge/status' && req.method === 'GET') {
    const [sources, chunks, jobs] = await Promise.all([
      listSallySources(),
      listSallyChunks(),
      listIngestJobs(10),
    ]);
    const body = {
      ok: true,
      sources: sources.length,
      chunks: chunks.length,
      pending: chunks.filter((c) => c.status === 'pending').length,
      approved: chunks.filter((c) => c.status === 'approved').length,
      lastJob: jobs[0] || null,
    };
    // #region agent log
    debugLog('C', 'sally-product-kb/routes.ts:status', 'status ok', {
      sources: body.sources,
      chunks: body.chunks,
      pending: body.pending,
      approved: body.approved,
      lastJobStatus: body.lastJob ? String((body.lastJob as { status?: string }).status || '') : null,
    }, 'live-debug');
    // #endregion
    sendJson(res, 200, body);
    return true;
  }

  if (pathname === '/api/sally-knowledge/sources' && req.method === 'GET') {
    await ensureDefaultSallySources();
    sendJson(res, 200, { ok: true, sources: await listSallySources() });
    return true;
  }

  if (pathname === '/api/sally-knowledge/sources' && req.method === 'POST') {
    const body = await readJson(req);
    const kind = body.kind === 'paste' ? 'paste' : 'url';
    const row = await upsertSallySource({
      id: body.id ? String(body.id) : undefined,
      kind,
      url: body.url != null ? String(body.url) : undefined,
      title: body.title != null ? String(body.title) : undefined,
      raw_text: body.raw_text != null ? String(body.raw_text) : undefined,
      enabled: body.enabled !== false,
    });
    sendJson(res, 200, { ok: true, source: row });
    return true;
  }

  if (pathname === '/api/sally-knowledge/chunks' && req.method === 'GET') {
    const status = undefined; // all
    sendJson(res, 200, { ok: true, chunks: await listSallyChunks({ status }) });
    return true;
  }

  if (pathname === '/api/sally-knowledge/chunks/decide' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const decision = String(body.decision || '').toLowerCase();
    if (!id || (decision !== 'approve' && decision !== 'reject')) {
      sendJson(res, 400, { ok: false, error: 'id_and_decision_required' });
      return true;
    }
    const row = await decideSallyChunk(id, decision as 'approve' | 'reject');
    if (!row) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    await warmSallyKnowledgeCache();
    // #region agent log
    debugLog('D', 'sally-product-kb/routes.ts:decide', 'decide+warm', {
      id,
      decision,
      status: String(row.status || ''),
      active: Boolean(row.active),
    }, 'live-debug');
    // #endregion
    sendJson(res, 200, { ok: true, chunk: row });
    return true;
  }

  if (pathname === '/api/sally-knowledge/ingest' && req.method === 'POST') {
    const { jobId } = await enqueueSallyKnowledgeIngest({ runNow: true });
    // #region agent log
    debugLog('E', 'sally-product-kb/routes.ts:ingest', 'ingest enqueued', { jobId }, 'live-debug');
    // #endregion
    sendJson(res, 200, { ok: true, jobId });
    return true;
  }

  if (pathname === '/api/sally-knowledge/jobs' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, jobs: await listIngestJobs(30) });
    return true;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
  return true;
}
