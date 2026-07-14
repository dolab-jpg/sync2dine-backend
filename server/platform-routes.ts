import type { IncomingMessage, ServerResponse } from 'http';
import {
  createOrganization,
  deleteOrganization,
  getOrganizationById,
  listOrganizations,
  maskOrganization,
  PLAN_CONFIG,
  updateOrganization,
  type OrgPlan,
  type OrgStatus,
} from './organizations';
import { getGlobalUsageThisMonth, getTokensUsedThisMonth, getUsageSummaryForOrg } from './usage';
import { isAuthEnforced, requireAuth } from './auth';

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

function enrichOrg(org: ReturnType<typeof getOrganizationById>) {
  if (!org) return null;
  const tokensUsedThisMonth = getTokensUsedThisMonth(org.id);
  const usage = getUsageSummaryForOrg(org.id);
  const planCfg = PLAN_CONFIG[org.plan];
  return {
    ...maskOrganization(org, tokensUsedThisMonth),
    tokensUsedThisMonth,
    usageCostUsd: usage.costUsd,
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
    const orgs = listOrganizations().map(o => enrichOrg(o)!);
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

        sendJson(res, 201, {
          organization,
          mainUserEmail: provisioned.mainUserEmail,
          mainUserCreated: true,
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
    sendJson(res, 200, getUsageSummaryForOrg(orgId));
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
