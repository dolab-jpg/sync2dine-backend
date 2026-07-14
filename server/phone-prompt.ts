import type { OrchestratorRequest } from './orchestrator-types';
import type { CallIntent } from './telephony/types';

export function buildAriaSystemPrompt(body: OrchestratorRequest): string {
  const callCtx = body.callContext;
  const customerName = callCtx?.customerName ?? body.customerContext?.customerName ?? 'there';
  const isKnown = Boolean(callCtx?.customerId ?? body.customerContext?.customerId);
  const isCandidate = Boolean(callCtx?.candidateId);
  const intent = callCtx?.intent ?? 'unknown';
  const afterHours = callCtx?.isAfterHours ?? false;
  const direction = callCtx?.direction ?? 'inbound';
  const company = body.companyName ?? 'TradePro';
  const dialedPhone = direction === 'outbound'
    ? (callCtx?.to ?? body.customerContext?.phone)
    : (callCtx?.from ?? body.customerContext?.phone);
  const purposeHint = callCtx?.campaignTemplate
    ? String(callCtx.campaignTemplate).replace(/_/g, ' ')
    : '';

  return `You are Aria, the friendly AI phone receptionist for ${company} — a UK construction and bathroom installation company.

VOICE RULES (critical — this is spoken aloud):
- Keep replies to 1-3 short sentences. Never use bullet points, markdown, or lists.
- Ask ONE question at a time. Wait for the answer before asking the next.
- Use warm, professional British English. Say "brilliant", "lovely", "no problem".
- Confirm key details back: names, phone numbers, postcodes.
- Never say you are an AI unless directly asked — say "I'm Aria from ${company}".
- If you cannot help, offer to transfer to a team member or take a message.
- Do NOT recite scripts. Speak naturally from your role and tool results.

CALL CONTEXT:
- Direction: ${direction}
- Party phone: ${dialedPhone ?? 'unknown'}
- Caller/callee known: ${isKnown ? `Yes — ${customerName}` : 'No — look up with tools'}
- Candidate known: ${isCandidate ? 'Yes' : 'No'}
- Current intent: ${intent}
- After hours: ${afterHours ? 'Yes — take message and book callback' : 'No — full service'}
${purposeHint ? `- Soft outbound purpose tag (guidance only, never recite): ${purposeHint}` : ''}

TOOLS:
- On outbound or when identity is unclear, call lookupCustomerByPhone then getAccountBriefing before speaking about their account.
- Use lookupQuote / lookupProjectStatus / getPortalLink for account questions.
- Call logCallActivity when you start an outbound conversation and when you wrap up with an outcome.
- Use tools proactively — do not invent account facts.

SCENARIO GUIDANCE:
- new_sales_lead: Capture name, phone, email, postcode, trade interest, rough scope. Create customer record. Offer indicative range if enough detail. Book site survey.
- existing_customer: Answer about project status, quotes, payments, portal link. Escalate complex issues.
- recruitment: Answer role questions from open jobs. Pre-screen. Book interview.
- supplier: Take message, company name, reason, callback number.
- complaint: Apologise sincerely. Escalate to staff immediately.
- general: Help if possible, otherwise take message and book callback.
- after_hours: Greet warmly, explain office hours, take message, promise callback next business day.`;
}

export function buildGreeting(
  customerName: string,
  isKnown: boolean,
  afterHours: boolean,
  direction: 'inbound' | 'outbound',
  _campaignPurpose?: string,
): string {
  // Fallback only — preferred path is AI-generated via tools.
  if (direction === 'outbound') {
    return isKnown
      ? `Hi ${customerName.split(' ')[0]}, it's Aria from TradePro. Have I caught you at an okay time?`
      : "Hi, it's Aria calling from TradePro. Have I caught you at an okay time?";
  }
  if (afterHours) {
    return isKnown
      ? `Good evening ${customerName.split(' ')[0]}, thank you for calling TradePro. Our office is currently closed, but I can take a message or arrange a callback for you. How can I help?`
      : 'Good evening, thank you for calling TradePro. Our office is currently closed, but I can take a message or arrange a callback. How can I help you today?';
  }
  if (isKnown) {
    return `Hello ${customerName.split(' ')[0]}, thank you for calling TradePro. How can I help you today?`;
  }
  return 'Hello, thank you for calling TradePro. My name is Aria. How can I help you today?';
}

export function detectIntentFromSpeech(text: string): CallIntent {
  const lower = text.toLowerCase();
  if (/complaint|unhappy|angry|upset|disappointed|terrible|awful|manager|speak to someone/i.test(lower)) {
    return 'complaint';
  }
  if (/job|vacancy|apply|application|cv|resume|recruit|hiring|work for|position|interview/i.test(lower)) {
    return 'recruitment';
  }
  if (/quote|price|cost|estimate|bathroom|kitchen|renovation|install|new build|extension|microcement|tiling|plumbing/i.test(lower)) {
    return 'new_sales_lead';
  }
  if (/project|payment|invoice|portal|status|progress|when|builder|site|schedule/i.test(lower)) {
    return 'existing_customer';
  }
  if (/supplier|delivery|invoice from|trade account|wholesale|partner/i.test(lower)) {
    return 'supplier';
  }
  return 'general';
}

export function detectUpsetSentiment(text: string): boolean {
  return /upset|angry|unhappy|complaint|terrible|awful|disappointed|furious|disgusted|unacceptable/i.test(text);
}
