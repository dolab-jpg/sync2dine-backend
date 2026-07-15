/**
 * Channel write tool dispatcher — full executor parity for WhatsApp/phone inbound.
 */
import { randomBytes } from 'crypto';
import {
  getDataStore,
  saveCustomerRecord,
  saveQuoteRecord,
  updateQuoteRecord,
  syncData,
} from './data-store';
import type { ServerAgentRole } from './role-permissions';
import { canExecuteActionForRole } from './role-permissions';
import type { OrchestratorRequest } from './orchestrator-types';
import {
  applyProjectWriteAction,
  approveChangeOrderServer,
  assignContractorServer,
  buildDefaultPaymentStages,
  completeHandoverServer,
  createProjectFromQuoteServer,
  markPaymentReceivedServer,
} from './project-writes';
import { autoSendReceiptAfterMarkPaidServer, sendReceiptForStageServer } from './payment-receipt-service';
import { executePlanningWrite, isPlanningWriteAction } from './planning-writes';
import { executePhoneTool } from './phone-tools';
import {
  buildPolicyContext,
  canWriteCollection,
  isRecordInScope,
  type DataCollection,
  type WriteOperation,
} from './dataPolicy';

export interface ChannelWriteResult {
  action: string;
  executed: boolean;
  summary: string;
  output: Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
}

function denied(action: string, input: Record<string, unknown>, role: ServerAgentRole): ChannelWriteResult {
  return { action, executed: false, summary: `Not permitted for role ${role}.`, output: input };
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

function parseQuoteLines(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.map((line, idx) => {
    const row = line as Record<string, unknown>;
    const qty = readOptionalNumber(row.quantity ?? row.qty) ?? 1;
    const rate = readOptionalNumber(row.rate ?? row.price ?? row.unitPrice) ?? 0;
    const total = readOptionalNumber(row.total) ?? qty * rate;
    return {
      id: String(row.id ?? `L${Date.now()}${idx}`),
      description: String(row.description ?? row.name ?? 'Line item'),
      quantity: qty,
      rate,
      total,
    };
  });
}

function findQuote(input: Record<string, unknown>) {
  const store = getDataStore();
  const quoteId = firstString(input.quoteId);
  if (quoteId) return store.quotes.find((q) => String(q.id) === quoteId);
  const customerName = firstString(input.customerName);
  if (customerName) {
    const lower = customerName.toLowerCase();
    return store.quotes.find((q) => String(q.customerName ?? '').toLowerCase().includes(lower));
  }
  return store.quotes[0];
}

export async function executeChannelWrite(
  action: string,
  input: Record<string, unknown>,
  ctx: {
    role: ServerAgentRole;
    approvedBy?: string;
    orchestratorBody?: OrchestratorRequest;
    phone?: string;
  },
): Promise<ChannelWriteResult> {
  const { role, approvedBy, orchestratorBody, phone } = ctx;
  const body = orchestratorBody ?? { messages: [] };

  if (!canExecuteActionForRole(role, action)) {
    return denied(action, input, role);
  }

  if (action === 'navigate' || action === 'navigateTo') {
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

  if (action === 'detectTrades') {
    const trades = Array.isArray(input.trades) ? input.trades as Array<Record<string, unknown>> : [];
    const valid = trades.filter((t) => firstString(t.tradeId));
    const names = valid.map((t) => String(t.tradeId)).join(', ');
    return {
      action,
      executed: valid.length > 0,
      summary: valid.length ? `Detected trades: ${names}.` : 'No trades detected.',
      output: { ...input, trades: valid },
    };
  }

  if (action === 'startQuote' || action === 'proposeQuoteFields') {
    const tradeId = firstString(input.tradeId) ?? 'bathroom';
    const customerId = firstString(input.customerId) ?? '';
    const route = `/quote/${tradeId}${customerId ? `/${customerId}` : ''}?prefill=ai`;
    const base = appBaseUrl();
    return {
      action,
      executed: true,
      summary: action === 'startQuote' ? `Quote wizard ready for ${tradeId}.` : 'Quote fields staged.',
      output: { ...input, tradeId, deepLink: base ? `${base}${route}` : route, prefill: true },
    };
  }

  if (action === 'addQuoteLines') {
    const quote = findQuote(input);
    if (!quote) {
      return { action, executed: false, summary: 'No quote found.', output: input };
    }
    const newLines = parseQuoteLines(input.lines ?? input.items);
    if (!newLines.length) {
      return { action, executed: false, summary: 'No line items provided.', output: input };
    }
    const existing = Array.isArray(quote.lines) ? quote.lines as Array<Record<string, unknown>> : [];
    const merged = [...existing, ...newLines];
    const total = merged.reduce((s, l) => s + Number(l.total ?? 0), 0);
    updateQuoteRecord(String(quote.id), { lines: merged, items: merged, total });
    return {
      action,
      executed: true,
      summary: `Added ${newLines.length} line(s) to quote ${quote.id}.`,
      output: { ...input, quoteId: quote.id, total, lineCount: merged.length },
    };
  }

  if (action === 'updateQuoteLines') {
    const quote = findQuote(input);
    if (!quote) return { action, executed: false, summary: 'No quote found.', output: input };
    const lines = parseQuoteLines(input.lines ?? input.items);
    if (!lines.length) return { action, executed: false, summary: 'No line items.', output: input };
    const total = readOptionalNumber(input.total) ?? lines.reduce((s, l) => s + Number(l.total ?? 0), 0);
    updateQuoteRecord(String(quote.id), { lines, items: lines, total });
    return {
      action,
      executed: true,
      summary: `Updated ${lines.length} line(s) on quote ${quote.id}.`,
      output: { ...input, quoteId: quote.id, total },
    };
  }

  if (action === 'convertQuoteToProject') {
    const quote = findQuote(input);
    if (!quote) {
      return { action, executed: false, summary: 'Quote not found.', output: input };
    }
    if (quote.projectId) {
      return {
        action,
        executed: true,
        summary: `Project already exists (${String(quote.projectId)}).`,
        output: { ...input, projectId: quote.projectId, quoteId: quote.id },
      };
    }
    const customer = getDataStore().customers.find((c) => String(c.id) === String(quote.customerId));
    if (!customer) {
      return { action, executed: false, summary: 'Customer record missing.', output: input };
    }
    if (input.markQuoteAccepted !== false && String(quote.status) !== 'accepted') {
      updateQuoteRecord(String(quote.id), { status: 'accepted' });
    }
    const project = createProjectFromQuoteServer(quote, customer);
    updateQuoteRecord(String(quote.id), { status: 'accepted', projectId: project.id });
    if (input.withPaymentPlan === true) {
      const stages = buildDefaultPaymentStages(Number(project.totalCustomerCost ?? quote.total ?? 0));
      applyProjectWriteAction(String(project.id), 'proposePaymentPlan', { stages }, approvedBy ?? 'Channel AI');
    }
    return {
      action,
      executed: true,
      summary: `Created project ${project.id} for ${quote.customerName}.`,
      output: { ...input, projectId: project.id, quoteId: quote.id },
    };
  }

  if (action === 'sendContract') {
    const store = getDataStore();
    const contractId = firstString(input.contractId);
    const contract = contractId
      ? store.contracts.find((c) => String(c.id) === contractId)
      : store.contracts.find((c) => String(c.quoteId) === String(input.quoteId));
    if (!contract) {
      return { action, executed: false, summary: 'Contract not found.', output: input };
    }
    if (String(contract.status) === 'signed') {
      return { action, executed: false, summary: 'Contract already signed.', output: input };
    }
    const idx = store.contracts.findIndex((c) => String(c.id) === String(contract.id));
    store.contracts[idx] = {
      ...contract,
      status: 'sent',
      sentAt: new Date().toISOString(),
      sentBy: approvedBy ?? 'Channel AI',
    };
    syncData(store);
    const signToken = firstString(contract.signToken);
    const base = appBaseUrl();
    const signLink = signToken && base ? `${base}/contract/${signToken}` : signToken ? `/contract/${signToken}` : null;
    return {
      action,
      executed: true,
      summary: `Contract ${contract.id} sent to customer.`,
      output: { ...input, contractId: contract.id, signLink, sent: true },
    };
  }

  if (action === 'completeHandover') {
    const projectId = firstString(input.projectId, body.projectContext?.projectId);
    if (!projectId) return { action, executed: false, summary: 'Need projectId.', output: input };
    const result = completeHandoverServer(projectId, firstString(input.signedBy) ?? approvedBy ?? 'Customer', firstString(input.customerNotes));
    return { action, executed: result.ok, summary: result.summary, output: { ...input, projectId } };
  }

  if (action === 'assignContractor') {
    const projectId = firstString(input.projectId, body.projectContext?.projectId);
    if (!projectId) return { action, executed: false, summary: 'Need projectId.', output: input };
    const result = assignContractorServer(projectId, input);
    return { action, executed: result.ok, summary: result.summary, output: { ...input, projectId, contractorId: result.contractorId } };
  }

  if (action === 'markPaymentReceived') {
    const projectId = firstString(input.projectId, body.projectContext?.projectId);
    if (!projectId) return { action, executed: false, summary: 'Need projectId.', output: input };
    const result = markPaymentReceivedServer(projectId, input);
    let summary = result.summary;
    if (result.ok && result.stageId) {
      const receipt = await autoSendReceiptAfterMarkPaidServer(projectId, result.stageId);
      if (receipt && !receipt.skipped) {
        summary += receipt.ok ? ` ${receipt.summary}` : ` Receipt not sent: ${receipt.summary}`;
      }
    }
    return { action, executed: result.ok, summary, output: { ...input, projectId, stageId: result.stageId } };
  }

  const projectActions = new Set([
    'proposePaymentPlan', 'savePaymentPlan', 'proposeSchedule', 'saveProjectSchedule', 'proposePlan',
    'checkPaymentGate', 'draftInvoice', 'draftContract', 'draftBuilderMessage', 'draftCustomerMessage',
    'proposeChangeOrder', 'notifyCustomerChangeOrder', 'updateTaskStatus', 'tagPhoto', 'logBuilderPrice',
    'sendBuilderBrief', 'sendContractorBrief', 'requestSitePhotos', 'relayCustomerUpdate', 'logBuilderReply',
    'assessExtraFromPhotos', 'assessProgress', 'recordCostEntry', 'fixCostEntry', 'logHours', 'correctTimesheet',
    'updateProject',
  ]);

  if (projectActions.has(action)) {
    const projectId = firstString(input.projectId, body.projectContext?.projectId, body.customerContext?.projectId);
    if (!projectId) {
      return { action, executed: false, summary: `${action} needs projectId.`, output: input };
    }
    const result = applyProjectWriteAction(projectId, action, input, approvedBy ?? 'Channel AI');
    return { action, executed: result.ok, summary: result.summary, output: result.output };
  }

  if (action === 'approveChangeOrder' || action === 'rejectChangeOrder') {
    const projectId = firstString(input.projectId, body.customerContext?.projectId, body.projectContext?.projectId);
    const changeOrderId = firstString(input.changeOrderId);
    if (!projectId || !changeOrderId) {
      return { action, executed: false, summary: 'Need projectId and changeOrderId.', output: input };
    }
    const result = approveChangeOrderServer(projectId, changeOrderId, approvedBy ?? 'Customer', action === 'approveChangeOrder');
    return { action, executed: result.ok, summary: result.summary, output: { ...input, projectId, changeOrderId } };
  }

  if (action === 'sendPaymentLink') {
    const projectId = firstString(input.projectId, body.customerContext?.projectId);
    const store = getDataStore();
    const project = projectId ? store.projects.find((p) => String(p.id) === projectId) : undefined;
    const token = firstString(project?.portalToken);
    const base = appBaseUrl();
    const portalLink = token ? (base ? `${base}/portal/${token}` : `/portal/${token}`) : null;
    const stages = Array.isArray(project?.paymentStages) ? project.paymentStages as Array<Record<string, unknown>> : [];
    const due = stages.find((s) => String(s.status) === 'due' || String(s.status) === 'pending');
    return {
      action,
      executed: Boolean(portalLink),
      summary: portalLink ? `Payment link: ${portalLink}${due ? ` — ${String(due.name)} £${Number(due.amount ?? 0)}` : ''}` : 'No portal link available.',
      output: { ...input, portalLink, stage: due ?? null },
    };
  }

  if (action === 'bookSurvey') {
    const appointment = {
      id: `APT${Date.now()}`,
      customerId: firstString(input.customerId, body.customerContext?.customerId),
      customerName: firstString(input.customerName, body.customerContext?.customerName),
      type: firstString(input.type) ?? 'site_survey',
      preferredDate: input.preferredDate,
      preferredTime: input.preferredTime,
      address: input.address,
      status: 'requested',
      source: phone ? 'whatsapp' : 'channel',
      phone: phone ?? body.customerContext?.phone,
      createdAt: new Date().toISOString(),
      kind: 'appointment',
    };
    const store = getDataStore();
    store.sessions.push(appointment);
    syncData(store);
    return {
      action,
      executed: true,
      summary: `Survey booked (${appointment.id}).`,
      output: { ...input, appointmentId: appointment.id },
    };
  }

  if (action === 'confirmHandover') {
    const projectId = firstString(input.projectId, body.customerContext?.projectId);
    if (!projectId) return { action, executed: false, summary: 'Need projectId.', output: input };
    const result = completeHandoverServer(projectId, firstString(input.signedBy) ?? 'Customer', firstString(input.notes));
    return { action, executed: result.ok, summary: result.summary, output: { ...input, projectId } };
  }

  if (action === 'confirmContract') {
    const store = getDataStore();
    const contractId = firstString(input.contractId);
    const contract = contractId
      ? store.contracts.find((c) => String(c.id) === contractId)
      : store.contracts.find((c) => String(c.customerId) === String(body.customerContext?.customerId));
    if (!contract) return { action, executed: false, summary: 'Contract not found.', output: input };
    const idx = store.contracts.findIndex((c) => String(c.id) === String(contract.id));
    store.contracts[idx] = {
      ...contract,
      status: 'signed',
      signedAt: new Date().toISOString(),
      signedBy: firstString(input.signedBy) ?? body.customerContext?.customerName ?? 'Customer',
    };
    syncData(store);
    return {
      action,
      executed: true,
      summary: `Contract ${contract.id} confirmed signed.`,
      output: { ...input, contractId: contract.id },
    };
  }

  if (action === 'categorizeTransaction') {
    const store = getDataStore();
    const txId = firstString(input.transactionId, input.id);
    const idx = store.bankTransactions.findIndex((t) => String(t.id) === txId);
    if (idx < 0) return { action, executed: false, summary: 'Transaction not found.', output: input };
    store.bankTransactions[idx] = {
      ...store.bankTransactions[idx],
      category: input.category,
      categorizedAt: new Date().toISOString(),
      categorizedBy: approvedBy ?? 'Channel AI',
    };
    syncData(store);
    return { action, executed: true, summary: 'Transaction categorized.', output: { ...input, transactionId: txId } };
  }

  if (action === 'matchTransactionToProject') {
    const store = getDataStore();
    const txId = firstString(input.transactionId, input.id);
    const projectId = firstString(input.projectId);
    const idx = store.bankTransactions.findIndex((t) => String(t.id) === txId);
    if (idx < 0 || !projectId) {
      return { action, executed: false, summary: 'Need transactionId and projectId.', output: input };
    }
    store.bankTransactions[idx] = {
      ...store.bankTransactions[idx],
      matchedProjectId: projectId,
      matchedAt: new Date().toISOString(),
    };
    syncData(store);
    return { action, executed: true, summary: `Transaction matched to project ${projectId}.`, output: { ...input, transactionId: txId, projectId } };
  }

  if (action === 'draftClientReceipt' || action === 'sendClientReceipt') {
    const projectId = firstString(input.projectId, body.projectContext?.projectId);
    if (!projectId) return { action, executed: false, summary: 'Need projectId.', output: input };
    const result = await sendReceiptForStageServer(projectId, input, {
      force: action === 'sendClientReceipt' || input.force === true,
    });
    return {
      action,
      executed: result.ok && !result.skipped,
      summary: result.summary,
      output: { ...input, projectId },
    };
  }

  if (action === 'writeData') {
    const collection = firstString(input.collection) as DataCollection | undefined;
    const operation = (firstString(input.operation) ?? 'update') as WriteOperation;
    const id = firstString(input.id);
    const data = (input.data && typeof input.data === 'object' ? input.data : input) as Record<string, unknown>;
    if (!collection) {
      return { action, executed: false, summary: 'writeData needs collection.', output: input };
    }
    if (collection === 'projects' && operation === 'create') {
      return { action, executed: false, summary: 'Use convertQuoteToProject instead.', output: input };
    }
    const policyCtx = buildPolicyContext(body);
    if (!canWriteCollection(policyCtx.role, collection, operation)) {
      return { action, executed: false, summary: 'Write not permitted for this collection.', output: input };
    }
    const store = getDataStore();
    const key = collection as keyof typeof store;
    const listKey = ['customers', 'quotes', 'projects', 'builders', 'contracts'].includes(collection);
    if (!listKey) {
      return { action, executed: false, summary: `Collection ${collection} not writable on server yet.`, output: input };
    }
    const list = store[key] as Array<Record<string, unknown>>;
    if (operation === 'delete') {
      if (!id) return { action, executed: false, summary: 'id required for delete.', output: input };
      const existing = list.find((r) => String(r.id) === id);
      if (!existing || !isRecordInScope(collection, existing, policyCtx)) {
        return { action, executed: false, summary: 'Record not found or out of scope.', output: input };
      }
      (store[key] as Array<Record<string, unknown>>) = list.filter((r) => String(r.id) !== id);
      syncData(store);
      return { action, executed: true, summary: `Deleted ${collection} ${id}.`, output: { ...input, id } };
    }
    if (operation === 'update') {
      if (!id) return { action, executed: false, summary: 'id required for update.', output: input };
      const idx = list.findIndex((r) => String(r.id) === id);
      if (idx < 0) return { action, executed: false, summary: 'Record not found.', output: input };
      list[idx] = { ...list[idx], ...data, id, updatedAt: new Date().toISOString() };
      syncData(store);
      return { action, executed: true, summary: `Updated ${collection} ${id}.`, output: { ...input, id } };
    }
    const newId = firstString(data.id) ?? `${collection.slice(0, 2).toUpperCase()}${Date.now()}`;
    const record = { ...data, id: newId, createdAt: new Date().toISOString() };
    if (collection === 'customers') saveCustomerRecord(record);
    else if (collection === 'quotes') saveQuoteRecord(record);
    else {
      list.unshift(record);
      syncData(store);
    }
    return { action, executed: true, summary: `Created ${collection} ${newId}.`, output: { ...input, id: newId } };
  }

  if (isPlanningWriteAction(action)) {
    const result = executePlanningWrite(action, input);
    return { action, executed: result.ok, summary: result.summary, output: result.output };
  }

  const phoneTools = new Set([
    'classifyCallIntent', 'captureLead', 'bookCallback', 'scheduleAppointment', 'screenCandidate',
    'bookInterview', 'logCandidate', 'transferToHuman', 'enqueueOutboundCall', 'captureMessage',
  ]);
  if (phoneTools.has(action)) {
    const output = executePhoneTool(action, { ...input, phone: phone ?? input.phone }, body);
    const ok = !output.error;
    return {
      action,
      executed: ok,
      summary: ok ? `${action} completed.` : String(output.error),
      output,
    };
  }

  const mailboxTools = new Set([
    'listRecentEmails', 'getEmailThread', 'draftEmailReply', 'sendEmailReply', 'sendEmailWithAttachment',
  ]);
  if (mailboxTools.has(action)) {
    const { executeMailboxTool } = await import('./mailbox-routes');
    const { getRequestOrgId } = await import('./data-store');
    const orgId = getRequestOrgId();
    const userId = String(body.staffContext?.userId ?? 'default-user');
    const output = await executeMailboxTool(action, input, orgId, userId);
    const ok = !output.error;
    return {
      action,
      executed: ok || action === 'draftEmailReply',
      summary: ok ? `${action} completed.` : String(output.error ?? `${action} failed.`),
      output,
    };
  }

  if (action === 'draftInvoice' && !input.projectId) {
    const invoice = {
      id: `INV${Date.now()}`,
      customerId: firstString(input.customerId),
      lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
      total: readOptionalNumber(input.total) ?? 0,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
    return { action, executed: true, summary: `Invoice draft ${invoice.id} saved.`, output: { ...input, invoiceId: invoice.id } };
  }

  return {
    action,
    executed: false,
    summary: `Tool ${action} is not wired on the channel executor.`,
    output: { ...input, serverNote: 'tool_not_wired' },
  };
}

/** All write tools that must have server handlers (parity gate). */
export const CHANNEL_WRITE_TOOLS = [
  'priceSmallJob', 'submitForApproval', 'approveQuote', 'rejectQuote', 'saveCustomer', 'linkCustomer',
  'updateLeadStatus', 'logFollowUp', 'saveQuote', 'updateQuote', 'generatePaymentSchedule', 'saveContract',
  'sendContract', 'detectTrades', 'startQuote', 'proposeQuoteFields', 'addQuoteLines', 'updateQuoteLines',
  'convertQuoteToProject', 'completeHandover', 'assignContractor', 'markPaymentReceived',
  'proposePaymentPlan', 'savePaymentPlan', 'proposeSchedule', 'saveProjectSchedule', 'proposePlan',
  'checkPaymentGate', 'draftInvoice', 'draftContract', 'draftBuilderMessage', 'draftCustomerMessage',
  'proposeChangeOrder', 'notifyCustomerChangeOrder', 'updateTaskStatus', 'tagPhoto', 'logBuilderPrice',
  'sendBuilderBrief', 'sendContractorBrief', 'requestSitePhotos', 'relayCustomerUpdate', 'logBuilderReply',
  'assessExtraFromPhotos', 'assessProgress', 'recordCostEntry', 'fixCostEntry', 'logHours', 'correctTimesheet',
  'approveChangeOrder', 'rejectChangeOrder', 'sendPaymentLink', 'bookSurvey', 'confirmHandover', 'confirmContract',
  'categorizeTransaction', 'matchTransactionToProject', 'draftClientReceipt', 'sendClientReceipt', 'writeData', 'navigateTo', 'navigate',
  'updateApplication', 'setStage', 'setPricing', 'sendPricingEmail', 'logDrawing', 'sendReviewEmail',
  'recordCouncil', 'raiseChangeRequest', 'resolveChangeRequest', 'setDeadline', 'addComment', 'portalStatusCheck',
  'sendCouncilReply', 'sendCourtesyEmail', 'markDecision', 'generatePostApprovalTasks', 'convertToProject',
  'classifyCallIntent', 'captureLead', 'bookCallback', 'scheduleAppointment', 'screenCandidate', 'bookInterview',
  'logCandidate', 'transferToHuman', 'enqueueOutboundCall', 'captureMessage',
  'draftEmailReply', 'sendEmailReply', 'sendEmailWithAttachment', 'updateProject', 'escalateToStaff',
] as const;

export async function smokeChannelWrite(action: string): Promise<boolean> {
  const noopInput: Record<string, unknown> = {
    quoteId: 'Q-smoke',
    projectId: 'P-smoke',
    changeOrderId: 'CO-smoke',
    contractId: 'CT-smoke',
    transactionId: 'TX-smoke',
    tasks: 'Test task',
    lines: [{ description: 'Test', quantity: 1, rate: 100, total: 100 }],
    stages: [{ name: 'Deposit', percentage: 30, amount: 300 }],
    intent: 'general',
    name: 'Smoke Test',
    reason: 'smoke',
    to: '447700900000',
    template: 'lead_callback',
    message: 'test',
    collection: 'customers',
    operation: 'update',
    id: 'C-smoke',
    data: { notes: 'smoke' },
    stage: 'pricing',
    applicationId: 'PA-smoke',
  };
  const result = await executeChannelWrite(action, noopInput, {
    role: 'super_admin',
    approvedBy: 'Smoke',
  });
  return result.executed || result.output.serverNote !== 'tool_not_wired';
}
