import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth, resolveOrgIdForRequest } from './auth';
import {
  ensureOrgOpenAIKeyLoaded,
  getOrgOpenAIKeyStatus,
  setOrgOpenAIApiKey,
  syncOrgOpenAIKeyToSupabase,
} from './organizations';

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

function headerString(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
  return null;
}

function assertHasOrg(req: IncomingMessage, res: ServerResponse, orgId: string | null): boolean {
  if (!orgId) {
    sendJson(res, 400, { error: 'Missing org id (X-Org-Id)' });
    return false;
  }
  if (isAuthEnforced()) {
    const ctx = requireAuth(req);
    if (!ctx) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
    if (ctx.role === 'super_admin' && ctx.orgId && ctx.orgId !== orgId) {
      sendJson(res, 403, { error: 'Forbidden — wrong organization' });
      return false;
    }
  }
  return true;
}

function assertCanManageOrgKey(req: IncomingMessage, res: ServerResponse, orgId: string | null, bodyRole?: string): boolean {
  if (!assertHasOrg(req, res, orgId)) return false;

  if (isAuthEnforced()) {
    const ctx = requireAuth(req);
    if (!ctx) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
    if (ctx.role !== 'super_admin' && ctx.role !== 'platform_owner') {
      sendJson(res, 403, { error: 'Forbidden — super admin only' });
      return false;
    }
    return true;
  }

  // Dev / Supabase session: UI is gated to super_admin; accept role header or body.
  const role = headerString(req, 'x-user-role') || bodyRole;
  if (role && role !== 'super_admin' && role !== 'platform_owner') {
    sendJson(res, 403, { error: 'Forbidden — super admin only' });
    return false;
  }
  return true;
}

export async function handleOrgOpenAIKeyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/org/openai-key') return false;

  if (req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    // Any org member can read configured status (never the raw key).
    if (!assertHasOrg(req, res, orgId)) return true;
    await ensureOrgOpenAIKeyLoaded(orgId!);
    sendJson(res, 200, getOrgOpenAIKeyStatus(orgId!));
    return true;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    let body: { apiKey?: string; orgId?: string; role?: string } = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const orgId = resolveOrgIdForRequest(req, body);
    if (!assertCanManageOrgKey(req, res, orgId, body.role)) return true;

    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) {
      sendJson(res, 400, { error: 'apiKey is required' });
      return true;
    }

    const updated = setOrgOpenAIApiKey(orgId!, apiKey);
    const syncResult = await syncOrgOpenAIKeyToSupabase(orgId!, updated.openaiApiKeyEncrypted);
    sendJson(res, 200, {
      configured: true,
      maskedHint: getOrgOpenAIKeyStatus(orgId!).maskedHint,
      syncedToCloud: syncResult.synced,
      cloudSyncWarning: syncResult.warning,
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
