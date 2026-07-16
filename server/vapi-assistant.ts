/**
 * Shared builders for Vapi assistant payloads (outbound + assistant-request).
 */
import { DEFAULT_ORG_ID, getCallById } from './data-store';
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
import { getVapiVoiceConfig, getVapiWebhookBaseUrl } from './vapi-client';
export { resolveTransferNumber, transferDestinationsFromEnv } from './transfer-numbers';
import { transferDestinationsFromEnv } from './transfer-numbers';

export function buildVapiAssistantForParty(opts: {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  campaignTemplate?: string;
  callId?: string;
  contactName?: string;
}): {
  assistant: Record<string, unknown>;
  identity: PhoneCallerIdentity;
  verified: boolean;
} {
  const identity = resolvePhoneCallerIdentity(opts.partyPhone, DEFAULT_ORG_ID);
  const verified = opts.callId ? isPhoneAuthVerified(opts.callId) : false;
  const existingCall = opts.callId ? getCallById(opts.callId) : undefined;
  const languageOverride = (existingCall?.metadata as Record<string, unknown> | undefined)?.callLanguage as
    | string
    | undefined;
  const { instructions, language } = buildPhoneBrainPrompt({
    orgId: DEFAULT_ORG_ID,
    partyPhone: opts.partyPhone,
    direction: opts.direction,
    campaignTemplate: opts.campaignTemplate,
    contactName: opts.contactName || identity.name,
    identity,
    callId: opts.callId,
    phoneAuthVerified: verified,
    languageOverride,
  });

  const webhookBase = getVapiWebhookBaseUrl();
  const toolServer = `${webhookBase}/webhooks/vapi`;
  const firstName = (opts.contactName || identity.name || '').split(/\s+/)[0];

  let firstMessage: string;
  if (identity.kind === 'staff' || identity.kind === 'foreman') {
    firstMessage = verified
      ? `Hi ${firstName || 'there'}, Cynthia here — you're unlocked, what do you need?`
      : `Hi ${firstName || 'there'}, Cynthia here — when you can, say your four-digit security code and I'll unlock your tools.`;
  } else if (opts.direction === 'outbound') {
    firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, it's Cynthia from TradePro — how are you getting on?`;
  } else {
    firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, Cynthia from TradePro here — how can I help?`;
  }

  // Vapi uses native { type: 'endCall' } — do not also expose a function endCall
  // (that path only marks the DB completed and leaves the live session open).
  const functionTools = getPhoneSessionChatTools(identity, verified)
    .filter((tool) => tool.function.name !== 'endCall')
    .map((tool) => ({
      type: 'function',
      function: tool.function,
      async: false,
      server: { url: toolServer },
    }));

  // Always expose PIN verifier for staff sessions even if somehow filtered
  if (identity.kind !== 'customer' && !functionTools.some((t) => t.function.name === 'verifyStaffPhonePin')) {
    functionTools.unshift({
      type: 'function',
      function: VERIFY_PIN_TOOL.function,
      async: false,
      server: { url: toolServer },
    });
  }

  const nativeTools: Array<Record<string, unknown>> = [
    { type: 'endCall' },
  ];
  const xfer = transferDestinationsFromEnv();
  if (xfer.length) {
    nativeTools.push({
      type: 'transferCall',
      destinations: xfer,
    });
  }

  const assistant: Record<string, unknown> = {
    name: identity.kind === 'customer' ? 'Cynthia TradePro' : `Cynthia (${identity.role})`,
    firstMessage,
    model: {
      provider: 'openai',
      model: process.env.VAPI_LLM_MODEL?.trim() || 'gpt-4o',
      temperature: 0.7,
      messages: [{ role: 'system', content: instructions }],
      tools: [...nativeTools, ...functionTools],
    },
    voice: getVapiVoiceConfig(),
    transcriber: {
      provider: 'deepgram',
      // Multilingual STT so callers can flip language mid-call (Vapi + Deepgram multi).
      model: process.env.VAPI_DEEPGRAM_MODEL?.trim() || 'nova-2',
      language: deepgramLanguageForPack(language),
    },
    silenceTimeoutSeconds: 45,
    maxDurationSeconds: Number(process.env.VAPI_MAX_CALL_SECONDS || 900),
    backgroundSound: 'off',
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

  return { assistant, identity, verified };
}
