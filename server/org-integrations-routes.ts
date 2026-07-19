import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth, resolveOrgIdForRequest } from './auth';
import {
  getOrgIntegrationDecrypted,
  listOrgIntegrations,
  upsertOrgIntegration,
  updateOrgIntegrationStatus,
  type IntegrationStatus,
} from './org-integrations-store';
import { isMaskedOrPlaceholder } from './integration-secret-fields';
import { syncOrgOpenAIKeyToSupabase, setOrgAIBrainConfig } from './organizations';
import { encryptSecret } from './crypto';
import { buildOrgIntegrationsStatus } from './org-integrations-status';

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

function assertCanManage(req: IncomingMessage, res: ServerResponse, orgId: string | null, bodyRole?: string): boolean {
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

  const role = headerString(req, 'x-user-role') || bodyRole;
  if (role && role !== 'super_admin' && role !== 'platform_owner') {
    sendJson(res, 403, { error: 'Forbidden — super admin only' });
    return false;
  }
  return true;
}

function parseIntegrationId(pathname: string): string | null {
  // /api/org/integrations/:id or /api/org/integrations/:id/test
  const parts = pathname.split('/').filter(Boolean);
  // api, org, integrations, :id [, test]
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'org' || parts[2] !== 'integrations') {
    return null;
  }
  return parts[3] || null;
}

async function runTestAndRespond(
  integrationId: string,
  values: Record<string, string>,
): Promise<{ success: boolean; message: string; status: IntegrationStatus }> {
  // Capture handleIntegrationTest output without a real HTTP response
  let captured: { success: boolean; message: string; status: IntegrationStatus } | null = null;
  const fakeRes = {
    statusCode: 200,
    setHeader() {},
    end(body: string) {
      try {
        captured = JSON.parse(body) as typeof captured;
      } catch {
        captured = { success: false, message: 'Invalid test response', status: 'error' };
      }
    },
  } as unknown as ServerResponse;

  const { handleIntegrationTest } = await import('./integrations-test');
  await handleIntegrationTest({} as IncomingMessage, fakeRes, { integrationId, values });
  return captured ?? { success: false, message: 'Test produced no result', status: 'error' };
}

export async function handleOrgIntegrationsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/org/integrations')) return false;

  // GET /api/org/integrations
  if (pathname === '/api/org/integrations' && req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    // #region agent log
    fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'73adb0'},body:JSON.stringify({sessionId:'73adb0',runId:'pre-deploy',hypothesisId:'H1',location:'org-integrations-routes.ts:GET',message:'route hit',data:{orgId,method:req.method,pathname},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!assertHasOrg(req, res, orgId)) return true;
    const integrations = await listOrgIntegrations(orgId!);
    const summary = {
      connected: integrations.filter((i) => i.status === 'connected').length,
      notConfigured: integrations.filter((i) => i.status === 'not_configured').length,
      error: integrations.filter((i) => i.status === 'error').length,
      mock: integrations.filter((i) => i.status === 'mock').length,
      total: integrations.length,
    };
    // #region agent log
    fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'73adb0'},body:JSON.stringify({sessionId:'73adb0',runId:'pre-deploy',hypothesisId:'H1',location:'org-integrations-routes.ts:GET:done',message:'list complete',data:{orgId,summary,count:integrations.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    sendJson(res, 200, { orgId, integrations, summary });
    return true;
  }

  // GET /api/org/integrations/status — Supabase + env + runtime merge for hub hydrate
  if (pathname === '/api/org/integrations/status' && req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    if (!assertHasOrg(req, res, orgId)) return true;
    try {
      const payload = await buildOrgIntegrationsStatus(orgId!);
      sendJson(res, 200, payload);
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Failed to build integrations status',
      });
    }
    return true;
  }

  const integrationId = parseIntegrationId(pathname);
  if (!integrationId) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  const isTest = pathname.endsWith('/test');

  // POST /api/org/integrations/:id/test
  if (isTest && req.method === 'POST') {
    let body: {
      values?: Record<string, string>;
      role?: string;
      orgId?: string;
    } = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const orgId = resolveOrgIdForRequest(req, body);
    if (!assertCanManage(req, res, orgId, body.role)) return true;

    const stored = await getOrgIntegrationDecrypted(orgId!, integrationId);
    const merged: Record<string, string> = { ...(stored?.values ?? {}) };
    if (body.values) {
      for (const [k, v] of Object.entries(body.values)) {
        if (isMaskedOrPlaceholder(v)) continue;
        merged[k] = String(v);
      }
    }

    const result = await runTestAndRespond(integrationId, merged);
    await updateOrgIntegrationStatus(orgId!, integrationId, result.status);
    sendJson(res, result.success ? 200 : 400, result);
    return true;
  }

  // PUT /api/org/integrations/:id
  if (!isTest && (req.method === 'PUT' || req.method === 'POST')) {
    let body: {
      values?: Record<string, string>;
      enabled?: boolean;
      mockMode?: boolean;
      status?: IntegrationStatus;
      role?: string;
      orgId?: string;
      migrate?: boolean;
    } = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const orgId = resolveOrgIdForRequest(req, body);
    if (!assertCanManage(req, res, orgId, body.role)) return true;

    const result = await upsertOrgIntegration(orgId!, integrationId, {
      enabled: body.enabled,
      mockMode: body.mockMode,
      status: body.status,
      values: body.values,
    });

    // Mirror OAuth / SMTP client secrets onto VPS disk so mailbox runtime
    // (integration-secrets.json) stays in sync with Supabase Save.
    if (
      (
        integrationId === 'email_oauth'
        || integrationId === 'google_calendar'
        || integrationId === 'email_smtp'
        || integrationId === 'email_resend'
        || integrationId === 'stripe'
      )
      && body.values
    ) {
      const { saveIntegrationSecrets } = await import('./integration-secrets');
      const stored = await getOrgIntegrationDecrypted(orgId!, integrationId);
      const merged: Record<string, string> = { ...(stored?.values ?? {}) };
      for (const [k, v] of Object.entries(body.values)) {
        if (isMaskedOrPlaceholder(v)) continue;
        merged[k] = String(v);
      }
      saveIntegrationSecrets(integrationId, merged);
    }

    // Mirror OpenAI brain key into organizations table (existing path)
    if (integrationId === 'openai' && body.values) {
      const apiKey = body.values.apiKey?.trim();
      const deepseek = body.values.deepseekApiKey;
      if (apiKey && !isMaskedOrPlaceholder(apiKey)) {
        const updated = setOrgAIBrainConfig(orgId!, {
          openaiApiKey: apiKey,
          deepseekApiKey: deepseek !== undefined && !isMaskedOrPlaceholder(deepseek) ? deepseek : undefined,
          provider: body.values.provider === 'deepseek' ? 'deepseek' : 'openai',
        });
        await syncOrgOpenAIKeyToSupabase(orgId!, updated.openaiApiKeyEncrypted || encryptSecret(apiKey));
      }
    }

    sendJson(res, 200, {
      ...result.public,
      syncedToCloud: result.syncedToCloud,
      cloudSyncWarning: result.warning,
    });
    return true;
  }

  // GET /api/org/integrations/:id
  if (!isTest && req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    if (!assertHasOrg(req, res, orgId)) return true;
    const all = await listOrgIntegrations(orgId!);
    const one = all.find((i) => i.integrationId === integrationId);
    if (!one) {
      sendJson(res, 200, {
        integrationId,
        enabled: false,
        mockMode: true,
        status: 'not_configured',
        values: {},
        configuredFields: {},
        hasSecrets: false,
        source: 'none',
      });
      return true;
    }
    sendJson(res, 200, one);
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
