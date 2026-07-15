import {
  getDataStore,
  saveCustomerRecord,
  saveQuoteRecord,
  updateQuoteRecord,
  syncData,
  getProjectById,
} from './data-store';
import { canExecuteActionForRole, type ServerAgentRole } from './role-permissions';
import { executeServerReadTool, executeCustomerTool } from './orchestrator-tool-exec';
import { executeChannelWrite } from './channel-writes';
import { lookupQuotesFromStore, formatQuoteBreakdownText } from './quote-lookup';
import { researchTaskPrices, pickHigherEnd } from './price-research-service';
import { savePendingConfirmation, consumePendingConfirmation } from './conversation-store';
import type { OrchestratorRequest } from './orchestrator-types';
import { randomBytes } from 'crypto';
import { emitAgentActivity } from './agent-activity';
import { resolveStaffUserId } from './cynthia-staff-store';

/** Staff user targeted by the live activity feed (explicit context first, then registered phone). */
function activityTargetUser(ctx: { orgId: string; phone?: string; orchestratorBody?: OrchestratorRequest }): string | null {
  const explicit = ctx.orchestratorBody?.staffContext?.userId?.trim();
  if (explicit && explicit !== 'default-staff') return explicit;
  return resolveStaffUserId({ staffPhone: ctx.phone, orgId: ctx.orgId });
}

export const CONFIRM_ACTIONS = new Set([
  'sendContract',
  'approveQuote',
  'rejectQuote',
  'draftInvoice',
  'sendEmailReply',
  'sendEmailWithAttachment',
  'notifyCustomerChangeOrder',
]);

export const CUSTOMER_ALLOWED_ACTIONS = new Set([
  'lookupQuote',
  'lookupProjectStatus',
  'approveChangeOrder',
  'rejectChangeOrder',
  'sendPaymentLink',
  'confirmHandover',
  'confirmContract',
  'escalateToStaff',
  'getPortalLink',
  'bookSurvey',
]);

export interface ChannelActionResult {
  action: string;
  executed: boolean;
  summary: string;
  output: Record<string, unknown>;
  needsConfirm?: boolean;
  confirmPrompt?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function parseTaskList(raw: string): string[] {
  return raw
    .split(/\r?\n|;|\u2022|(?:^|\s)\d+[.)]\s|,(?=\s*[a-zA-Z])/g)
    .map((s) => s.replace(/^[-*\s]+/, '').trim())
    .filter((s) => s.length > 1);
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
}

function resolveCustomer(input: Record<string, unknown>) {
  const store = getDataStore();
  const customerId = firstString(input.customerId);
  if (customerId) {
    const byId = store.customers.find((c) => String(c.id) === customerId);
    if (byId) return byId;
  }
  const name = firstString(input.customerName, input.name);
  if (name) {
    const lower = name.toLowerCase();
    return store.customers.find((c) => String(c.name ?? '').toLowerCase().includes(lower));
  }
  return undefined;
}

async function execPriceSmallJob(
  input: Record<string, unknown>,
  role: ServerAgentRole,
  approvedBy?: string
): Promise<ChannelActionResult> {
  if (!canExecuteActionForRole(role, 'priceSmallJob')) {
    return { action: 'priceSmallJob', executed: false, summary: 'Not permitted.', output: input };
  }
  const rawTasks = Array.isArray(input.tasks)
    ? (input.tasks as unknown[]).map(String).join('\n')
    : firstString(input.tasks, input.taskList) ?? '';
  if (!rawTasks.trim()) {
    return { action: 'priceSmallJob', executed: false, summary: 'Provide tasks to price.', output: input };
  }
  const customer = resolveCustomer(input);
  const tasks = parseTaskList(rawTasks);
  const { items: lines } = await researchTaskPrices(tasks, {
    tradeName: firstString(input.tradeName) ?? 'Small Jobs',
    postcode: firstString(input.postcode) ?? String(customer?.address ?? ''),
    orgId: (input as { orgId?: string }).orgId ?? null,
  });
  const quoteItems = lines.map((line, idx) => {
    const price = pickHigherEnd(line);
    return {
      productId: `task-${idx}`,
      name: line.task,
      quantity: 1,
      price,
      total: price,
    };
  });
  const total = quoteItems.reduce((s, i) => s + i.total, 0);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 14);
  const quote = saveQuoteRecord({
    customerId: customer?.id ?? '',
    customerName: customer?.name ?? firstString(input.customerName) ?? 'Customer',
    tradeName: firstString(input.tradeName) ?? 'Small Jobs',
    expiresAt: expiresAt.toISOString(),
    items: quoteItems,
    labour: [],
    extras: [],
    discount: 0,
    total,
    status: 'awaiting_approval',
    pricingResearch: { lines, provider: 'openai' },
    approval: { state: 'pending', originalTotal: total },
    createdBy: approvedBy ?? 'AI',
  });
  const breakdown = lines.map((l) => `${l.task}: low £${l.low} / typical £${l.typical} / high £${l.high}`).join('\n');
  return {
    action: 'priceSmallJob',
    executed: true,
    summary: `Priced ${quoteItems.length} task(s) at £${total.toLocaleString('en-GB')} — in approval queue (${quote.id}).`,
    output: {
      ...input,
      quoteId: quote.id,
      total,
      items: quoteItems,
      pricingResearch: { lines },
      breakdownText: breakdown,
    },
  };
}

function execSubmitForApproval(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'submitForApproval')) {
    return { action: 'submitForApproval', executed: false, summary: 'Not permitted.', output: input };
  }
  const store = getDataStore();
  const quoteId = firstString(input.quoteId);
  const quote = quoteId
    ? store.quotes.find((q) => String(q.id) === quoteId)
    : store.quotes[0];
  if (!quote) {
    return { action: 'submitForApproval', executed: false, summary: 'No quote found.', output: input };
  }
  updateQuoteRecord(String(quote.id), {
    status: 'awaiting_approval',
    approval: { state: 'pending', originalTotal: quote.total },
  });
  return {
    action: 'submitForApproval',
    executed: true,
    summary: `Quote ${quote.id} submitted for approval.`,
    output: { ...input, quoteId: quote.id },
  };
}

function execApproveQuote(input: Record<string, unknown>, role: ServerAgentRole, approved: boolean, approvedBy?: string): ChannelActionResult {
  const action = approved ? 'approveQuote' : 'rejectQuote';
  if (!canExecuteActionForRole(role, action)) {
    return { action, executed: false, summary: 'Only managers can approve or reject quotes.', output: input };
  }
  const store = getDataStore();
  const quoteId = firstString(input.quoteId);
  const quote = quoteId ? store.quotes.find((q) => String(q.id) === quoteId) : undefined;
  if (!quote) {
    return { action, executed: false, summary: 'Specify quoteId.', output: input };
  }
  const total = Number(input.total ?? quote.total);
  updateQuoteRecord(String(quote.id), {
    status: approved ? 'approved' : 'rejected',
    total,
    approval: {
      state: approved ? 'approved' : 'rejected',
      by: approvedBy ?? 'Manager',
      at: new Date().toISOString(),
      note: firstString(input.note),
      originalTotal: (quote.approval as { originalTotal?: number })?.originalTotal ?? quote.total,
    },
  });
  return {
    action,
    executed: true,
    summary: approved
      ? `Approved quote ${quote.id} at £${total.toLocaleString('en-GB')}.`
      : `Rejected quote ${quote.id}.`,
    output: { ...input, quoteId: quote.id, total },
  };
}

function execSaveCustomer(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'saveCustomer') && !canExecuteActionForRole(role, 'linkCustomer')) {
    return { action: 'saveCustomer', executed: false, summary: 'Not permitted.', output: input };
  }
  const name = firstString(input.name, input.customerName);
  if (!name) {
    return { action: 'saveCustomer', executed: false, summary: 'Customer name required.', output: input };
  }
  const record = saveCustomerRecord({
    id: firstString(input.customerId, input.id),
    name,
    email: firstString(input.email) ?? '',
    phone: firstString(input.phone) ?? '',
    address: firstString(input.address) ?? '',
    status: firstString(input.status) ?? 'lead',
    source: firstString(input.source) ?? 'whatsapp',
    preferredLanguage: firstString(input.preferredLanguage),
    notes: firstString(input.notes) ?? '',
  });
  return {
    action: 'saveCustomer',
    executed: true,
    summary: `Saved customer ${record.name}.`,
    output: { ...input, customerId: record.id, customerName: record.name },
  };
}

function execUpdateLeadStatus(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'updateLeadStatus')) {
    return { action: 'updateLeadStatus', executed: false, summary: 'Not permitted.', output: input };
  }
  const customerId = firstString(input.customerId);
  const status = firstString(input.status);
  if (!customerId || !status) {
    return { action: 'updateLeadStatus', executed: false, summary: 'Need customerId and status.', output: input };
  }
  const store = getDataStore();
  const customer = store.customers.find((c) => String(c.id) === customerId);
  if (!customer) {
    return { action: 'updateLeadStatus', executed: false, summary: 'Customer not found.', output: input };
  }
  const note = firstString(input.note);
  const notes = note ? `${String(customer.notes ?? '')}\n${note}`.trim() : customer.notes;
  saveCustomerRecord({ ...customer, status, notes, lastContact: new Date().toISOString() });
  return {
    action: 'updateLeadStatus',
    executed: true,
    summary: `Updated ${customer.name} to ${status}.`,
    output: { ...input, customerId, status },
  };
}

function execLogFollowUp(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'logFollowUp')) {
    return { action: 'logFollowUp', executed: false, summary: 'Not permitted.', output: input };
  }
  const customerId = firstString(input.customerId);
  if (!customerId) {
    return { action: 'logFollowUp', executed: false, summary: 'Need customerId.', output: input };
  }
  const store = getDataStore();
  const customer = store.customers.find((c) => String(c.id) === customerId);
  if (!customer) {
    return { action: 'logFollowUp', executed: false, summary: 'Customer not found.', output: input };
  }
  const note = firstString(input.note) ?? 'Follow-up via channel';
  const nextFollowUp = firstString(input.nextFollowUp);
  const notes = `${String(customer.notes ?? '')}\n[${new Date().toISOString().slice(0, 10)}] ${note}`.trim();
  saveCustomerRecord({
    ...customer,
    notes,
    lastContact: new Date().toISOString(),
    ...(nextFollowUp ? { nextFollowUp } : {}),
  });
  return {
    action: 'logFollowUp',
    executed: true,
    summary: `Follow-up logged for ${customer.name}.`,
    output: { ...input, customerId },
  };
}

function execSaveQuote(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'saveQuote')) {
    return { action: 'saveQuote', executed: false, summary: 'Not permitted.', output: input };
  }
  const customer = resolveCustomer(input);
  const items = Array.isArray(input.items) ? input.items : [];
  const total = Number(input.total ?? 0) || items.reduce((s: number, i: Record<string, unknown>) => s + Number(i.total ?? i.price ?? 0), 0);
  const quote = saveQuoteRecord({
    id: firstString(input.quoteId, input.id),
    customerId: customer?.id ?? firstString(input.customerId) ?? '',
    customerName: customer?.name ?? firstString(input.customerName) ?? 'Customer',
    tradeName: firstString(input.tradeName, input.tradeId) ?? 'General',
    items,
    labour: Array.isArray(input.labour) ? input.labour : [],
    extras: Array.isArray(input.extras) ? input.extras : [],
    total,
    status: firstString(input.status) ?? 'draft',
    expiresAt: firstString(input.expiresAt) ?? new Date(Date.now() + 14 * 86400000).toISOString(),
  });
  return {
    action: 'saveQuote',
    executed: true,
    summary: `Saved quote ${quote.id} (£${total.toLocaleString('en-GB')}).`,
    output: { ...input, quoteId: quote.id, total },
  };
}

function execUpdateQuote(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'updateQuote')) {
    return { action: 'updateQuote', executed: false, summary: 'Not permitted.', output: input };
  }
  const quoteId = firstString(input.quoteId);
  if (!quoteId) {
    return { action: 'updateQuote', executed: false, summary: 'quoteId required.', output: input };
  }
  const updated = updateQuoteRecord(quoteId, input);
  if (!updated) {
    return { action: 'updateQuote', executed: false, summary: 'Quote not found.', output: input };
  }
  return {
    action: 'updateQuote',
    executed: true,
    summary: `Updated quote ${quoteId}.`,
    output: { ...input, quoteId },
  };
}

async function execGeneratePaymentSchedule(input: Record<string, unknown>, role: ServerAgentRole): Promise<ChannelActionResult> {
  if (!canExecuteActionForRole(role, 'generatePaymentSchedule')) {
    return { action: 'generatePaymentSchedule', executed: false, summary: 'Not permitted.', output: input };
  }
  const store = getDataStore();
  const quoteId = firstString(input.quoteId);
  const quote = quoteId ? store.quotes.find((q) => String(q.id) === quoteId) : undefined;
  const total = Number(input.total ?? quote?.total ?? 0);
  if (total <= 0) {
    return { action: 'generatePaymentSchedule', executed: false, summary: 'Need a total.', output: input };
  }
  const deposit = Math.round(total * 0.3);
  const mid = Math.round(total * 0.4);
  const final = total - deposit - mid;
  const stages = [
    { label: 'Deposit', description: 'Booking deposit', percent: 30, amount: deposit, dueTrigger: 'on_signing', status: 'pending' },
    { label: 'Mid payment', description: 'Progress payment', percent: 40, amount: mid, dueTrigger: 'milestone', status: 'pending' },
    { label: 'Final balance', description: 'On completion', percent: 30, amount: final, dueTrigger: 'completion', status: 'pending' },
  ];
  return {
    action: 'generatePaymentSchedule',
    executed: true,
    summary: `Suggested schedule: deposit £${deposit}, mid £${mid}, final £${final}.`,
    output: { ...input, stages, total },
  };
}

function execSaveContract(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'saveContract')) {
    return { action: 'saveContract', executed: false, summary: 'Not permitted.', output: input };
  }
  const store = getDataStore();
  const quoteId = firstString(input.quoteId);
  const quote = quoteId ? store.quotes.find((q) => String(q.id) === quoteId) : undefined;
  if (!quote || String(quote.status) !== 'approved') {
    return { action: 'saveContract', executed: false, summary: 'Need an approved quote.', output: input };
  }
  const customer = store.customers.find((c) => String(c.id) === String(quote.customerId));
  const stages = Array.isArray(input.stages) ? input.stages : [];
  const deposit = stages.length
    ? Number((stages[0] as Record<string, unknown>).amount ?? 0)
    : Math.round(Number(quote.total) * 0.3);
  const id = `CT${Date.now()}`;
  const signToken = randomBytes(24).toString('hex');
  const contract = {
    id,
    customerId: String(quote.customerId ?? ''),
    customerName: String(quote.customerName ?? customer?.name ?? 'Customer'),
    quoteId: String(quote.id),
    tradeName: quote.tradeName,
    total: quote.total,
    depositAmount: deposit,
    stages: stages.length ? stages : [
      { label: 'Deposit', description: 'Booking deposit', percent: 30, amount: deposit, dueTrigger: 'on_signing', status: 'pending' },
    ],
    bodyRendered: `Contract for ${quote.customerName} — ${quote.tradeName} — £${Number(quote.total).toLocaleString('en-GB')}`,
    status: 'draft',
    createdAt: new Date().toISOString(),
    signToken,
    signTokenExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  };
  store.contracts = [contract, ...(store.contracts ?? [])];
  syncData(store);
  return {
    action: 'saveContract',
    executed: true,
    summary: `Draft contract ${id} saved.`,
    output: { ...input, contractId: id },
  };
}

function execNavigateTo(input: Record<string, unknown>): ChannelActionResult {
  const route = firstString(input.route, input.path) ?? '/';
  const base = appBaseUrl();
  const link = base ? `${base}${route.startsWith('/') ? route : `/${route}`}` : route;
  return {
    action: 'navigateTo',
    executed: true,
    summary: `Open: ${link}`,
    output: { ...input, route, deepLink: link },
  };
}

function execUpdateProject(input: Record<string, unknown>, role: ServerAgentRole): ChannelActionResult {
  if (!canExecuteActionForRole(role, 'updateTaskStatus') && !canExecuteActionForRole(role, 'updateProject')) {
    return { action: 'updateTaskStatus', executed: false, summary: 'Not permitted.', output: input };
  }
  const projectId = firstString(input.projectId);
  const store = getDataStore();
  const idx = store.projects.findIndex((p) => String(p.id) === projectId);
  if (idx < 0) {
    return { action: 'updateTaskStatus', executed: false, summary: 'Project not found.', output: input };
  }
  const project = { ...store.projects[idx] };
  if (input.taskId && Array.isArray(project.tasks)) {
    project.tasks = (project.tasks as Array<Record<string, unknown>>).map((t) =>
      String(t.id) === String(input.taskId)
        ? { ...t, status: firstString(input.status) ?? 'completed' }
        : t
    );
  }
  if (input.status) project.status = input.status;
  store.projects[idx] = project;
  syncData(store);
  return {
    action: 'updateTaskStatus',
    executed: true,
    summary: `Updated project ${projectId}.`,
    output: { ...input, projectId },
  };
}

function execEscalate(input: Record<string, unknown>): ChannelActionResult {
  const projectId = firstString(input.projectId);
  if (projectId) {
    const store = getDataStore();
    const idx = store.projects.findIndex((p) => String(p.id) === projectId);
    if (idx >= 0) {
      store.projects[idx] = { ...store.projects[idx], escalated: true };
      syncData(store);
    }
  }
  return {
    action: 'escalateToStaff',
    executed: true,
    summary: 'Escalated to office team.',
    output: { ...input, queued: true },
  };
}

function execLookupQuote(input: Record<string, unknown>, body: OrchestratorRequest): ChannelActionResult {
  const result = lookupQuotesFromStore({
    quoteId: firstString(input.quoteId, body.customerContext?.quoteId),
    customerId: firstString(input.customerId, body.customerContext?.customerId),
  });
  const quotes = (result.quotes ?? []) as Array<Record<string, unknown>>;
  const breakdown = formatQuoteBreakdownText(quotes);
  return {
    action: 'lookupQuote',
    executed: true,
    summary: quotes.length ? breakdown.split('\n')[0] : 'No quotes found.',
    output: { ...result, breakdownText: breakdown },
  };
}

export function isYesNo(text: string): 'yes' | 'no' | null {
  const t = text.trim().toLowerCase();
  if (/^(yes|y|yeah|yep|confirm|ok|okay|go ahead|approved?)$/i.test(t)) return 'yes';
  if (/^(no|n|nope|cancel|stop|reject)$/i.test(t)) return 'no';
  return null;
}

export async function executeChannelAction(
  action: string,
  input: Record<string, unknown>,
  ctx: {
    role: ServerAgentRole;
    orgId: string;
    phone?: string;
    approvedBy?: string;
    orchestratorBody?: OrchestratorRequest;
    skipConfirm?: boolean;
  }
): Promise<ChannelActionResult> {
  const { role, phone, approvedBy, orchestratorBody, skipConfirm } = ctx;
  const body = orchestratorBody ?? { messages: [] };

  if (!skipConfirm && CONFIRM_ACTIONS.has(action) && phone) {
    return {
      action,
      executed: false,
      needsConfirm: true,
      confirmPrompt: `Reply YES to confirm ${action}, or NO to cancel.`,
      summary: `Pending confirmation for ${action}.`,
      output: input,
    };
  }

  if (action === 'lookupQuote') return execLookupQuote(input, body);
  if (action === 'lookupProjectStatus' || action === 'getPortalLink') {
    const output = executeCustomerTool(action, input, body);
    return { action, executed: true, summary: action, output };
  }
  if (action === 'escalateToStaff') return execEscalate(input);

  const readTools = new Set([
    'searchCustomers', 'searchProjects', 'searchQuotes', 'searchLeads',
    'getBusinessSnapshot', 'getTeamPerformance', 'getProjectProfit', 'getCostBreakdown', 'readData',
  ]);
  if (readTools.has(action)) {
    const output = await executeServerReadTool(action, input, body);
    return { action, executed: true, summary: action, output };
  }

  switch (action) {
    case 'priceSmallJob':
      return execPriceSmallJob(input, role, approvedBy);
    case 'submitForApproval':
      return execSubmitForApproval(input, role);
    case 'approveQuote':
      return execApproveQuote(input, role, true, approvedBy);
    case 'rejectQuote':
      return execApproveQuote(input, role, false, approvedBy);
    case 'saveCustomer':
    case 'linkCustomer':
      return execSaveCustomer(input, role);
    case 'updateLeadStatus':
      return execUpdateLeadStatus(input, role);
    case 'logFollowUp':
      return execLogFollowUp(input, role);
    case 'saveQuote':
      return execSaveQuote(input, role);
    case 'updateQuote':
      return execUpdateQuote(input, role);
    case 'generatePaymentSchedule':
      return execGeneratePaymentSchedule(input, role);
    case 'saveContract':
      return execSaveContract(input, role);
    case 'navigateTo':
      return execNavigateTo(input);
    case 'updateTaskStatus':
    case 'updateProject':
      return execUpdateProject(input, role);
    default: {
      const write = await executeChannelWrite(action, input, {
        role,
        approvedBy,
        orchestratorBody: body,
        phone,
      });
      return write;
    }
  }
}

export async function executeChannelActions(
  actions: Array<{ action: string; input: Record<string, unknown>; output?: Record<string, unknown> }>,
  ctx: Parameters<typeof executeChannelAction>[2]
): Promise<ChannelActionResult[]> {
  const results: ChannelActionResult[] = [];
  const activityUser = activityTargetUser(ctx);
  for (const item of actions) {
    const merged = { ...item.input, ...item.output };
    if (CONFIRM_ACTIONS.has(item.action) && ctx.phone && !ctx.skipConfirm) {
      savePendingConfirmation(ctx.orgId, ctx.phone, item.action, merged);
      results.push({
        action: item.action,
        executed: false,
        needsConfirm: true,
        confirmPrompt: `Reply YES to confirm ${item.action.replace(/([A-Z])/g, ' $1').trim()}, or NO to cancel.`,
        summary: `Awaiting YES/NO for ${item.action}.`,
        output: merged,
      });
      continue;
    }
    if (
      item.action === 'writeData'
      && String(merged.operation ?? '') === 'delete'
      && ctx.phone
      && !ctx.skipConfirm
    ) {
      savePendingConfirmation(ctx.orgId, ctx.phone, item.action, merged);
      results.push({
        action: item.action,
        executed: false,
        needsConfirm: true,
        confirmPrompt: 'Reply YES to confirm delete, or NO to cancel.',
        summary: 'Awaiting YES/NO for writeData delete.',
        output: merged,
      });
      continue;
    }
    if (activityUser) emitAgentActivity({ orgId: ctx.orgId, targetUserId: activityUser, channel: 'channel', action: item.action, phase: 'started', summary: `Running ${item.action}…` });
    const result = await executeChannelAction(item.action, merged, ctx);
    if (activityUser) emitAgentActivity({ orgId: ctx.orgId, targetUserId: activityUser, channel: 'channel', action: item.action, phase: result.executed ? 'completed' : result.needsConfirm ? 'working' : 'error', summary: result.summary, route: typeof result.output?.route === 'string' ? String(result.output.route) : undefined });
    results.push(result);
  }
  return results;
}

export async function handleConfirmationReply(
  orgId: string,
  phone: string,
  text: string,
  ctx: Omit<Parameters<typeof executeChannelAction>[2], 'skipConfirm'>
): Promise<{ handled: boolean; reply?: string; results?: ChannelActionResult[] }> {
  const yn = isYesNo(text);
  if (!yn) return { handled: false };
  const pending = consumePendingConfirmation(orgId, phone);
  if (!pending) return { handled: false };
  if (yn === 'no') {
    return { handled: true, reply: 'Cancelled — no changes made.' };
  }
  const result = await executeChannelAction(pending.action, pending.input, {
    ...ctx,
    skipConfirm: true,
  });
  return {
    handled: true,
    reply: result.summary,
    results: [result],
  };
}

export function filterActionsForChannelMode(
  actions: Array<{ action: string; input: Record<string, unknown>; output?: Record<string, unknown> }>,
  mode: 'staff' | 'foreman' | 'customer'
): Array<{ action: string; input: Record<string, unknown>; output?: Record<string, unknown> }> {
  if (mode === 'customer') {
    return actions.filter((a) => CUSTOMER_ALLOWED_ACTIONS.has(a.action));
  }
  return actions;
}

export function appendProjectAiAction(projectId: string, action: Record<string, unknown>): void {
  const project = getProjectById(projectId);
  if (!project) return;
  const store = getDataStore();
  const idx = store.projects.findIndex((p) => String(p.id) === projectId);
  if (idx < 0) return;
  const aiActions = [...(store.projects[idx].aiActions as unknown[] ?? []), action];
  store.projects[idx] = { ...store.projects[idx], aiActions };
  syncData(store);
}
