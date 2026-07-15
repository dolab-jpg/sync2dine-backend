import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth, resolveOrgIdForRequest } from './auth';
import {
  ensureOrgOpenAIKeyLoaded,
  getOrgOpenAIKeyStatus,
  setOrgAIBrainConfig,
  setOrgOpenAIApiKey,
  syncOrgOpenAIKeyToSupabase,
  type AIBrainProvider,
} from './organizations';
import { probeLLMConnection, resolveBrainProvider } from './llm-connection';
import { resolveOpenAIApiKeyAsync, mapOpenAIError } from './openai-connection';

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
  if (pathname !== '/api/org/openai-key' && pathname !== '/api/org/ai-brain') return false;

  if (req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    if (!assertHasOrg(req, res, orgId)) return true;
    await ensureOrgOpenAIKeyLoaded(orgId!);
    sendJson(res, 200, getOrgOpenAIKeyStatus(orgId!));
    return true;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    let body: {
      apiKey?: string;
      openaiApiKey?: string;
      deepseekApiKey?: string;
      provider?: AIBrainProvider;
      orgId?: string;
      role?: string;
      probe?: boolean;
    } = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const orgId = resolveOrgIdForRequest(req, body);
    if (!assertCanManageOrgKey(req, res, orgId, body.role)) return true;

    const openaiApiKey = String(body.openaiApiKey ?? body.apiKey ?? '').trim();
    const deepseekApiKey = body.deepseekApiKey !== undefined
      ? String(body.deepseekApiKey).trim()
      : undefined;
    const provider = body.provider === 'deepseek' || body.provider === 'openai'
      ? body.provider
      : undefined;

    if (!openaiApiKey && deepseekApiKey === undefined && !provider) {
      sendJson(res, 400, { error: 'apiKey (OpenAI) is required, or provide DeepSeek/provider updates' });
      return true;
    }

    let updated;
    if (deepseekApiKey !== undefined || provider || pathname === '/api/org/ai-brain') {
      updated = setOrgAIBrainConfig(orgId!, {
        openaiApiKey: openaiApiKey || undefined,
        deepseekApiKey,
        provider,
      });
    } else {
      updated = setOrgOpenAIApiKey(orgId!, openaiApiKey);
    }

    const syncResult = await syncOrgOpenAIKeyToSupabase(orgId!, updated.openaiApiKeyEncrypted);

    let probeOk = true;
    let probeMessage: string | undefined;
    if (body.probe !== false && openaiApiKey) {
      try {
        const key = await resolveOpenAIApiKeyAsync(openaiApiKey, orgId);
        if (key) await probeLLMConnection('openai', key);
      } catch (err) {
        probeOk = false;
        probeMessage = mapOpenAIError(err).message;
      }
    } else if (body.probe !== false && provider === 'deepseek' && deepseekApiKey) {
      try {
        await probeLLMConnection('deepseek', deepseekApiKey);
      } catch (err) {
        probeOk = false;
        probeMessage = mapOpenAIError(err).message;
      }
    }

    const status = getOrgOpenAIKeyStatus(orgId!);
    sendJson(res, probeOk ? 200 : 200, {
      ...status,
      configured: status.configured || Boolean(openaiApiKey),
      syncedToCloud: syncResult.synced,
      cloudSyncWarning: syncResult.warning,
      connected: probeOk && (status.configured || Boolean(openaiApiKey)),
      probeMessage,
      provider: resolveBrainProvider(provider, orgId),
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
