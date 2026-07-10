import { mockAdapter } from './mockAdapter';
import { twilioAdapter } from './twilioAdapter';
import { soho66Adapter } from './soho66Adapter';
import type { TelephonyConfig, TelephonyProvider, TelephonyProviderId } from './types';

const adapters: Record<TelephonyProviderId, TelephonyProvider> = {
  mock: mockAdapter,
  twilio: twilioAdapter,
  soho66: soho66Adapter,
};

export function resolveTelephonyConfig(overrides?: Partial<TelephonyConfig>): TelephonyConfig {
  const provider = (overrides?.provider
    ?? process.env.TELEPHONY_PROVIDER
    ?? 'mock') as TelephonyProviderId;

  return {
    provider,
    accountSid: overrides?.accountSid ?? process.env.TWILIO_ACCOUNT_SID,
    authToken: overrides?.authToken ?? process.env.TWILIO_AUTH_TOKEN,
    fromNumber: overrides?.fromNumber
      ?? (provider === 'soho66' ? process.env.SOHO66_FROM_NUMBER : process.env.TWILIO_FROM_NUMBER),
    webhookBaseUrl: overrides?.webhookBaseUrl ?? process.env.WEBHOOK_BASE_URL ?? process.env.APP_BASE_URL,
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
  return adapters[resolved.provider] ?? mockAdapter;
}

export * from './types';
