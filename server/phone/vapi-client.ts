/**
 * Vapi HTTP client + config helpers for managed SIP telephony.
 */
import { listPhoneLines } from '../data-store';

export type VapiRegion = 'us' | 'eu';

export function getVapiRegion(): VapiRegion {
  const region = String(process.env.VAPI_REGION || 'eu').trim().toLowerCase();
  return region === 'us' ? 'us' : 'eu';
}

export function getVapiApiBase(): string {
  return getVapiRegion() === 'us' ? 'https://api.vapi.ai' : 'https://api.eu.vapi.ai';
}

export function getVapiPrivateKey(): string | null {
  const key = process.env.VAPI_PRIVATE_KEY?.trim() || process.env.VAPI_API_KEY?.trim();
  return key || null;
}

export function getVapiServerSecret(): string | null {
  return process.env.VAPI_SERVER_SECRET?.trim() || null;
}

export function getVapiWebhookBaseUrl(): string {
  return (
    process.env.VAPI_WEBHOOK_BASE_URL?.trim()
    || process.env.PUBLIC_WEBHOOK_BASE_URL?.trim()
    || process.env.WEBHOOK_BASE_URL?.trim()
    || 'http://127.0.0.1:3001'
  ).replace(/\/$/, '');
}

/** Prefer a configured ElevenLabs voice — production fails closed without an explicit id. */
export function getVapiVoiceConfig(): Record<string, unknown> {
  const voiceId = process.env.VAPI_ELEVENLABS_VOICE_ID?.trim()
    || process.env.ELEVENLABS_VOICE_ID?.trim()
    || '';
  if (!voiceId) {
    const allowDevFallback = process.env.ALLOW_TELEPHONY_MOCK === '1'
      || process.env.NODE_ENV === 'test'
      || (process.env.NODE_ENV !== 'production' && process.env.FAIL_CLOSED !== '1');
    if (!allowDevFallback) {
      throw new Error('VAPI_ELEVENLABS_VOICE_ID (or ELEVENLABS_VOICE_ID) must be configured');
    }
  }
  return {
    provider: '11labs',
    voiceId: voiceId || 'EQx6HGDYjkDpcli6vorJ', // Judie — Cockney Character (dev/test only)
    model: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_turbo_v2_5',
    stability: 0.35,
    similarityBoost: 0.8,
    style: 0.45,
    optimizeStreamingLatency: 3,
  };
}

export function getVapiPublicKey(): string | null {
  return process.env.VAPI_PUBLIC_KEY?.trim() || null;
}

/**
 * UK E.164. Geographic numbers often arrive without the leading 0
 * (e.g. Winslow 1296715055 → +441296715055). Do not blindly prefix `+`.
 */
export function toUkE164(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw.replace(/\s+/g, '');
  if (digits.startsWith('44') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 10) return `+44${digits.slice(1)}`;
  // Missing leading 0: 10-digit UK NSN (1/2/3 geographic, 7 mobile, etc.).
  if (digits.length === 10 && /^[1-9]/.test(digits)) return `+44${digits}`;
  if (raw.startsWith('+')) return `+${digits}`;
  return `+${digits}`;
}

export function toE164Uk(input: string): string {
  return toUkE164(input);
}

/** True for a plausible UK E.164 (+44 + 9–10-digit NSN, not starting with 0). */
export function isPlausibleUkE164(phone: string | null | undefined): boolean {
  const e164 = toUkE164(String(phone || '').trim());
  return /^\+44[1-9]\d{8,9}$/.test(e164);
}

export function getSoho66AriaLine() {
  const lines = listPhoneLines();
  const aria = lines.find((l) => l.purpose === 'aria' && l.enabled !== false)
    || lines.find((l) => l.enabled !== false)
    || lines[0];
  return aria ?? null;
}

export async function vapiFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; raw: string }> {
  const key = getVapiPrivateKey();
  if (!key) throw new Error('VAPI_PRIVATE_KEY is not configured');
  const url = `${getVapiApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(45000) });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    json = { raw };
  }
  return { ok: response.ok, status: response.status, json, raw };
}
