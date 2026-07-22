import { getIntegrationSecrets, saveIntegrationSecrets } from './integration-secrets';

export type StripeRuntimeConfig = {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  /** Where the secret was resolved from (for ops / platform status). */
  source: 'env' | 'runtime' | 'platform_org' | 'none';
};

let hydratedFromPlatform = false;

/** Resolve Stripe server credentials from env first, then persisted integration secrets. */
export function getStripeRuntimeConfig(): StripeRuntimeConfig {
  const envSecret = process.env.STRIPE_SECRET_KEY?.trim() || '';
  const saved = getIntegrationSecrets('stripe');
  const secretKey = envSecret || saved.secretKey?.trim() || '';
  const publishableKey =
    process.env.STRIPE_PUBLISHABLE_KEY?.trim()
    || process.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim()
    || saved.publishableKey?.trim()
    || '';
  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET?.trim()
    || saved.webhookSecret?.trim()
    || '';

  let source: StripeRuntimeConfig['source'] = 'none';
  if (envSecret) source = 'env';
  else if (saved.secretKey?.trim()) source = hydratedFromPlatform ? 'platform_org' : 'runtime';

  return { secretKey, publishableKey, webhookSecret, source };
}

/**
 * Load Stripe keys from the platform-owner (home) org integrations row in Supabase
 * into local integration-secrets.json. SaaS weekly billing always uses this account.
 */
export async function hydrateStripeFromPlatformOwner(): Promise<StripeRuntimeConfig> {
  const current = getStripeRuntimeConfig();
  if (current.secretKey) return current;

  try {
    const { getHomeOrgId } = await import('./home-org');
    const { getOrgIntegrationDecrypted } = await import('./org-integrations-store');
    const orgId = getHomeOrgId();
    const row = await getOrgIntegrationDecrypted(orgId, 'stripe');
    const values = row?.values ?? {};
    const secretKey = values.secretKey?.trim() || '';
    if (!secretKey) return getStripeRuntimeConfig();

    saveIntegrationSecrets('stripe', {
      secretKey,
      publishableKey: values.publishableKey || '',
      webhookSecret: values.webhookSecret || '',
    });
    hydratedFromPlatform = true;
  } catch (err) {
    console.warn(
      '[stripe-config] platform org hydrate failed:',
      err instanceof Error ? err.message : err,
    );
  }
  return getStripeRuntimeConfig();
}

/** Ensure platform Stripe credentials are available before Billing API calls. */
export async function ensureStripeReady(): Promise<StripeRuntimeConfig> {
  let cfg = getStripeRuntimeConfig();
  if (!cfg.secretKey) {
    cfg = await hydrateStripeFromPlatformOwner();
  }
  if (!cfg.secretKey) {
    throw new Error(
      'Platform Stripe is not configured. Open Integrations → Stripe on the platform owner account and Save/Test the secret key.',
    );
  }
  return cfg;
}

export function maskStripeKeyHint(secretKey: string): string {
  const v = secretKey.trim();
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 7)}…${v.slice(-4)}`;
}
