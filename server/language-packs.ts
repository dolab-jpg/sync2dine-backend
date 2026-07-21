import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_PATH = join(__dirname, 'data', 'language-packs.json');

/** Phone + CRM spoken languages (Judie-first; preferredLanguage unlocks non-en dial). */
export const SUPPORTED_LANGS = [
  'en',
  'es',
  'pl',
  'ru',
  'uk',
  'zh',
  'hi',
  'tr',
  'ar',
  'ro',
  'pt',
  'it',
  'sq',
  'fa',
] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export const LANG_LABELS: Record<SupportedLang, string> = {
  en: 'English',
  es: 'Spanish',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  zh: 'Chinese',
  hi: 'Hindi',
  tr: 'Turkish',
  ar: 'Arabic',
  ro: 'Romanian',
  pt: 'Portuguese',
  it: 'Italian',
  sq: 'Albanian',
  fa: 'Farsi / Persian',
};

const ALIAS_TO_LANG: Record<string, SupportedLang> = {
  hindi: 'hi',
  indian: 'hi',
  turkish: 'tr',
  arabic: 'ar',
  romanian: 'ro',
  portuguese: 'pt',
  italian: 'it',
  spanish: 'es',
  polish: 'pl',
  russian: 'ru',
  ukrainian: 'uk',
  chinese: 'zh',
  mandarin: 'zh',
  albanian: 'sq',
  farsi: 'fa',
  persian: 'fa',
  dari: 'fa',
};

export interface LanguagePack {
  label: string;
  systemInstruction: string;
  phrases: Record<string, string>;
}

export type LanguagePacksMap = Record<string, LanguagePack>;

let cache: LanguagePacksMap | null = null;

const EMPTY_PACK: LanguagePack = {
  label: 'English',
  systemInstruction: 'Reply only in English. Keep replies short and clear for WhatsApp/phone.',
  phrases: {
    greeting: 'Hello! How can I help you today?',
    thanks: 'Thank you.',
    confirm_yes_no: 'Reply YES to confirm or NO to cancel.',
    done: 'Done.',
    error_generic: 'Sorry, something went wrong. Please try again.',
    unknown_contact: 'Thanks for getting in touch. How can I help with your order?',
    need_more_info: 'Could you share a bit more detail so I can help?',
  },
};

export function normalizeLang(code: string | null | undefined): SupportedLang {
  const raw = (code ?? 'en').toLowerCase().trim();
  const base = raw.split('-')[0];
  if (ALIAS_TO_LANG[raw]) return ALIAS_TO_LANG[raw];
  if (ALIAS_TO_LANG[base]) return ALIAS_TO_LANG[base];
  return (SUPPORTED_LANGS as readonly string[]).includes(base) ? (base as SupportedLang) : 'en';
}

export function isRtlLang(lang?: string | null): boolean {
  const n = normalizeLang(lang);
  return n === 'fa' || n === 'ar';
}

function ensureFile(): void {
  if (existsSync(PACKS_PATH)) return;
  mkdirSync(dirname(PACKS_PATH), { recursive: true });
  writeFileSync(PACKS_PATH, JSON.stringify({ en: EMPTY_PACK }, null, 2));
}

export function loadLanguagePacks(): LanguagePacksMap {
  if (cache) return cache;
  ensureFile();
  try {
    const raw = JSON.parse(readFileSync(PACKS_PATH, 'utf-8')) as LanguagePacksMap;
    cache = raw && typeof raw === 'object' ? raw : { en: EMPTY_PACK };
  } catch {
    cache = { en: EMPTY_PACK };
  }
  return cache;
}

export function saveLanguagePacks(packs: LanguagePacksMap): LanguagePacksMap {
  const next: LanguagePacksMap = {};
  for (const lang of SUPPORTED_LANGS) {
    const incoming = packs[lang];
    const existing = loadLanguagePacks()[lang] ?? EMPTY_PACK;
    next[lang] = {
      label: String(incoming?.label ?? existing.label ?? lang),
      systemInstruction: String(incoming?.systemInstruction ?? existing.systemInstruction ?? ''),
      phrases: {
        ...(existing.phrases ?? {}),
        ...(incoming?.phrases && typeof incoming.phrases === 'object' ? incoming.phrases : {}),
      },
    };
  }
  mkdirSync(dirname(PACKS_PATH), { recursive: true });
  writeFileSync(PACKS_PATH, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** Drop in-memory cache (tests / after external file edit). */
export function clearLanguagePacksCache(): void {
  cache = null;
}

export function getPack(lang?: string | null): LanguagePack {
  const code = normalizeLang(lang);
  const packs = loadLanguagePacks();
  return packs[code] ?? packs.en ?? EMPTY_PACK;
}

export function getSystemInstruction(lang?: string | null): string {
  return getPack(lang).systemInstruction;
}

/**
 * Deepgram STT for Vapi phone: always multilingual so callers can flip mid-call.
 */
export function deepgramLanguageForPack(_lang?: string | null): string {
  return 'multi';
}

/**
 * Look up a saved phrase. Supports `{name}` style placeholders from vars.
 * Falls back to English pack, then the key itself.
 */
export function getPhrase(
  lang: string | null | undefined,
  key: string,
  vars?: Record<string, string | number>
): string {
  const pack = getPack(lang);
  const en = getPack('en');
  let text = pack.phrases[key] ?? en.phrases[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}
