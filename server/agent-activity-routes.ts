/**
 * Replay + client-emission API for the live agent activity feed.
 *
 * GET  /api/agent-activity?sinceSeq=N&limit=M — events for the authenticated user
 * POST /api/agent-activity — browser-originated events (client tool executions)
 *
 * Header conventions follow cynthia-routes: X-Org-Id + X-User-Id.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { resolveOrgIdForRequest } from './auth';
import {
  emitAgentActivity,
  isAgentActivityPhase,
  listAgentActivity,
  MAX_SUMMARY_LENGTH,
} from './agent-activity';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function userFrom(req: IncomingMessage, body?: Record<string, unknown>): string | null {
  const h = req.headers['x-user-id'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  if (typeof body?.userId === 'string' && body.userId.trim()) return body.userId.trim();
  return null;
}

export async function handleAgentActivityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/agent-activity') return false;

  if (req.method === 'GET') {
    const userId = userFrom(req);
    if (!userId || userId === 'default-staff') {
      sendJson(res, 401, { error: 'Authenticated userId required', code: 'staff_not_resolved' });
      return true;
    }
    const orgId = resolveOrgIdForRequest(req);
    const url = new URL(req.url || '/', 'http://localhost');
    const sinceSeq = Number(url.searchParams.get('sinceSeq')) || 0;
    const limit = Number(url.searchParams.get('limit')) || 50;
    const events = await listAgentActivity({ orgId, targetUserId: userId, sinceSeq, limit });
    sendJson(res, 200, { events });
    return true;
  }

  if (req.method === 'POST') {
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const userId = userFrom(req, body);
    if (!userId || userId === 'default-staff') {
      sendJson(res, 401, { error: 'Authenticated userId required', code: 'staff_not_resolved' });
      return true;
    }
    if (!isAgentActivityPhase(body.phase)) {
      sendJson(res, 422, { error: `phase must be one of started/working/changed/saved/navigate/completed/error` });
      return true;
    }
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!summary) {
      sendJson(res, 422, { error: 'summary required' });
      return true;
    }
    if (summary.length > MAX_SUMMARY_LENGTH * 4) {
      sendJson(res, 422, { error: 'summary too long' });
      return true;
    }
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : undefined;
    const orgId = resolveOrgIdForRequest(req, body as { orgId?: string });
    const event = emitAgentActivity({
      orgId,
      targetUserId: userId,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 120) : undefined,
      channel: typeof body.channel === 'string' ? body.channel.slice(0, 60) : undefined,
      capability: typeof body.capability === 'string' ? body.capability.slice(0, 60) : undefined,
      action: typeof body.action === 'string' ? body.action.slice(0, 120) : undefined,
      phase: body.phase,
      summary,
      route: typeof body.route === 'string' ? body.route.slice(0, 300) : undefined,
      payload,
    });
    sendJson(res, 200, { ok: Boolean(event), id: event?.id ?? null, seq: event?.seq ?? null });
    return true;
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: 'Method not allowed' }));
  return true;
}
