import type { IncomingMessage, ServerResponse } from 'http';
import { DEFAULT_ORG_ID, setRequestOrgId } from './data-store';
import { resolveOrgIdForRequest, isAuthEnforced, requireAuth } from './auth';
import {
  listMenuItemsForOrg,
  upsertMenuItemForOrg,
  deleteMenuItemForOrg,
} from './menu-catalog';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Shared menu HTTP API for till / channels (catalog source: products via menu-catalog).
 */
export async function handleMenuRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/menu')) return false;

  const orgId = resolveOrgIdForRequest(req, {}) || DEFAULT_ORG_ID;
  setRequestOrgId(orgId);

  if (pathname === '/api/menu' && req.method === 'GET') {
    const items = await listMenuItemsForOrg(orgId);
    sendJson(res, 200, { items });
    return true;
  }

  if (pathname === '/api/menu' && (req.method === 'POST' || req.method === 'PUT')) {
    if (isAuthEnforced() && !requireAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const result = await upsertMenuItemForOrg(orgId, {
      id: body.id != null ? String(body.id) : undefined,
      name: String(body.name ?? ''),
      category: body.category != null ? String(body.category) : undefined,
      price: Number(body.price ?? 0),
      description: body.description != null ? String(body.description) : undefined,
      available: body.available !== false,
      allergensContains: Array.isArray(body.allergensContains)
        ? (body.allergensContains as string[]) as never
        : undefined,
      deal: body.deal && typeof body.deal === 'object' ? (body.deal as never) : undefined,
    });
    if (!result.ok) {
      sendJson(res, 400, { error: result.error || 'upsert_failed' });
      return true;
    }
    sendJson(res, 200, { item: result.item });
    return true;
  }

  const delMatch = pathname.match(/^\/api\/menu\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    if (isAuthEnforced() && !requireAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const id = decodeURIComponent(delMatch[1]);
    const result = await deleteMenuItemForOrg(orgId, id);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error || 'delete_failed' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
