/**
 * Shared builders for Vapi assistant payloads (outbound + assistant-request).
 */
import { DEFAULT_ORG_ID, getCallById, hydrateCallerFromCloud } from './data-store';
import {
  buildPhoneBrainPrompt,
  getPhoneSessionChatTools,
  VERIFY_PIN_TOOL,
} from './phone-brain';
import {
  isPhoneAuthVerified,
  resolvePhoneCallerIdentity,
  type PhoneCallerIdentity,
} from './phone-auth';
import { deepgramLanguageForPack } from './language-packs';
import { getVapiVoiceConfigForLang } from './phone-voices';
import { getVapiServerSecret, getVapiWebhookBaseUrl } from './vapi-client';
export { resolveTransferNumber, transferDestinationsFromEnv } from './transfer-numbers';
import { transferDestinationsFromEnv } from './transfer-numbers';
import {
  buildSallyBrainPrompt,
  getSallyPhoneSessionChatTools,
  isSallySalesCall,
  SALLY_PERSONA,
} from './sally-sales-phone';
import { getHomeOrgId } from './home-org';
import { buildVapiModelBlock } from './vapi-llm-model';
import { debugLog } from './debug-session-log';

type SilencePersona = 'sally' | 'judie' | 'staff';

/** Shared dead-air ladder for every Vapi phone agent (check → re-ask → hang up). */
export function buildSilenceHooks(persona: SilencePersona): Array<Record<string, unknown>> {
  const lines =
    persona === 'sally'
      ? {
          check: [
            'You still with me, love?',
            'You still there?',
            'Can you still hear me?',
          ],
          reask:
            "Look, I just need a quick yes or no on a twenty-minute install chat — otherwise I'll leave it there.",
          bye: "Alright, I'll let you go — ring Sync2Dine when you're free. Cheers!",
        }
      : persona === 'staff'
        ? {
            check: ['You still there?', 'Can you still hear me?'],
            reask: "Still need something, or shall I hang up?",
            bye: "I'll leave it there — shout if you need me. Bye!",
          }
        : {
            check: ['You still there?', 'Can you still hear me?'],
            reask: 'Anything else I can help with, or shall I leave it there?',
            bye: 'No worries — call back anytime. Bye for now!',
          };

  return [
    {
      on: 'customer.speech.timeout',
      name: 'silence_check',
      options: {
        timeoutSeconds: 8,
        triggerMaxCount: 3,
        triggerResetMode: 'onUserSpeech',
      },
      do: [{ type: 'say', exact: lines.check }],
    },
    {
      on: 'customer.speech.timeout',
      name: 'silence_reask',
      options: {
        timeoutSeconds: 18,
        triggerMaxCount: 3,
        triggerResetMode: 'onUserSpeech',
      },
      do: [{ type: 'say', exact: lines.reask }],
    },
    {
      on: 'customer.speech.timeout',
      name: 'silence_hangup',
      options: {
        timeoutSeconds: 28,
        triggerMaxCount: 3,
        triggerResetMode: 'onUserSpeech',
      },
      do: [
        { type: 'say', exact: lines.bye },
        { type: 'tool', tool: { type: 'endCall' } },
      ],
    },
  ];
}

export async function buildVapiAssistantForParty(opts: {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  campaignTemplate?: string;
  callId?: string;
  contactName?: string;
  agentPersona?: string;
}): Promise<{
  assistant: Record<string, unknown>;
  identity: PhoneCallerIdentity;
  verified: boolean;
  agentPersona?: string;
}> {
  await hydrateCallerFromCloud(opts.partyPhone);
  const identity = resolvePhoneCallerIdentity(opts.partyPhone, DEFAULT_ORG_ID);
  const verified = opts.callId ? isPhoneAuthVerified(opts.callId) : false;
  const existingCall = opts.callId ? getCallById(opts.callId) : undefined;
  const languageOverride = (existingCall?.metadata as Record<string, unknown> | undefined)?.callLanguage as
    | string
    | undefined;
  const callMeta = (existingCall?.metadata as Record<string, unknown> | undefined) || {};
  const outboundBrief = callMeta.brief != null
    ? String(callMeta.brief)
    : callMeta.aim != null
      ? String(callMeta.aim)
      : undefined;

  const sally = isSallySalesCall(callMeta, {
    campaignTemplate: opts.campaignTemplate,
    agentPersona: opts.agentPersona || String(callMeta.agentPersona || ''),
  });

  const webhookBase = getVapiWebhookBaseUrl();
  const toolServer = `${webhookBase}/webhooks/vapi`;
  const webhookSecret = getVapiServerSecret() || undefined;
  const toolServerCfg = webhookSecret
    ? { url: toolServer, secret: webhookSecret }
    : { url: toolServer };
  const firstName = (opts.contactName || identity.name || String(callMeta.company || '')).split(/\s+/)[0];

  let instructions: string;
  let language: string;
  let firstMessage: string;
  let assistantName: string;
  let functionTools: Array<Record<string, unknown>>;

  if (sally) {
    const sallyPrompt = buildSallyBrainPrompt({
      partyPhone: opts.partyPhone,
      direction: opts.direction,
      outboundBrief,
      contactName: opts.contactName || identity.name,
      companyHint: callMeta.company != null ? String(callMeta.company) : undefined,
    });
    instructions = sallyPrompt.instructions;
    language = sallyPrompt.language;
    assistantName = 'Sally Sync2Dine';
    if (opts.direction === 'outbound') {
      firstMessage = firstName && !/^guest$/i.test(firstName)
        ? `Alright ${firstName}, it's Sally from Sync2Dine — you got a minute?`
        : `Alright love, it's Sally from Sync2Dine — who am I speaking with?`;
    } else {
      firstMessage = firstName && !/^guest$/i.test(firstName)
        ? `Alright ${firstName}, Sally from Sync2Dine — what can I do you for?`
        : `Alright, Sally from Sync2Dine — who am I speaking with?`;
    }
    functionTools = getSallyPhoneSessionChatTools()
      .filter((tool) => tool.function.name !== 'endCall')
      .map((tool) => ({
        type: 'function',
        function: tool.function,
        async: false,
        server: toolServerCfg,
      }));
  } else {
    const built = buildPhoneBrainPrompt({
      orgId: DEFAULT_ORG_ID,
      partyPhone: opts.partyPhone,
      direction: opts.direction,
      campaignTemplate: opts.campaignTemplate,
      outboundBrief,
      contactName: opts.contactName || identity.name,
      identity,
      callId: opts.callId,
      phoneAuthVerified: verified,
      languageOverride,
    });
    instructions = built.instructions;
    language = built.language;

    if (identity.kind === 'staff' || identity.kind === 'foreman') {
      firstMessage = verified
        ? `Hi ${firstName || 'there'}, Cynthia here — you're unlocked, what do you need?`
        : `Hi ${firstName || 'there'}, Cynthia here — when you can, say your four-digit security code and I'll unlock your tools.`;
      assistantName = `Judie (${identity.role})`;
    } else if (opts.direction === 'outbound') {
      firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, it's Judie from Sync2Dine — how are you getting on?`;
      assistantName = 'Judie Sync2Dine';
    } else {
      firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, Judie from Sync2Dine here — how can I help?`;
      assistantName = 'Judie Sync2Dine';
    }

    functionTools = getPhoneSessionChatTools(identity, verified)
      .filter((tool) => tool.function.name !== 'endCall')
      .map((tool) => ({
        type: 'function',
        function: tool.function,
        async: false,
        server: toolServerCfg,
      }));

    if (identity.kind !== 'customer' && !functionTools.some((t) => t.function.name === 'verifyStaffPhonePin')) {
      functionTools.unshift({
        type: 'function',
        function: VERIFY_PIN_TOOL.function,
        async: false,
        server: toolServerCfg,
      });
    }
  }

  const nativeTools: Array<Record<string, unknown>> = [
    { type: 'endCall' },
  ];
  // Sally sales: callback only — no warm transfer destinations.
  if (!sally) {
    const xfer = transferDestinationsFromEnv();
    if (xfer.length) {
      nativeTools.push({
        type: 'transferCall',
        destinations: xfer,
      });
    }
  }

  const baseVoice = getVapiVoiceConfigForLang(language) as Record<string, unknown>;
  const voice = sally
    ? { ...baseVoice, stability: 0.28, style: 0.55, similarityBoost: 0.85 }
    : baseVoice;

  const model = await buildVapiModelBlock({
    orgId: getHomeOrgId() || DEFAULT_ORG_ID,
    instructions,
    tools: [...nativeTools, ...functionTools],
  });

  const silencePersona: SilencePersona = sally
    ? 'sally'
    : identity.kind === 'staff' || identity.kind === 'foreman'
      ? 'staff'
      : 'judie';

  const isMeetingConfirm = String(callMeta.aim || '').toLowerCase() === 'meeting_confirm';
  if (sally && isMeetingConfirm && opts.direction === 'outbound') {
    firstMessage = firstName && !/^guest$/i.test(firstName)
      ? `Alright ${firstName}, Sally from Sync2Dine — just confirming your twenty-minute install chat is still on.`
      : `Alright love, Sally from Sync2Dine — just confirming your twenty-minute install chat is still on.`;
  }

  const assistant: Record<string, unknown> = {
    name: assistantName,
    firstMessage,
    model,
    voice,
    transcriber: {
      provider: 'deepgram',
      // Multilingual STT so callers can flip language mid-call (Vapi + Deepgram multi).
      model: process.env.VAPI_DEEPGRAM_MODEL?.trim() || 'nova-2',
      language: deepgramLanguageForPack(language),
    },
    silenceTimeoutSeconds: 35,
    maxDurationSeconds: Number(
      process.env.VAPI_MAX_CALL_SECONDS
      || (sally ? 1200 : 900),
    ),
    backgroundSound: 'off',
    hooks: buildSilenceHooks(silencePersona),
    ...(sally
      ? {
          voicemailDetectionEnabled: true,
          voicemailMessage:
            process.env.SALLY_VOICEMAIL_MESSAGE?.trim()
            || "Hi, it's Sally from Sync2Dine. We help restaurants answer the phone with AI that takes orders. I'll try you again soon — reply to this number when you're free. Thanks!",
        }
      : {}),
    // PIN via spoken digits → verifyStaffPhonePin. Do NOT send keypadInputEnabled (Vapi 400).
    serverUrl: toolServer,
    ...(webhookSecret ? { serverUrlSecret: webhookSecret } : {}),
    serverMessages: [
      'transcript',
      'status-update',
      'end-of-call-report',
      'tool-calls',
      'hang',
      'conversation-update',
    ],
  };

  // #region agent log
  debugLog('A', 'vapi-assistant.ts:buildVapiAssistantForParty', 'assistant silence config', {
    silencePersona,
    sally,
    aim: String(callMeta.aim || ''),
    silenceTimeoutSeconds: assistant.silenceTimeoutSeconds,
    hooksCount: Array.isArray(assistant.hooks) ? (assistant.hooks as unknown[]).length : 0,
    hookNames: Array.isArray(assistant.hooks)
      ? (assistant.hooks as Array<{ name?: string }>).map((h) => h.name)
      : [],
    hasThisCallIsDemo: String(instructions || '').includes('THIS CALL IS THE DEMO'),
    hasBookIntegration: String(instructions || '').includes('bookIntegrationMeeting'),
  });
  // #endregion

  return { assistant, identity, verified, agentPersona: sally ? SALLY_PERSONA : undefined };
}
