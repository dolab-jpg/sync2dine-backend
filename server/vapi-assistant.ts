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
import { getVapiWebhookBaseUrl } from './vapi-client';
export { resolveTransferNumber, transferDestinationsFromEnv } from './transfer-numbers';
import { transferDestinationsFromEnv } from './transfer-numbers';
import {
  buildSallyBrainPrompt,
  getSallyPhoneSessionChatTools,
  isSallySalesCall,
  isSallyTransferAllowed,
  SALLY_PERSONA,
} from './sally-sales-phone';
import { getHomeOrgId } from './home-org';
import { buildVapiModelBlock } from './vapi-llm-model';

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
    lineDid: callMeta.lineDid != null ? String(callMeta.lineDid) : undefined,
  });

  const webhookBase = getVapiWebhookBaseUrl();
  const toolServer = `${webhookBase}/webhooks/vapi`;
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
        server: { url: toolServer },
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
      assistantName = `Lizzie (${identity.role})`;
    } else if (opts.direction === 'outbound') {
      firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, it's Lizzie from Sync2Dine — how are you getting on?`;
      assistantName = 'Lizzie Sync2Dine';
    } else {
      firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, Lizzie from Sync2Dine here — how can I help?`;
      assistantName = 'Lizzie Sync2Dine';
    }

    functionTools = getPhoneSessionChatTools(identity, verified)
      .filter((tool) => tool.function.name !== 'endCall')
      .map((tool) => ({
        type: 'function',
        function: tool.function,
        async: false,
        server: { url: toolServer },
      }));

    if (identity.kind !== 'customer' && !functionTools.some((t) => t.function.name === 'verifyStaffPhonePin')) {
      functionTools.unshift({
        type: 'function',
        function: VERIFY_PIN_TOOL.function,
        async: false,
        server: { url: toolServer },
      });
    }
  }

  const nativeTools: Array<Record<string, unknown>> = [
    { type: 'endCall' },
  ];
  // Transfer destinations when VOICE_TRANSFER_* is set.
  // Sally: only expose native transferCall if SALLY_ALLOW_TRANSFER=1 (default off — AI-staffed).
  const xfer = transferDestinationsFromEnv();
  if (xfer.length && (!sally || isSallyTransferAllowed())) {
    nativeTools.push({
      type: 'transferCall',
      destinations: xfer,
    });
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
    silenceTimeoutSeconds: sally ? 90 : 45,
    maxDurationSeconds: Number(
      process.env.VAPI_MAX_CALL_SECONDS
      || (sally ? 1200 : 900),
    ),
    backgroundSound: 'off',
    ...(sally
      ? {
          voicemailDetectionEnabled: true,
          voicemailMessage:
            process.env.SALLY_VOICEMAIL_MESSAGE?.trim()
            || "Hi, it's Sally from Sync2Dine. We help restaurants answer the phone with AI that takes orders. I'll try you again soon — or reply to this number and we'll book a quick demo. Thanks!",
        }
      : {}),
    // PIN via spoken digits → verifyStaffPhonePin. Do NOT send keypadInputEnabled (Vapi 400).
    serverUrl: toolServer,
    serverMessages: [
      'transcript',
      'status-update',
      'end-of-call-report',
      'tool-calls',
      'hang',
      'conversation-update',
    ],
  };

  return { assistant, identity, verified, agentPersona: sally ? SALLY_PERSONA : undefined };
}
