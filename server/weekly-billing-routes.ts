/**
 * Platform + org APIs for weekly usage billing breakdowns and invoice runs.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth, resolveOrgIdForRequest } from './auth';
import { getOrganizationById } from './organizations';
import {
  buildWeeklyBillingBreakdown,
  resolveBillingWeek,
  toCustomerBreakdown,
  weekRangeFromStart,
} from './weekly-usage-billing';
import {
  listBillingPeriodsForOrg,
  findBillingPeriod,
} from './billing-periods';

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

function assertPlatform(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAuthEnforced()) return true;
  const ctx = requireAuth(req);
  if (!ctx || ctx.role !== 'platform_owner') {
    sendJson(res, 403, { error: 'Forbidden — platform owner only' });
    return false;
  }
  return true;
}

function parseWeekStart(url: URL): string | undefined {
  const raw = url.searchParams.get('weekStart') || undefined;
  if (!raw) return undefined;
  weekRangeFromStart(raw);
  return raw;
}

export async function handleWeeklyBillingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // Org-facing: sell lines only
  if (pathname === '/api/org/weekly-usage' && req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    if (!orgId) {
      sendJson(res, 400, { error: 'Missing org id (X-Org-Id)' });
      return true;
    }
    try {
      const weekStart = parseWeekStart(url);
      const breakdown = buildWeeklyBillingBreakdown(orgId, { weekStartIso: weekStart });
      const period = findBillingPeriod(orgId, breakdown.weekStart);
      sendJson(res, 200, {
        ...toCustomerBreakdown(breakdown),
        invoiceStatus: period?.status,
        stripeInvoiceId: period?.stripeInvoiceId,
        hostedInvoiceUrl: period?.stripeHostedInvoiceUrl,
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === '/api/org/billing-periods' && req.method === 'GET') {
    const orgId = resolveOrgIdForRequest(req);
    if (!orgId) {
      sendJson(res, 400, { error: 'Missing org id (X-Org-Id)' });
      return true;
    }
    const periods = listBillingPeriodsForOrg(orgId).map((p) => ({
      id: p.id,
      weekStart: p.weekStart,
      weekEnd: p.weekEnd,
      isoWeek: p.isoWeek,
      fareVersion: p.fareVersion,
      status: p.status,
      customerSubtotalGbp: p.customerSubtotalGbp,
      stripeInvoiceId: p.stripeInvoiceId,
      stripeHostedInvoiceUrl: p.stripeHostedInvoiceUrl,
      customerBreakdown: p.customerBreakdownJson,
      // intentionally omit internalMarginJson
    }));
    sendJson(res, 200, { periods });
    return true;
  }

  if (pathname === '/api/platform/stripe-status' && req.method === 'GET') {
    if (!assertPlatform(req, res)) return true;
    const { getPlatformStripeStatus } = await import('./stripe-service');
    sendJson(res, 200, await getPlatformStripeStatus());
    return true;
  }

  // Platform: includes margins
  if (pathname === '/api/platform/weekly-billing/run' && req.method === 'POST') {
    if (!assertPlatform(req, res)) return true;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { runWeeklyUsageBilling } = await import('./weekly-billing-worker');
    const summary = await runWeeklyUsageBilling({
      weekStartIso: typeof body.weekStart === 'string' ? body.weekStart : undefined,
      orgId: typeof body.orgId === 'string' ? body.orgId : undefined,
      dryRun: body.dryRun === true,
    });
    sendJson(res, 200, summary);
    return true;
  }

  const platformBreakdown = pathname.match(
    /^\/api\/platform\/organizations\/([^/]+)\/weekly-usage$/,
  );
  if (platformBreakdown && req.method === 'GET') {
    if (!assertPlatform(req, res)) return true;
    const orgId = decodeURIComponent(platformBreakdown[1]!);
    if (!getOrganizationById(orgId)) {
      sendJson(res, 404, { error: 'Organization not found' });
      return true;
    }
    try {
      const weekStart = parseWeekStart(url);
      const breakdown = buildWeeklyBillingBreakdown(orgId, { weekStartIso: weekStart });
      const period = findBillingPeriod(orgId, breakdown.weekStart);
      sendJson(res, 200, {
        ...breakdown,
        invoiceStatus: period?.status,
        stripeInvoiceId: period?.stripeInvoiceId,
        hostedInvoiceUrl: period?.stripeHostedInvoiceUrl,
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const platformPeriods = pathname.match(
    /^\/api\/platform\/organizations\/([^/]+)\/billing-periods$/,
  );
  if (platformPeriods && req.method === 'GET') {
    if (!assertPlatform(req, res)) return true;
    const orgId = decodeURIComponent(platformPeriods[1]!);
    sendJson(res, 200, {
      periods: listBillingPeriodsForOrg(orgId),
      currentWeek: resolveBillingWeek(),
    });
    return true;
  }

  return false;
}
