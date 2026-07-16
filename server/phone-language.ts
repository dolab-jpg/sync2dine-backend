/**
 * Persist phone setCallLanguage to CRM / staff profile so the next call remembers it.
 */
import { createClient } from '@supabase/supabase-js';
import { saveCustomerRecord, resolveContactByPhone, getDataStore, syncData } from './data-store';
import { upsertTeamMember, type TeamMember } from './conversation-store';
import { LANG_LABELS, normalizeLang, type SupportedLang } from './language-packs';
import type { PhoneCallerIdentity } from './phone-auth';

function trySupabaseAdmin() {
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function spokenLanguageNudge(lang: SupportedLang): string {
  const label = LANG_LABELS[lang] ?? lang;
  return [
    `Speak your next reply aloud in ${label} immediately — do not list languages and stop.`,
    'Your name is still Cynthia in every language; never introduce yourself as an ElevenLabs voice label.',
    'Keep using the same tools as before. Tool calls, CRM writes, emails, contracts, quotes, and any text that reaches a customer stay formal UK English.',
  ].join(' ');
}

export async function persistCallLanguagePreference(
  identity: PhoneCallerIdentity,
  rawLang: string,
): Promise<{ language: SupportedLang; persisted: string[] }> {
  const language = normalizeLang(rawLang);
  const persisted: string[] = [];

  if (identity.kind === 'customer') {
    const contact = resolveContactByPhone(identity.phone);
    const store = getDataStore();
    const existing = contact.customerId
      ? store.customers.find((c) => String(c.id) === String(contact.customerId))
      : undefined;
    if (existing) {
      saveCustomerRecord({
        ...existing,
        preferredLanguage: language,
      });
      persisted.push('customer');
    }
  } else {
    if (identity.member) {
      const updated: TeamMember = {
        ...identity.member,
        preferredLanguage: language,
      };
      upsertTeamMember(updated);
      persisted.push('teamMember');
    }
    if (identity.userId) {
      const supabase = trySupabaseAdmin();
      if (supabase) {
        const { error } = await supabase
          .from('profiles')
          .update({
            preferred_language: language,
            updated_at: new Date().toISOString(),
          })
          .eq('id', identity.userId);
        if (!error) persisted.push('profile');
        else console.warn('persistCallLanguagePreference profile update failed:', error.message);
      }
    }
    // Builder / foreman CRM row when present
    if (identity.kind === 'foreman' && identity.route.builderId) {
      const store = getDataStore();
      const idx = (store.builders ?? []).findIndex(
        (b) => String(b.id) === String(identity.route.builderId),
      );
      if (idx >= 0) {
        store.builders[idx] = {
          ...store.builders[idx],
          preferredLanguage: language,
        };
        syncData(store);
        persisted.push('builder');
      }
    }
  }

  return { language, persisted };
}
