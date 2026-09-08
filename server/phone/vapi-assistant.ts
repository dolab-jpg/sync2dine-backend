/**
 * Shared builders for Vapi assistant payloads (outbound + assistant-request).
 * Session brains load from server/brains/{sally|judie|cynthia}.
 */
import { DEFAULT_ORG_ID, getCallById, hydrateCallerFromCloud, saveCall } from '../data-store';
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
import {
  applyInboundCandidateRecruitmentMeta,
  isSallyRecruitmentCall,
  recruitmentVoicemailMessage,
} from '../sally/recruitment-interview';
import { buildBrainSession, type SilencePersona } from '../brains/index';
import { CYNTHIA_PERSONA } from '../brains/cynthia/branding';
import { getHomeOrgId, SYNC2DINE_SPOKEN } from '../home-org';
import { buildVapiModelBlock } from './vapi-llm-model';
import { debugLog } from '../debug-session-log';

export type { SilencePersona };

/** Shared dead-air ladder for every Vapi phone agent (check → re-ask → hang up). */
export function buildSilenceHooks(
  persona: SilencePersona,
  opts?: { omitHangup?: boolean; timeoutScale?: number; recruitment?: boolean },
): Array<Record<string, unknown>> {
  const scale = opts?.timeoutScale && opts.timeoutScale > 0 ? opts.timeoutScale : 1;
  const t = (seconds: number) => Math.max(8, Math.round(seconds * scale));
  const lines =
    opts?.recruitment
      ? {
          check: [
            'You still with me?',
            'You still there?',
            'Can you still hear me?',
          ],
          reask: 'Still there? Shall we finish the interview?',
          bye: "I'll leave it there — call this number back when you can finish the interview. Cheers!",
        }
      : persona === 'sally'
      ? {
          check: [
            'You still with me, love?',
            'You still there?',
            'Can you still hear me?',
          ],
          reask:
            "No worries — is the manager or owner about, or when are they usually in? Otherwise I can leave a short message.",
          bye: `Alright, I'll let you go — ring ${SYNC2DINE_SPOKEN} when you're free. Cheers!`,
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
            // Only after a long quiet stretch — do NOT apologise mid placeFoodOrder.
            check: [
              'You still with me, love?',
              'Can you still hear me?',
              'I am here — what can I get you?',
            ],
            reask: 'Sorry about that — what would you like to order?',
            bye: 'No worries — call back anytime. Bye for now!',
          };

  const hooks: Array<Record<string, unknown>> = [
    {
      on: 'customer.speech.timeout',
      name: 'silence_check',
      options: {
        timeoutSeconds: t(8),
        triggerMaxCount: 3,
        triggerResetMode: 'onUserSpeech',
      },
      do: [{ type: 'say', exact: lines.check }],
    },
    {
      on: 'customer.speech.timeout',
      name: 'silence_reask',
      options: {
        timeoutSeconds: t(18),
        triggerMaxCount: 3,
        triggerResetMode: 'onUserSpeech',
      },
      do: [{ type: 'say', exact: lines.reask }],
    },
  ];
  if (!opts?.omitHangup) {
    hooks.push({
      on: 'customer.speech.timeout',
      name: 'silence_hangup',
      options: {
        timeoutSeconds: t(28),
        triggerMaxCount: 3,
        triggerResetMode: 'onUserSpeech',
      },
      do: [
        { type: 'say', exact: lines.bye },
        { type: 'tool', tool: { type: 'endCall' } },
      ],
    });
  }
  return hooks;
}

const SALLY_DEFAULT_VOICEMAIL =
  `Hi, it's Sally from ${SYNC2DINE_SPOKEN}. We help restaurants answer the phone with AI that takes orders. I'll try you again soon — reply to this number when you're free. Thanks!`;

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
  // Never block assistant-request on CRM hydrate (Vapi budget ~7.5s).
  void Promise.race([
    hydrateCallerFromCloud(opts.partyPhone),
    new Promise((resolve) => setTimeout(resolve, 400)),
  ]).catch(() => undefined);
  const identity = resolvePhoneCallerIdentity(opts.partyPhone, orgId);
  const verified = opts.callId ? isPhoneAuthVerified(opts.callId) : false;
  const existingCall = opts.callId ? getCallById(opts.callId) : undefined;
  const languageOverride = (existingCall?.metadata as Record<string, unknown> | undefined)?.callLanguage as
    | string
    | undefined;
  let callMeta = { ...((existingCall?.metadata as Record<string, unknown> | undefined) || {}) };
  const personaHint = String(opts.agentPersona || callMeta.agentPersona || callMeta.linePurpose || '').toLowerCase();
  let contactName = opts.contactName || identity.name || String(callMeta.contactName || callMeta.name || '');
  if (opts.direction === 'inbound' && (personaHint === 'sally' || personaHint === SALLY_PERSONA)) {
    const stamped = applyInboundCandidateRecruitmentMeta(opts.partyPhone, callMeta);
    callMeta = stamped.meta;
    if (stamped.contactName) contactName = stamped.contactName;
    if (opts.callId && stamped.candidateId) {
      saveCall({
        id: opts.callId,
        contactName: stamped.contactName || contactName,
        candidateId: stamped.candidateId,
        campaignTemplate: 'recruitment_interview',
        intent: 'recruitment',
        metadata: callMeta,
      });
    }
  }
  const outboundBrief = callMeta.brief != null
    ? String(callMeta.brief)
    : callMeta.aim != null
      ? String(callMeta.aim)
      : undefined;
  const recruitment = isSallyRecruitmentCall(callMeta, {
    campaignTemplate: opts.campaignTemplate,
    agentPersona: opts.agentPersona || String(callMeta.agentPersona || ''),
  });

  const webhookBase = getVapiWebhookBaseUrl();
  const toolServer = `${webhookBase}/webhooks/vapi`;
  const webhookSecret = getVapiServerSecret() || undefined;
  const toolServerCfg = webhookSecret
    ? { url: toolServer, secret: webhookSecret }
    : { url: toolServer };
  const firstName = (contactName || String(callMeta.company || '')).split(/\s+/)[0];

  const session = await buildBrainSession({
    partyPhone: opts.partyPhone,
    direction: opts.direction,
    identity,
    verified,
    callId: opts.callId,
    campaignTemplate: recruitment ? 'recruitment_interview' : opts.campaignTemplate,
    outboundBrief,
    contactName,
    companyHint: callMeta.company != null ? String(callMeta.company) : undefined,
    languageOverride,
    callMeta,
    agentPersona: opts.agentPersona || String(callMeta.agentPersona || ''),
    orgId,
  });
  const sally = session.id === 'sally';
  // Sally OUTBOUND sales = English-UK only. Never let a foreign word flip her
  // language (drift into Spanish + "let me switch languages" + hang up).
  const sallyOutbound = sally && opts.direction === 'outbound';
  let { instructions, language, firstMessage, assistantName } = session;
  if (sallyOutbound) language = 'en';
  const silencePersona: SilencePersona = session.silencePersona;

  const functionTools = session.chatTools
    // Sally never switches languages on phone sales — strip setCallLanguage for all Sally calls.
    .filter((tool) => !(sally && tool.function.name === 'setCallLanguage'))
    .map((tool) => ({
      type: 'function' as const,
      function: tool.function,
      async: false,
      server: toolServerCfg,
    }));

  const nativeTools: Array<Record<string, unknown>> = [
    { type: 'endCall' },
  ];
  if (sally) {
    nativeTools.push({ type: 'voicemail' });
  }
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
  const voiceTuned = sally
    ? { ...baseVoice, stability: 0.28, style: 0.55, similarityBoost: 0.85 }
    : baseVoice;
  // Spoken brand fix: TTS mangles the written brand ("Sync2Dime" / "Sing2Dine" /
  // "Cinque Dying"). Map written forms to the phonetic "Sync to Dine" before TTS.
  const voice = {
    ...voiceTuned,
    chunkPlan: {
      formatPlan: {
        replacements: [
          { type: 'exact', key: 'Sync2Dine', value: 'Sync to Dine' },
          { type: 'exact', key: 'sync Two dine', value: 'Sync to Dine' },
        ],
      },
    },
  };

  const model = await buildVapiModelBlock({
    // Judie restaurant calls use the restaurant org key; Sally uses home/platform.
    orgId: sally ? (getHomeOrgId() || orgId) : orgId,
    instructions,
    tools: [...nativeTools, ...functionTools],
    // Judie diner: OpenAI + capped tokens — DeepSeek + full CRM tool pack caused 5–8s turn gaps.
    preferFastVoice: !sally,
  });

  const isMeetingConfirm = String(callMeta.aim || '').toLowerCase() === 'meeting_confirm';
  if (sally && isMeetingConfirm && opts.direction === 'outbound' && !recruitment) {
    firstMessage = firstName && !/^guest$/i.test(firstName)
      ? `Alright ${firstName}, Sally from ${SYNC2DINE_SPOKEN} — just confirming your twenty-minute install chat is still on.`
      : `Alright love, Sally from ${SYNC2DINE_SPOKEN} — just confirming your twenty-minute install chat is still on.`;
  }

  const sallyVoicemailMessage = recruitment
    ? recruitmentVoicemailMessage()
    : (process.env.SALLY_VOICEMAIL_MESSAGE?.trim() || SALLY_DEFAULT_VOICEMAIL);
  // Sally outbound: skip silence hangup so beep + voicemail drop can finish; stretch check/reask.
  // (sallyOutbound computed above so language/voice/transcriber can be locked to English.)
  // Judie inbound: omit auto hangup so we wait for caller goodbye after the order;
  // keep gentle still-there checks, scaled past placeFoodOrder.
  const judieInbound = !sally && opts.direction === 'inbound';
  const silenceHooks = buildSilenceHooks(
    silencePersona,
    sallyOutbound
      ? { omitHangup: true, timeoutScale: 2.5, recruitment }
      : judieInbound
        ? { omitHangup: true, timeoutScale: 2.75 }
        : recruitment
          ? { recruitment: true }
          : undefined,
  );

  const assistant: Record<string, unknown> = {
    name: assistantName,
    firstMessage,
    firstMessageMode: 'assistant-speaks-first',
    model,
    voice,
    // Vapi live monitoring: reliably expose a listen (+ control) URL. Safe for all personas.
    monitorPlan: { listenEnabled: true, controlEnabled: true },
    transcriber: {
      provider: 'deepgram',
      // Inbound/Judie: multilingual STT so callers can flip language mid-call.
      // Sally OUTBOUND: locked to en-GB so a foreign word cannot flip her.
      model: process.env.VAPI_DEEPGRAM_MODEL?.trim() || 'nova-2',
      language: sallyOutbound
        ? deepgramLanguageForPack(language, { lockEnglish: true })
        : deepgramLanguageForPack(language),
    },
    silenceTimeoutSeconds: sallyOutbound ? 60 : judieInbound ? 55 : 35,
    maxDurationSeconds: Number(
      process.env.VAPI_MAX_CALL_SECONDS
      || (sallyOutbound ? 420 : sally ? 1200 : 900),
    ),
    backgroundSound: 'off',
    hooks: silenceHooks,
    ...(sally
      ? {
          voicemailMessage: sallyVoicemailMessage,
          voicemailDetection: {
            provider: 'vapi',
            backoffPlan: {
              maxRetries: 5,
              startAtSeconds: 2,
              frequencySeconds: 2.5,
            },
            // Wait long enough for typical UK greetings before speaking the drop.
            beepMaxAwaitSeconds: 30,
          },
          // Conservative turn-taking for takeaway main-line noise / loudspeaker.
          startSpeakingPlan: {
            waitSeconds: Number(process.env.VAPI_SALLY_WAIT_SECONDS || 0.55),
            smartEndpointingPlan: {
              provider: 'livekit',
              waitFunction: process.env.VAPI_SALLY_EOT_WAIT_FUNCTION?.trim()
                || '30 + 500 * sqrt(x) + 2200 * x^3',
            },
            transcriptionEndpointingPlan: {
              onPunctuationSeconds: 0.35,
              onNoPunctuationSeconds: 1.2,
              onNumberSeconds: 0.5,
            },
          },
          stopSpeakingPlan: {
            numWords: 3,
            voiceSeconds: 0.3,
            backoffSeconds: 1.0,
          },
        }
      : {
          // Faster turn-taking for diner Judie (was relying on Vapi defaults → multi-second dead air).
          // LiveKit smart endpointing is recommended for English; waitSeconds is a floor after EOT.
          startSpeakingPlan: {
            waitSeconds: Number(process.env.VAPI_JUDIE_WAIT_SECONDS || 0.35),
            smartEndpointingPlan: {
              provider: 'livekit',
              // Slightly snappier than default waitFunction for takeaway turns.
              waitFunction: process.env.VAPI_JUDIE_EOT_WAIT_FUNCTION?.trim()
                || '20 + 400 * sqrt(x) + 1800 * x^3',
            },
            transcriptionEndpointingPlan: {
              onPunctuationSeconds: 0.2,
              onNoPunctuationSeconds: 0.9,
              onNumberSeconds: 0.4,
            },
          },
          stopSpeakingPlan: {
            numWords: 2,
            voiceSeconds: 0.2,
            backoffSeconds: 0.8,
          },
        }),
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
