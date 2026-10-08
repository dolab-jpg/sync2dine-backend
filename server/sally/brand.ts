/**
 * Sally-local brand constants (phone + Sally channels).
 * Do NOT mutate home-org BDIDDIES_COMPANY / SYNC2DINE_SPOKEN — those brand the platform tenant.
 */

/** Company Sally answers for on the platform DID. */
export const SALLY_EMPLOYER = 'Sync2Gear';

/** Phonetic employer for prompts / firstMessage (TTS maps this — see vapi-assistant). */
export const SALLY_EMPLOYER_SPOKEN = 'sync Two gear';

/** Preferred spoken form after TTS replacement. */
export const SALLY_EMPLOYER_TTS = 'Sync to Gear';

export const SALLY_EMPLOYER_URL = 'https://sync2gear.io';

/** Restaurant product line under Sync2Gear. */
export const SALLY_PRODUCT_SYNC2DINE = 'Sync2Dine';
export const SALLY_PRODUCT_SYNC2DINE_SPOKEN = 'sync Two dine';
export const SALLY_PRODUCT_SYNC2DINE_TTS = 'Sync to Dine';
export const SALLY_PRODUCT_SYNC2DINE_URL = 'https://sync2dine.io';

/**
 * Sync2Gear / FloorMix sell facts for ads and dual-brand phone sell.
 * Locked for Phase 2 — prices only if getOfferTerms / commercial later; no invented £.
 */
export const SALLY_SYNC2GEAR_SELL_FACTS: string[] = [
  'Sync2Gear (sync2gear.io / sync2gear.com) is the parent company; Sally answers the Sync2Gear company line.',
  'FloorMix is Sync2Gear’s venue operations product: online dashboard at sync2gear.com plus the FloorMix phone APK for floor staff.',
  'FloorMix covers room music, owner-directed announcements, and multi-zone atmosphere control from the phone/dashboard — not a Spotify substitute; exclusive venue soundtrack / announce workflow.',
  'Sync2Dine (sync2dine.io) is Sync2Gear’s restaurant phone-AI product line: Judie (orders/bookings on the venue line), Atmosphere (soundtrack + announcements + staff training modules), and Complete (both).',
  'On Sync2Dine sell path: Judie / Atmosphere / Complete packages and prices come from getOfferTerms — never invent rates.',
  'On Sync2Gear / FloorMix sell path: explain product fit and book a callback or integration meeting; do not invent FloorMix package prices until getOfferTerms / commercial covers them.',
  'Never sell Sally as the product. Never take diner food orders on this line — Judie does that after they buy Sync2Dine.',
  'Route by pain: missed calls/orders → Sync2Dine Judie; room/audio/announcements/training → Atmosphere and/or FloorMix; both → Complete or dual stack.',
];

export function formatSallySync2GearSellFactsBlock(): string {
  return [
    'SYNC2GEAR / FLOORMIX SELL FACTS (Sally dual-brand — authoritative for Sync2Gear product talk):',
    ...SALLY_SYNC2GEAR_SELL_FACTS.map((line) => `- ${line}`),
  ].join('\n');
}
