import type { IncomingMessage, ServerResponse } from 'http';
import { getDataStore, setRequestOrgId, getAgentCapacitySnapshot } from './data-store';
import { getOfficeTeamRoster } from './team-snapshot';

function periodStart(period: string): Date {
  const now = new Date();
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === 'quarter') {
    const qMonth = Math.floor(now.getMonth() / 3) * 3;
    return new Date(now.getFullYear(), qMonth, 1);
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function safePct(num: number, den: number): number {
  if (!den || !Number.isFinite(num / den)) return 0;
  return Math.round((num / den) * 100 * 10) / 10;
}

export function computeAnalyticsOverview(period: string, orgId?: string) {
  const store = getDataStore(orgId);
  const cutoff = periodStart(period);

  const customers = (store.customers as Array<Record<string, unknown>> | undefined) ?? [];
  const quotes = (Array.isArray(store.quotes) ? store.quotes : []) as Array<Record<string, unknown>>;

  const periodCustomers = customers.filter(
    (c) => new Date(String(c.createdAt ?? '')).getTime() >= cutoff.getTime(),
  );
  const periodQuotes = quotes.filter(
    (q) => new Date(String(q.createdAt ?? '')).getTime() >= cutoff.getTime(),
  );

  const leads = periodCustomers.filter((c) => String(c.status ?? '') === 'lead').length;
  const won = periodCustomers.filter((c) => String(c.status ?? '') === 'won').length;
  const lost = periodCustomers.filter((c) => String(c.status ?? '') === 'lost').length;
  const revenue = periodQuotes
    .filter((q) => String(q.status ?? '') === 'accepted' || String(q.status ?? '') === 'won')
    .reduce((s, q) => s + Number(q.total ?? 0), 0);

  const conversion = safePct(won, leads + won + lost);
  const avgDeal = won > 0 ? Math.round(revenue / won) : 0;
  const pipeline = leads + periodCustomers.filter((c) => String(c.status ?? '') === 'quoted').length;

  const team = getOfficeTeamRoster().map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    revenue: m.performance.revenue,
    leads: m.performance.leads,
    won: m.performance.won,
    conversionRate: m.performance.conversionRate,
  }));

  let agents: Array<Record<string, unknown>> = [];
  try {
    const cap = getAgentCapacitySnapshot?.();
    if (cap) {
      agents = [{
        name: 'Cynthia',
        status: (cap as Record<string, unknown>).activeCallCount
          ? 'on_call'
          : (cap as Record<string, unknown>).totalActive
            ? 'on_call'
            : 'idle',
        activeCallCount:
          (cap as Record<string, unknown>).activeCallCount
          ?? (cap as Record<string, unknown>).totalActive
          ?? 0,
      }];
    }
  } catch {
    // agent status not available
  }

  return {
    period,
    revenue,
    leads,
    conversion,
    avgDeal,
    pipeline,
    team,
    agents,
    won,
    lost,
    totalCustomers: customers.length,
    totalQuotes: quotes.length,
  };
}

// ── Analytics event ring buffer (5E) ────────────────────────────────
const MAX_EVENTS = 100;
const analyticsEvents: Array<Record<string, unknown>> = [];

export function pushAnalyticsEvent(event: Record<string, unknown>): void {
  analyticsEvents.unshift({
    ...event,
    receivedAt: new Date().toISOString(),
  });
  if (analyticsEvents.length > MAX_EVENTS) analyticsEvents.length = MAX_EVENTS;
}

export function getAnalyticsEvents(limit = 50): Array<Record<string, unknown>> {
  return analyticsEvents.slice(0, limit);
}

// ── Route handler ───────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function handleAnalyticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname === '/api/analytics/overview' && req.method === 'GET') {
    const orgId = (req.headers['x-org-id'] as string | undefined) ?? undefined;
    if (orgId) setRequestOrgId(orgId);
    const period = url.searchParams.get('period') || 'month';
    const overview = computeAnalyticsOverview(period, orgId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(overview));
    return true;
  }

  if (pathname === '/webhooks/analytics/events' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const events = Array.isArray(body) ? body : [body];
      for (const ev of events) {
        if (ev && typeof ev === 'object') pushAnalyticsEvent(ev as Record<string, unknown>);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, stored: events.length }));
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return true;
  }

  if (pathname === '/api/analytics/events' && req.method === 'GET') {
    const limit = Math.min(MAX_EVENTS, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ events: getAnalyticsEvents(limit) }));
    return true;
  }

  return false;
}
