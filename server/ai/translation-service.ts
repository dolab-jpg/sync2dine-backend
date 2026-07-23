/**
 * Canonical-English translation gateway.
 *
 * Worker/staff/customer channels may converse in any SUPPORTED_LANGS language, but the
 * orchestrator, CRM writes, search/tool inputs, and documents all reason in English.
 * This module is the single place that talks to OpenAI to move text across that boundary —
 * every call is allowlisted to SUPPORTED_LANGS, time-boxed, cached, and never throws for the
 * "safe" (public) functions: translation failures fall back to the original text so a flaky
 * translation call can never break a chat/webhook request.
 */
import {
  getPack,
  getPhrase,
  getSystemInstruction,
  normalizeLang,
  LANG_LABELS,
  SUPPORTED_LANGS,
  type SupportedLang,
} from '../language-packs';

export { getPack, getPhrase, getSystemInstruction, normalizeLang };
export type { SupportedLang };

const SCRIPT_HINTS: Array<{ lang: SupportedLang; test: (t: string) => boolean }> = [
  { lang: 'zh', test: (t) => /[\u4e00-\u9fff]/.test(t) },
  { lang: 'fa', test: (t) => /[\u0600-\u06ff]/.test(t) },
  // Ukrainian-specific letters (ї/є/ґ) disambiguate from Russian when present.
  { lang: 'uk', test: (t) => /[їєґІЇЄҐ]/.test(t) },
  // Russian-specific letters (ъ/э/ё) that don't appear in modern Ukrainian.
  { lang: 'ru', test: (t) => /[ъэЪЭёЁ]/.test(t) },
];

/** Any run of 4+ Cyrillic letters with no language-specific marker — ambiguous uk/ru. */
const CYRILLIC_RUN = /[а-яА-Я]{4,}/;

/**
 * Cheap script/character heuristic — never calls OpenAI. Used as a fast first pass and as the
 * fallback when the LLM-based detection fails or times out. Callers who already know the
 * speaker's `preferredLanguage` (from their profile) should prefer that over this heuristic —
 * see `normalizeInboundText`.
 */
export async function detectLanguage(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) return 'en';
  for (const hint of SCRIPT_HINTS) {
    if (hint.test(trimmed)) return hint.lang;
  }
  // Cyrillic but no uk/ru-specific letters — heuristic can't tell them apart; default to
  // Russian only as a last resort (both are in SUPPORTED_LANGS, callers with a known
  // preferredLanguage always win over this guess).
  if (CYRILLIC_RUN.test(trimmed)) return 'ru';
  return 'en';
}

// ---------------------------------------------------------------------------
// In-memory translation cache — simple Map-based LRU keyed by a cheap hash of
// (direction, lang, text). Caps memory use for repeated stock phrases/questions.
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 500;
const translationCache = new Map<string, string>();

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${hash}.${text.length}`;
}

function cacheKey(direction: 'to-en' | 'from-en' | 'search-to-en' | 'search-from-en', lang: string, text: string): string {
  return `${direction}:${lang}:${hashText(text)}`;
}

function cacheGet(key: string): string | undefined {
  const value = translationCache.get(key);
  if (value === undefined) return undefined;
  // Refresh recency for LRU behaviour.
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key: string, value: string): void {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  if (translationCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey !== undefined) translationCache.delete(oldestKey);
  }
}

/** Exposed for tests only — keeps cache state isolated between test cases. */
export function clearTranslationCacheForTests(): void {
  translationCache.clear();
}

// ---------------------------------------------------------------------------
// LLM plumbing — kept behind a small, overridable seam so unit tests can stub
// the model call without hitting OpenAI or needing a mocking framework.
// ---------------------------------------------------------------------------

interface TranslationChatClient {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

type TranslationClientFactory = (orgId: string | null) => Promise<TranslationChatClient>;

let clientFactoryOverride: TranslationClientFactory | null = null;

/** Test-only seam — inject a fake chat client instead of hitting OpenAI. Pass `null` to reset. */
export function __setTranslationClientFactoryForTests(factory: TranslationClientFactory | null): void {
  clientFactoryOverride = factory;
}

async function getTranslationClient(orgId?: string | null): Promise<TranslationChatClient> {
  if (clientFactoryOverride) return clientFactoryOverride(orgId ?? null);
  const { createLLMClientForOrg } = await import('./llm-connection');
  const { client } = await createLLMClientForOrg(orgId ?? null, '/api/internal/translate', {});
  return client as unknown as TranslationChatClient;
}

const TRANSLATE_TIMEOUT_MS = 7000;
const TRANSLATE_MODEL = 'gpt-4o-mini';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function runTranslationModel(systemPrompt: string, userText: string, orgId?: string | null): Promise<string> {
  const client = await getTranslationClient(orgId);
  const completion = await withTimeout(
    Promise.resolve(
      client.chat.completions.create({
        model: TRANSLATE_MODEL,
        temperature: 0,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
      }),
    ),
    TRANSLATE_TIMEOUT_MS,
    'translation request',
  );
  const content = completion.choices?.[0]?.message?.content ?? '';
  return content.trim();
}

const PRESERVE_INSTRUCTION =
  'Preserve numbers, dates, names, addresses, currency amounts, units, and measurements exactly as written — ' +
  'do not convert, round, reformat, or translate them. Do not add notes, explanations, or quotation marks. ' +
  'Return ONLY the translated text.';

/**
 * Real translate-to-English. Throws on error/timeout/empty result — used internally by the
 * safe `translateToEnglish` wrapper and by `ensureEnglishForCustomerSend`, which needs to know
 * whether the translation genuinely failed (vs. coincidentally matched the input).
 */
export async function translateToEnglishStrict(
  text: string,
  fromLang?: string | null,
  orgId?: string | null,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const source = fromLang ? normalizeLang(fromLang) : normalizeLang(await detectLanguage(trimmed));
  if (source === 'en') return trimmed;

  const key = cacheKey('to-en', source, trimmed);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const system = `You are a precise translator for a UK construction company. Translate the user's message from ${LANG_LABELS[source]} into English. ${PRESERVE_INSTRUCTION}`;
  const result = await runTranslationModel(system, trimmed, orgId);
  if (!result) throw new Error('translateToEnglish: empty translation result');
  cacheSet(key, result);
  return result;
}

/**
 * Safe translate-to-English — allowlisted, cached, time-boxed. Never throws: on any
 * error/timeout it logs and falls back to the original text so callers (webhooks, chat
 * handlers) never break because a translation call failed.
 */
export async function translateToEnglish(
  text: string,
  fromLang?: string | null,
  orgId?: string | null,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  try {
    return await translateToEnglishStrict(trimmed, fromLang, orgId);
  } catch (err) {
    console.error('translateToEnglish: falling back to original text after failure:', err);
    return trimmed;
  }
}

/**
 * Real translate-from-English. Throws on error/timeout/empty result — kept for symmetry with
 * translateToEnglishStrict and for callers that need to distinguish a genuine failure.
 */
export async function translateFromEnglishStrict(
  text: string,
  toLang?: string | null,
  orgId?: string | null,
): Promise<string> {
  const lang = normalizeLang(toLang);
  const trimmed = text.trim();
  if (!trimmed || lang === 'en') return trimmed;

  const key = cacheKey('from-en', lang, trimmed);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const system = `You are a precise translator for a UK construction company. Translate the following English text into ${LANG_LABELS[lang]}. ${PRESERVE_INSTRUCTION}`;
  const result = await runTranslationModel(system, trimmed, orgId);
  if (!result) throw new Error('translateFromEnglish: empty translation result');
  cacheSet(key, result);
  return result;
}

/**
 * Safe translate-from-English. Prefers saved phrase-pack lookups for a handful of known stock
 * lines (fast path, no network call, consistent wording), otherwise calls the model for
 * arbitrary AI-generated English text. Never throws — falls back to the English text.
 */
export async function translateFromEnglish(
  text: string,
  toLang: string,
  orgId?: string | null,
): Promise<string> {
  const lang = normalizeLang(toLang);
  const trimmed = text.trim();
  if (!trimmed || lang === 'en') return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower === 'done.' || lower === 'done') return getPhrase(lang, 'done');
  if (lower.includes('reply yes to confirm')) return getPhrase(lang, 'confirm_yes_no');

  try {
    return await translateFromEnglishStrict(trimmed, lang, orgId);
  } catch (err) {
    console.error('translateFromEnglish: falling back to English text after failure:', err);
    return trimmed;
  }
}

/**
 * Inbound: resolve the speaker's language (profile `preferredLanguage` always wins over the
 * heuristic) and produce a real canonical-English copy for the orchestrator/search/CRM layer.
 */
export async function normalizeInboundText(
  text: string,
  preferredLanguage?: string | null,
  orgId?: string | null,
): Promise<{ english: string; detectedLanguage: string; original: string }> {
  const detected = preferredLanguage
    ? normalizeLang(preferredLanguage)
    : await detectLanguage(text);
  const english = detected === 'en' ? text : await translateToEnglish(text, detected, orgId);
  return { english, detectedLanguage: detected, original: text };
}

/**
 * Outbound: localize an English reply for a specific speaker. Stock phrase-pack keys are a
 * fast-path/first-choice; everything else (arbitrary AI-generated English) is really
 * translated via the model.
 */
export async function localizeOutboundText(
  englishText: string,
  targetLanguage?: string | null,
  orgId?: string | null,
): Promise<string> {
  const lang = normalizeLang(targetLanguage);
  if (lang === 'en') return englishText;
  return translateFromEnglish(englishText, lang, orgId);
}

// ---------------------------------------------------------------------------
// Search-query helpers — translate a foreign-language query to English before it is used to
// search canonical (English) records/knowledge, and translate short explanatory result text
// back without touching structured data (names/totals/statuses/measurements).
// ---------------------------------------------------------------------------

/** Translate a foreign-language search query to English before querying CRM/KB records. */
export async function translateSearchQuery(
  query: string,
  fromLang?: string | null,
  orgId?: string | null,
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  const lang = fromLang ? normalizeLang(fromLang) : await detectLanguage(trimmed);
  if (lang === 'en') return trimmed;
  return translateToEnglish(trimmed, lang, orgId);
}

/**
 * Translate short explanatory text around search results back to the speaker's language.
 * Intended for labels/explanations only — never pass structured data (names, totals,
 * statuses, measurements) through this; keep those literal in the caller.
 */
export async function localizeSearchResultText(
  text: string,
  toLang?: string | null,
  orgId?: string | null,
): Promise<string> {
  const lang = normalizeLang(toLang);
  const trimmed = text.trim();
  if (!trimmed || lang === 'en') return trimmed;
  try {
    const system = `You are a precise translator for a UK construction company. Translate the following short English explanation into ${LANG_LABELS[lang]}. It accompanies structured search results (names, totals, statuses, dates, measurements) that are NOT part of this text. ${PRESERVE_INSTRUCTION}`;
    const key = cacheKey('search-from-en', lang, trimmed);
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    const result = await runTranslationModel(system, trimmed, orgId);
    if (!result) return trimmed;
    cacheSet(key, result);
    return result;
  } catch (err) {
    console.error('localizeSearchResultText: falling back to English text after failure:', err);
    return trimmed;
  }
}

export { SUPPORTED_LANGS };
