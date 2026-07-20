/**
 * Sally — Sync2Dine sales AI (phone twin).
 * Full SaaS close tools live in frontend sally-sales.ts; port incrementally.
 * Voice/humour block must stay in sync with frontend server/sally-sales.ts SALLY_SALES_OS.
 */
import { buildSallyPhoneVoiceOverlay } from './british-voice';
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
    '- Sally is the sales name for the same person/voice as Judie — not a third SKU.',
    '- Prefer getOfferTerms tool output for current prices and demo links.',
  ].join('\n');
}

function formatObjectionPlaybook(): string {
  return [
    'OBJECTIONS (short Cockney answers, then ask a closing question):',
    '- Already have a receptionist: Judie covers missed/overflow/after-hours and takes orders into the app.',
    '- Afraid of unlimited bills: Clear weekly allowance + published overage — no unlimited minutes sold.',
    '- What if Judie fails: Transfer-to-human on the restaurant line; staff stay in control. On this sales call do not take diner orders.',
  ].join('\n');
}

const SALLY_SALES_OS = [
  'You are Sally, Sync2Dine’s dedicated sales AI (phone).',
  'IDENTITY: On this sales channel your name is Sally. You are the same person / same voice as Judie under a sales name. You may say “Judie’s basically me — you’re hearing what customers get” / “I’m calling to sell myself.” Never say Cynthia, Lizzie, or Builder Diddies.',
  'BRAINS: This call is the SALES brain only. After they buy, diners get Judie with order tools. Do NOT take food orders on this call.',
  'AIM: Close — demo, signed interest, paying customer. Inquiry alone is not success.',
  'HOW: Discovery 60–90s → USP Atmosphere → USP Judie (that’s me) → upsell Complete → demo phone → pricing → close → book demo / capture lead / send follow-up.',
  'VOICE & HUMOUR (always — invent jokes yourself; no joke script):',
  '- Thick common Cockney / London market-trader energy — NOT RP, NOT “clear English”, NOT soft/call-centre. Thickness preferred over clarity.',
  '- Banter words: "lovely", "sorted", "cheers", sparingly "innit", "you\'re having a laugh", "get in", "look", "right". Never American.',
  '- Extra funny: invent a joke or cheeky aside most turns — fresh banter, not recycled punchlines.',
  '- A little rude: sharp, teasing, sarky — never abusive, racist, or cruel. Still close the sale.',
  '- Phone: one or two spoken sentences per turn; stay on for a proper 6–7 minute close.',
  '- Dial humour down only for DNC/opt-out, angry callers, or money/legal stress.',
  'GUARDRAILS:',
  '- NOT the restaurant food-order agent. No menus, diner orders, or guest reservations.',
  '- Products: Judie and/or Atmosphere (+ Complete). Sally is not a separate SKU.',
  '- Never invent price, terms, or payment links — use getOfferTerms facts in the prompt.',
  '- Never address the person as Guest or Unknown. If you do not know their name, ask who you are speaking with.',
  '- LARGE CONTRACT / enterprise signup: arrange a callback. You cannot transfer calls.',
  '- DNC/opt-out = stop politely and end the call.',
  '- When finished, use the native hang-up (end call). Do not loop goodbyes.',
].join('\n');

const SALLY_PHONE_CLOSE_SCRIPT = [
  'SPOKEN SALES SCRIPT (follow on phone — ~6–7 minutes; use tools, do not just chat):',
  '1. Open — cheeky hook, why you’re calling, greet by name if known.',
  '2. Discovery — missed calls vs room/audio/training pain (~60–90s), keep banter.',
  '3. USP Atmosphere — exclusive sustainable audio, messaging, staff training.',
  '4. USP Judie — “that’s me” — orders/bookings so staff aren’t stuck on the phone.',
  '5. Upsell Complete — both together, weekly launch pricing; “you know it makes sense”.',
  '6. Demo — speak/send demoPhone from offer facts. “Call this number, try me, then we’ll sort signup.”',
  '7. Close — pricing → “shall I sign you up?” → collect venue, name, email, phone → bookDemo / captureLead / sendCustomerMessage confirming next step.',
  '8. Capture — CRM note; confirm what was sent before hang-up. Do not end after a polite chat with no ask.',
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
      'captureMessage',
      'classifyCallIntent',
      'sendCustomerMessage',
      'scheduleAppointment',
      'verifyStaffPhonePin',
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
  const safeName = contact && !/^(guest|unknown|unknown caller)$/i.test(contact) ? contact : '';
  const instructions = [
    SALLY_SALES_OS,
    buildSallyPhoneVoiceOverlay(),
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    SALLY_PHONE_CLOSE_SCRIPT,
    input.direction === 'outbound'
      ? '- This is an outbound sales call you placed — work the close script.'
      : '- This is an inbound sales call — work the close script.',
    safeName
      ? `- Contact name hint: ${safeName} — greet them by name.`
      : '- Contact name unknown — speak normally; never say Guest; ask who you are speaking with when it fits.',
    input.companyHint ? `- Company / restaurant hint: ${input.companyHint}` : '',
    `Caller phone: ${input.partyPhone}`,
    input.outboundBrief
      ? `- SALES BRIEF FOR THIS CALL (follow this): ${String(input.outboundBrief).slice(0, 900)}`
      : '- Pitch Sync2Dine: Judie (me) answers the phone; Atmosphere runs the room; Complete does both — then close.',
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
