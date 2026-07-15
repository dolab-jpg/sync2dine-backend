import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_PATH = join(__dirname, 'data', 'language-packs.json');

export const SUPPORTED_LANGS = ['en', 'sq', 'uk', 'ru', 'zh', 'es', 'pl', 'fa'] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export const LANG_LABELS: Record<SupportedLang, string> = {
  en: 'English',
  sq: 'Albanian',
  uk: 'Ukrainian',
  ru: 'Russian',
  zh: 'Chinese',
  es: 'Spanish',
  pl: 'Polish',
  fa: 'Farsi / Persian',
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
    unknown_contact: 'Thanks for getting in touch. How can we help with your project?',
    need_more_info: 'Could you share a bit more detail so I can help?',
  },
};

export function normalizeLang(code: string | null | undefined): SupportedLang {
  const c = (code ?? 'en').toLowerCase().split('-')[0];
  return (SUPPORTED_LANGS as readonly string[]).includes(c) ? (c as SupportedLang) : 'en';
}

export function isRtlLang(lang?: string | null): boolean {
  return normalizeLang(lang) === 'fa';
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

/** Deepgram nova-2 language code per pack; 'multi' triggers Deepgram's multilingual mode. */
const DEEPGRAM_LANG_BY_PACK: Record<SupportedLang, string> = {
  en: 'en-GB',
  es: 'es',
  pl: 'pl',
  zh: 'zh',
  uk: 'uk',
  ru: 'ru',
  fa: 'multi',
  sq: 'multi',
};

export function deepgramLanguageForPack(lang?: string | null): string {
  const code = normalizeLang(lang);
  return DEEPGRAM_LANG_BY_PACK[code] ?? 'multi';
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
