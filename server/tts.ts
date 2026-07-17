import { getAgentSettings, getCallById, getRequestOrgId } from './data-store';
import { getOrgOpenAIApiKey, listOrganizations } from './organizations';
import { requireOpenAIApiKeyAsync, resolveOpenAIApiKeyAsync } from './openai-connection';
import { resolveElevenLabsApiKey } from './org-elevenlabs';
import { recordProviderUsage } from './usage';

export const OPENAI_TTS_VOICE_IDS = new Set(['fable', 'alloy', 'nova', 'shimmer', 'echo', 'onyx']);

export interface TtsResult {
  buffer: Buffer;
  contentType: string;
  provider: 'chatterbox' | 'openai' | 'elevenlabs';
}

export interface ChatterboxConfig {
  baseUrl: string;
  apiKey: string;
  ttsPath: string;
}

const BIAS = 0x84;
const CLIP = 32635;

function linearToMulaw(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent === 0 ? 4 : exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xff;
}

function pcm16ToMulaw8k(pcm: Buffer, srcRate = 24000): Buffer {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount <= 0) return Buffer.alloc(0);
  const ratio = srcRate / 8000;
  const outLen = Math.floor(sampleCount / ratio);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcIndex = Math.min(sampleCount - 1, Math.floor(i * ratio));
    const sample = pcm.readInt16LE(srcIndex * 2);
    out[i] = linearToMulaw(sample);
  }
  return out;
}

export function getChatterboxConfig(): ChatterboxConfig | null {
  const baseUrl = (process.env.CHATTERBOX_BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: process.env.CHATTERBOX_API_KEY ?? '',
    ttsPath: process.env.CHATTERBOX_TTS_PATH ?? '/tts',
  };
}

function isOpenAiVoiceId(voiceId: string | null | undefined): boolean {
  return !!voiceId && OPENAI_TTS_VOICE_IDS.has(voiceId);
}

function resolveVoiceId(override?: string | null): string | null {
  if (override) return override;
  return (
    getAgentSettings().activeVoiceId
    || process.env.ELEVENLABS_VOICE_ID?.trim()
    || process.env.VAPI_ELEVENLABS_VOICE_ID?.trim()
    || null
  );
}

function getElevenLabsConfig(orgId?: string | null): { apiKey: string; voiceId: string; modelId: string } | null {
  const apiKey = resolveElevenLabsApiKey(orgId ?? getRequestOrgId());
  if (!apiKey) return null;
  const voiceId = (
    process.env.ELEVENLABS_VOICE_ID?.trim()
    || process.env.VAPI_ELEVENLABS_VOICE_ID?.trim()
    || 'EQx6HGDYjkDpcli6vorJ'
  );
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_turbo_v2_5';
  return { apiKey, voiceId, modelId };
}

async function synthesizeWithElevenLabs(
  text: string,
  voiceId: string,
  format: 'mp3' | 'pcm' | 'mulaw' = 'mp3',
): Promise<TtsResult> {
  const orgId = getRequestOrgId();
  const cfg = getElevenLabsConfig(orgId);
  if (!cfg) throw new Error('ELEVENLABS_API_KEY not configured');
  const outputFormat = format === 'mulaw'
    ? 'ulaw_8000'
    : format === 'pcm'
      ? 'pcm_24000'
      : 'mp3_44100_128';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/*,application/octet-stream,*/*',
    },
    body: JSON.stringify({
      text,
      model_id: cfg.modelId,
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.8,
        style: 0.45,
        use_speaker_boost: true,
      },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS error (${response.status})${errText ? `: ${errText.slice(0, 200)}` : ''}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = format === 'mulaw'
    ? 'audio/basic'
    : format === 'pcm'
      ? 'audio/L16; rate=24000; channels=1'
      : 'audio/mpeg';
  const meterOrg = orgId && orgId !== 'default' ? orgId : resolveTtsOrgId();
  if (meterOrg && text) {
    try {
      recordProviderUsage({
        orgId: meterOrg,
        provider: 'elevenlabs',
        unit: 'characters',
        quantity: text.length,
        endpoint: 'tts.elevenlabs',
        model: cfg.modelId,
        metadata: { voiceId, format },
      });
    } catch {
      /* metering must not break TTS */
    }
  }
  return { buffer, contentType, provider: 'elevenlabs' };
}

function resolveTtsOrgId(): string | null {
  const current = getRequestOrgId();
  if (current && current !== 'default' && getOrgOpenAIApiKey(current)) return current;
  for (const org of listOrganizations()) {
    if (getOrgOpenAIApiKey(org.id)) return org.id;
  }
  return current && current !== 'default' ? current : null;
}

export function hasOpenAIKeyAvailable(): boolean {
  if ((process.env.OPENAI_API_KEY || '').trim()) return true;
  return listOrganizations().some((org) => Boolean(getOrgOpenAIApiKey(org.id)));
}

async function synthesizeWithChatterbox(
  text: string,
  voiceId: string,
  config: ChatterboxConfig,
): Promise<TtsResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/*,application/octet-stream,*/*',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const path = config.ttsPath.startsWith('/') ? config.ttsPath : `/${config.ttsPath}`;
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, voice_id: voiceId }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Chatterbox TTS error (${response.status})${errText ? `: ${errText.slice(0, 200)}` : ''}`);
  }

  const contentType = response.headers.get('content-type') ?? 'audio/wav';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType, provider: 'chatterbox' };
}

async function synthesizeWithOpenAI(
  text: string,
  voiceId: string,
  format: 'mp3' | 'pcm' | 'mulaw' = 'mp3',
): Promise<TtsResult> {
  const orgId = resolveTtsOrgId();
  const apiKey = await requireOpenAIApiKeyAsync(undefined, orgId);
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  const voice = isOpenAiVoiceId(voiceId) ? voiceId : 'fable';

  if (format === 'pcm' || format === 'mulaw') {
    const pcm = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice as 'fable',
      input: text,
      response_format: 'pcm',
    });
    const pcmBuf = Buffer.from(await pcm.arrayBuffer());
    if (format === 'pcm') {
      return { buffer: pcmBuf, contentType: 'audio/L16; rate=24000; channels=1', provider: 'openai' };
    }
    const mulaw = pcm16ToMulaw8k(pcmBuf, 24000);
    return { buffer: mulaw, contentType: 'audio/basic', provider: 'openai' };
  }

  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: voice as 'fable',
    input: text,
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  return { buffer, contentType: 'audio/mpeg', provider: 'openai' };
}

export async function synthesizeSpeech(
  text: string,
  voiceIdOverride?: string | null,
  format: 'mp3' | 'pcm' | 'mulaw' = 'mp3',
): Promise<TtsResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('TTS text is required');
  }

  const eleven = getElevenLabsConfig();
  const voiceId = resolveVoiceId(voiceIdOverride) || eleven?.voiceId || null;
  const chatterbox = getChatterboxConfig();
  const orgId = resolveTtsOrgId();
  const openAiKey = await resolveOpenAIApiKeyAsync(undefined, orgId);

  // Prefer ElevenLabs (Cockney Aria) whenever configured — including phone μ-law
  if (eleven && voiceId && !isOpenAiVoiceId(voiceId)) {
    try {
      return await synthesizeWithElevenLabs(trimmed, voiceId, format);
    } catch (err) {
      console.warn('[tts] ElevenLabs failed, falling back', err instanceof Error ? err.message : err);
      if (!openAiKey && !chatterbox) throw err;
    }
  }

  if (format === 'mulaw' || format === 'pcm') {
    if (!openAiKey) throw new Error('OpenAI or ElevenLabs key required for mulaw/pcm TTS');
    return synthesizeWithOpenAI(trimmed, voiceId ?? 'fable', format);
  }

  if (chatterbox && voiceId && !isOpenAiVoiceId(voiceId)) {
    try {
      return await synthesizeWithChatterbox(trimmed, voiceId, chatterbox);
    } catch (err) {
      if (!openAiKey) throw err;
    }
  }

  if (openAiKey) {
    return synthesizeWithOpenAI(trimmed, voiceId ?? 'fable', 'mp3');
  }

  if (chatterbox && voiceId) {
    return synthesizeWithChatterbox(trimmed, voiceId, chatterbox);
  }

  throw new Error('No TTS provider configured — set ELEVENLABS_API_KEY, CHATTERBOX_BASE_URL, or OpenAI key');
}

export function resolveTtsTextFromCall(callId: string): string | null {
  const call = getCallById(callId);
  if (!call) return null;
  const turns = Array.isArray(call.transcript)
    ? (call.transcript as Array<{ role: string; content: string }>)
    : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'agent' && turns[i].content?.trim()) {
      return turns[i].content.trim();
    }
  }
  return null;
}

export function buildAgentTtsUrl(
  webhookBase: string,
  params: { text?: string; callId?: string; voiceId?: string; format?: string },
): string {
  const base = webhookBase.replace(/\/$/, '');
  const url = new URL(`${base}/api/agent/tts`);
  if (params.text) url.searchParams.set('text', params.text);
  if (params.callId) url.searchParams.set('callId', params.callId);
  if (params.voiceId) url.searchParams.set('voiceId', params.voiceId);
  if (params.format) url.searchParams.set('format', params.format);
  return url.toString();
}

export function shouldUsePlayAudio(): boolean {
  if (getElevenLabsConfig()) return true;
  const settings = getAgentSettings();
  if (!settings.activeVoiceId) return false;
  if (getChatterboxConfig()) return true;
  if (hasOpenAIKeyAvailable() && isOpenAiVoiceId(settings.activeVoiceId)) return true;
  return hasOpenAIKeyAvailable();
}
