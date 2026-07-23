/**
 * Shared builders for Vapi assistant payloads (outbound + assistant-request).
 * Session brains load from server/brains/{sally|judie|cynthia}.
 */
import { DEFAULT_ORG_ID, getCallById, hydrateCallerFromCloud } from '../data-store';
import {
  isPhoneAuthVerified,
  resolvePhoneCallerIdentity,
  type PhoneCallerIdentity,
} from './phone-auth';
import { deepgramLanguageForPack } from '../language-packs';
import { getVapiVoiceConfigForLang } from './phone-voices';
import { getVapiServerSecret, getVapiWebhookBaseUrl } from './vapi-client';
export { resolveTransferNumber, transferDestinationsFromEnv } from './transfer-numbers';
import { transferDestinationsFromEnv } from './transfer-numbers';
import { SALLY_PERSONA } from './sally-sales-phone';
import { buildBrainSession, type SilencePersona } from '../brains/index';
import { CYNTHIA_PERSONA } from '../brains/cynthia/branding';
import { getHomeOrgId } from '../home-org';
import { buildVapiModelBlock } from './vapi-llm-model';
import { debugLog } from '../debug-session-log';

export type { SilencePersona };

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
      : persona === 'staff' || persona === 'cynthia'
        ? {
            check: ['You still there?', 'Can you still hear me?'],
            reask: "Still need something, or shall I hang up?",
            bye:
              persona === 'cynthia'
                ? "I'll leave it there — call Builder Diddies if you need me. Bye!"
                : "I'll leave it there — shout if you need me. Bye!",
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
  /** Trusted org from DID routing — never from the LLM. */
  orgId?: string;
}): Promise<{
  assistant: Record<string, unknown>;
  identity: PhoneCallerIdentity;
  verified: boolean;
  agentPersona?: string;
}> {
  const orgId = String(opts.orgId || getHomeOrgId() || DEFAULT_ORG_ID).trim();
  await hydrateCallerFromCloud(opts.partyPhone);
  const identity = resolvePhoneCallerIdentity(opts.partyPhone, orgId);
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

  const webhookBase = getVapiWebhookBaseUrl();
  const toolServer = `${webhookBase}/webhooks/vapi`;
  const webhookSecret = getVapiServerSecret() || undefined;
  const toolServerCfg = webhookSecret
    ? { url: toolServer, secret: webhookSecret }
    : { url: toolServer };
  const firstName = (opts.contactName || identity.name || String(callMeta.company || '')).split(/\s+/)[0];

  const session = await buildBrainSession({
    partyPhone: opts.partyPhone,
    direction: opts.direction,
    identity,
    verified,
    callId: opts.callId,
    campaignTemplate: opts.campaignTemplate,
    outboundBrief,
    contactName: opts.contactName || identity.name,
    companyHint: callMeta.company != null ? String(callMeta.company) : undefined,
    languageOverride,
    callMeta,
    agentPersona: opts.agentPersona || String(callMeta.agentPersona || ''),
  });
  const sally = session.id === 'sally';
  let { instructions, language, firstMessage, assistantName } = session;
  const silencePersona: SilencePersona = session.silencePersona;

  const functionTools = session.chatTools.map((tool) => ({
    type: 'function' as const,
    function: tool.function,
    async: false,
    server: toolServerCfg,
  }));

  const nativeTools: Array<Record<string, unknown>> = [
    { type: 'endCall' },
  ];
  if (session.allowTransfer) {
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
    // Judie restaurant calls use the restaurant org key; Sally uses home/platform.
    orgId: sally ? (getHomeOrgId() || orgId) : orgId,
    instructions,
    tools: [...nativeTools, ...functionTools],
  });

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

  return {
    assistant,
    identity,
    verified,
    agentPersona: sally
      ? SALLY_PERSONA
      : session.id === 'cynthia'
        ? CYNTHIA_PERSONA
        : undefined,
  };
}
