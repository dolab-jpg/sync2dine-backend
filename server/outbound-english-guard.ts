/**
 * English-only external boundary guard.
 *
 * Workers/staff may chat with the AI (and with each other) in their preferred language, but
 * anything that reaches a customer — manual staff replies, tool-generated messages, emails,
 * contract/quote/invoice text — must be canonical English. Call `ensureEnglishForCustomerSend`
 * immediately before any customer-facing send; if it returns `ok: false`, hold/reject the send
 * instead of leaking untranslated foreign-language text to a customer.
 */
import { normalizeLang, type SupportedLang } from './language-packs';
import { detectLanguage, translateToEnglishStrict } from './translation-service';

export interface EnglishGuardResult {
  english: string;
  ok: boolean;
}

export async function ensureEnglishForCustomerSend(
  text: string,
  sourceLang?: string | null,
  orgId?: string | null,
): Promise<EnglishGuardResult> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { english: trimmed, ok: true };

  const knownLang = sourceLang ? normalizeLang(sourceLang) : undefined;
  if (knownLang === 'en') return { english: trimmed, ok: true };

  let lang: SupportedLang | undefined = knownLang;
  if (!lang) {
    lang = normalizeLang(await detectLanguage(trimmed));
    if (lang === 'en') return { english: trimmed, ok: true };
  }

  try {
    const english = (await translateToEnglishStrict(trimmed, lang, orgId)).trim();
    if (!english) return { english: trimmed, ok: false };
    return { english, ok: true };
  } catch (err) {
    console.error('ensureEnglishForCustomerSend: translation failed, blocking send:', err);
    return { english: trimmed, ok: false };
  }
}
