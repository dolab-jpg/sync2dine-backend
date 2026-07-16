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

/** Translate listed string fields in-place for customer-facing tool payloads. */
export async function ensureEnglishFields(
  input: Record<string, unknown>,
  fields: string[],
  sourceLang?: string | null,
  orgId?: string | null,
): Promise<{ ok: boolean; input: Record<string, unknown>; error?: string }> {
  const next = { ...input };
  for (const field of fields) {
    const raw = next[field];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const guard = await ensureEnglishForCustomerSend(raw, sourceLang, orgId);
    if (!guard.ok) {
      return {
        ok: false,
        input: next,
        error: `Could not translate ${field} to English before customer send.`,
      };
    }
    next[field] = guard.english;
  }
  return { ok: true, input: next };
}

/** Actions whose free-text fields must be English before they leave the system. */
export const CUSTOMER_ENGLISH_TEXT_FIELDS: Record<string, string[]> = {
  sendEmailReply: ['body', 'subject'],
  sendEmailWithAttachment: ['body', 'subject'],
  sendQuote: ['body', 'subject', 'message'],
  sendInvoice: ['body', 'subject', 'message'],
  sendContract: ['body', 'message', 'notes'],
  draftCustomerMessage: ['body', 'message', 'subject'],
  relayCustomerUpdate: ['body', 'message'],
  notifyCustomerChangeOrder: ['body', 'message', 'notes'],
  sendCustomerMessage: ['message', 'body'],
  generateContractPdf: ['terms', 'body', 'notes'],
  generateInvoicePdf: ['notes', 'body', 'description'],
  draftContract: ['body', 'terms', 'notes'],
  draftInvoice: ['body', 'notes', 'description'],
  saveContract: ['body', 'terms', 'bodyRendered', 'notes'],
};
