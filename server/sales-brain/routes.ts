import type { IncomingMessage, ServerResponse } from 'http';
import { getHomeOrgId } from '../home-org';
import {
  getSalesBrainStore,
  syncSalesBrainStore,
  type SalesPlaybookSnippet,
} from './store';

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

/** GET/POST /api/sales-brain/* */
export async function handleSalesBrainRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/sales-brain')) return false;
  const orgId = getHomeOrgId();
  const store = getSalesBrainStore();

  if (pathname === '/api/sales-brain/insights' && req.method === 'GET') {
    const rows = store.insights
      .filter((i) => i.orgId === orgId)
      .slice(-50)
      .reverse();
    sendJson(res, 200, { ok: true, insights: rows });
    return true;
  }

  if (pathname === '/api/sales-brain/recommendations' && req.method === 'GET') {
    const rows = store.recommendations
      .filter((r) => r.orgId === orgId)
      .slice(-50)
      .reverse();
    sendJson(res, 200, { ok: true, recommendations: rows });
    return true;
  }

  if (pathname === '/api/sales-brain/snippets' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      snippets: store.snippets.filter((s) => s.orgId === orgId),
    });
    return true;
  }

  if (pathname === '/api/sales-brain/recommendations/decide' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const decision = String(body.decision || '').toLowerCase();
    const rec = store.recommendations.find((r) => r.id === id && r.orgId === orgId);
    if (!rec) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    const now = new Date().toISOString();
    if (decision === 'approve') {
      rec.status = 'approved';
      rec.updatedAt = now;
      const snip: SalesPlaybookSnippet = {
        id: `sps-${Date.now()}`,
        orgId,
        slot: rec.type || 'general',
        body: rec.proposedText.slice(0, 500),
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      store.snippets.push(snip);
      syncSalesBrainStore(store);
      sendJson(res, 200, { ok: true, recommendation: rec, snippet: snip });
      return true;
    }
    if (decision === 'reject') {
      rec.status = 'rejected';
      rec.updatedAt = now;
      syncSalesBrainStore(store);
      sendJson(res, 200, { ok: true, recommendation: rec });
      return true;
    }
    sendJson(res, 400, { ok: false, error: 'decision must be approve|reject' });
    return true;
  }

  if (pathname === '/api/sales-brain/status' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      queued: store.jobs.filter((j) => j.status === 'queued').length,
      insights: store.insights.filter((i) => i.orgId === orgId).length,
      pendingRecs: store.recommendations.filter((r) => r.orgId === orgId && r.status === 'pending').length,
      activeSnippets: store.snippets.filter((s) => s.orgId === orgId && s.active).length,
    });
    return true;
  }

  return false;
}
