import {
  isValidServerTradeId,
  TRADE_EXTRACTABLE_FIELDS,
  TRADE_PLAYBOOK_PHASES,
  TRADE_REGISTRY,
  TRADE_IDS_CSV,
} from '../../trade-registry';
import { getDataStore } from '../../data-store';
import {
  assessExtraFromVision,
  assessProgressFromVision,
  resolvePhotoUrlsFromContext,
} from '../vision-handler';
import { canExecuteActionForRole, filterActionsForRole, getRequestRole, isGenericTool } from '../../role-permissions';
import { resolveSystemPrompt } from '../orchestrator-prompt';
import {
  executeCustomerTool,
  executeServerReadTool,
  executeUpdateLeadStatus,
  SERVER_READ_TOOLS,
} from '../../orchestrator-tool-exec';
import { PHONE_TOOLS, executePhoneTool, PHONE_AUTO_ACTIONS } from '../../phone-tools';
import {
  RESTAURANT_TOOL_DEFS,
  RESTAURANT_TOOL_NAMES,
  executeRestaurantTool,
} from '../restaurant-ai-tools';
import type {
  OrchestratorAction,
  OrchestratorMessage,
  OrchestratorMode,
  OrchestratorRequest,
  OrchestratorResult,
} from '../orchestrator-types';
import { PLANNING_ACTION_NAMES, PLANNING_TOOLS } from '../planning-tools';
import { GAP_AUTO_ACTIONS, GAP_CLOSING_TOOLS } from '../gap-closing-tools';
import { expandFacadeCall, FACADE_TOOLS, FACADE_WEB_STAFF_MODES, isFacadeEnabled } from '../tool-facade';
import {
  buildClarifyIntro,
  classifyTaskIntent,
  isProceedMessage,
  shouldClarifyBeforeExecute,
} from '../../task-planner';

import {
  hasPlanningContext,
  MAX_TOOL_ROUNDS,
  GENERIC_TOOLS,
  STAFF_TOOLS,
  CUSTOMER_TOOLS,
  EMAIL_TOOLS,
  CONTRACT_TOOLS,
  PROJECT_TOOLS,
  FOREMAN_TOOLS,
  COSTING_TOOLS,
  ACCOUNTS_TOOLS,
  LEAD_CYCLE_TOOLS,
  NAVIGATION_TOOLS,
  RESTAURANT_TOOLS,
} from './tool-catalog';
import { getToolsForMode, sanitizeToolsForOpenAI } from './tools-for-mode';
import { AUTO_ACTION_NAMES } from './auto-actions';

export type { OrchestratorAction, OrchestratorRequest, OrchestratorResult } from '../orchestrator-types';
export { getToolsForMode, sanitizeToolsForOpenAI } from './tools-for-mode';
export { AUTO_ACTION_NAMES } from './auto-actions';

export function applyRoleGate(body: OrchestratorRequest, result: OrchestratorResult): OrchestratorResult {
  const role = getRequestRole(body);
  const gated = {
    ...result,
    proposedActions: filterActionsForRole(role, result.proposedActions),
    autoActions: filterActionsForRole(role, result.autoActions),
  };
  return gated;
}

export function resolveMode(body: OrchestratorRequest): OrchestratorMode {
  if (body.orchestratorMode) return body.orchestratorMode;
  if (hasPlanningContext(body)) return 'planning';
  if (body.callContext?.callId) return 'phone';
  const staffRole = body.staffContext?.role;
  if (staffRole === 'customer' || (body.customerContext && !body.staffContext)) return 'customer';
  if (body.staffContext?.role === 'builder') return 'foreman';
  if (body.projectContext && staffRole && staffRole !== 'customer') return 'project';
  if (body.staffContext) return 'staff';
  if (body.customerContext) return 'customer';
  return 'auto';
}

export function toMessageRole(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

export function safeParseObject(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse failures and return empty object
  }
  return {};
}

export function buildActionSummary(action: OrchestratorAction): string {
  if (action.action === 'detectTrades') {
    const trades = Array.isArray(action.output.trades)
      ? (action.output.trades as Array<{ tradeId?: string }>)
          .map(t => t.tradeId)
          .filter(Boolean)
          .join(', ')
      : '';
    return `Detected trades: ${trades || 'none'}`;
  }
  if (action.action === 'startQuote') return `Ready to start quote for ${String(action.output.tradeId ?? 'selected trade')}`;
  if (action.action === 'linkCustomer') return `Customer matched: ${String(action.output.name ?? action.output.customerId ?? 'ready')}`;
  if (action.action === 'saveCustomer') return `Customer saved: ${String(action.output.name ?? 'ready')}`;
  if (action.action === 'saveQuote') return `Quote saved: ${String(action.output.tradeId ?? 'trade')} — £${String(action.output.total ?? 'TBC')}`;
  if (action.action === 'updateQuote') return `Quote updated: ${String(action.output.quoteId ?? 'latest')}`;
  if (action.action === 'proposeQuoteFields') return `Quote fields prepared for ${String(action.output.tradeId ?? 'trade')}`;
  if (action.action === 'lookupQuote') return `Quote lookup complete (${String(action.output.count ?? 0)} result(s))`;
  if (action.action === 'lookupProjectStatus') return `Project lookup complete (${String(action.output.count ?? 0)} result(s))`;
  if (action.action === 'getPortalLink') return `Portal link ${action.output.portalLink ? 'ready' : 'unavailable'}`;
  if (action.action === 'escalateToStaff') return 'Escalation prepared for staff follow-up';
  if (action.action === 'proposeChangeOrder') return `Change order draft ready: ${String(action.output.title ?? 'Untitled')}`;
  if (action.action === 'notifyCustomerChangeOrder') return `Customer notification ready for change order ${String(action.output.changeOrderId ?? '')}`;
  if (action.action === 'assessExtraFromPhotos') return `Photo extra assessment ready (${String(action.output.title ?? 'variation')})`;
  if (action.action === 'assessProgress') return 'Photo progress assessment ready';
  if (action.action === 'getProjectProfit') return `Profit: £${String(action.output.grossProfit ?? 0)} (${String(action.output.marginPct ?? 0)}% margin)`;
  if (action.action === 'getCostBreakdown') return `Cost breakdown ready for ${String(action.output.projectName ?? 'project')}`;
  if (action.action === 'recordCostEntry') return `Cost recorded: ${String(action.output.supplier ?? '')} — £${String(action.output.total ?? 0)}`;
  if (action.action === 'logHours') return `Hours logged: ${String(action.output.hours ?? 0)}h (£${String(action.output.labourCost ?? 0)})`;
  if (AUTO_ACTION_NAMES.has(action.action)) return `${action.action}: ready to auto-run`;
  return `${action.action}: ready for review`;
}

export function buildActionsSummaryText(actions: OrchestratorAction[]): string {
  if (!actions.length) return '';
  return actions.map(buildActionSummary).join('\n');
}

export function extractCustomerFromMessage(text: string): {
  name?: string;
  email?: string;
  phone?: string;
  budget?: number;
} {
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/\b07\d{8,10}\b/) ?? text.match(/\b\+?44?\s*7\d{3}\s*\d{3}\s*\d{3,4}\b/);
  const budgetMatch = text.match(/£\s*(\d+(?:\.\d+)?)\s*k/i)
    ?? text.match(/£\s*(\d[\d,]*)/);
  let budget: number | undefined;
  if (budgetMatch) {
    const raw = budgetMatch[1].replace(/,/g, '');
    budget = text.toLowerCase().includes('k') && !raw.includes('.')
      ? Number(raw) * 1000
      : Number(raw);
  }
  const namePatterns = [
    /customer\s+name\s+([a-z]+(?:\s+[a-z]+)*)/i,
    /(?:for|customer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /(?:called|named)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  ];
  let name: string | undefined;
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      name = match[1].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      break;
    }
  }
  return {
    name,
    email: emailMatch?.[0],
    phone: phoneMatch?.[0]?.replace(/\s/g, ''),
    budget: Number.isFinite(budget) ? budget : undefined,
  };
}

export function inferTradesFromText(text: string): Array<{ tradeId: string; confidence: number; reason?: string }> {
  const lower = text.toLowerCase();
  const detected: Array<{ tradeId: string; confidence: number; reason?: string }> = [];

  for (const trade of TRADE_REGISTRY) {
    const signals = trade.signals.split(', ').map(s => s.trim().toLowerCase());
    const matches = signals.filter(s => lower.includes(s));
    if (matches.length > 0) {
      detected.push({
        tradeId: trade.id,
        confidence: Math.min(0.95, 0.5 + matches.length * 0.15),
        reason: `Matched: ${matches.slice(0, 3).join(', ')}`,
      });
    }
  }

  return detected.sort((a, b) => b.confidence - a.confidence);
}

export function mockFieldsForTrade(tradeId: string): Record<string, { value: unknown; confidence: number; reason?: string }> {
  const keys = TRADE_EXTRACTABLE_FIELDS[tradeId] ?? ['area'];
  const fields: Record<string, { value: unknown; confidence: number; reason?: string }> = {};
  for (const key of keys) {
    if (key === 'length') fields[key] = { value: 3.5, confidence: 0.6, reason: 'Mock estimate' };
    else if (key === 'width') fields[key] = { value: 2.5, confidence: 0.55 };
    else if (key === 'area') fields[key] = { value: 25, confidence: 0.5 };
    else if (key === 'rooms') fields[key] = { value: 3, confidence: 0.65 };
    else if (key === 'finish') fields[key] = { value: 'standard', confidence: 0.5 };
    else fields[key] = { value: 'standard', confidence: 0.45, reason: 'Mock — verify on site' };
  }
  return fields;
}

export function inferRouteFromText(lower: string): string | undefined {
  if (lower.includes('site survey') || /\bsurveys?\b/.test(lower)) return '/site-survey';
  if (lower.includes('quote')) return '/quote';
  if (lower.includes('project')) return '/projects';
  if (lower.includes('customer')) return '/customers';
  if (lower.includes('staff')) return '/staff';
  if (lower.includes('dashboard') || lower.includes('home')) return '/';
  return undefined;
}

export function extractSearchQuery(text: string, fallback: string): string {
  const quoted = text.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const cleaned = text.replace(/\b(search|find|lookup|look up|customer|project|quote|quotes|for|please)\b/gi, ' ').trim();
  return cleaned || fallback;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export interface ProjectContextContractor {
  id: string;
  name: string;
  tradeId?: string;
  trade?: string;
}

export function readAssignedContractors(projectContext: Record<string, unknown> | undefined): ProjectContextContractor[] {
  const contractors = projectContext?.assignedContractors;
  if (!Array.isArray(contractors)) return [];
  const parsed: Array<ProjectContextContractor | null> = contractors
    .map((value) => {
      if (!value || typeof value !== 'object') return null;
      const raw = value as Record<string, unknown>;
      const id = firstString(raw.id, raw.contractorId);
      const name = firstString(raw.name);
      if (!id || !name) return null;
      return {
        id,
        name,
        tradeId: firstString(raw.tradeId),
        trade: firstString(raw.trade),
      };
    })
  return parsed.filter((item): item is ProjectContextContractor => item !== null);
}

export function getTradePhaseSummary(tradeId: string | undefined): string {
  if (!tradeId || !isValidServerTradeId(tradeId)) return 'survey -> delivery -> handover';
  const phases = TRADE_PLAYBOOK_PHASES[tradeId] ?? ['survey', 'delivery', 'handover'];
  return phases.join(' -> ');
}

export function readStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

export function buildChangeOrderFromAssessment(
  assessment: Record<string, unknown>,
  projectContext?: Record<string, unknown>
): Record<string, unknown> {
  const amountMin = Number(assessment.amountMin ?? 0);
  const amountMax = Number(assessment.amountMax ?? amountMin);
  const midpoint = amountMin > 0 && amountMax > 0
    ? Math.round((amountMin + amountMax) / 2)
    : Number(assessment.amount ?? 0);

  return {
    title: String(assessment.title ?? 'Variation request'),
    description: String(assessment.description ?? 'Variation identified from site photos.'),
    reason: String(assessment.reason ?? 'Builder photo assessment indicated additional scope.'),
    amount: midpoint,
    amountMin,
    amountMax,
    estimatedDays: Number(assessment.estimatedDays ?? 0),
    status: 'pending_customer',
    projectId: firstString(projectContext?.projectId),
    confidence: Number(assessment.confidence ?? 0.6),
    risks: Array.isArray(assessment.risks) ? assessment.risks : [],
  };
}

export async function executeVisionTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest,
  apiKey: string
): Promise<Record<string, unknown> | null> {
  const photoIds = readStringArray(input.photoIds);
  const images = resolvePhotoUrlsFromContext(body.projectContext, photoIds);
  const tradeId = firstString(input.tradeId, body.staffContext?.tradeId, body.projectContext?.tradeId) ?? 'general';

  if (name === 'assessExtraFromPhotos') {
    const builderNote = firstString(input.builderNote) ?? 'Assess whether this is extra scope.';
    const extra = await assessExtraFromVision({
      apiKey,
      tradeId,
      builderNote,
      images,
      projectContext: body.projectContext,
    });
    return {
      ...extra,
      tradeId,
      photoCount: images.length,
      photoIds,
      proposeChangeOrder: buildChangeOrderFromAssessment(extra as unknown as Record<string, unknown>, body.projectContext),
    };
  }

  if (name === 'assessProgress') {
    const progress = await assessProgressFromVision({
      apiKey,
      tradeId,
      images,
      projectContext: body.projectContext,
    });
    return {
      ...progress,
      tradeId,
      photoCount: images.length,
      photoIds,
    };
  }

  return null;
}

export function summarizeProjectStatus(project: Record<string, unknown>): Record<string, unknown> {
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

export function buildCustomerReplyFromActions(actions: OrchestratorAction[]): string | null {
  const parts: string[] = [];

  const statusAction = actions.find(a => a.action === 'lookupProjectStatus');
  if (statusAction) {
    const projects = Array.isArray(statusAction.output.projects)
      ? statusAction.output.projects as Array<Record<string, unknown>>
      : [];
    if (projects.length > 0) {
      const p = projects[0];
      const trade = firstString(p.tradeName);
      const statusLabel = String(p.status ?? 'in progress').replace(/_/g, ' ');
      parts.push(`Your ${trade ? `${trade.toLowerCase()} ` : ''}project "${String(p.projectName)}" is currently ${statusLabel}.`);
      const tasks = Array.isArray(p.todayTasks) ? (p.todayTasks as string[]).filter(Boolean) : [];
      if (tasks.length) parts.push(`Next up on site: ${tasks.join(', ')}.`);
      const finish = firstString(p.finishDate);
      if (finish) parts.push(`Target completion: ${finish}.`);
      const pay = p.nextPaymentDue as Record<string, unknown> | null;
      if (pay && typeof pay === 'object') {
        parts.push(`Next payment stage: ${String(pay.name)} (£${Number(pay.amount ?? 0).toLocaleString('en-GB')}).`);
      }
    } else {
      parts.push('I could not see live schedule details for your project just now.');
    }
  }

  const quoteAction = actions.find(a => a.action === 'lookupQuote');
  if (quoteAction) {
    const quotes = Array.isArray(quoteAction.output.quotes)
      ? quoteAction.output.quotes as Array<Record<string, unknown>>
      : [];
    if (quotes.length > 0) {
      const q = quotes[0];
      parts.push(`Your latest quote${q.quoteId ? ` (${String(q.quoteId)})` : ''} for ${String(q.projectName ?? q.tradeName ?? 'your job')} comes to £${Number(q.total ?? 0).toLocaleString('en-GB')} — project status: ${String(q.projectStatus ?? 'in progress')}.`);
    } else {
      parts.push("I couldn't find a quote on file for you yet — the team can sort one out quickly.");
    }
  }

  const portalAction = actions.find(a => a.action === 'getPortalLink');
  if (portalAction) {
    parts.push(portalAction.output.portalLink
      ? `Here is your portal link: ${String(portalAction.output.portalLink)}`
      : 'Your portal link is not set up yet — I have asked the team to sort it.');
  }

  const escalateAction = actions.find(a => a.action === 'escalateToStaff');
  if (escalateAction) {
    parts.push("I've also passed your question to the office team — they'll come back to you shortly (usually within 4 hours).");
  }

  return parts.length ? parts.join(' ') : null;
}

export function wrapMockResult(result: OrchestratorResult): OrchestratorResult {
  return { ...result, mockMode: true };
}

export function staffMockGreetingContent(body: OrchestratorRequest, trimmed: string): string | null {
  const userName = body.staffContext?.userName ?? 'there';
  const role = body.staffContext?.role ?? 'staff';
  const humour = body.aiStudio?.humourLevel;
  if (/^(hi|hiya|hello|hey|yo|good\s+(morning|afternoon|evening))[\s!.,?]*$/i.test(trimmed)) {
    if (humour === 'del_boy') {
      return `Alright ${userName} — ${role} on deck today. Lovely jubbly. What are we sorting?`;
    }
    return `Hello ${userName} — you're logged in as ${role}. Ask about quotes, customers, or projects.`;
  }
  if (/\b(who am i|what is my name|my name)\b/i.test(trimmed)) {
    if (humour === 'del_boy') {
      return `You're ${userName}, boss — ${role} today. What do you need?`;
    }
    return `You are ${userName}, logged in as ${role}.`;
  }
  if (/\bhow many customers\b/i.test(trimmed)) {
    const count = body.businessSnapshot?.customerCount ?? body.staffContext?.customers?.length ?? 0;
    return `You've got ${count} customer${count === 1 ? '' : 's'} on file.`;
  }
  if (/\bhow many quotes\b/i.test(trimmed)) {
    const count = body.businessSnapshot?.quoteCount ?? body.staffContext?.quotes?.length ?? 0;
    return `There are ${count} quote${count === 1 ? '' : 's'} in the system.`;
  }
  return null;
}

export function detectQuoteWonIntent(lower: string): boolean {
  return /\b(gone ahead|won the job|accepted|make.*job|convert.*project|into a job)\b/i.test(lower);
}

export function extractCustomerNameFromMessage(
  message: string,
  customers?: Array<{ name: string }>
): string | undefined {
  const list = customers ?? [];
  const lower = message.toLowerCase();
  const match = list.find((c) => {
    const first = String(c.name ?? '').toLowerCase().split(' ')[0] ?? '';
    return first.length > 0 && lower.includes(first);
  });
  if (match) return match.name;
  const nameMatch = message.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return nameMatch?.[1];
}

