/**
 * Staff APIs for phone billing rates, Soho66 trunk fields, ElevenLabs keys, and usage.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth, resolveOrgIdForRequest } from './auth';
import {
  getPhoneBillingConfig,
  getPhoneUsageSummary,
  maskPhoneBilling,
  setPhoneBillingConfig,
} from './phone-billing';
import {
  getOrgElevenLabsStatus,
  setOrgElevenLabsApiKey,
} from './org-elevenlabs';
import { getUsageSummaryForOrg, getProviderQuantityThisMonth } from './usage';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
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

function assertCanManage(req: IncomingMessage, res: ServerResponse, bodyRole?: string): boolean {
  if (isAuthEnforced()) {
    const ctx = requireAuth(req);
    if (!ctx) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
    if (
      ctx.role !== 'super_admin' &&
      ctx.role !== 'platform_owner' &&
      ctx.role !== 'manager'
    ) {
      sendJson(res, 403, { error: 'Forbidden' });
      return false;
    }
    return true;
  }
  const role = headerString(req, 'x-user-role') || bodyRole;
  if (role && !['super_admin', 'platform_owner', 'manager'].includes(role)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return false;
  }
  return true;
}

export async function handleOrgPhoneBillingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const phoneBilling = pathname === '/api/org/phone-billing';
  const phoneUsage = pathname === '/api/org/phone-usage';
  const elevenlabs = pathname === '/api/org/elevenlabs-key';
  const usageBundle = pathname === '/api/org/usage-bundle';
  if (!phoneBilling && !phoneUsage && !elevenlabs && !usageBundle) return false;

  const orgId = resolveOrgIdForRequest(req);
  if (!orgId) {
    sendJson(res, 400, { error: 'Missing org id (X-Org-Id)' });
    return true;
  }

  if (phoneUsage && req.method === 'GET') {
    sendJson(res, 200, getPhoneUsageSummary(orgId));
    return true;
  }

  if (usageBundle && req.method === 'GET') {
    sendJson(res, 200, {
      phone: getPhoneUsageSummary(orgId),
      elevenlabs: {
        ...getOrgElevenLabsStatus(orgId),
        charactersThisMonth: getProviderQuantityThisMonth(orgId, 'elevenlabs'),
      },
      openai: getUsageSummaryForOrg(orgId),
    });
    return true;
  }

  if (phoneBilling && req.method === 'GET') {
    sendJson(res, 200, maskPhoneBilling(getPhoneBillingConfig(orgId)));
    return true;
  }

  if (phoneBilling && (req.method === 'PUT' || req.method === 'POST')) {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!assertCanManage(req, res, body.role as string | undefined)) return true;
    const updated = setPhoneBillingConfig(orgId, {
      phoneMinutesIncluded:
        body.phoneMinutesIncluded !== undefined
          ? Number(body.phoneMinutesIncluded)
          : undefined,
      phoneRateMobilePerMin:
        body.phoneRateMobilePerMin !== undefined
          ? Number(body.phoneRateMobilePerMin)
          : undefined,
      phoneRateLandlinePerMin:
        body.phoneRateLandlinePerMin !== undefined
          ? Number(body.phoneRateLandlinePerMin)
          : undefined,
      soho66SipUsername:
        body.soho66SipUsername !== undefined
          ? String(body.soho66SipUsername)
          : undefined,
      soho66SipPassword:
        body.soho66SipPassword !== undefined
          ? String(body.soho66SipPassword)
          : undefined,
      soho66SipDomain:
        body.soho66SipDomain !== undefined ? String(body.soho66SipDomain) : undefined,
      soho66FromNumber:
        body.soho66FromNumber !== undefined
          ? String(body.soho66FromNumber)
          : undefined,
      soho66BridgeUrl:
        body.soho66BridgeUrl !== undefined ? String(body.soho66BridgeUrl) : undefined,
    });
    sendJson(res, 200, { success: true, config: updated });
    return true;
  }

  if (elevenlabs && req.method === 'GET') {
    sendJson(res, 200, {
      ...getOrgElevenLabsStatus(orgId),
      charactersThisMonth: getProviderQuantityThisMonth(orgId, 'elevenlabs'),
    });
    return true;
  }

  if (elevenlabs && (req.method === 'PUT' || req.method === 'POST')) {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!assertCanManage(req, res, body.role as string | undefined)) return true;
    const apiKey = String(body.apiKey ?? body.elevenlabsApiKey ?? '');
    const status = setOrgElevenLabsApiKey(orgId, apiKey, {
      voiceId: body.voiceId !== undefined ? String(body.voiceId) : undefined,
      monthlyCharCap:
        body.monthlyCharCap !== undefined ? Number(body.monthlyCharCap) : undefined,
    });
    sendJson(res, 200, {
      success: true,
      ...status,
      charactersThisMonth: getProviderQuantityThisMonth(orgId, 'elevenlabs'),
    });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
