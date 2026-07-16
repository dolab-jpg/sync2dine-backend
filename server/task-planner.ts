import type { OrchestratorMessage, OrchestratorRequest } from './orchestrator-types';

export type TaskPhase = 'chat' | 'clarify' | 'execute' | 'complete';
export type AutonomyLevel = 'assist' | 'balanced' | 'autopilot';

export interface PendingTaskPayload {
  id: string;
  summary: string;
  questions: string[];
  askedAt: string;
}

export interface TaskClassification {
  isBigTask: boolean;
  summary: string;
  missingFields: string[];
  questions: string[];
}

const BIG_TASK_VERBS = /\b(set up|setup|create|book|schedule|quote|invoice|full|complete|new customer|payment plan|convert|make.*job|gone ahead)\b/i;
const SIMPLE_INTENTS = /\b(who am i|my name|what is my name|hello|hi\b|hey\b|how many|count|status|list|show me|give me)\b/i;
const PROCEED_INTENTS = /\b(proceed|go ahead|use (your )?best judgment|just do it|use context|get on with it|sorted|carry on)\b/i;

const WRITE_TOOL_NAMES = new Set([
  'saveCustomer', 'linkCustomer', 'saveQuote', 'updateQuote', 'startQuote',
  'writeData', 'proposePaymentPlan', 'proposeSchedule', 'draftInvoice',
  'convertQuoteToProject',
]);

export function isProceedMessage(message: string): boolean {
  return PROCEED_INTENTS.test(message.trim());
}

export function classifyTaskIntent(
  message: string,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): TaskClassification {
  const lower = message.toLowerCase().trim();
  const summary = message.length > 120 ? `${message.slice(0, 117)}…` : message;

  if (body.pendingTask || isProceedMessage(message)) {
    return { isBigTask: true, summary: body.pendingTask?.summary ?? summary, missingFields: [], questions: [] };
  }

  if (SIMPLE_INTENTS.test(lower) && !BIG_TASK_VERBS.test(lower)) {
    return { isBigTask: false, summary, missingFields: [], questions: [] };
  }

  const actionCount = (lower.match(/\b(and|then|also|plus)\b/g) ?? []).length;
  const hasMultiEntity = /\b(customer|quote|project|survey|invoice|payment)\b.*\b(customer|quote|project|survey|invoice|payment)\b/i.test(lower);
  const isLong = lower.split(/[.!?]/).filter(Boolean).length >= 2 || lower.length > 100;
  const hasBigVerbs = BIG_TASK_VERBS.test(lower);

  const isBigTask = (hasBigVerbs && (hasMultiEntity || isLong || actionCount >= 1))
    || (hasMultiEntity && hasBigVerbs);

  if (!isBigTask) {
    return { isBigTask: false, summary, missingFields: [], questions: [] };
  }

  const missingFields: string[] = [];
  const questions: string[] = [];

  const hasCustomer = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(message)
    || Boolean(body.staffContext?.customerId)
    || (body.staffContext?.customers?.some((c) => {
      const name = String(c?.name ?? '').toLowerCase();
      return name.length > 0 && lower.includes(name);
    }));

  const hasTrade = /\b(bathroom|kitchen|electrical|plumbing|roofing|loft|extension|painting|flooring)\b/i.test(lower)
    || Boolean(body.staffContext?.tradeId);

  const hasBudget = /£\s*\d|budget|\d+\s*k\b/i.test(lower);
  const hasTimeline = /\b(next week|this week|asap|urgent|timeline|when|date)\b/i.test(lower);
  const hasAddress = /\b(birmingham|london|manchester|road|street|postcode|[A-Z]{1,2}\d)\b/i.test(lower);

  if (!hasCustomer && /customer|client|new lead/i.test(lower)) {
    missingFields.push('customer');
    questions.push('Customer name and phone number?');
  }
  if (!hasTrade && /quote|refit|job|project/i.test(lower)) {
    missingFields.push('trade');
    questions.push('Which trade — full bathroom, kitchen, electrical, or something else?');
  }
  if (!hasBudget && /quote|price|estimate|around/i.test(lower)) {
    missingFields.push('budget');
    questions.push('Rough budget band (e.g. £5k–£8k)?');
  }
  if (!hasTimeline && /survey|book|schedule|start/i.test(lower)) {
    missingFields.push('timeline');
    questions.push('Preferred timeline — this week, next week, or flexible?');
  }
  if (!hasAddress && /new customer|site|survey|address/i.test(lower)) {
    missingFields.push('address');
    questions.push('Site address or area?');
  }

  if (questions.length === 0 && isBigTask) {
    questions.push(
      'Who is the customer (name and phone)?',
      'What trade and scope (full refit or partial)?',
      'Any budget or timeline I should work to?',
    );
    missingFields.push('details');
  }

  return {
    isBigTask,
    summary,
    missingFields,
    questions: questions.slice(0, 4),
  };
}

export function shouldClarifyBeforeExecute(
  classification: TaskClassification,
  autonomy: AutonomyLevel,
  body: OrchestratorRequest,
  message: string
): boolean {
  if (!classification.isBigTask) return false;
  if (body.pendingTask && !isProceedMessage(message)) return false;
  if (body.pendingTask && isProceedMessage(message)) return false;

  if (autonomy === 'autopilot') {
    return classification.missingFields.length >= 3;
  }
  if (autonomy === 'balanced') {
    return classification.missingFields.length >= 2;
  }
  return classification.questions.length > 0;
}

export function buildClarifyIntro(summary: string, humourLevel?: string): string {
  if (humourLevel === 'del_boy') {
    return `Right then boss — before I knock this together (${summary}), quick checks:`;
  }
  return `I'll get this sorted. Quick checks on "${summary}":`;
}

export function isWriteToolAction(action: string): boolean {
  return WRITE_TOOL_NAMES.has(action);
}
