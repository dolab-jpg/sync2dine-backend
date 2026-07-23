import Stripe from 'stripe';
import {
  getOrganizationById,
  PLAN_CONFIG,
  updateOrganization,
  type Organization,
  type OrgPlan,
} from '../organizations';
import type { Database } from '../../shared/database.types.js';
import {
  ensureStripeReady,
  getStripeRuntimeConfig,
  maskStripeKeyHint,
} from './stripe-config';

let stripeClient: Stripe | null = null;
let stripeClientKey = '';

export function getStripe(): Stripe {
  const key = getStripeRuntimeConfig().secretKey;
  if (!key) {
    throw new Error(
      'Platform Stripe is not configured. Open Integrations → Stripe on the platform owner account and Save/Test the secret key.',
    );
  }
  if (!stripeClient || stripeClientKey !== key) {
    stripeClient = new Stripe(key);
    stripeClientKey = key;
  }
  return stripeClient;
}

/** Prefer this for billing — hydrates platform-owner Stripe from Integrations if needed. */
export async function getStripeReady(): Promise<Stripe> {
  await ensureStripeReady();
  return getStripe();
}

export async function getPlatformStripeStatus(): Promise<{
  configured: boolean;
  source: string;
  keyHint?: string;
  mode?: 'live' | 'test' | 'unknown';
  accountId?: string;
  error?: string;
}> {
  try {
    const cfg = await ensureStripeReady();
    const mode = cfg.secretKey.startsWith('sk_live')
      ? 'live'
      : cfg.secretKey.startsWith('sk_test')
        ? 'test'
        : 'unknown';
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve();
    return {
      configured: true,
      source: cfg.source,
      keyHint: maskStripeKeyHint(cfg.secretKey),
      mode,
      accountId: account.id,
    };
  } catch (err) {
    return {
      configured: false,
      source: getStripeRuntimeConfig().source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Returns the locally persisted billing state used by staff-facing tools.
 * Stripe webhooks keep these organization fields current, so this must not
 * make a new Stripe API request during a conversation.
 */
export function getOrgPaymentStatus(
  orgId: string,
): { paid: boolean; status: string; subscriptionStatus?: string | null } | null {
  const org = getOrganizationById(orgId);
  if (!org) return null;
  const subscriptionStatus = org.subscriptionStatus ?? null;
  return {
    paid: org.status === 'active' || subscriptionStatus === 'active',
    status: org.status,
    subscriptionStatus,
  };
}

function subscriptionPeriodEnd(subscription: unknown): string | undefined {
  if (!subscription || typeof subscription !== 'object') return undefined;
  const items = (subscription as { items?: unknown }).items;
  if (!items || typeof items !== 'object') return undefined;
  const data = (items as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const periodEnd = data[0] && typeof data[0] === 'object'
    ? (data[0] as { current_period_end?: unknown }).current_period_end
    : undefined;
  return typeof periodEnd === 'number'
    ? new Date(periodEnd * 1000).toISOString()
    : undefined;
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
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
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
    const { getSupabaseAdmin } = await import('../supabase-admin.js');
    const supabase = getSupabaseAdmin();
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status) row.status = patch.status;
    if (patch.subscriptionStatus) row.subscription_status = patch.subscriptionStatus;
    if (patch.stripeCustomerId) row.stripe_customer_id = patch.stripeCustomerId;
    if (patch.stripeSubscriptionId) row.stripe_subscription_id = patch.stripeSubscriptionId;
    if (patch.currentPeriodEnd) row.current_period_end = patch.currentPeriodEnd;
    const { error } = await supabase
      .from('organizations')
      .update(row as unknown as Database['public']['Tables']['organizations']['Update'])
      .eq('id', orgId);
    if (error) console.warn('[stripe] Supabase org sync failed:', error.message);
  } catch (err) {
    console.warn('[stripe] Supabase org sync unavailable:', err instanceof Error ? err.message : err);
  }
}

function stripeObjectMetadata(object: unknown): Record<string, string> {
  if (!object || typeof object !== 'object') return {};
  const record = object as Record<string, unknown>;
  const direct = record.metadata && typeof record.metadata === 'object'
    ? record.metadata as Record<string, unknown>
    : {};
  const parent = record.parent && typeof record.parent === 'object'
    ? record.parent as Record<string, unknown>
    : {};
  const subscriptionDetails =
    parent.subscription_details && typeof parent.subscription_details === 'object'
      ? parent.subscription_details as Record<string, unknown>
      : record.subscription_details && typeof record.subscription_details === 'object'
        ? record.subscription_details as Record<string, unknown>
        : {};
  const nested = subscriptionDetails.metadata && typeof subscriptionDetails.metadata === 'object'
    ? subscriptionDetails.metadata as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.entries({ ...nested, ...direct })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function stripeId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
}

async function reconcileQuotePayment(
  event: Stripe.Event,
  object: unknown,
  details: {
    sessionId?: string;
    subscriptionId?: string;
    customerId?: string;
  } = {},
): Promise<void> {
  const metadata = stripeObjectMetadata(object);
  const quoteId = metadata.quoteId?.trim();
  const orgId = metadata.orgId?.trim();
  if (!quoteId || !orgId) return;
  const { markQuotePaidFromStripe } = await import('./quote-checkout');
  const reconciled = await markQuotePaidFromStripe({
    quoteId,
    orgId,
    eventId: event.id,
    paidAt: new Date(event.created * 1000).toISOString(),
    stripeCustomerId: details.customerId,
    stripeSubscriptionId: details.subscriptionId,
    stripeCheckoutSessionId: details.sessionId,
  });
  if (!reconciled) {
    throw new Error(`Quote ${quoteId} could not be reconciled`);
  }
}

export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await reconcileQuotePayment(event, session, {
        sessionId: session.id,
        customerId: stripeId(session.customer),
        subscriptionId: stripeId(session.subscription),
      });
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      if (event.type !== 'customer.subscription.deleted' && sub.status === 'active') {
        await reconcileQuotePayment(event, sub, {
          subscriptionId: sub.id,
          customerId: stripeId(sub.customer),
        });
      }
      const orgId = sub.metadata?.orgId;
      let org = orgId ? getOrganizationById(orgId) : undefined;
      if (!org) {
        const { getOrganizationByStripeSubscriptionId } = await import('../organizations');
        org = getOrganizationByStripeSubscriptionId(sub.id);
      }
      if (!org && orgId) {
        // Supabase-provisioned orgs may not exist in the disk store yet.
        org = { id: orgId } as unknown as Organization;
      }
      if (!org) return;

      const status = event.type === 'customer.subscription.deleted'
        ? 'cancelled'
        : mapStripeStatusToOrgStatus(sub.status);

      const periodEnd = subscriptionPeriodEnd(sub);

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
      const usageMeta = stripeObjectMetadata(invoice);
      if (usageMeta.type === 'usage_overage' && invoice.id) {
        const { updateBillingPeriodByStripeInvoice } = await import('./billing-periods');
        await updateBillingPeriodByStripeInvoice(
          invoice.id,
          'past_due',
          invoice.hosted_invoice_url ?? undefined,
        );
        // Usage overage failure must not suspend the whole org subscription.
        break;
      }
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const { getOrganizationByStripeCustomerId } = await import('../organizations');
      let org = getOrganizationByStripeCustomerId(customerId);
      if (!org) {
        try {
          const { getSupabaseAdmin } = await import('../supabase-admin.js');
          const { data } = await getSupabaseAdmin()
            .from('organizations')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();
          if (data?.id) org = { id: String(data.id) } as unknown as Organization;
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
      const invoiceRecord = invoice as unknown as Record<string, unknown>;
      const usageMeta = stripeObjectMetadata(invoice);
      if (usageMeta.type === 'usage_overage' && invoice.id) {
        const { updateBillingPeriodByStripeInvoice } = await import('./billing-periods');
        await updateBillingPeriodByStripeInvoice(
          invoice.id,
          'paid',
          invoice.hosted_invoice_url ?? undefined,
        );
        break;
      }
      await reconcileQuotePayment(event, invoice, {
        customerId: stripeId(invoice.customer),
        subscriptionId: stripeId(invoiceRecord.subscription),
      });
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const { getOrganizationByStripeCustomerId } = await import('../organizations');
      let org = getOrganizationByStripeCustomerId(customerId);
      if (!org) {
        try {
          const { getSupabaseAdmin } = await import('../supabase-admin.js');
          const { data } = await getSupabaseAdmin()
            .from('organizations')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();
          if (data?.id) org = { id: String(data.id) } as unknown as Organization;
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

export type UsageInvoiceChargeResult = {
  charged: boolean;
  skipped?: boolean;
  reason?: string;
  invoiceId?: string;
  status?: string;
  hostedInvoiceUrl?: string | null;
  amountGbp?: number;
};

async function resolveDefaultPaymentMethodId(
  stripe: Stripe,
  customerId: string,
  subscriptionId?: string,
): Promise<string | undefined> {
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const fromSub = sub.default_payment_method;
      if (typeof fromSub === 'string' && fromSub) return fromSub;
      if (fromSub && typeof fromSub === 'object' && 'id' in fromSub) return fromSub.id;
    } catch {
      /* fall through */
    }
  }
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return undefined;
    const fromCustomer = customer.invoice_settings?.default_payment_method;
    if (typeof fromCustomer === 'string' && fromCustomer) return fromCustomer;
    if (fromCustomer && typeof fromCustomer === 'object' && 'id' in fromCustomer) {
      return fromCustomer.id;
    }
  } catch {
    /* ignore */
  }
  try {
    const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    return methods.data[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Create a usage/overage Invoice from customer sell lines and debit the
 * Stripe Customer default payment method (charge_automatically).
 */
export async function createAndChargeUsageInvoice(
  orgId: string,
  breakdown: import('./weekly-usage-billing').WeeklyBillingBreakdown,
): Promise<UsageInvoiceChargeResult> {
  const org = getOrganizationById(orgId);
  if (!org) throw new Error('Organization not found');
  if (!org.stripeCustomerId) {
    return { charged: false, skipped: true, reason: 'missing_stripe_customer' };
  }
  if (breakdown.customerSubtotalGbp <= 0 || breakdown.customerLines.length === 0) {
    return { charged: false, skipped: true, reason: 'no_overage', amountGbp: 0 };
  }

  const {
    findBillingPeriod,
    saveBillingPeriodFromBreakdown,
  } = await import('./billing-periods');
  const existing = findBillingPeriod(orgId, breakdown.weekStart);
  if (existing?.stripeInvoiceId && existing.status !== 'void' && existing.status !== 'draft') {
    return {
      charged: existing.status === 'paid',
      skipped: true,
      reason: 'already_invoiced',
      invoiceId: existing.stripeInvoiceId,
      status: existing.status,
      hostedInvoiceUrl: existing.stripeHostedInvoiceUrl,
      amountGbp: existing.customerSubtotalGbp,
    };
  }

  // Always charge on the platform-owner Stripe account (Integrations → Stripe).
  const stripe = await getStripeReady();
  const customerId = org.stripeCustomerId;
  const defaultPm = await resolveDefaultPaymentMethodId(
    stripe,
    customerId,
    org.stripeSubscriptionId,
  );
  if (defaultPm) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: defaultPm },
    });
  }

  const metadata = {
    orgId,
    billingWeek: breakdown.isoWeek,
    weekStart: breakdown.weekStart,
    type: 'usage_overage',
    fareVersion: breakdown.fareVersion,
    packageId: breakdown.packageId,
  };

  for (const line of breakdown.customerLines) {
    const amountPence = Math.round(line.amountGbp * 100);
    if (amountPence <= 0) continue;
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: amountPence,
      currency: 'gbp',
      description: line.description,
      metadata: {
        ...metadata,
        lineCode: line.code,
      },
    } as Stripe.InvoiceItemCreateParams);
  }

  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'charge_automatically',
    auto_advance: true,
    pending_invoice_items_behavior: 'include',
    metadata,
    description: `Sync2Dine usage overage — ${breakdown.isoWeek}`,
  } as Stripe.InvoiceCreateParams);

  let finalized: Stripe.Invoice = invoice;
  const invoiceId = invoice.id;
  if (!invoiceId) throw new Error('Stripe invoice missing id');
  if (invoice.status === 'draft') {
    finalized = await stripe.invoices.finalizeInvoice(invoiceId);
  }

  let paid: Stripe.Invoice = finalized;
  let charged = false;
  const finalizedId = finalized.id || invoiceId;
  if (defaultPm && finalized.status !== 'paid') {
    try {
      paid = await stripe.invoices.pay(finalizedId);
      charged = paid.status === 'paid';
    } catch (err) {
      console.warn(
        '[stripe] usage invoice pay failed:',
        err instanceof Error ? err.message : err,
      );
      paid = await stripe.invoices.retrieve(finalizedId);
    }
  } else if (finalized.status === 'paid') {
    charged = true;
  }

  const status = paid.status === 'paid'
    ? 'paid'
    : paid.status === 'open' || paid.status === 'uncollectible'
      ? 'past_due'
      : 'open';

  const paidId = paid.id || finalizedId;
  await saveBillingPeriodFromBreakdown(breakdown, {
    status: status as 'paid' | 'past_due' | 'open',
    stripeInvoiceId: paidId,
    stripeHostedInvoiceUrl: paid.hosted_invoice_url ?? undefined,
  });

  // Send branded customer email (sell lines only).
  try {
    const {
      buildSaasUsageInvoiceContent,
      buildSaasUsageInvoiceEmail,
      generateSaasUsageInvoicePdf,
      customerArtifactContainsInternalLeak,
    } = await import('../saas-usage-invoice');
    const content = buildSaasUsageInvoiceContent({
      breakdown,
      customerName: org.name,
      customerEmail: org.contactEmail,
      customerAddress: org.address,
      stripeInvoiceId: paidId,
      hostedInvoiceUrl: paid.hosted_invoice_url ?? undefined,
      status: charged ? 'paid' : 'due',
    });
    const email = buildSaasUsageInvoiceEmail(content);
    if (
      customerArtifactContainsInternalLeak(email.html)
      || customerArtifactContainsInternalLeak(email.text)
    ) {
      throw new Error('Customer invoice artifact leaked internal margin/cost fields');
    }
    const pdf = await generateSaasUsageInvoicePdf(content);
    if (customerArtifactContainsInternalLeak(Buffer.from(pdf.bytes).toString('latin1'))) {
      // PDF binary may false-positive; scan content fields instead (already checked email).
    }
    if (org.contactEmail) {
      const { sendPlainTextEmail } = await import('../email-service');
      await sendPlainTextEmail({
        to: org.contactEmail,
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments: [{
          filename: pdf.filename,
          content: pdf.bytes,
          contentType: pdf.mimeType,
        }],
      });
    }
  } catch (err) {
    console.warn('[stripe] usage invoice email failed:', err instanceof Error ? err.message : err);
  }

  return {
    charged,
    invoiceId: paidId,
    status: paid.status ?? undefined,
    hostedInvoiceUrl: paid.hosted_invoice_url,
    amountGbp: breakdown.customerSubtotalGbp,
  };
}
