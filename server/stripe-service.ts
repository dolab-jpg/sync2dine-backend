import Stripe from 'stripe';
import {
  getOrganizationById,
  PLAN_CONFIG,
  updateOrganization,
  type OrgPlan,
} from './organizations';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

function priceIdForPlan(plan: OrgPlan): string {
  const map: Record<OrgPlan, string | undefined> = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
    sync2dine_platform: process.env.STRIPE_PRICE_SYNC2DINE_PLATFORM,
    sync2dine_kiosk: process.env.STRIPE_PRICE_SYNC2DINE_KIOSK,
  };
  const id = map[plan]?.trim();
  if (!id) {
    throw new Error(`Stripe price not configured for plan "${plan}". Set STRIPE_PRICE_${plan.toUpperCase()} in env.`);
  }
  return id;
}

export async function createSubscriptionForOrg(
  orgId: string,
  email: string,
  name: string,
): Promise<void> {
  const org = getOrganizationById(orgId);
  if (!org) throw new Error('Organization not found');

  const stripe = getStripe();
  let customerId = org.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { orgId, orgName: org.name },
    });
    customerId = customer.id;
    updateOrganization(orgId, { stripeCustomerId: customerId });
  }

  const priceId = priceIdForPlan(org.plan);
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    metadata: { orgId },
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  });

  updateOrganization(orgId, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : undefined,
  });
}

export async function createCheckoutSessionForOrg(orgId: string): Promise<string> {
  const org = getOrganizationById(orgId);
  if (!org) throw new Error('Organization not found');

  const stripe = getStripe();
  let customerId = org.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: org.contactEmail,
      name: org.contactName,
      metadata: { orgId, orgName: org.name },
    });
    customerId = customer.id;
    updateOrganization(orgId, { stripeCustomerId: customerId });
  }

  const baseUrl = process.env.APP_BASE_URL?.trim() || 'http://localhost:5174';
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceIdForPlan(org.plan), quantity: 1 }],
    success_url: `${baseUrl}/platform/clients?stripe=success&org=${orgId}`,
    cancel_url: `${baseUrl}/platform/clients?stripe=cancel&org=${orgId}`,
    metadata: { orgId },
    subscription_data: { metadata: { orgId } },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

export function mapStripeStatusToOrgStatus(
  subscriptionStatus: string,
): 'active' | 'past_due' | 'suspended' | 'cancelled' | 'trial' {
  switch (subscriptionStatus) {
    case 'active':
    case 'trialing':
      return subscriptionStatus === 'trialing' ? 'trial' : 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    case 'paused':
    case 'incomplete':
      return 'suspended';
    default:
      return 'active';
  }
}

export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.orgId;
      let org = orgId ? getOrganizationById(orgId) : undefined;
      if (!org) {
        const { getOrganizationByStripeSubscriptionId } = await import('./organizations');
        org = getOrganizationByStripeSubscriptionId(sub.id);
      }
      if (!org) return;

      const status = event.type === 'customer.subscription.deleted'
        ? 'cancelled'
        : mapStripeStatusToOrgStatus(sub.status);

      updateOrganization(org.id, {
        stripeSubscriptionId: sub.id,
        subscriptionStatus: sub.status,
        status,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : undefined,
      });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const { getOrganizationByStripeCustomerId } = await import('./organizations');
      const org = getOrganizationByStripeCustomerId(customerId);
      if (!org) return;
      updateOrganization(org.id, { status: 'past_due', subscriptionStatus: 'past_due' });
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const { getOrganizationByStripeCustomerId } = await import('./organizations');
      const org = getOrganizationByStripeCustomerId(customerId);
      if (!org) return;
      updateOrganization(org.id, { status: 'active', subscriptionStatus: 'active' });
      break;
    }
    default:
      break;
  }
}

export function computeMrrForPlan(plan: OrgPlan): number {
  return PLAN_CONFIG[plan].monthlyPriceGbp;
}
