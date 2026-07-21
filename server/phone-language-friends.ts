/**
 * Spoken identity names for mid-call language switches (same session).
 * English stays Judie / Cynthia — other langs use local persona names.
 */
import { normalizeLang, type SupportedLang } from './language-packs';

const DEFAULT_SPOKEN_NAMES: Record<Exclude<SupportedLang, 'en'>, string> = {
  es: 'Lucía',
  pl: 'Ania',
  ru: 'Nastya',
  uk: 'Oksana',
  zh: 'Xiao Mei',
  hi: 'Priya',
  tr: 'Elif',
  ar: 'Layla',
  ro: 'Andreea',
  pt: 'Sofia',
  it: 'Giulia',
  sq: 'Elira',
  fa: 'Elham',
};

function parseSpokenNamesEnv(): Partial<Record<SupportedLang, string>> {
  const raw = process.env.VAPI_LANGUAGE_FRIEND_NAMES?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<SupportedLang, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const lang = normalizeLang(key);
      if (lang === 'en') continue;
      const name = String(value || '').trim();
      if (name) out[lang] = name;
    }
    return out;
  } catch {
    console.warn('[phone-language-friends] VAPI_LANGUAGE_FRIEND_NAMES is not valid JSON — ignoring');
    return {};
  }
}

/** First name for the spoken identity in a non-English language (never English). */
export function languageFriendName(lang: SupportedLang | string | null | undefined): string | null {
  const normalized = normalizeLang(lang);
  if (normalized === 'en') return null;
  const fromEnv = parseSpokenNamesEnv()[normalized];
  if (fromEnv) return fromEnv;
  return DEFAULT_SPOKEN_NAMES[normalized as Exclude<SupportedLang, 'en'>] || null;
}
