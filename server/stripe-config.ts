import { getIntegrationSecrets } from './integration-secrets';

export type StripeRuntimeConfig = {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
};

/** Resolve Stripe server credentials from env first, then persisted integration secrets. */
export function getStripeRuntimeConfig(): StripeRuntimeConfig {
  const saved = getIntegrationSecrets('stripe');
  return {
    secretKey: process.env.STRIPE_SECRET_KEY?.trim() || saved.secretKey?.trim() || '',
    publishableKey:
      process.env.STRIPE_PUBLISHABLE_KEY?.trim()
      || process.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim()
      || saved.publishableKey?.trim()
      || '',
    webhookSecret:
      process.env.STRIPE_WEBHOOK_SECRET?.trim()
      || saved.webhookSecret?.trim()
      || '',
  };
}
