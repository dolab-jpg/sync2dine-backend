import Stripe from 'stripe';
import {
  getOrganizationById,
  PLAN_CONFIG,
  updateOrganization,
  type OrgPlan,
} from './organizations';
import { getStripeRuntimeConfig } from './stripe-config';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    const key = getStripeRuntimeConfig().secretKey;
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

async function syncOrgBillingToSupabase(
  orgId: string,
  patch: {
    status?: string;
    subscriptionStatus?: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    currentPeriodEnd?: string;
  },
): Promise<void> {
  try {
    const { getSupabaseAdmin } = await import('./supabase-admin.js');
    const supabase = getSupabaseAdmin();
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status) row.status = patch.status;
    if (patch.subscriptionStatus) row.subscription_status = patch.subscriptionStatus;
    if (patch.stripeCustomerId) row.stripe_customer_id = patch.stripeCustomerId;
    if (patch.stripeSubscriptionId) row.stripe_subscription_id = patch.stripeSubscriptionId;
    if (patch.currentPeriodEnd) row.current_period_end = patch.currentPeriodEnd;
    const { error } = await supabase.from('organizations').update(row).eq('id', orgId);
    if (error) console.warn('[stripe] Supabase org sync failed:', error.message);
  } catch (err) {
    console.warn('[stripe] Supabase org sync unavailable:', err instanceof Error ? err.message : err);
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
      if (!org && orgId) {
        // Supabase-provisioned orgs may not exist in the disk store yet.
        org = { id: orgId } as ReturnType<typeof getOrganizationById>;
      }
      if (!org) return;

      const status = event.type === 'customer.subscription.deleted'
        ? 'cancelled'
        : mapStripeStatusToOrgStatus(sub.status);

      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : undefined;

      if (getOrganizationById(org.id)) {
        updateOrganization(org.id, {
          stripeSubscriptionId: sub.id,
          subscriptionStatus: sub.status,
          status,
          currentPeriodEnd: periodEnd,
        });
      }

      await syncOrgBillingToSupabase(org.id, {
        stripeSubscriptionId: sub.id,
        subscriptionStatus: sub.status,
        status,
        currentPeriodEnd: periodEnd,
      });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const { getOrganizationByStripeCustomerId } = await import('./organizations');
      let org = getOrganizationByStripeCustomerId(customerId);
      if (!org) {
        try {
          const { getSupabaseAdmin } = await import('./supabase-admin.js');
          const { data } = await getSupabaseAdmin()
            .from('organizations')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();
          if (data?.id) org = { id: String(data.id) } as typeof org;
        } catch { /* ignore */ }
      }
      if (!org) return;
      if (getOrganizationById(org.id)) {
        updateOrganization(org.id, { status: 'past_due', subscriptionStatus: 'past_due' });
      }
      await syncOrgBillingToSupabase(org.id, { status: 'past_due', subscriptionStatus: 'past_due' });
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const { getOrganizationByStripeCustomerId } = await import('./organizations');
      let org = getOrganizationByStripeCustomerId(customerId);
      if (!org) {
        try {
          const { getSupabaseAdmin } = await import('./supabase-admin.js');
          const { data } = await getSupabaseAdmin()
            .from('organizations')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();
          if (data?.id) org = { id: String(data.id) } as typeof org;
        } catch { /* ignore */ }
      }
      if (!org) return;
      if (getOrganizationById(org.id)) {
        updateOrganization(org.id, { status: 'active', subscriptionStatus: 'active' });
      }
      await syncOrgBillingToSupabase(org.id, { status: 'active', subscriptionStatus: 'active' });
      break;
    }
    default:
      break;
  }
}

export function computeMrrForPlan(plan: OrgPlan): number {
  return PLAN_CONFIG[plan].monthlyPriceGbp;
}
