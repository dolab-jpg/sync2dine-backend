/**
 * Per-language ElevenLabs voices for Lizzie phone (Vapi).
 * English / UK always uses Lizzie from env — never remapped by this module.
 */
import { type SupportedLang, normalizeLang } from './language-packs';
import { getVapiVoiceConfig } from './vapi-client';

/** Lizzie — Cockney Character (dev fallback only when env unset). */
export const LIZZIE_VOICE_ID = 'EQx6HGDYjkDpcli6vorJ';

/**
 * Default female funny/sassy voices for non-English. Env overrides:
 * VAPI_ELEVENLABS_VOICE_ID_ES, …_PL, …_RU, …_UK, …_ZH, …_FA, …_SQ
 * or JSON VAPI_ELEVENLABS_VOICE_MAP={"es":"…"} (must not override en).
 */
const DEFAULT_VOICE_BY_LANG: Record<Exclude<SupportedLang, 'en'>, string> = {
  es: '03vEurziQfq3V8WZhQvn', // Aerisita — Sassy and Comedic
  pl: 'NOWYzprzTwfZQqU76pBX', // Aleksandra — dynamic Polish
  ru: 'bi0tSQTrp58MDdPUkrEl', // Klava — energetic / loud
  uk: '2HWb7sZSrZqPB8HOI0KI', // Kira — strong Ukrainian female
  zh: 'DVE92KG0Yd4X7RoMqy8J', // Zicai — sitcom / comedic Mandarin
  fa: 'FGY2WhTYpPnrIDTdsKH5', // Laura — Enthusiast, Quirky Attitude
  sq: 'ejl43bbp2vjkAFGSmAMa', // Veronica — Sassy & Energetic
};

const ENV_SUFFIX: Record<Exclude<SupportedLang, 'en'>, string> = {
  es: 'ES',
  pl: 'PL',
  ru: 'RU',
  uk: 'UK',
  zh: 'ZH',
  fa: 'FA',
  sq: 'SQ',
};

function parseVoiceMapEnv(): Partial<Record<SupportedLang, string>> {
  const raw = process.env.VAPI_ELEVENLABS_VOICE_MAP?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<SupportedLang, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'en') continue; // never override Lizzie via JSON map
      const lang = normalizeLang(key);
      if (lang === 'en') continue;
      const id = String(value || '').trim();
      if (id) out[lang] = id;
    }
    return out;
  } catch {
    console.warn('[phone-voices] VAPI_ELEVENLABS_VOICE_MAP is not valid JSON — ignoring');
    return {};
  }
}

/** Resolve ElevenLabs voice id for a spoken call language. English always = Lizzie env. */
export function voiceIdForLang(lang: SupportedLang | string | null | undefined): string {
  const normalized = normalizeLang(lang);
  const englishId = process.env.VAPI_ELEVENLABS_VOICE_ID?.trim()
    || process.env.ELEVENLABS_VOICE_ID?.trim()
    || LIZZIE_VOICE_ID;

  if (normalized === 'en') return englishId;

  const fromJson = parseVoiceMapEnv()[normalized];
  if (fromJson) return fromJson;

  const suffix = ENV_SUFFIX[normalized];
  const fromEnv = process.env[`VAPI_ELEVENLABS_VOICE_ID_${suffix}`]?.trim();
  if (fromEnv) return fromEnv;

  return DEFAULT_VOICE_BY_LANG[normalized] || englishId;
}

/** Vapi voice config for a language — English uses getVapiVoiceConfig() unchanged. */
export function getVapiVoiceConfigForLang(lang: SupportedLang | string | null | undefined): Record<string, unknown> {
  const normalized = normalizeLang(lang);
  const base = getVapiVoiceConfig();
  if (normalized === 'en') return base;

  const voiceId = voiceIdForLang(normalized);
  return {
    ...base,
    voiceId,
  };
}
