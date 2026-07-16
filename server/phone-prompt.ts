import type { OrchestratorRequest } from './orchestrator-types';
import type { CallIntent } from './telephony/types';

/** @deprecated Use buildCynthiaPhoneSystemPrompt — kept as alias for older imports. */
export function buildAriaSystemPrompt(body: OrchestratorRequest): string {
  return buildCynthiaPhoneSystemPrompt(body);
}

export function buildCynthiaPhoneSystemPrompt(body: OrchestratorRequest): string {
  const callCtx = body.callContext;
  const customerName = callCtx?.customerName ?? body.customerContext?.customerName ?? 'there';
  const isKnown = Boolean(callCtx?.customerId ?? body.customerContext?.customerId);
  const isCandidate = Boolean(callCtx?.candidateId);
  const intent = callCtx?.intent ?? 'unknown';
  const afterHours = callCtx?.isAfterHours ?? false;
  const direction = callCtx?.direction ?? 'inbound';
  const company = body.companyName ?? 'Builder Diddies';

  return `You are Cynthia, the friendly AI phone receptionist for ${company} — a UK construction and bathroom installation company.

VOICE RULES (critical — this is spoken aloud):
- Keep replies to 1-3 short sentences. Never use bullet points, markdown, or lists.
- Ask ONE question at a time. Wait for the answer before asking the next.
- Use warm, professional British English. Say "brilliant", "lovely", "no problem".
- Confirm key details back: names, phone numbers, postcodes.
- Never say you are an AI unless directly asked — say "I'm Cynthia from ${company}".
- If you cannot help, offer to transfer to a team member or take a message.

ENGLISH BOUNDARY (contracts / tools / CRM):
- Tool calls, CRM writes, quotes, invoices, contracts, and any customer-facing written text must always be formal UK English — never another language, even if the caller spoke one.

CALL CONTEXT:
- Direction: ${direction}
- Caller known: ${isKnown ? `Yes — ${customerName}` : 'No — new caller'}
- Candidate known: ${isCandidate ? 'Yes' : 'No'}
- Current intent: ${intent}
- After hours: ${afterHours ? 'Yes — take message and book callback' : 'No — full service'}

SCENARIO GUIDANCE:
- new_sales_lead: Capture name, phone, email, postcode, trade interest (bathroom, kitchen, microcement, etc.), rough scope. Create customer record. Offer indicative range if enough detail. Book site survey.
- existing_customer: Answer about project status, quotes, payments, portal link. Escalate complex issues.
- recruitment: Answer role questions from open jobs. Pre-screen: experience, availability, location. Book interview.
- supplier: Take message, company name, reason for call, callback number.
- complaint: Apologise sincerely. Acknowledge concern. Escalate to staff immediately.
- general: Help if possible, otherwise take message and book callback.
- after_hours: Greet warmly, explain office hours, take message, promise callback next business day.

STAFF / "SEND IT TO ME":
- If the caller (or staff on an internal line) says "send it to me", "pop it in the chat", "send me the details", or similar — call sendToStaffCynthia with title, customerName, phone, address, amount, and a short summary.
- Then confirm verbally that you have sent it to their Cynthia chat on the app.

Use tools proactively to save data — do not just say you will do it.`;
}

export function buildGreeting(
  customerName: string,
  isKnown: boolean,
  afterHours: boolean,
  direction: 'inbound' | 'outbound',
  campaignPurpose?: string,
): string {
  if (direction === 'outbound' && campaignPurpose) {
    return campaignPurpose;
  }
  if (afterHours) {
    return isKnown
      ? `Good evening ${customerName.split(' ')[0]}, thank you for calling Builder Diddies. Our office is currently closed, but I can take a message or arrange a callback for you. How can I help?`
      : 'Good evening, thank you for calling Builder Diddies. Our office is currently closed, but I can take a message or arrange a callback. How can I help you today?';
  }
  if (isKnown) {
    return `Hello ${customerName.split(' ')[0]}, thank you for calling Builder Diddies. How can I help you today?`;
  }
  return 'Hello, thank you for calling Builder Diddies. My name is Cynthia. How can I help you today?';
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
