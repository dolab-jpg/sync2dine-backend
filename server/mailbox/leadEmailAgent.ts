import { handleOrchestrator } from '../orchestrator-handler';
import type { OrchestratorRequest } from '../orchestrator-types';
import { executeChannelActions } from '../channel-action-executor';
import { executePhoneTool } from '../phone-tools';
import { getDataStore } from '../data-store';
import type { CachedEmailMessage } from './types';
import {
  addInboxItem,
  getLeadCallbackPolicy,
  isMessageProcessed,
  markInboxNotified,
  markMessageProcessed,
  notifyStaff,
  type LeadInboxItem,
} from '../leads/leadInboxStore';

const BLOCKED_SEND_ACTIONS = new Set(['sendEmailReply', 'sendEmailWithAttachment']);

function buildLeadDeskPrompt(policy: string): string {
  return `You are the TradePro lead desk AI. Process this inbound email autonomously.

LEAD CALLBACK POLICY: ${policy}
- alert_only: recommend staff call or follow up — do NOT use enqueueOutboundCall
- outbound_first: if phone present and lead is ready, use enqueueOutboundCall with template lead_callback
- inbound_only: tag await-inbound-call, schedule follow-up, do NOT outbound call

WORKFLOW:
1. Decide if this is a sales lead (direct enquiry, purchased platform lead with contact details, or lead available to buy).
2. searchLeads/searchCustomers first to avoid duplicates.
3. saveCustomer or linkCustomer with status lead, appropriate source (email, purchased, website, google).
4. logFollowUp with nextFollowUp when callback needed.
5. draftEmailReply for direct enquiries (never send — draft only).
6. escalateToStaff if human must speak to customer urgently.
7. If not a lead (newsletter, supplier, spam), say so clearly — no CRM save needed.

Purchased leads: if contact details included, save full record. If only "buy this lead", save stub with tag lead-available-to-buy.
Direct enquiries: save + draft friendly UK reply.

End with a one-line staff summary and clear recommendation (Call within 2h / Await inbound / Buy lead first / Not a lead).`;
}

function extractEmailBody(message: CachedEmailMessage): string {
  if (message.textBody?.trim()) return message.textBody.trim();
  if (message.htmlBody?.trim()) {
    return message.htmlBody
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return message.snippet ?? '';
}

function buildStaffContext(orgId: string): OrchestratorRequest['staffContext'] {
  const store = getDataStore(orgId);
  return {
    role: 'staff',
    userId: 'lead-desk-agent',
    userName: 'Lead Desk AI',
    customers: store.customers.slice(0, 50).map((c) => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      email: String(c.email ?? ''),
      phone: String(c.phone ?? ''),
      status: String(c.status ?? ''),
      source: c.source ? String(c.source) : undefined,
      notes: c.notes ? String(c.notes) : undefined,
      leadScore: typeof c.leadScore === 'number' ? c.leadScore : undefined,
      nextFollowUp: c.nextFollowUp ? String(c.nextFollowUp) : undefined,
      budget: c.budget ? String(c.budget) : undefined,
    })),
    quotes: (store.quotes ?? []).slice(0, 50).map((q) => ({
      id: String(q.id ?? ''),
      customerId: String(q.customerId ?? ''),
      customerName: String(q.customerName ?? ''),
      tradeName: q.tradeName ? String(q.tradeName) : undefined,
      total: Number(q.total ?? 0),
      status: String(q.status ?? ''),
    })),
  };
}

function filterLeadAgentActions(
  actions: Array<{ action: string; input: Record<string, unknown>; output?: Record<string, unknown> }>,
  policy: ReturnType<typeof getLeadCallbackPolicy>
): Array<{ action: string; input: Record<string, unknown>; output?: Record<string, unknown> }> {
  return actions.filter((a) => {
    if (BLOCKED_SEND_ACTIONS.has(a.action)) return false;
    if (a.action === 'enqueueOutboundCall' && policy !== 'outbound_first') return false;
    return true;
  });
}

function extractCustomerIdFromResults(
  results: Array<{ action: string; executed: boolean; output: Record<string, unknown> }>
): string | undefined {
  for (const r of results) {
    if (!r.executed) continue;
    if (r.action === 'saveCustomer' || r.action === 'linkCustomer') {
      const id = r.output.customerId ?? r.output.id;
      if (id) return String(id);
    }
  }
  return undefined;
}

function extractDraftReply(
  results: Array<{ action: string; executed: boolean; output: Record<string, unknown> }>
): LeadInboxItem['draftReply'] | undefined {
  for (const r of results) {
    if (r.action !== 'draftEmailReply') continue;
    const to = String(r.output.to ?? '');
    const subject = String(r.output.subject ?? '');
    const body = String(r.output.body ?? '');
    if (to && body) return { to, subject, body };
  }
  return undefined;
}

function heuristicParse(body: string, fromAddr: string, fromName?: string): {
  name?: string;
  phone?: string;
  email?: string;
} {
  const phoneMatch = body.match(/(?:\+44|0)\d[\d\s()-]{8,14}\d/);
  const emailMatch = body.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const name = fromName && fromName !== fromAddr ? fromName : undefined;
  return {
    name,
    phone: phoneMatch?.[0]?.replace(/\s/g, ''),
    email: emailMatch?.[0] ?? (fromAddr.includes('@') ? fromAddr : undefined),
  };
}

export interface LeadEmailAgentResult {
  inboxItem: LeadInboxItem;
  skipped: boolean;
}

export async function runLeadEmailAgent(
  message: CachedEmailMessage,
  orgId = 'default'
): Promise<LeadEmailAgentResult> {
  const msgKey = message.messageId || message.id;
  if (isMessageProcessed(msgKey)) {
    return {
      inboxItem: {
        id: '',
        orgId,
        messageId: msgKey,
        emailCacheId: message.id,
        subject: message.subject,
        fromAddr: message.fromAddr,
        summary: 'Already processed',
        recommendation: 'No action',
        status: 'skipped',
        toolsUsed: [],
        createdAt: new Date().toISOString(),
      },
      skipped: true,
    };
  }

  const policy = getLeadCallbackPolicy();
  const body = extractEmailBody(message);
  const emailContent = [
    `From: ${message.fromName ?? message.fromAddr} <${message.fromAddr}>`,
    `Subject: ${message.subject}`,
    `Received: ${message.receivedAt}`,
    '',
    body.slice(0, 8000),
  ].join('\n');

  let summary = `New email: ${message.subject}`;
  let recommendation = 'Review in Lead Inbox';
  let status: LeadInboxItem['status'] = 'action_required';
  let toolsUsed: string[] = [];
  let customerId: string | undefined;
  let customerName: string | undefined;
  let phone: string | undefined;
  let draftReply: LeadInboxItem['draftReply'];
  let mergedDuplicate = false;
  let auditLog = '';

  try {
    const orchestratorBody: OrchestratorRequest = {
      messages: [{ role: 'user', content: emailContent }],
      orchestratorMode: 'staff',
      channel: 'overlay_chat',
      systemPrompt: buildLeadDeskPrompt(policy),
      staffContext: buildStaffContext(orgId),
      aiStudio: { autonomyLevel: 'autopilot' },
    };

    const result = await handleOrchestrator(orchestratorBody);
    const allActions = [...result.proposedActions, ...(result.autoActions ?? [])];
    const filtered = filterLeadAgentActions(allActions, policy);

    const standardResults = await executeChannelActions(filtered, {
      role: 'staff',
      orgId,
      approvedBy: 'Lead Desk AI',
      orchestratorBody,
      skipConfirm: true,
    });

    const phoneResults: Array<{ action: string; executed: boolean; output: Record<string, unknown>; summary: string }> = [];
    for (const action of filtered) {
      if (action.action === 'enqueueOutboundCall' && policy === 'outbound_first') {
        const output = executePhoneTool('enqueueOutboundCall', action.input, orchestratorBody);
        phoneResults.push({
          action: action.action,
          executed: true,
          output,
          summary: `Queued outbound call to ${String(action.input.to ?? 'lead')}`,
        });
      }
    }

    const combined = [...standardResults, ...phoneResults];
    toolsUsed = combined.filter((r) => r.executed).map((r) => r.action);
    customerId = extractCustomerIdFromResults(combined);
    draftReply = extractDraftReply(combined);

    if (result.content) {
      summary = result.content.split('\n')[0].slice(0, 200) || summary;
      auditLog = result.content.slice(0, 500);
    }

    const lower = result.content?.toLowerCase() ?? '';
    if (lower.includes('not a lead') || lower.includes('not a sales lead') || lower.includes('skip')) {
      status = 'skipped';
      recommendation = 'Not a lead — no action needed';
    } else if (lower.includes('buy') && lower.includes('lead')) {
      recommendation = 'Buy lead first on platform';
    } else if (lower.includes('await inbound') || policy === 'inbound_only') {
      recommendation = 'Await inbound call from customer';
    } else if (lower.includes('call') || policy === 'outbound_first') {
      recommendation = 'Call lead within 2 hours';
    } else {
      recommendation = 'Review and contact lead';
    }

    if (customerId) {
      const customer = getDataStore(orgId).customers.find((c) => String(c.id) === customerId);
      if (customer) {
        customerName = String(customer.name ?? '');
        phone = String(customer.phone ?? '');
        mergedDuplicate = toolsUsed.includes('linkCustomer') && !toolsUsed.includes('saveCustomer');
      }
    }
  } catch (err) {
    status = 'unparsed';
    recommendation = 'AI could not parse — review email manually';
    auditLog = err instanceof Error ? err.message : 'Orchestrator error';
    summary = `Unparsed lead email from ${message.fromAddr}: ${message.subject}`;

    const hint = heuristicParse(body, message.fromAddr, message.fromName);
    if (hint.phone || hint.email) {
      recommendation = 'Manual review — possible contact details in email body';
      phone = hint.phone;
      customerName = hint.name;
    }
  }

  const inboxItem = addInboxItem({
    orgId,
    messageId: msgKey,
    emailCacheId: message.id,
    subject: message.subject,
    fromAddr: message.fromAddr,
    fromName: message.fromName,
    summary,
    recommendation,
    customerId,
    customerName,
    phone,
    jobScope: body.slice(0, 120),
    status,
    mergedDuplicate,
    draftReply,
    toolsUsed,
    auditLog,
  });

  markMessageProcessed(msgKey);

  if (status === 'action_required' || status === 'unparsed') {
    await notifyStaff(orgId, summary, customerId, status === 'unparsed' ? 'high' : 'normal');
    const notified = markInboxNotified(inboxItem.id);
    if (notified) inboxItem.notifiedAt = notified.notifiedAt;
  }

  return { inboxItem, skipped: status === 'skipped' };
}
