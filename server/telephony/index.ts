import { mockAdapter } from './mockAdapter';
import { twilioAdapter } from './twilioAdapter';
import { soho66Adapter } from './soho66Adapter';
import { vapiAdapter } from './vapiAdapter';
import type { TelephonyConfig, TelephonyProvider, TelephonyProviderId } from './types';

const adapters: Record<TelephonyProviderId, TelephonyProvider> = {
  mock: mockAdapter,
  twilio: twilioAdapter,
  soho66: soho66Adapter,
  vapi: vapiAdapter,
};

/**
 * VOICE_PROVIDER overrides TELEPHONY_PROVIDER for outbound Cynthia calls.
 * - vapi: managed SIP/media (recommended)
 * - local_realtime / soho66: custom home SIP bridge
 * Production fails closed: no implicit mock.
 */
export function resolveVoiceProviderId(): TelephonyProviderId {
  const voice = String(process.env.VOICE_PROVIDER || '').trim().toLowerCase();
  if (voice === 'vapi') return 'vapi';
  if (voice === 'local_realtime' || voice === 'soho66' || voice === 'local') return 'soho66';
  if (voice === 'twilio') return 'twilio';
  if (voice === 'mock') {
    if (process.env.NODE_ENV === 'production' || process.env.FAIL_CLOSED === '1') {
      throw new Error('mock telephony is disabled in production — set VOICE_PROVIDER=vapi');
    }
    return 'mock';
  }
  const telephony = String(process.env.TELEPHONY_PROVIDER || '').trim().toLowerCase();
  if (telephony === 'vapi') return 'vapi';
  if (telephony === 'soho66' || telephony === 'twilio') return telephony as TelephonyProviderId;
  if (telephony === 'mock' || !telephony) {
    const allowMock = process.env.ALLOW_TELEPHONY_MOCK === '1' || process.env.NODE_ENV === 'test'
      || (process.env.NODE_ENV !== 'production' && process.env.FAIL_CLOSED !== '1');
    if (allowMock) return 'mock';
    throw new Error('Telephony provider not configured — set VOICE_PROVIDER=vapi');
  }
  throw new Error(`Unknown telephony provider: ${telephony || voice || '(empty)'}`);
}

export function resolveTelephonyConfig(overrides?: Partial<TelephonyConfig>): TelephonyConfig {
  const provider = (overrides?.provider ?? resolveVoiceProviderId()) as TelephonyProviderId;

  return {
    provider,
    accountSid: overrides?.accountSid ?? process.env.TWILIO_ACCOUNT_SID,
    authToken: overrides?.authToken ?? process.env.TWILIO_AUTH_TOKEN,
    fromNumber: overrides?.fromNumber
      ?? (provider === 'soho66' || provider === 'vapi'
        ? process.env.SOHO66_FROM_NUMBER
        : process.env.TWILIO_FROM_NUMBER),
    webhookBaseUrl: overrides?.webhookBaseUrl
      ?? process.env.VAPI_WEBHOOK_BASE_URL
      ?? process.env.WEBHOOK_BASE_URL
      ?? process.env.APP_BASE_URL,
    transferNumber: overrides?.transferNumber ?? process.env.VOICE_TRANSFER_NUMBER,
    afterHoursEnabled: overrides?.afterHoursEnabled ?? process.env.VOICE_AFTER_HOURS === '1',
    businessHoursStart: overrides?.businessHoursStart ?? process.env.VOICE_BUSINESS_HOURS_START ?? '09:00',
    businessHoursEnd: overrides?.businessHoursEnd ?? process.env.VOICE_BUSINESS_HOURS_END ?? '17:30',
    sipUsername: overrides?.sipUsername ?? process.env.SOHO66_SIP_USERNAME,
    sipPassword: overrides?.sipPassword ?? process.env.SOHO66_SIP_PASSWORD,
    sipDomain: overrides?.sipDomain ?? process.env.SOHO66_SIP_DOMAIN,
    sipBridgeUrl: overrides?.sipBridgeUrl ?? process.env.SOHO66_SIP_BRIDGE_URL,
  };
}

export function getTelephonyProvider(config?: TelephonyConfig): TelephonyProvider {
  const resolved = config ?? resolveTelephonyConfig();
  const adapter = adapters[resolved.provider];
  if (!adapter) {
    throw new Error(`No telephony adapter for provider: ${resolved.provider}`);
  }
  if (resolved.provider === 'mock' && (process.env.NODE_ENV === 'production' || process.env.FAIL_CLOSED === '1')) {
    throw new Error('mock telephony adapter is disabled in production');
  }
  return adapter;
}

export * from './types';
