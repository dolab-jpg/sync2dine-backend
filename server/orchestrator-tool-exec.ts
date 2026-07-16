import fs from 'fs';
import { getDataStore, resolveContactByPhone, appendCustomerCallActivity } from './data-store';
import { getOfficeTeamCounts, getOfficeTeamRoster, getTopPerformer } from './team-snapshot';
import { listTeamMembers } from './conversation-store';
import type { OrchestratorRequest } from './orchestrator-types';
import { getRequestRole } from './role-permissions';
import {
  buildPolicyContext,
  canReadCollection,
  filterRecordsForRole,
  redactRecord,
  redactRecords,
  type DataCollection,
  SENSITIVE_FIELD_KEYS,
} from './dataPolicy';
import { formatSpokenGbp, withSpokenMoney } from './spoken-money';
import { lookupQuotesFromStore } from './quote-lookup';

const SENSITIVE_KEYS = SENSITIVE_FIELD_KEYS;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function includesQuery(value: string | undefined | null, query: string): boolean {
  return String(value ?? '').toLowerCase().includes(String(query ?? '').toLowerCase());
}

function scrubOutput(output: Record<string, unknown>, role: string): Record<string, unknown> {
  if (role === 'super_admin' || role === 'manager' || role === 'staff') {
    return output;
  }
  const scrub = (obj: unknown): unknown => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  };
  return scrub(output) as Record<string, unknown>;
}

function summarizeProjectStatus(project: Record<string, unknown>): Record<string, unknown> {
  const paymentStages = Array.isArray(project.paymentStages) ? project.paymentStages as Array<Record<string, unknown>> : [];
  const tasks = Array.isArray(project.tasks) ? project.tasks as Array<Record<string, unknown>> : [];
  const nextPayment = paymentStages.find((stage) => {
    const status = String(stage.status ?? '');
    return status === 'due' || status === 'pending';
  });
  const openTasks = tasks
    .filter((task) => String(task.status ?? '') !== 'completed')
    .slice(0, 3)
    .map((task) => String(task.title ?? 'Untitled task'));

  return {
    projectId: String(project.id ?? ''),
    customerId: String(project.customerId ?? ''),
    projectName: String(project.projectName ?? 'Project'),
    status: String(project.status ?? 'unknown'),
    tradeName: firstString(project.tradeName, project.tradeId),
    startDate: firstString(project.startDate),
    finishDate: firstString(project.finishDate),
    todayTasks: openTasks,
    nextPaymentDue: nextPayment
      ? {
          name: String(nextPayment.name ?? 'Payment stage'),
          amount: Number(nextPayment.amount ?? 0),
          status: String(nextPayment.status ?? 'pending'),
          dueDate: firstString(nextPayment.dueDate),
        }
      : null,
    portalToken: firstString(project.portalToken),
    escalated: Boolean(project.escalated),
  };
}

export function executeCustomerTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest
): Record<string, unknown> {
  const store = getDataStore();
  const projects = Array.isArray(store.projects) ? store.projects as Array<Record<string, unknown>> : [];
  const requestedCustomerId = firstString(input.customerId, body.customerContext?.customerId);
  const requestedProjectId = firstString(input.projectId, body.projectContext?.projectId, body.customerContext?.projectId);
  const requestedQuoteId = firstString(input.quoteId, body.customerContext?.quoteId);

  if (name === 'lookupCustomerByPhone') {
    const phone = firstString(input.phone, body.customerContext?.phone, body.callContext?.to, body.callContext?.from);
    if (!phone) return { found: false, error: 'phone required' };
    const resolved = resolveContactByPhone(phone);
    return {
      found: Boolean(resolved.customerId),
      phone,
      customerId: resolved.customerId,
      customerName: resolved.customerName,
      contactName: resolved.contactName,
      contactRole: resolved.contactRole,
      projectId: resolved.projectId,
    };
  }

  if (name === 'getAccountBriefing') {
    const phone = firstString(input.phone, body.customerContext?.phone, body.callContext?.to, body.callContext?.from);
    let customerId = firstString(input.customerId, body.customerContext?.customerId);
    let contactName = firstString(body.customerContext?.contactName, body.customerContext?.customerName);
    let projectId = firstString(body.customerContext?.projectId, body.projectContext?.projectId);

    if ((!customerId || !projectId) && phone) {
      const resolved = resolveContactByPhone(phone);
      customerId = customerId ?? resolved.customerId ?? undefined;
      contactName = contactName ?? resolved.contactName;
      projectId = projectId ?? resolved.projectId ?? undefined;
    }

    const store = getDataStore();
    const customer = customerId
      ? (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId)
      : undefined;
    const customerPhone = firstString(customer?.phone, phone) ?? null;
    const customerAddress = firstString(customer?.address, customer?.siteAddress) ?? null;
    const projects = (store.projects as Array<Record<string, unknown>>)
      .filter((p) => customerId && String(p.customerId) === customerId)
      .slice(0, 3)
      .map((p) => ({
        projectId: String(p.id),
        projectName: String(p.projectName ?? 'Project'),
        status: String(p.status ?? 'unknown'),
        tradeName: firstString(p.tradeName, p.tradeId) ?? null,
        address: firstString(p.address, p.siteAddress, customer?.address) ?? null,
      }));
    const openQuotes = (Array.isArray(store.quotes) ? store.quotes as Array<Record<string, unknown>> : [])
      .filter((q) => customerId && String(q.customerId) === customerId)
      .slice(0, 3)
      .map((q) => {
        const total = Number(q.total ?? q.totalCustomerCost ?? 0);
        return {
          quoteId: String(q.id),
          total,
          spokenTotal: formatSpokenGbp(total),
          status: String(q.status ?? 'unknown'),
        };
      });

    const name = firstString(customer?.name, contactName) ?? 'the customer';
    const active = projects.find((p) => p.status !== 'completed') ?? projects[0];
    const quoteHint = openQuotes[0]
      ? ` Latest quote totals ${openQuotes[0].spokenTotal}.`
      : '';
    const spokenHint = active
      ? `${name} has project "${active.projectName}" currently ${active.status.replace(/_/g, ' ')}${active.address ? ` at ${active.address}` : ''}.${quoteHint}`
      : `${name} is on file${openQuotes.length ? ` with ${openQuotes.length} quote(s)` : ''}.${quoteHint}`;

    return {
      found: Boolean(customerId),
      customerId: customerId ?? null,
      customerName: name,
      phone: customerPhone,
      address: customerAddress,
      projectId: active?.projectId ?? projectId ?? null,
      projects,
      quotes: openQuotes,
      spokenHint,
    };
  }

  if (name === 'logCallActivity') {
    const customerId = firstString(input.customerId, body.customerContext?.customerId);
    const callId = firstString(input.callId, body.callContext?.callId);
    const summary = firstString(input.summary) ?? 'Cynthia phone call';
    const outcome = firstString(input.outcome);
    if (!customerId) return { logged: false, error: 'customerId required' };
    const note = appendCustomerCallActivity({
      customerId,
      callId: callId ?? undefined,
      summary,
      outcome: outcome ?? undefined,
    });
    return { logged: true, customerId, note };
  }

  if (name === 'lookupQuote') {
    const fromStore = lookupQuotesFromStore({
      quoteId: requestedQuoteId ?? null,
      customerId: requestedCustomerId ?? null,
    });
    const customerNameQ = firstString(input.customerName, input.name)?.toLowerCase();
    let quotes = (fromStore.quotes as Array<Record<string, unknown>>).map((q) =>
      withSpokenMoney({
        ...q,
        total: Number(q.total ?? 0),
      }),
    );
    if (!quotes.length && customerNameQ) {
      const storeQuotes = (getDataStore().quotes ?? []) as Array<Record<string, unknown>>;
      quotes = storeQuotes
        .filter((q) => String(q.customerName ?? '').toLowerCase().includes(customerNameQ))
        .slice(0, 5)
        .map((q) => withSpokenMoney({
          quoteId: String(q.id ?? ''),
          customerId: String(q.customerId ?? ''),
          customerName: String(q.customerName ?? ''),
          tradeName: String(q.tradeName ?? q.tradeId ?? ''),
          status: String(q.status ?? 'draft'),
          total: Number(q.total ?? q.totalCustomerCost ?? 0),
        }));
    }
    const top = quotes[0];
    const spokenHint = top
      ? `${String(top.customerName || 'That')} ${String(top.tradeName || 'quote')} is ${String(top.spokenTotal)}.`
      : 'No matching quotes found.';
    return {
      count: quotes.length,
      query: {
        quoteId: requestedQuoteId ?? null,
        customerId: requestedCustomerId ?? null,
        customerName: customerNameQ ?? null,
      },
      quotes,
      spokenHint,
    };
  }

  if (name === 'lookupProjectStatus') {
    const matches = projects
      .filter((project) => {
        if (requestedProjectId && String(project.id ?? '') === requestedProjectId) return true;
        if (requestedCustomerId && String(project.customerId ?? '') === requestedCustomerId) return true;
        return false;
      })
      .map(summarizeProjectStatus);

    return {
      count: matches.length,
      query: {
        projectId: requestedProjectId ?? null,
        customerId: requestedCustomerId ?? null,
      },
      projects: matches,
    };
  }

  if (name === 'getPortalLink') {
    const project = projects.find((item) => String(item.id ?? '') === requestedProjectId);
    const token = firstString(project?.portalToken);
    const appBase = process.env.APP_BASE_URL ?? process.env.PUBLIC_APP_URL ?? '';
    const portalPath = token ? `/portal/${token}` : null;
    return {
      projectId: requestedProjectId ?? null,
      portalLink: token
        ? (appBase ? `${appBase.replace(/\/$/, '')}${portalPath}` : portalPath)
        : null,
      available: Boolean(token),
    };
  }

  if (name === 'escalateToStaff') {
    return {
      queued: true,
      reason: firstString(input.reason) ?? 'Customer requested staff follow-up',
      customerId: requestedCustomerId ?? null,
      projectId: requestedProjectId ?? null,
      nextStep: 'Office team follow-up required.',
    };
  }

  return {};
}

function searchCustomersServer(
  customers: NonNullable<OrchestratorRequest['staffContext']>['customers'],
  query: string,
  limit: number
) {
  const q = query.trim();
  const browse = !q || /^(all|list|browse|customers?|everyone|recent)$/i.test(q);
  const storeCustomers = (getDataStore().customers as Array<Record<string, unknown>> || []).map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    email: String(c.email ?? ''),
    phone: String(c.phone ?? ''),
  }));
  const list = (customers?.length
    ? customers.map((c) => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      email: String(c.email ?? ''),
      phone: String(c.phone ?? ''),
    }))
    : storeCustomers) ?? [];
  if (!list.length) return { results: [] as Array<Record<string, unknown>>, hasMore: false, total: 0 };

  const matched = browse
    ? list
    : list.filter((c) =>
      includesQuery(c.name, q)
      || includesQuery(c.email, q)
      || includesQuery(c.phone, q)
    );
  const slice = matched.slice(0, limit).map((c) => ({
    id: c.id,
    title: c.name,
    name: c.name,
    subtitle: `${c.email} • ${c.phone}`,
    phone: c.phone,
    email: c.email,
    route: '/crm',
  }));
  return {
    results: slice,
    hasMore: matched.length > slice.length,
    total: matched.length,
  };
}

function searchQuotesServer(
  quotes: NonNullable<OrchestratorRequest['staffContext']>['quotes'],
  query: string,
  limit: number
) {
  const q = query.trim().toLowerCase();
  const browse = !q || /^(all|list|browse|quotes?|recent|latest)$/i.test(q);
  const storeQuotes = (Array.isArray(getDataStore().quotes) ? getDataStore().quotes as Array<Record<string, unknown>> : [])
    .map((quote) => ({
      id: String(quote.id ?? ''),
      customerName: String(quote.customerName ?? ''),
      tradeName: String(quote.tradeName ?? quote.tradeId ?? ''),
      total: Number(quote.total ?? quote.totalCustomerCost ?? 0),
      status: String(quote.status ?? ''),
    }));
  const list = (quotes?.length ? quotes : storeQuotes) ?? [];
  if (!list.length) return { results: [] as Array<Record<string, unknown>>, hasMore: false, total: 0 };
  const matched = browse
    ? list
    : list.filter((quote) =>
      String(quote.id ?? '').toLowerCase().includes(q)
      || String(quote.customerName ?? '').toLowerCase().includes(q)
      || String(quote.tradeName ?? '').toLowerCase().includes(q)
      || String(quote.status ?? '').toLowerCase().includes(q)
    );
  const slice = matched.slice(0, limit).map((quote) => {
    const spokenTotal = formatSpokenGbp(quote.total);
    return {
      id: quote.id,
      title: `${quote.id} • ${quote.customerName}`,
      subtitle: `${quote.tradeName ?? 'Trade'} • ${spokenTotal} • ${quote.status}`,
      customerName: quote.customerName,
      tradeName: quote.tradeName,
      total: quote.total,
      spokenTotal,
      status: quote.status,
      route: '/quotes',
    };
  });
  return {
    results: slice,
    hasMore: matched.length > slice.length,
    total: matched.length,
  };
}

function searchProjectsServer(query: string, limit: number, status?: string) {
  const q = query.trim().toLowerCase();
  const statusQ = String(status || '').trim().toLowerCase();
  const projects = getDataStore().projects as Array<Record<string, unknown>>;
  const openish = new Set(['open', 'active', 'in_progress', 'in progress', 'ongoing']);
  const wantsOpen = openish.has(q) || openish.has(statusQ) || q === 'all open' || q === 'open projects';
  return projects
    .filter((p) => {
      const name = String(p.projectName ?? '').toLowerCase();
      const customer = String(p.customerName ?? '').toLowerCase();
      const id = String(p.id ?? '').toLowerCase();
      const st = String(p.status ?? '').toLowerCase();
      if (wantsOpen) return st && st !== 'completed' && st !== 'cancelled' && st !== 'canceled';
      if (statusQ && !st.includes(statusQ)) return false;
      if (!q) return true;
      return name.includes(q) || customer.includes(q) || id.includes(q) || st.includes(q);
    })
    .slice(0, limit)
    .map((p) => {
      const customerId = String(p.customerId ?? '');
      const customer = customerId
        ? (getDataStore().customers as Array<Record<string, unknown>>)
          .find((c) => String(c.id) === customerId)
        : undefined;
      const address = String(
        p.address ?? p.siteAddress ?? customer?.address ?? '',
      ).trim();
      const customerPhone = String(
        p.customerPhone ?? customer?.phone ?? '',
      ).trim();
      return {
        id: String(p.id ?? ''),
        title: `${String(p.projectName ?? 'Project')} (${String(p.id ?? '')})`,
        subtitle: `${String(p.customerName ?? '')} • ${String(p.status ?? '')}`,
        customerName: String(p.customerName ?? ''),
        customerId,
        customerPhone: customerPhone || null,
        address: address || null,
        assignedBuilder: String(p.assignedBuilder ?? '') || null,
        status: String(p.status ?? ''),
        route: '/projects',
      };
    });
}

export function executeBusinessSnapshot(body: OrchestratorRequest): Record<string, unknown> {
  const store = getDataStore();
  const storeCustomers = (store.customers as Array<Record<string, unknown>> || []).map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
  }));
  const storeQuotes = (Array.isArray(store.quotes) ? store.quotes as Array<Record<string, unknown>> : []).map((q) => ({
    id: String(q.id ?? ''),
    customerName: String(q.customerName ?? ''),
    trade: String(q.tradeName ?? q.tradeId ?? ''),
    total: Number(q.total ?? q.totalCustomerCost ?? 0),
    status: String(q.status ?? ''),
  }));
  const customers = (body.staffContext?.customers?.length
    ? body.staffContext.customers
    : storeCustomers);
  const quotes = (body.staffContext?.quotes?.length
    ? body.staffContext.quotes.map((q) => ({
      id: q.id,
      customerName: q.customerName,
      trade: q.tradeName ?? q.tradeId,
      total: q.total,
      status: q.status,
    }))
    : storeQuotes);
  const office = getOfficeTeamCounts();
  const activeProjects = store.projects
    .filter((p) => {
      const st = String(p.status ?? '').toLowerCase();
      return st && st !== 'completed' && st !== 'cancelled' && st !== 'canceled';
    });
  const recentQuotes = quotes.slice(0, 10).map((q) => {
    const total = Number(q.total ?? 0);
    return {
      ...q,
      total,
      spokenTotal: formatSpokenGbp(total),
    };
  });
  const highest = [...quotes].sort((a, b) => Number(b.total ?? 0) - Number(a.total ?? 0))[0];
  const highestSpoken = highest ? formatSpokenGbp(Number(highest.total ?? 0)) : null;
  const nameList = customers.slice(0, 15).map((c) => c.name).filter(Boolean);
  return {
    customerCount: customers.length,
    quoteCount: quotes.length,
    projectCount: store.projects.length,
    openProjectCount: activeProjects.length,
    builderCount: body.businessSnapshot?.builderCount ?? store.builders.length,
    officeStaffCount: body.businessSnapshot?.officeStaffCount ?? office.officeStaffCount,
    managerCount: body.businessSnapshot?.managerCount ?? office.managerCount,
    salesStaffCount: body.businessSnapshot?.salesStaffCount ?? office.salesStaffCount,
    recentCustomers: customers.slice(0, 15).map((c) => ({ id: c.id, name: c.name })),
    recentQuotes,
    highestQuote: highest
      ? {
          id: highest.id,
          customerName: highest.customerName,
          trade: highest.trade,
          total: Number(highest.total ?? 0),
          spokenTotal: highestSpoken,
        }
      : null,
    activeProjects: activeProjects
      .slice(0, 10)
      .map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.projectName ?? 'Project'),
        customer: String(p.customerName ?? ''),
        status: String(p.status ?? ''),
      })),
    builders: store.builders.slice(0, 20).map((b) => ({
      id: String(b.id ?? ''),
      name: String(b.name ?? b.companyName ?? 'Builder'),
    })),
    spokenHint: highestSpoken
      ? `You've got ${customers.length} customers on the books, ${activeProjects.length} open projects, and ${quotes.length} quotes. Highest quote is ${highestSpoken}${highest?.customerName ? ` for ${highest.customerName}` : ''}. Recent customers: ${nameList.slice(0, 8).join(', ')}.`
      : `You've got ${customers.length} customers on the books, ${activeProjects.length} open projects, and ${quotes.length} quotes. Recent customers: ${nameList.slice(0, 8).join(', ')}.`,
  };
}

export const SERVER_READ_TOOLS = new Set([
  'searchCustomers',
  'searchProjects',
  'searchQuotes',
  'searchLeads',
  'lookupQuote',
  'lookupProjectStatus',
  'getPortalLink',
  'getBusinessSnapshot',
  'getTeamPerformance',
  'getProjectProfit',
  'getCostBreakdown',
  'readData',
]);

type LeadCustomer = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  status?: string;
  source?: string;
  leadScore?: number;
  nextFollowUp?: string;
  budget?: string;
  notes?: string;
};

function readLeadCustomers(body: OrchestratorRequest): LeadCustomer[] {
  const fromStaff = body.staffContext?.customers ?? [];
  const fromData = body.dataContext?.customers;
  const dataList = Array.isArray(fromData) ? fromData as LeadCustomer[] : [];
  const byId = new Map<string, LeadCustomer>();
  for (const c of fromStaff) byId.set(c.id, c as LeadCustomer);
  for (const c of dataList) {
    const existing = byId.get(String(c.id ?? ''));
    byId.set(String(c.id ?? ''), { ...existing, ...c });
  }
  return [...byId.values()];
}

export function executeGetTeamPerformance(body: OrchestratorRequest): Record<string, unknown> {
  const role = getRequestRole(body);
  if (role !== 'super_admin' && role !== 'manager' && role !== 'staff') {
    return {
      allowed: false,
      message: 'Team roster is available to office staff only.',
      spokenHint: 'I cannot share the staff roster on this account.',
    };
  }
  const members = listTeamMembers();
  const roster = members.map((m) => ({
    id: m.id,
    name: m.name,
    phone: m.phone,
    role: m.role,
    hasPhonePin: Boolean(m.phonePinHash),
  }));
  // Legacy snapshot roster as fallback when no registered team phones
  const legacy = getOfficeTeamRoster().map((m) => ({
    id: m.id,
    name: m.name,
    phone: m.phone,
    role: m.role,
    hasPhonePin: false,
  }));
  const useRoster = roster.length ? roster : legacy;
  const spokenNames = useRoster
    .slice(0, 12)
    .map((m) => `${m.name}, ${String(m.role).replace(/_/g, ' ')}`)
    .join('; ');
  const topPerformer = roster.length
    ? null
    : ([...getOfficeTeamRoster()].sort((a, b) => b.performance.revenue - a.performance.revenue)[0]
      ?? getTopPerformer());
  return {
    allowed: true,
    roster: useRoster,
    registeredStaffCount: roster.length,
    topPerformer: topPerformer ?? null,
    managerCount: useRoster.filter((m) => m.role === 'manager' || m.role === 'super_admin').length,
    salesStaffCount: useRoster.filter((m) => m.role === 'staff').length,
    spokenHint: useRoster.length
      ? `You've got ${useRoster.length} registered team members: ${spokenNames}.`
      : 'No registered team members on file yet.',
  };
}

export function executeSearchLeads(
  input: Record<string, unknown>,
  body: OrchestratorRequest
): Record<string, unknown> {
  const customers = readLeadCustomers(body);
  const query = firstString(input.query)?.toLowerCase() ?? '';
  const statusFilter = firstString(input.status)?.toLowerCase();
  const sourceFilter = firstString(input.source)?.toLowerCase();
  const limit = Number(input.limit) || 10;

  const results = customers
    .filter((c) => {
      const status = String(c.status ?? '').toLowerCase();
      if (statusFilter && status !== statusFilter) return false;
      const isLead =
        status === 'lead'
        || status === 'quoted'
        || status === 'won'
        || status === 'lost'
        || Boolean(c.source);
      if (!isLead && !query) return false;
      if (sourceFilter && String(c.source ?? '').toLowerCase() !== sourceFilter) return false;
      if (!query) return true;
      return (
        includesQuery(String(c.name ?? ''), query)
        || includesQuery(String(c.email ?? ''), query)
        || includesQuery(String(c.phone ?? ''), query)
        || includesQuery(String(c.source ?? ''), query)
        || includesQuery(String(c.notes ?? ''), query)
        || includesQuery(status, query)
      );
    })
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status ?? 'lead',
      source: c.source ?? null,
      leadScore: c.leadScore ?? null,
      nextFollowUp: c.nextFollowUp ?? null,
      budget: c.budget ?? null,
      email: c.email ?? '',
      phone: c.phone ?? '',
      route: '/crm',
    }));

  return {
    query: query || null,
    status: statusFilter ?? null,
    source: sourceFilter ?? null,
    count: results.length,
    results,
  };
}

export function executeUpdateLeadStatus(input: Record<string, unknown>): Record<string, unknown> {
  return {
    clientExecute: true,
    instruction: 'Update the customer lead status on the client via updateCustomer.',
    customerId: firstString(input.customerId) ?? null,
    status: firstString(input.status) ?? null,
    note: firstString(input.note) ?? null,
  };
}

function findProjectByIdOrName(
  projects: Array<Record<string, unknown>>,
  projectId?: string,
  projectName?: string
): Record<string, unknown> | undefined {
  if (projectId) {
    const byId = projects.find((p) => String(p.id ?? '') === projectId);
    if (byId) return byId;
  }
  if (projectName) {
    const q = projectName.toLowerCase();
    return projects.find((p) => {
      const name = String(p.projectName ?? '').toLowerCase();
      const customer = String(p.customerName ?? '').toLowerCase();
      return name.includes(q) || customer.includes(q) || q.includes(name);
    });
  }
  return undefined;
}

function computeProjectProfit(project: Record<string, unknown>) {
  const costEntries = Array.isArray(project.costEntries) ? project.costEntries as Array<Record<string, unknown>> : [];
  const timesheets = Array.isArray(project.timesheets) ? project.timesheets as Array<Record<string, unknown>> : [];
  const builderPayments = Array.isArray(project.builderPayments) ? project.builderPayments as Array<Record<string, unknown>> : [];
  const invoices = Array.isArray(project.invoices) ? project.invoices as Array<Record<string, unknown>> : [];

  const materialCosts = costEntries.reduce((sum, e) => sum + Number(e.total ?? 0), 0);
  const labourCosts = timesheets.reduce((sum, t) => sum + Number(t.labourCost ?? 0), 0);
  const otherCosts = builderPayments
    .filter((p) => String(p.status ?? '') !== 'pending')
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  const paidInvoices = invoices
    .filter((inv) => String(inv.status ?? '') === 'paid')
    .reduce((sum, inv) => sum + Number(inv.total ?? 0), 0);
  const revenue = paidInvoices > 0 ? paidInvoices : Number(project.totalCustomerCost ?? 0);
  const totalCosts = materialCosts + labourCosts + otherCosts;
  const grossProfit = revenue - totalCosts;
  const totalHours = timesheets.reduce((sum, t) => sum + Number(t.hours ?? 0), 0);

  const categoryBreakdown: Record<string, number> = {};
  for (const entry of costEntries) {
    const items = Array.isArray(entry.items) ? entry.items as Array<Record<string, unknown>> : [];
    for (const item of items) {
      const cat = String(item.category ?? 'other');
      categoryBreakdown[cat] = (categoryBreakdown[cat] ?? 0) + Number(item.total ?? 0);
    }
  }

  return {
    projectId: String(project.id ?? ''),
    projectName: String(project.projectName ?? 'Project'),
    customerName: String(project.customerName ?? ''),
    status: String(project.status ?? ''),
    revenue,
    materialCosts,
    labourCosts,
    otherCosts,
    totalCosts,
    grossProfit,
    marginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
    totalHours,
    costEntryCount: costEntries.length,
    flaggedCount: costEntries.filter((e) => String(e.status ?? '') === 'flagged').length,
    categoryBreakdown,
  };
}

function mergeCollectionData(
  body: OrchestratorRequest,
  collection: DataCollection
): Record<string, unknown>[] | Record<string, unknown> | null {
  const ctx = body.dataContext ?? {};
  const fromClient = ctx[collection];
  const store = getDataStore();

  if (collection === 'projects') {
    const serverProjects = (store.projects ?? []) as Record<string, unknown>[];
    const clientProjects = Array.isArray(fromClient) ? (fromClient as Record<string, unknown>[]) : [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const p of serverProjects) byId.set(String(p.id ?? ''), p);
    for (const p of clientProjects) byId.set(String(p.id ?? ''), { ...byId.get(String(p.id ?? '')) ?? {}, ...p });
    return [...byId.values()];
  }

  if (collection === 'builders') {
    const serverBuilders = (store.builders ?? []) as Record<string, unknown>[];
    const clientBuilders = Array.isArray(fromClient) ? (fromClient as Record<string, unknown>[]) : [];
    if (clientBuilders.length > 0) return clientBuilders;
    return serverBuilders;
  }

  if (Array.isArray(fromClient)) return fromClient as Record<string, unknown>[];
  if (fromClient && typeof fromClient === 'object') return fromClient as Record<string, unknown>;
  return null;
}

function matchesQuery(record: Record<string, unknown>, query: string): boolean {
  const q = query.toLowerCase();
  return Object.values(record).some((v) => {
    if (typeof v === 'string') return v.toLowerCase().includes(q);
    if (typeof v === 'number') return String(v).includes(q);
    return false;
  });
}

export function executeReadData(
  input: Record<string, unknown>,
  body: OrchestratorRequest
): Record<string, unknown> {
  const collection = String(input.collection ?? '') as DataCollection;
  const policyCtx = buildPolicyContext(body);
  const role = getRequestRole(body);

  if (!canReadCollection(role, collection)) {
    return {
      collection,
      allowed: false,
      message: 'You do not have access to this data.',
      records: [],
      count: 0,
    };
  }

  const raw = mergeCollectionData(body, collection);
  if (raw === null) {
    return { collection, allowed: true, records: [], count: 0, message: 'No data in this collection.' };
  }

  if (!Array.isArray(raw)) {
    const redacted = redactRecord(role, raw);
    return { collection, allowed: true, record: redacted, count: 1 };
  }

  let records = filterRecordsForRole(collection, raw, policyCtx);
  const id = firstString(input.id);
  if (id) {
    records = records.filter((r) => String(r.id ?? '') === id);
  }
  const query = firstString(input.query);
  if (query) {
    records = records.filter((r) => matchesQuery(r, query));
  }
  const limit = Number(input.limit) || 20;
  records = records.slice(0, limit);
  const redacted = redactRecords(role, records);

  return {
    collection,
    allowed: true,
    count: redacted.length,
    records: redacted,
  };
}

function executeCostingReadTool(
  toolName: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest
): Record<string, unknown> {
  const store = getDataStore();
  const projects = store.projects as Array<Record<string, unknown>>;
  const projectId = firstString(input.projectId, body.projectContext?.projectId);
  const projectName = firstString(input.projectName);
  const project = findProjectByIdOrName(projects, projectId, projectName);

  if (!project) {
    return { found: false, message: 'Project not found. Provide projectId or projectName.' };
  }

  const profit = computeProjectProfit(project);

  if (toolName === 'getProjectProfit') {
    return { found: true, ...profit };
  }

  const costEntries = Array.isArray(project.costEntries) ? project.costEntries : [];
  const timesheets = Array.isArray(project.timesheets) ? project.timesheets : [];

  return {
    found: true,
    ...profit,
    costEntries: costEntries.map((e: Record<string, unknown>) => ({
      id: String(e.id ?? ''),
      supplier: String(e.supplier ?? ''),
      total: Number(e.total ?? 0),
      status: String(e.status ?? ''),
      aiSummary: String(e.aiSummary ?? ''),
      items: Array.isArray(e.items) ? e.items : [],
    })),
    timesheets: timesheets.map((t: Record<string, unknown>) => ({
      id: String(t.id ?? ''),
      builderId: String(t.builderId ?? ''),
      hours: Number(t.hours ?? 0),
      rate: Number(t.rate ?? 0),
      labourCost: Number(t.labourCost ?? 0),
      clockIn: String(t.clockIn ?? ''),
      clockOut: t.clockOut ? String(t.clockOut) : null,
    })),
  };
}

export async function executeServerReadTool(
  toolName: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest
): Promise<Record<string, unknown>> {
  const role = getRequestRole(body);
  const limit = Number(input.limit) || 15;
  let output: Record<string, unknown>;

  if (toolName === 'searchCustomers') {
    const query = String(input.query ?? 'list');
    const { results, hasMore, total } = searchCustomersServer(body.staffContext?.customers, query, limit);
    const names = results.map((r) => String(r.name || r.title || '')).filter(Boolean);
    output = {
      query,
      count: results.length,
      total,
      hasMore,
      results,
      spokenHint: results.length
        ? `I found ${total} customer${total === 1 ? '' : 's'}. ${hasMore ? `Here are the first ${results.length}: ` : ''}${names.join(', ')}.`
        : 'No customers matched that search.',
    };
  } else if (toolName === 'searchQuotes') {
    const query = String(input.query ?? 'list');
    const { results, hasMore, total } = searchQuotesServer(body.staffContext?.quotes, query, limit);
    const top = results[0];
    output = {
      query,
      count: results.length,
      total,
      hasMore,
      results,
      spokenHint: top
        ? `${String(top.customerName || 'A quote')} for ${String(top.tradeName || 'work')} is ${String(top.spokenTotal)}. ${total > 1 ? `Showing ${results.length} of ${total}.` : ''}`
        : 'No quotes matched that search.',
    };
  } else if (toolName === 'searchProjects') {
    const query = String(input.query ?? input.status ?? 'open');
    const results = searchProjectsServer(query, limit, firstString(input.status));
    output = { query, count: results.length, results };
  } else if (toolName === 'getBusinessSnapshot') {
    output = executeBusinessSnapshot(body);
  } else if (toolName === 'getTeamPerformance') {
    output = executeGetTeamPerformance(body);
  } else if (toolName === 'searchLeads') {
    output = executeSearchLeads(input, body);
  } else if (toolName === 'getProjectProfit' || toolName === 'getCostBreakdown') {
    output = executeCostingReadTool(toolName, input, body);
  } else if (toolName === 'readData') {
    output = executeReadData(input, body);
  } else if (
    toolName === 'lookupQuote'
    || toolName === 'lookupProjectStatus'
    || toolName === 'getPortalLink'
    || toolName === 'escalateToStaff'
  ) {
    output = executeCustomerTool(toolName, input, body);
  } else {
    output = input;
  }

  return scrubOutput(output, role);
}
