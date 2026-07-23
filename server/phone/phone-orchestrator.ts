/**
 * LEGACY — unused by live Vapi path (see docs/PHONE_ARCHITECTURE.md).
 * Implementation archived at server/_quarantine/phone-orchestrator.ts
 * Restore only if a softphone caller is proven; do not edit for product work.
 */
export async function handlePhoneTurn(): Promise<never> {
  throw new Error(
    'phone-orchestrator is quarantined — live phone uses Vapi (phone/vapi-routes). See docs/PHONE_ARCHITECTURE.md',
  );
}
