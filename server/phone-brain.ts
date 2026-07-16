/**
 * Shared phone brain: same Cyrus persona + account/company memory used by
 * the webhook conversation path and OpenAI Realtime sessions.
 */
import {
  getDataStore,
  getProjectById,
  resolveContactByPhone,
  isAfterHours,
} from './data-store';
import { conversationToOrchestratorMessages } from './conversation-store';
import { readStudioConfigExport } from './ai-studio-routes';
import { buildBritishVoicePrompt, formatKnowledgeChunks } from './british-voice';
import { PHONE_TOOLS } from './phone-tools';
import {
  resolvePhoneCallerIdentity,
  isPhoneAuthVerified,
  type PhoneCallerIdentity,
} from './phone-auth';
import { getPack, normalizeLang, SUPPORTED_LANGS, type SupportedLang } from './language-packs';
import { formatSpokenGbp } from './spoken-money';
export const REALTIME_PHONE_VOICE_DEFAULT = 'coral'; // female-leaning Realtime voice
export const REALTIME_PHONE_MODEL_DEFAULT = 'gpt-realtime';

const FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS = new Set([
  'oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not',
]);

function sanitizeChatTools<T extends { type: 'function'; function: { name: string; parameters?: Record<string, unknown> } }>(
  tools: T[],
): T[] {
  return tools.map((tool) => {
    const parameters = { ...(tool.function.parameters ?? {}) } as Record<string, unknown>;
    for (const key of FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS) {
      delete parameters[key];
    }
    if (parameters.type !== 'object') parameters.type = 'object';
    if (!parameters.properties || typeof parameters.properties !== 'object') {
      parameters.properties = {};
    }
    return {
      ...tool,
      function: { ...tool.function, parameters },
    };
  });
}

/** Chat-completions-shaped customer tools (subset used on phone). */
const PHONE_CUSTOMER_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'lookupCustomerByPhone',
      description: 'Resolve a customer/contact/project from a phone number',
      parameters: {
        type: 'object',
        properties: { phone: { type: 'string' } },
        required: ['phone'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getAccountBriefing',
      description: 'Spoken-friendly account summary for the current caller',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getLeadBrief',
      description: 'Load CRM lead notes and conversation history with aims for the current or named lead',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string' },
          customerId: { type: 'string' },
          query: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'addLeadNote',
      description: 'Save a conversation note with optional aim and structured disposition onto the CRM lead after or during a call',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          detail: { type: 'string' },
          aim: { type: 'string' },
          outcome: { type: 'string' },
          disposition: {
            type: 'string',
            enum: [
              'no_answer',
              'busy',
              'voicemail',
              'answered_interested',
              'answered_not_interested',
              'callback_requested',
              'wrong_number',
              'do_not_call',
              'transferred',
              'quote_requested',
              'appointment_booked',
              'failed',
              'other',
            ],
          },
        },
        required: ['customerId', 'detail'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'lookupQuote',
      description: 'Find quote summaries by quote ID, customer ID, or customer name. Prefer spokenTotal when answering amounts aloud.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          customerId: { type: 'string' },
          customerName: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'lookupProjectStatus',
      description: 'Find active project status by project ID or customer ID',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getPortalLink',
      description: 'Get customer portal link for a specific project',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'escalateToStaff',
      description: 'Escalate the caller to a human staff member',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logCallActivity',
      description: 'Log a phone call summary onto the customer record / timeline',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          callId: { type: 'string' },
          summary: { type: 'string' },
          outcome: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  },
];

/** Staff-only CRM / office tools for phone (gated server-side until PIN verified). */
const PHONE_STAFF_CRM_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'searchCustomers',
      description: 'Search or list customers by name, email, or phone. Use query "list" to browse recent customers.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name/phone fragment, or "list" / "all" to browse' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'searchProjects',
      description: 'Search projects by name, customer, id, or status (e.g. open / active)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          customerId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'searchQuotes',
      description: 'Search quotes by id, customer name, trade, or status',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getBusinessSnapshot',
      description: 'Company overview: customer count, open projects, quotes, builders — use for “how many customers/projects” questions',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getTeamPerformance',
      description: 'List registered team members (name, role, phone) — use for “who’s on the team / staff details”',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

export function buildAccountBrainContext(
  partyPhone: string,
  resolved: ReturnType<typeof resolveContactByPhone>,
): string {
  const store = getDataStore();
  const lines: string[] = [
    'Account memory for this live call (treat as known — do not ask them to restate):',
    `Caller phone: ${partyPhone}`,
  ];
  if (resolved.customerName) lines.push(`Customer: ${resolved.customerName}`);
  if (resolved.customerId) lines.push(`Customer id: ${resolved.customerId}`);
  if (resolved.contactName) {
    lines.push(`Contact: ${resolved.contactName}${resolved.contactRole ? ` (${resolved.contactRole})` : ''}`);
  }
  if (resolved.projectId) {
    const project = getProjectById(resolved.projectId);
    if (project) {
      lines.push(`Project: ${String(project.projectName ?? project.id)} — status ${String(project.status ?? 'unknown')}`);
      const tasks = ((project.tasks as Array<Record<string, unknown>> ?? [])
        .filter((t) => t.status !== 'completed')
        .slice(0, 3)
        .map((t) => String(t.title))
        .filter(Boolean));
      if (tasks.length) lines.push(`Open tasks: ${tasks.join('; ')}`);
    } else {
      lines.push(`Project id: ${resolved.projectId}`);
    }
  }
  const customer = resolved.customerId
    ? (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === resolved.customerId)
    : undefined;
  if (customer?.notes) lines.push(`Notes: ${String(customer.notes).slice(0, 400)}`);
  const activities = Array.isArray(customer?.activities)
    ? (customer!.activities as Array<Record<string, unknown>>).slice(0, 8)
    : [];
  if (activities.length) {
    lines.push('Conversation history (use this — do not invent prior talks):');
    for (const a of activities) {
      const detail = String(a.detail ?? a.summary ?? '').slice(0, 200);
      if (!detail) continue;
      const aim = a.aim ? ` aim=${a.aim}` : '';
      const when = String(a.createdAt ?? '').slice(0, 16);
      lines.push(`- ${when}${aim}: ${detail}${a.outcome ? ` → ${a.outcome}` : ''}`);
    }
  }
  if (customer?.nextFollowUp) {
    lines.push(`Next follow-up: ${String(customer.nextFollowUp)}`);
  }
  const quotes = (store.quotes as Array<Record<string, unknown>> ?? [])
    .filter((q) => String(q.customerId ?? '') === String(resolved.customerId ?? ''))
    .slice(0, 3);
  for (const q of quotes) {
    const total = Number(q.total ?? 0);
    lines.push(`Quote ${String(q.id)}: ${String(q.status ?? '')} total ${total} (spoken: ${formatSpokenGbp(total)})`);
  }
  return lines.join('\n');
}

export interface PhoneBrainPromptInput {
  orgId: string;
  partyPhone: string;
  direction?: 'inbound' | 'outbound';
  campaignTemplate?: string;
  /** Staff instruction from CRM "Call this person" text box */
  outboundBrief?: string;
  contactName?: string;
  /** When set, skip re-resolve (call-site already resolved). */
  identity?: PhoneCallerIdentity;
  callId?: string;
  phoneAuthVerified?: boolean;
  /** Overrides CRM preferredLanguage (e.g. resumed call with a saved setCallLanguage choice). */
  languageOverride?: string | null;
}

const LANGUAGE_NAMES: Record<SupportedLang, string> = {
  en: 'English',
  sq: 'Albanian',
  uk: 'Ukrainian',
  ru: 'Russian',
  zh: 'Chinese (Mandarin)',
  es: 'Spanish',
  pl: 'Polish',
  fa: 'Persian (Farsi)',
};

function buildLanguageBlock(lang: SupportedLang, forStaff: boolean): string {
  const switchList = SUPPORTED_LANGS
    .filter((l) => l !== 'en')
    .map((l) => LANGUAGE_NAMES[l])
    .join(', ');
  const lines = [
    lang === 'en'
      ? `Default call language: English${forStaff ? '' : ' (British)'} with Cockney-lite energy.`
      : `Preferred call language for this caller: ${LANGUAGE_NAMES[lang]}. Open and continue the call in ${LANGUAGE_NAMES[lang]} unless they switch back to English.`,
    `If the caller speaks or asks for another supported language (${switchList}), switch fluently straight away: call tool setCallLanguage with the language code (${SUPPORTED_LANGS.join(', ')}), then speak your next reply in that language immediately — never list languages and stop.`,
    'Your name is Lizzie in every language. Never introduce yourself as an ElevenLabs voice label (Aerisita, Klava, Veronica, Laura, etc.). Keep using the same tools after a language switch.',
    lang !== 'en' ? getPack(lang).systemInstruction : '',
    forStaff
      ? 'This spoken-language choice covers ONLY what you say out loud to this colleague. Tool calls, CRM writes, logged summaries, and any text that will reach a customer (messages, documents, briefs) must always be composed in formal UK English, regardless of the language you are speaking on this call.'
      : 'Formal written outputs from tools (invoices, contracts, customer written messages) always stay in professional UK English regardless of spoken call language.',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Full system instructions for Realtime / phone: British (Cockney nudge), female,
 * funny, short text-message style + company + account + recent Cyrus history.
 * Staff/builder sessions get a different persona + PIN unlock rules.
 */
export function buildPhoneBrainPrompt(input: PhoneBrainPromptInput): {
  instructions: string;
  resolved: ReturnType<typeof resolveContactByPhone>;
  history: Array<{ role: string; content: string }>;
  identity: PhoneCallerIdentity;
  language: SupportedLang;
} {
  const identity = input.identity ?? resolvePhoneCallerIdentity(input.partyPhone, input.orgId);
  const resolved = resolveContactByPhone(input.partyPhone);
  const afterHours = isAfterHours();
  const account = buildAccountBrainContext(input.partyPhone, resolved);
  const studio = readStudioConfigExport();
  const humourLevel = String(studio?.humourLevel ?? 'cheeky');
  const companyInstructions = String(studio?.companyInstructions ?? '');
  const knowledgeChunks = Array.isArray(studio?.knowledgeChunks) ? studio!.knowledgeChunks as unknown[] : [];
  const knowledgeBlock = formatKnowledgeChunks(knowledgeChunks);
  const history = conversationToOrchestratorMessages(input.orgId, input.partyPhone, 20);
  const verified = input.phoneAuthVerified
    ?? (input.callId ? isPhoneAuthVerified(input.callId) : false);

  // Staff/builder default to English on the phone for site clarity; customers get CRM preference.
  const language: SupportedLang = identity.kind !== 'customer'
    ? normalizeLang(input.languageOverride ?? 'en')
    : normalizeLang(input.languageOverride ?? identity.route.preferredLanguage ?? 'en');
  const languageBlock = buildLanguageBlock(language, identity.kind !== 'customer');
  const agent = getDataStore().agentSettings;
  const aboutUs = agent?.aboutUs?.trim();
  const sayToday = agent?.sayToday?.trim();
  const restaurantBlock = [
    aboutUs ? `About us (share if asked): ${aboutUs}` : '',
    sayToday ? `Say today (optional greeting colour): ${sayToday}` : '',
  ].filter(Boolean).join('\n');

  const britishRole = identity.kind === 'customer' ? 'customer' : 'staff';
  const britishChannel = identity.kind === 'customer' ? 'phone' : 'phone_staff';
  const british = buildBritishVoicePrompt(
    humourLevel === 'straight' ? 'straight' : 'cheeky',
    britishRole,
    [companyInstructions, knowledgeBlock].filter(Boolean).join('\n\n') || undefined,
    britishChannel,
  );

  let persona: string;
  if (identity.kind === 'staff' || identity.kind === 'foreman') {
    const roleLabel = identity.kind === 'foreman' ? 'builder / site' : `office (${identity.role})`;
    persona = [
      `You are Lizzie, Sync2Dine's phone assistant speaking to ${identity.name}, a registered ${roleLabel} colleague.`,
      'IDENTITY: Your name is Lizzie. Whenever anyone asks who you are, reply that you are Lizzie and you are here to help. Never say TradePro. Never use an ElevenLabs voice label as your name.',
      'Default speech: British English, warm Cockney-lite, short spoken replies — never American. If they ask for another supported language, switch spoken replies and call setCallLanguage, then keep using the same tools.',
      'MONEY SPEECH (critical): Never say £, GBP, commas, or digit runs like 5200 or 570000. Prefer each tool result spokenTotal / spokenHint verbatim (e.g. "five thousand two hundred pounds").',
      '',
      'SECURITY — phone PIN:',
      verified
        ? [
          '- This caller has already verified their phone PIN for this call. Proceed with their role tools.',
          '- For account / customer / project / quote / money / staff questions: ALWAYS call the matching tools (getBusinessSnapshot, searchCustomers, searchProjects, searchQuotes, lookupQuote, getAccountBriefing, getTeamPerformance, saveQuote, sendCustomerMessage, etc.) and speak the real numbers from spokenHint/spokenTotal — never say you cannot access CRM.',
        ].join('\n')
        : [
          '- They are recognised by caller ID but NOT yet unlocked for privileged CRM tools.',
          '- Naturally ask them to say their 4-digit security code when it fits — you are the brain, not a rigid script.',
          '- When you hear four digits, call tool verifyStaffPhonePin.',
          '- Wrong PIN: stay warm, keep the conversation going, gently retry later — never hang up, never dead-end, never lock them out.',
          '- Until verified: do NOT leak internal CRM details; still chat, take a message, or transfer if they ask.',
          '- AFTER verifyStaffPhonePin returns verified:true — immediately use CRM tools for any account/customer/project/staff/money question. Never claim you cannot look things up once unlocked.',
        ].join('\n'),
      '',
      identity.kind === 'foreman'
        ? '- Once unlocked: help with site/project status, briefs, and logging — not office approvals or invoices.'
        : [
          '- Once unlocked: willingly use tools for accounts, customers (by name or phone — searchCustomers with query "list" to browse), projects, quotes, company counts (getBusinessSnapshot), staff roster (getTeamPerformance), saveQuote for indicative pricing, bookCallback / placeOutboundCall for reminders (valid E.164 only), sendCustomerMessage for WhatsApp, and sendToStaffCynthia for “send it to me”.',
          '- Creating a lead while YOU are on a staff phone: always pass the customer phone explicitly — never use your own handset number.',
          '- Do not offer vague “I can arrange a report” when a tool can answer — call the tool and summarise the result in one short spoken sentence.',
          '- Your display name is Lizzie. Keep the same voice, accent, and settings.',
          '- When they say “send it to me”, “pop it in the chat”, “message me that”, or similar — call sendToStaffCynthia with title, customerName, phone, address, amount, and a short summary, then confirm you sent it to their Lizzie chat.',
          '- When they ask you to message a customer: call sendCustomerMessage. If it fails because WhatsApp is not configured, say so clearly — never invent success.',
          '- When they ask you to call/remind a customer later, use bookCallback or placeOutboundCall with confirmed:true and a real phone number.',
          '- When they ask to hang up or say goodbye, end the call.',
        ].join('\n'),
      '- If they ask for a person or you cannot help: tell them you will put them on a short hold, then call transferToHuman (warm consult — staff answers you first, then you connect the caller).',
      '- End the call when they say goodbye or ask to hang up.',
      '- Reply only with spoken words; one or two chatty sentences.',
      afterHours ? '- Outside normal hours: still help colleagues.' : '',
      input.direction === 'outbound' ? '- This is an outbound call you placed.' : '- This is an inbound call.',
    ].filter(Boolean).join('\n');
  } else {
    persona = [
      'You are Lizzie, a cheeky female phone assistant for Sync2Dine (England) — takeaway phone ordering.',
      'IDENTITY: Your name is Lizzie. Whenever anyone asks who you are, reply: "Lizzie, I am here to help." Never say TradePro. Never introduce yourself as an ElevenLabs voice label.',
      'HARD RULES — accent & locale:',
      '- You operate in England. Default spoken language is British English (en-GB) with warm London Cockney / Estuary girl energy — never an American accent.',
      '- Soft Cockney flavour in English wording is welcome ("lovely", "sorted", "innit" sparingly, "cheers") but do NOT become unintelligible slang.',
      '- If the caller asks for another supported language, switch spoken replies fluently, call setCallLanguage, then continue in that language immediately (never list languages and stop). Keep the same funny female Lizzie persona and the same tools.',
      '- NEVER use American spelling or vocabulary when speaking English ("awesome", "gotta", "schedule a meeting" → prefer "book a chat").',
      '- UK spelling and UK phone and date formats for English speech and for any written/tool English.',
      '- MONEY: never speak £ or bare digit amounts — say full pounds in words (prefer tool spokenTotal / spokenHint).',
      '',
      'Tone & style:',
      '- Be properly funny: quick banter, light teasing, self-deprecating asides — every reply can have a smile, without roasting the customer.',
      '- Keep it short: one or two chatty spoken sentences, text-message casual, no lists, no markdown, no formal paragraphs.',
      '- Help first, joke second — if they are stressed or talking money/legal/safety, dial humour down.',
      '- Same brain as the Lizzie chat assistant: use company knowledge and account memory; do not pretend you need to look up facts you already have.',
      '- Food ordering: use getMenu to read the menu and placeFoodOrder once the caller confirms items, order type, and total.',
      '',
      'Live phone call:',
      '- Reply only with spoken words.',
      '- If the call just connected, greet them naturally in one short cheeky sentence using account memory.',
      '- If they ask for a person: say you will put them on a short hold, then call transferToHuman. Warm consult — staff answers you first; you brief them, then connect the caller. End the call when they say goodbye.',
      afterHours ? '- Outside normal hours: still help; offer a callback if needed.' : '',
      input.campaignTemplate ? `- Soft call purpose (do not recite): ${input.campaignTemplate}` : '',
      input.outboundBrief
        ? `- STAFF BRIEF FOR THIS CALL (follow this — do not ignore): ${String(input.outboundBrief).slice(0, 800)}`
        : '',
      input.direction === 'outbound'
        ? '- This is an outbound call you placed. After the conversation, call addLeadNote with detail + disposition (interested / not interested / callback / no answer / transferred / etc.).'
        : '- This is an inbound call.',
    ].filter(Boolean).join('\n');
  }

  const historyBlock = history.length
    ? `Recent conversation memory (same thread as chat/WhatsApp):\n${history
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')
      .slice(0, 3500)}`
    : 'No prior conversation history on this thread.';

  const staffLine = identity.kind !== 'customer'
    ? `Caller identity: ${identity.name} · role ${identity.role} · kind ${identity.kind} · PIN ${verified ? 'verified' : 'pending'}`
    : account;

  const instructions = [persona, british, languageBlock, restaurantBlock, staffLine, identity.kind === 'customer' ? account : '', historyBlock]
    .filter(Boolean)
    .join('\n\n');
  return { instructions, resolved, history, identity, language };
}

export const VERIFY_PIN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'verifyStaffPhonePin',
    description: 'Verify the staff/builder phone security PIN (digits from keypad or spoken). Required before privileged tools.',
    parameters: {
      type: 'object',
      properties: {
        pin: { type: 'string', description: 'Exactly 4 digit PIN (spoken digits OK)' },
      },
      required: ['pin'],
    },
  },
};

export const END_CALL_FUNCTION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'endCall',
    description: 'End the phone call politely after saying goodbye',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
    },
  },
};

export const SET_CALL_LANGUAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'setCallLanguage',
    description:
      'Switch the spoken language for the rest of this call and remember it for next time. After this tool returns, speak your next reply immediately in that language as Cynthia — never list languages and stop. Same tools continue; you stay Cynthia.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: [...SUPPORTED_LANGS],
          description: `Language code: ${SUPPORTED_LANGS.join(', ')}`,
        },
      },
      required: ['language'],
    },
  },
};

export function getPhoneSessionChatTools(identity: PhoneCallerIdentity, verified: boolean) {
  const base = identity.kind === 'customer'
    ? [...PHONE_CUSTOMER_TOOLS, ...PHONE_TOOLS, END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL]
    : identity.kind === 'foreman'
      ? [
          VERIFY_PIN_TOOL,
          ...PHONE_CUSTOMER_TOOLS.filter((t) =>
            ['lookupCustomerByPhone', 'getAccountBriefing', 'getLeadBrief', 'addLeadNote', 'lookupProjectStatus', 'logCallActivity'].includes(t.function.name),
          ),
          ...PHONE_STAFF_CRM_TOOLS.filter((t) =>
            ['searchProjects'].includes(t.function.name),
          ),
          ...PHONE_TOOLS.filter((t) => ['transferToHuman', 'captureMessage'].includes(t.function.name)),
          END_CALL_FUNCTION_TOOL,
          SET_CALL_LANGUAGE_TOOL,
        ]
      : [
          VERIFY_PIN_TOOL,
          ...PHONE_CUSTOMER_TOOLS,
          ...PHONE_STAFF_CRM_TOOLS,
          ...PHONE_TOOLS.filter((t) =>
            [
              'transferToHuman',
              'captureMessage',
              'bookCallback',
              'scheduleAppointment',
              'captureLead',
              'saveQuote',
              'sendCustomerMessage',
              'classifyCallIntent',
              'sendToStaffCynthia',
              'deliverCallFollowUp',
              'placeOutboundCall',
              'enqueueOutboundCall',
              'getMenu',
              'placeFoodOrder',
            ].includes(t.function.name),
          ),
          END_CALL_FUNCTION_TOOL,
          SET_CALL_LANGUAGE_TOOL,
        ];

  // CRITICAL: Always expose the full staff/foreman tool list to Vapi.
  // PIN gating is enforced server-side in isToolAllowedForPhoneSession.
  // Filtering tools here until verified left Lizzie with nothing to call after unlock
  // (assistant tools are fixed at call start and cannot grow mid-call).
  void verified;
  return base;
}

/** Convert chat-completions tools → Realtime flat tool schema. */
export function toRealtimeTools(
  tools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>,
): Array<{ type: 'function'; name: string; description?: string; parameters?: Record<string, unknown> }> {
  return sanitizeChatTools(tools).map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters ?? { type: 'object', properties: {} },
  }));
}

export function getRealtimePhoneTools(identity?: PhoneCallerIdentity, verified = false) {
  if (identity) return toRealtimeTools(getPhoneSessionChatTools(identity, verified));
  return toRealtimeTools([...PHONE_CUSTOMER_TOOLS, ...PHONE_TOOLS, END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL]);
}
