import type { IncomingMessage, ServerResponse } from 'http';
import {
  createOrganization,
  deleteOrganization,
  getOrganizationById,
  listOrganizations,
  listOrganizationsWithSupabase,
  maskOrganization,
  PLAN_CONFIG,
  updateOrganization,
  type OrgPlan,
  type OrgStatus,
} from './organizations';
import { getGlobalUsageThisMonth, getTokensUsedThisMonth, getUsageSummaryForOrg } from './usage';
import { getPhoneUsageSummary } from './phone-billing';
import { getOrgElevenLabsStatus } from './org-elevenlabs';
import { isAuthEnforced, requireAuth } from './auth';
import {
  deletePlatformPhoneLine,
  getJudiePhoneLineForOrg,
  getPlatformPhoneLine,
  getSallyPlatformPhoneLine,
  listAllPlatformPhoneLines,
  savePlatformPhoneLine,
  saveSallyPlatformPhoneLine,
  withDecryptedSipPassword,
  type PhoneLineConnectionType,
} from './phone-lines';
import {
  getPhoneLineById,
  withOrgContext,
  withOrgContextAsync,
  type PhoneLinePurpose,
} from './data-store';
import { registerAllEnabledLines, testLineConnection } from './telephony/lineRegistry';

function assertPlatformAccess(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAuthEnforced()) return true;
  const ctx = requireAuth(req);
  if (!ctx || ctx.role !== 'platform_owner') {
    sendJson(res, 403, { error: 'Forbidden — platform owner only' });
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parsePhoneLinePurpose(value: unknown, fallback: PhoneLinePurpose = 'aria'): PhoneLinePurpose {
  if (value === 'staff' || value === 'sally' || value === 'aria') return value;
  return fallback;
}

function parseConnectionType(value: unknown): PhoneLineConnectionType | undefined {
  if (value === 'soho66' || value === 'sip' || value === 'twilio' || value === 'other') return value;
  return undefined;
}

function orgIdFromRequest(req: IncomingMessage, body?: Record<string, unknown>): string {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fromQuery = url.searchParams.get('orgId')?.trim();
  if (fromQuery) return fromQuery;
  const fromBody = body?.orgId;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();
  return '';
}

function enrichOrg(org: ReturnType<typeof getOrganizationById>) {
  if (!org) return null;
  const tokensUsedThisMonth = getTokensUsedThisMonth(org.id);
  const usage = getUsageSummaryForOrg(org.id);
  const phone = getPhoneUsageSummary(org.id);
  const elevenlabs = getOrgElevenLabsStatus(org.id);
  const planCfg = PLAN_CONFIG[org.plan];
  return {
    ...maskOrganization(org, tokensUsedThisMonth),
    tokensUsedThisMonth,
    usageCostUsd: usage.costUsd,
    elevenlabsCharactersThisMonth: usage.elevenlabsCharacters ?? 0,
    elevenlabsConfigured: elevenlabs.configured,
    phoneOutboundMinutes: phone.outboundMinutes,
    phoneFreeMinutesRemaining: phone.freeMinutesRemaining,
    phoneEstimatedCostGbp: phone.estimatedCostGbp,
    phoneMobileMinutes: phone.mobileMinutes,
    phoneLandlineMinutes: phone.landlineMinutes,
    monthlyPriceGbp: planCfg.monthlyPriceGbp,
    planLabel: planCfg.label,
  };
}

export async function handlePlatformRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/platform/')) return false;

  if (!assertPlatformAccess(req, res)) return true;

  if (pathname === '/api/platform/plans' && req.method === 'GET') {
    sendJson(res, 200, { plans: PLAN_CONFIG });
    return true;
  }

  if (pathname === '/api/platform/phone-lines/register-all' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const orgId = orgIdFromRequest(req, body);
    if (!orgId) {
      sendJson(res, 400, { error: 'orgId is required' });
      return true;
    }
    if (!getOrganizationById(orgId)) {
      sendJson(res, 404, { error: 'Organization not found' });
      return true;
    }
    const result = await withOrgContextAsync(orgId, () => registerAllEnabledLines());
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/platform/sally-phone-line' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
    if (req.method === 'GET') {
      const line = getSallyPlatformPhoneLine();
      sendJson(res, line ? 200 : 404, line ? { line } : { error: 'Sally phone line not configured' });
      return true;
    }

    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    try {
      const line = saveSallyPlatformPhoneLine({
        label: typeof body.label === 'string' ? body.label : undefined,
        sipUsername: String(body.sipUsername ?? ''),
        sipPassword: typeof body.sipPassword === 'string' ? body.sipPassword : undefined,
        sipDomain: typeof body.sipDomain === 'string' ? body.sipDomain : undefined,
        did: String(body.did ?? ''),
        enabled: body.enabled !== false,
        connectionType: parseConnectionType(body.connectionType),
      });
      sendJson(res, 200, { line });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/platform/phone-lines' && req.method === 'GET') {
    sendJson(res, 200, { lines: listAllPlatformPhoneLines() });
    return true;
  }

  if (pathname === '/api/platform/phone-lines' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const orgId = orgIdFromRequest(req, body);
    if (!orgId) {
      sendJson(res, 400, { error: 'orgId is required' });
      return true;
    }
    try {
      const line = savePlatformPhoneLine({
        orgId,
        label: String(body.label ?? ''),
        sipUsername: String(body.sipUsername ?? ''),
        sipPassword: typeof body.sipPassword === 'string' ? body.sipPassword : undefined,
        sipDomain: typeof body.sipDomain === 'string' ? body.sipDomain : undefined,
        did: String(body.did ?? ''),
        enabled: body.enabled !== false,
        purpose: parsePhoneLinePurpose(body.purpose, 'aria'),
        connectionType: parseConnectionType(body.connectionType),
        assignedUserId: body.assignedUserId === null ? null : typeof body.assignedUserId === 'string' ? body.assignedUserId : undefined,
      });
      sendJson(res, 201, { line });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const phoneLineTestMatch = pathname.match(/^\/api\/platform\/phone-lines\/([^/]+)\/test$/);
  if (phoneLineTestMatch && req.method === 'POST') {
    const lineId = decodeURIComponent(phoneLineTestMatch[1]);
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const orgId = orgIdFromRequest(req, body);
    if (!orgId) {
      sendJson(res, 400, { error: 'orgId is required' });
      return true;
    }
    const line = withOrgContext(orgId, () => getPhoneLineById(lineId));
    if (!line) {
      sendJson(res, 404, { error: 'Line not found' });
      return true;
    }
    const result = await testLineConnection(withDecryptedSipPassword(line));
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  const phoneLineMatch = pathname.match(/^\/api\/platform\/phone-lines\/([^/]+)$/);
  if (phoneLineMatch) {
    const lineId = decodeURIComponent(phoneLineMatch[1]);

    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const orgId = url.searchParams.get('orgId')?.trim() ?? '';
      if (!orgId) {
        sendJson(res, 400, { error: 'orgId query parameter is required' });
        return true;
      }
      const line = getPlatformPhoneLine(orgId, lineId);
      if (!line) {
        sendJson(res, 404, { error: 'Line not found' });
        return true;
      }
      sendJson(res, 200, { line });
      return true;
    }

    if (req.method === 'PATCH') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const orgId = orgIdFromRequest(req, body);
      if (!orgId) {
        sendJson(res, 400, { error: 'orgId is required' });
        return true;
      }
      const existing = withOrgContext(orgId, () => getPhoneLineById(lineId));
      if (!existing) {
        sendJson(res, 404, { error: 'Line not found' });
        return true;
      }
      try {
        const line = savePlatformPhoneLine({
          orgId,
          id: lineId,
          label: typeof body.label === 'string' ? body.label : existing.label,
          sipUsername: typeof body.sipUsername === 'string' ? body.sipUsername : existing.sipUsername,
          sipPassword: typeof body.sipPassword === 'string' ? body.sipPassword : undefined,
          sipDomain: typeof body.sipDomain === 'string' ? body.sipDomain : existing.sipDomain,
          did: typeof body.did === 'string' ? body.did : existing.did,
          enabled: body.enabled !== undefined ? body.enabled !== false : existing.enabled,
          purpose: body.purpose !== undefined ? parsePhoneLinePurpose(body.purpose, existing.purpose ?? 'aria') : existing.purpose,
          connectionType: parseConnectionType(body.connectionType) ?? existing.connectionType,
          assignedUserId: body.assignedUserId === null ? null : typeof body.assignedUserId === 'string' ? body.assignedUserId : existing.assignedUserId,
          status: existing.status,
        });
        sendJson(res, 200, { line });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let orgId = url.searchParams.get('orgId')?.trim() ?? '';
      if (!orgId) {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        orgId = orgIdFromRequest(req, body);
      }
      if (!orgId) {
        sendJson(res, 400, { error: 'orgId is required' });
        return true;
      }
      const ok = deletePlatformPhoneLine(orgId, lineId);
      sendJson(res, ok ? 200 : 404, ok ? { success: true } : { error: 'Line not found' });
      return true;
    }
  }

  if (pathname === '/api/platform/stats' && req.method === 'GET') {
    const orgs = listOrganizations();
    const active = orgs.filter(o => o.status === 'active').length;
    const trialing = orgs.filter(o => o.status === 'trial').length;
    const pastDue = orgs.filter(o => o.status === 'past_due').length;
    const mrr = orgs
      .filter(o => o.status === 'active' || o.status === 'trial')
      .reduce((sum, o) => sum + PLAN_CONFIG[o.plan].monthlyPriceGbp, 0);
    sendJson(res, 200, {
      total: orgs.length,
      active,
      trialing,
      pastDue,
      suspended: orgs.filter(o => o.status === 'suspended').length,
      mrr,
      tokensThisMonth: getGlobalUsageThisMonth(),
    });
    return true;
  }

  if (pathname === '/api/platform/organizations' && req.method === 'GET') {
    const orgs = (await listOrganizationsWithSupabase()).map(o => enrichOrg(o)!);
    sendJson(res, 200, { organizations: orgs });
    return true;
  }

  if (pathname === '/api/platform/organizations' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const adminPassword = String(body.adminPassword ?? '').trim();
    if (!adminPassword || adminPassword.length < 8) {
      sendJson(res, 400, { error: 'Main user password is required (min 8 characters)' });
      return true;
    }
    if (!String(body.name ?? '').trim() || !String(body.contactEmail ?? '').trim()) {
      sendJson(res, 400, { error: 'Company name and contact email are required' });
      return true;
    }

    const {
      canProvisionViaSupabase,
      provisionOrganizationInSupabase,
      mapSupabaseOrgToApi,
    } = await import('./provision-org.js');

    if (canProvisionViaSupabase()) {
      try {
        const provisioned = await provisionOrganizationInSupabase({
          name: body.name,
          contactName: body.contactName,
          contactEmail: body.contactEmail,
          contactPhone: body.contactPhone,
          address: body.address,
          plan: body.plan,
          monthlyTokenCap: body.monthlyTokenCap,
          notes: body.notes,
          adminPassword,
        });
        const organization = mapSupabaseOrgToApi(provisioned.organization);

        try {
          createOrganization({
            id: organization.id,
            name: body.name,
            contactName: body.contactName || body.name,
            contactEmail: body.contactEmail,
            contactPhone: body.contactPhone || '',
            address: body.address,
            plan: body.plan as OrgPlan,
            status: 'trial',
            openaiApiKey: body.openaiApiKey,
            monthlyTokenCap: body.monthlyTokenCap,
            notes: body.notes,
            trialDays: body.trialDays,
          });
        } catch {
          // non-fatal
        }

        if (body.sendInviteEmail) {
          try {
            const { sendOrgInviteEmail } = await import('./email-service');
            await sendOrgInviteEmail({
              id: organization.id,
              name: organization.name,
              contactName: organization.contactName,
              contactEmail: organization.contactEmail,
              contactPhone: organization.contactPhone,
              status: organization.status as OrgStatus,
              plan: organization.plan as OrgPlan,
              openaiApiKeyEncrypted: '',
              monthlyTokenCap: organization.monthlyTokenCap,
              createdAt: organization.createdAt,
              updatedAt: organization.updatedAt,
            });
          } catch {
            // non-fatal
          }
        }

        let stripeCheckoutUrl: string | undefined;
        let stripeWarning: string | undefined;
        if (body.createStripeSubscription) {
          try {
            const { createCheckoutSessionForOrg } = await import('./stripe-service');
            stripeCheckoutUrl = await createCheckoutSessionForOrg(organization.id);
          } catch (err) {
            stripeWarning = err instanceof Error ? err.message : String(err);
          }
        }

        sendJson(res, 201, {
          organization,
          mainUserEmail: provisioned.mainUserEmail,
          mainUserCreated: true,
          kioskUrl: provisioned.kioskUrl,
          stripeCheckoutUrl,
          stripeWarning,
        });
        return true;
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }

    const org = createOrganization({
      name: body.name,
      contactName: body.contactName,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      address: body.address,
      plan: body.plan as OrgPlan,
      status: (body.status as OrgStatus) ?? 'trial',
      openaiApiKey: body.openaiApiKey,
      monthlyTokenCap: body.monthlyTokenCap,
      notes: body.notes,
      trialDays: body.trialDays,
    });

    const { createUser } = await import('./users');
    createUser({
      orgId: org.id,
      name: body.contactName || body.name,
      email: body.contactEmail,
      password: adminPassword,
      role: 'super_admin',
    });

    if (body.createStripeSubscription) {
      try {
        const { createSubscriptionForOrg } = await import('./stripe-service');
        await createSubscriptionForOrg(org.id, body.contactEmail, body.contactName);
      } catch (err) {
        sendJson(res, 201, {
          organization: enrichOrg(org),
          mainUserEmail: String(body.contactEmail).trim().toLowerCase(),
          mainUserCreated: true,
          stripeWarning: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    }

    if (body.sendInviteEmail) {
      try {
        const { sendOrgInviteEmail } = await import('./email-service');
        await sendOrgInviteEmail(org);
      } catch {
        // non-fatal
      }
    }

    const refreshed = getOrganizationById(org.id);
    sendJson(res, 201, {
      organization: enrichOrg(refreshed ?? org),
      mainUserEmail: String(body.contactEmail).trim().toLowerCase(),
      mainUserCreated: true,
    });
    return true;
  }

  const judieLineMatch = pathname.match(/^\/api\/platform\/organizations\/([^/]+)\/judie-phone-line$/);
  if (judieLineMatch && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
    const orgId = decodeURIComponent(judieLineMatch[1]);
    if (!getOrganizationById(orgId)) {
      sendJson(res, 404, { error: 'Organization not found' });
      return true;
    }

    if (req.method === 'GET') {
      const line = getJudiePhoneLineForOrg(orgId);
      sendJson(res, line ? 200 : 404, line ? { line } : { error: 'Judie phone line not configured' });
      return true;
    }

    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    try {
      const existing = getJudiePhoneLineForOrg(orgId);
      const line = savePlatformPhoneLine({
        orgId,
        id: existing?.id,
        label: typeof body.label === 'string' ? body.label : existing?.label || 'Judie',
        sipUsername: String(body.sipUsername ?? existing?.sipUsername ?? ''),
        sipPassword: typeof body.sipPassword === 'string' ? body.sipPassword : undefined,
        sipDomain: typeof body.sipDomain === 'string' ? body.sipDomain : existing?.sipDomain,
        did: String(body.did ?? existing?.did ?? ''),
        enabled: body.enabled !== false,
        purpose: 'aria',
        connectionType: parseConnectionType(body.connectionType) ?? existing?.connectionType,
      });
      sendJson(res, 200, { line });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const orgMatch = pathname.match(/^\/api\/platform\/organizations\/([^/]+)$/);
  if (orgMatch) {
    const orgId = decodeURIComponent(orgMatch[1]);

    if (req.method === 'GET') {
      const org = getOrganizationById(orgId);
      if (!org) {
        sendJson(res, 404, { error: 'Organization not found' });
        return true;
      }
      sendJson(res, 200, { organization: enrichOrg(org) });
      return true;
    }

    if (req.method === 'PATCH') {
      const body = JSON.parse(await readBody(req));
      const updated = updateOrganization(orgId, {
        name: body.name,
        contactName: body.contactName,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        address: body.address,
        plan: body.plan,
        status: body.status,
        openaiApiKey: body.openaiApiKey,
        monthlyTokenCap: body.monthlyTokenCap,
        notes: body.notes,
        whatsappPhoneNumberId: body.whatsappPhoneNumberId,
        phoneDid: body.phoneDid,
        subscriptionStatus: body.subscriptionStatus,
        currentPeriodEnd: body.currentPeriodEnd,
        stripeCustomerId: body.stripeCustomerId,
        stripeSubscriptionId: body.stripeSubscriptionId,
        saasPackageId: body.saasPackageId,
      });
      if (!updated) {
        sendJson(res, 404, { error: 'Organization not found' });
        return true;
      }
      sendJson(res, 200, { organization: enrichOrg(updated) });
      return true;
    }

    if (req.method === 'DELETE') {
      const ok = deleteOrganization(orgId);
      sendJson(res, ok ? 200 : 404, { success: ok });
      return true;
    }
  }

  const usageMatch = pathname.match(/^\/api\/platform\/organizations\/([^/]+)\/usage$/);
  if (usageMatch && req.method === 'GET') {
    const orgId = decodeURIComponent(usageMatch[1]);
    if (!getOrganizationById(orgId)) {
      sendJson(res, 404, { error: 'Organization not found' });
      return true;
    }
    sendJson(res, 200, {
      ...getUsageSummaryForOrg(orgId),
      phone: getPhoneUsageSummary(orgId),
      elevenlabs: {
        ...getOrgElevenLabsStatus(orgId),
        charactersThisMonth: getUsageSummaryForOrg(orgId).elevenlabsCharacters ?? 0,
      },
    });
    return true;
  }

  const stripeMatch = pathname.match(/^\/api\/platform\/organizations\/([^/]+)\/stripe-checkout$/);
  if (stripeMatch && req.method === 'POST') {
    const orgId = decodeURIComponent(stripeMatch[1]);
    try {
      const { createCheckoutSessionForOrg } = await import('./stripe-service');
      const url = await createCheckoutSessionForOrg(orgId);
      sendJson(res, 200, { url });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
