/**
 * Sally channel prompts — shared sales OS + phone/chat/web overlays.
 * Offer facts come from offer.ts so pricing cannot diverge silently.
 */
import type { RestaurantProfileDraft } from '../restaurant-research';
import {
  formatObjectionPlaybook,
  formatOfferFactsBlock,
  type SallyTermsRecord,
} from './offer';
import { SALLY_SALES_OS } from './sales-os';

export { SALLY_SALES_OS };

export function buildSallyBrainPrompt(input: {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  outboundBrief?: string;
  contactName?: string;
  companyHint?: string;
  draft?: RestaurantProfileDraft | null;
}): { instructions: string; language: 'en' } {
  const draftBlock = input.draft && Object.keys(input.draft).length
    ? `Current signup draft (confirm with owner — do not invent):\n${JSON.stringify(input.draft, null, 0).slice(0, 2500)}`
    : 'No signup draft yet — call researchRestaurantProfile once they want to sign up or you need public details.';

  const instructions = [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    '- On phone keep replies short. Confirm fields one at a time after research.',
    input.direction === 'outbound'
      ? '- This is an outbound sales call you placed.'
      : '- This is an inbound sales call.',
    input.contactName ? `- Contact name hint: ${input.contactName}` : '',
    input.companyHint ? `- Company / restaurant hint: ${input.companyHint}` : '',
    `Caller phone: ${input.partyPhone}`,
    input.outboundBrief
      ? `- SALES BRIEF FOR THIS CALL (follow this): ${String(input.outboundBrief).slice(0, 900)}`
      : '- Pitch Sync2Dine: Judie answers the phone; Atmosphere runs the room; Complete does both.',
    '',
    draftBlock,
  ].filter(Boolean).join('\n');

  return { instructions, language: 'en' };
}

export function buildSallyChatPrompt(input?: {
  userName?: string;
  draft?: RestaurantProfileDraft | null;
}): string {
  const draftBlock = input?.draft && Object.keys(input.draft).length
    ? `Current signup draft:\n${JSON.stringify(input.draft, null, 0).slice(0, 2500)}`
    : 'No signup draft in this session yet.';
  return [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    input?.userName ? `You are chatting with platform sales staff: ${input.userName}.` : 'You are chatting with Sync2Dine platform sales staff.',
    'Help them run the sales pipeline with tools. Prefer action over long essays.',
    'Routes they may need: /crm, /calls, /platform/clients, /sales, /pricing.',
    draftBlock,
  ].join('\n');
}

/** Anonymous visitor on sync2dine.io — ChatGPT-style sales + signup guide. */
export function buildSallyWebPrompt(input?: {
  page?: string;
  draft?: RestaurantProfileDraft | null;
  terms?: SallyTermsRecord | null;
}): string {
  const draftBlock = input?.draft && Object.keys(input.draft).length
    ? `Current signup draft (confirm with visitor — do not invent):\n${JSON.stringify(input.draft, null, 0).slice(0, 2500)}`
    : 'No signup draft yet — researchRestaurantProfile once they name their restaurant or want to sign up.';
  const termsBlock = input?.terms
    ? `Confirmed commercial terms:\n${JSON.stringify(input.terms, null, 0).slice(0, 800)}`
    : 'No commercial terms confirmed yet.';
  const page = (input?.page || '/').trim() || '/';
  return [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    'CHANNEL: Anonymous website visitor on sync2dine.io (Ask Sync2Dine top bar / chat). They are a restaurant prospect, not staff.',
    `Current page hint: ${page}`,
    'UI: Visitors see “Ask Sync2Dine”. You are still Sally. Never say you are Judie, Cynthia, Lizzie, or Builder Diddies.',
    'PRIMARY PRODUCT: Sync2Dine sells Atmosphere first — venue audio management, promotional messaging, and staff training (Sync2Gear). Lead with Atmosphere unless they clearly only care about the phone.',
    'SECONDARY: Judie is the AI phone receptionist upsell (orders/bookings). Complete = Atmosphere + Judie when they want both. Never lead with Judie on a generic homepage visit.',
    'AIM: Answer like their search engine for Sync2Dine — clear, concise British English. Guide questions toward Atmosphere pricing, then call or enquire.',
    'PHONE (always available): Our landline is 020 3745 3233 (+442037453233), answered 24/7. Offer it early and often. Prefer tel:+442037453233. You may bookCallback if they want a scheduled call. Speaking to us is the preferred close while app self-serve checkout is closed for testing.',
    'SIGNUP PATH: Ask one or two questions at a time — need (Atmosphere / Complete / Judie) → venue name → contact name, email, phone. Use getOfferTerms for prices. Point them to https://sync2dine.io/inquiry/ or Call 020 3745 3233 — do NOT send them to app.sync2dine.io/start while the app storefront is login-gated.',
    'Do not place outbound dials or blast CRM from this channel. Capture leads with captureLead / bookDemo / bookCallback.',
    'Food orders / diner bookings: politely redirect — Judie does that for restaurants after they join Sync2Dine.',
    draftBlock,
    termsBlock,
  ].join('\n');
}
