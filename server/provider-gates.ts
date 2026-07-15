/**
 * Production fail-closed gates for Vapi / telephony providers.
 * Development mocks only when ALLOW_TELEPHONY_MOCK=1 (or NODE_ENV=test).
 */
import { getVapiPrivateKey, getVapiServerSecret, getVapiWebhookBaseUrl } from './vapi-client';

export function isProductionRuntime(): boolean {
  if (process.env.FAIL_CLOSED === '1') return true;
  if (process.env.NODE_ENV === 'test' && process.env.FAIL_CLOSED !== '1') return false;
  if (process.env.ALLOW_TELEPHONY_MOCK === '1' && process.env.FAIL_CLOSED !== '1') return false;
  return (
    process.env.NODE_ENV === 'production'
    || Boolean(process.env.RAILWAY_ENVIRONMENT)
    || Boolean(process.env.RENDER)
    || Boolean(process.env.FLY_APP_NAME)
  );
}

export function getVapiPublicKey(): string | null {
  return process.env.VAPI_PUBLIC_KEY?.trim() || null;
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  errors: string[];
}

/** Hard requirements for placing/handling production Vapi calls. */
export function assertVapiProductionReady(): ProviderHealth {
  const errors: string[] = [];
  const voice = String(process.env.VOICE_PROVIDER || '').trim().toLowerCase();
  if (isProductionRuntime()) {
    if (voice && voice !== 'vapi') {
      errors.push(`VOICE_PROVIDER must be vapi in production (got ${voice})`);
    }
    if (!voice) errors.push('VOICE_PROVIDER must be explicitly set to vapi');
  }
  if (!getVapiPrivateKey()) errors.push('VAPI_PRIVATE_KEY is not configured');
  if (!getVapiPublicKey() && isProductionRuntime()) errors.push('VAPI_PUBLIC_KEY is not configured');
  if (!process.env.VAPI_PHONE_NUMBER_ID?.trim() && isProductionRuntime()) {
    errors.push('VAPI_PHONE_NUMBER_ID is not configured');
  }
  const webhook = getVapiWebhookBaseUrl();
  if (isProductionRuntime() && (!webhook || webhook.includes('127.0.0.1') || webhook.includes('localhost'))) {
    errors.push('VAPI_WEBHOOK_BASE_URL must be a public HTTPS URL');
  }
  if (isProductionRuntime() && !getVapiServerSecret()) {
    errors.push('VAPI_SERVER_SECRET is required in production');
  }
  const voiceId = process.env.VAPI_ELEVENLABS_VOICE_ID?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim();
  if (isProductionRuntime() && !voiceId) {
    errors.push('Configured ElevenLabs voice id is required (VAPI_ELEVENLABS_VOICE_ID)');
  }
  return { ok: errors.length === 0, provider: 'vapi', errors };
}

export function rejectUnknownProvider(provider: string): string | null {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) {
    if (isProductionRuntime()) return 'Telephony provider is not configured';
    return null;
  }
  if (p === 'mock' && isProductionRuntime()) {
    return 'mock telephony is disabled in production';
  }
  const known = new Set(['vapi', 'soho66', 'local_realtime', 'local', 'twilio', 'mock']);
  if (!known.has(p)) return `Unknown telephony provider: ${p}`;
  return null;
}
