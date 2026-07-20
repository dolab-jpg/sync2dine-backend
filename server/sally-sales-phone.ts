/**
 * Sally — Sync2Dine sales AI (phone twin).
 * Full SaaS close tools live in frontend sally-sales.ts; port incrementally.
 * Voice/humour block must stay in sync with frontend server/sally-sales.ts SALLY_SALES_OS.
 */
import { PHONE_TOOLS } from './phone-tools';
import { END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL } from './phone-brain';

export const SALLY_PERSONA = 'sally';

export function isSallySalesCall(
  meta?: Record<string, unknown> | null,
  opts?: { campaignTemplate?: string; agentPersona?: string },
): boolean {
  const m = meta || {};
  const persona = String(opts?.agentPersona || m.agentPersona || '').toLowerCase();
  if (persona === SALLY_PERSONA) return true;
  if (String(m.aim || '').toLowerCase() === 'sales_outreach') return true;
  if (String(m.source || '').toLowerCase() === 'sales_csv_dial') return true;
  return false;
}

function formatOfferFactsBlock(): string {
  return [
    'OFFER FACTS (do not invent beyond this — call getOfferTerms for live numbers):',
    '- Sync2Dine sells Judie (AI phone), Atmosphere (venue audio), and Complete (both).',
    '- Prefer getOfferTerms tool output for current prices and demo links.',
  ].join('\n');
}

function formatObjectionPlaybook(): string {
  return [
    'OBJECTIONS (short Cockney answers, then ask a closing question):',
    '- Already have a receptionist: Judie covers missed/overflow/after-hours and takes orders into the app.',
    '- Afraid of unlimited bills: Clear weekly allowance + published overage — no unlimited minutes sold.',
    '- What if Judie fails: Transfer-to-human; staff stay in control. Sally never pretends to take diner orders.',
  ].join('\n');
}

const SALLY_SALES_OS = [
  'You are Sally, Sync2Dine’s dedicated sales AI (phone).',
  'IDENTITY: Your name is Sally. You work for Sync2Dine (sync2dine.io). Never say you are Judie, Lizzie, Cynthia, or Builder Diddies. Never take food orders.',
  'AIM: Take a restaurant prospect from first contact toward a demo, signed interest, and paying customer.',
  'HOW: Discovery 60–90s → authority (founder + Judie + Atmosphere) → route to Atmosphere / Judie / Complete → handle objections → book demo or callback → capture lead.',
  'VOICE & HUMOUR (always — invent jokes yourself; no joke script):',
  '- Speak Cockney / London market-trader energy. Soft Cockney flavour: "lovely", "sorted", "cheers", sparingly "innit", "you\'re having a laugh", "get in". Never American.',
  '- Extra funny: invent a joke or cheeky aside most turns — fresh banter, not recycled punchlines.',
  '- A little rude: sharp, teasing, sarky — never abusive, racist, or cruel. Still close the sale.',
  '- Phone: one or two spoken sentences.',
  '- Dial humour down only for DNC/opt-out, angry callers, or money/legal stress.',
  'GUARDRAILS:',
  '- NOT the restaurant food-order agent. No menus, diner orders, or guest reservations.',
  '- NEVER sell Sally as the product. The product is Judie and/or Atmosphere.',
  '- Never invent price, terms, or payment links — use getOfferTerms facts in the prompt.',
  '- Never address the person as Guest or Unknown. If you do not know their name, ask who you are speaking with.',
  '- DNC/opt-out = stop politely and end the call.',
  '- When finished, use the native hang-up (end call). Do not loop goodbyes.',
].join('\n');

const GET_OFFER_TERMS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'getOfferTerms',
    description: 'Read current Sync2Dine commercial offer terms (prices/demo links) for this sales call.',
    parameters: { type: 'object', properties: {} },
  },
};

const BOOK_DEMO_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bookDemo',
    description: 'Book a Sync2Dine product demo / callback for this prospect.',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'Preferred time in plain English or ISO' },
        name: { type: 'string' },
        phone: { type: 'string' },
        restaurant: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
};

function pickPhoneTools(...names: string[]) {
  const set = new Set(names);
  return PHONE_TOOLS.filter((t) => set.has(t.function.name));
}

export function getSallyPhoneSessionChatTools() {
  return [
    GET_OFFER_TERMS_TOOL,
    BOOK_DEMO_TOOL,
    ...pickPhoneTools(
      'bookCallback',
      'captureLead',
      'transferToHuman',
      'captureMessage',
      'classifyCallIntent',
      'sendCustomerMessage',
      'scheduleAppointment',
    ),
    END_CALL_FUNCTION_TOOL,
    SET_CALL_LANGUAGE_TOOL,
  ];
}

export function buildSallyBrainPrompt(input: {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  outboundBrief?: string;
  contactName?: string;
  companyHint?: string;
}): { instructions: string; language: 'en' } {
  const contact = String(input.contactName || '').trim();
  const safeName = contact && !/^guest$/i.test(contact) ? contact : '';
  const instructions = [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    '- On phone keep replies short.',
    input.direction === 'outbound'
      ? '- This is an outbound sales call you placed.'
      : '- This is an inbound sales call.',
    safeName ? `- Contact name hint: ${safeName}` : '- Contact name unknown — ask who you are speaking with before pitching hard.',
    input.companyHint ? `- Company / restaurant hint: ${input.companyHint}` : '',
    `Caller phone: ${input.partyPhone}`,
    input.outboundBrief
      ? `- SALES BRIEF FOR THIS CALL (follow this): ${String(input.outboundBrief).slice(0, 900)}`
      : '- Pitch Sync2Dine: Judie answers the phone; Atmosphere runs the room; Complete does both.',
  ].filter(Boolean).join('\n');

  return { instructions, language: 'en' };
}

export async function executeSallySalesPhoneTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { callId?: string; partyPhone?: string; orgId?: string },
): Promise<unknown> {
  if (name === 'getOfferTerms') {
    return {
      ok: true,
      note: 'Use platform offer store / env prices on the full Sally sales stack when available.',
      landline: '020 3745 3233',
      tel: '+442037453233',
    };
  }
  if (name === 'bookDemo') {
    return {
      ok: true,
      booked: false,
      message: 'Demo request noted — confirm details with the prospect and captureLead if needed.',
      input,
      callId: ctx.callId,
    };
  }
  return { ok: false, error: `Unknown Sally phone tool: ${name}` };
}
