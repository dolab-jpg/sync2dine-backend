import { getAgentSettings, getCallById } from './data-store';
import { requireOpenAIApiKey } from './openai-connection';

export const OPENAI_TTS_VOICE_IDS = new Set(['fable', 'alloy', 'nova', 'shimmer', 'echo', 'onyx']);

export interface TtsResult {
  buffer: Buffer;
  contentType: string;
  provider: 'chatterbox' | 'openai';
}

export interface ChatterboxConfig {
  baseUrl: string;
  apiKey: string;
  ttsPath: string;
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
  return getAgentSettings().activeVoiceId ?? null;
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

async function synthesizeWithOpenAI(text: string, voiceId: string): Promise<TtsResult> {
  const apiKey = requireOpenAIApiKey();
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });
  const voice = isOpenAiVoiceId(voiceId) ? voiceId : 'fable';
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: voice as 'fable',
    input: text,
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  return { buffer, contentType: 'audio/mpeg', provider: 'openai' };
}

export async function synthesizeSpeech(text: string, voiceIdOverride?: string | null): Promise<TtsResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('TTS text is required');
  }

  const voiceId = resolveVoiceId(voiceIdOverride);
  const chatterbox = getChatterboxConfig();

  if (chatterbox && voiceId && !isOpenAiVoiceId(voiceId)) {
    try {
      return await synthesizeWithChatterbox(trimmed, voiceId, chatterbox);
    } catch (err) {
      if (!process.env.OPENAI_API_KEY) throw err;
      // fall through to OpenAI if cloned voice fails but OpenAI is available
    }
  }

  if (process.env.OPENAI_API_KEY) {
    return synthesizeWithOpenAI(trimmed, voiceId ?? 'fable');
  }

  if (chatterbox && voiceId) {
    return synthesizeWithChatterbox(trimmed, voiceId, chatterbox);
  }

  throw new Error('No TTS provider configured — set CHATTERBOX_BASE_URL or OPENAI_API_KEY');
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
  params: { text?: string; callId?: string; voiceId?: string },
): string {
  const base = webhookBase.replace(/\/$/, '');
  const url = new URL(`${base}/api/agent/tts`);
  if (params.text) url.searchParams.set('text', params.text);
  if (params.callId) url.searchParams.set('callId', params.callId);
  if (params.voiceId) url.searchParams.set('voiceId', params.voiceId);
  return url.toString();
}

export function shouldUsePlayAudio(): boolean {
  const settings = getAgentSettings();
  if (!settings.activeVoiceId) return false;
  if (getChatterboxConfig()) return true;
  if (process.env.OPENAI_API_KEY && isOpenAiVoiceId(settings.activeVoiceId)) return true;
  return !!process.env.OPENAI_API_KEY;
}
