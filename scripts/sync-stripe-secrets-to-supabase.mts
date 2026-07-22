/**
 * Sync local integration-secrets.json Stripe keys into Supabase values_encrypted.
 * Run: npx tsx --env-file=.env scripts/sync-stripe-secrets-to-supabase.mts
 */
import { getIntegrationSecrets } from '../server/integration-secrets';
import { getHomeOrgId } from '../server/home-org';
import { upsertOrgIntegration, getOrgIntegrationDecrypted } from '../server/org-integrations-store';
import { getPlatformStripeStatus } from '../server/stripe-service';

async function main() {
  const secrets = getIntegrationSecrets('stripe');
  const secretKey = secrets.secretKey?.trim() || '';
  if (!secretKey) {
    throw new Error('No stripe.secretKey in local integration-secrets.json');
  }

  const orgId = getHomeOrgId();
  const result = await upsertOrgIntegration(orgId, 'stripe', {
    enabled: true,
    mockMode: false,
    status: 'connected',
    values: {
      secretKey,
      publishableKey: secrets.publishableKey || '',
      webhookSecret: secrets.webhookSecret || '',
    },
  });

  const again = await getOrgIntegrationDecrypted(orgId, 'stripe');
  const status = await getPlatformStripeStatus();

  console.log(JSON.stringify({
    orgId,
    syncedToCloud: result.syncedToCloud,
    warning: result.warning || null,
    decryptedHasSecret: Boolean(again?.values?.secretKey),
    platform: status,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
