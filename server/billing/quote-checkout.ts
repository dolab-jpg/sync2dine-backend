import { createHmac, timingSafeEqual } from 'crypto';
import type Stripe from 'stripe';
import { getDataStore, syncData, withOrgContext } from '../data-store';
import { getStripe } from './stripe-service';
import { DEFAULT_ORG_UUID, getSupabaseAdmin } from '../supabase-admin';

const TOKEN_VERSION = 1;
const DEV_TOKEN_SECRET = 'sync2dine-dev-quote-checkout-change-in-production';
const TERMINAL_QUOTE_STATUSES = new Set([
  'archived',
  'cancelled',
  'expired',
  'paid',
  'rejected',
]);

export type QuoteCheckoutTokenPayload = {
  v: 1;
  quoteId: string;
  orgId: string;
  exp: number;
};

export type QuoteRecord = Record<string, unknown>;

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function signingSecret(): string {
  const secret =
    process.env.QUOTE_CHECKOUT_SIGNING_SECRET?.trim()
    || process.env.ORG_ENCRYPTION_KEY?.trim()
    || process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'QUOTE_CHECKOUT_SIGNING_SECRET, ORG_ENCRYPTION_KEY, or JWT_SECRET is required in production',
    );
  }
  return DEV_TOKEN_SECRET;
}

function tokenSignature(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`quote-checkout.${encodedPayload}`)
    .digest('base64url');
}

export function signQuoteCheckoutToken(
  input: Omit<QuoteCheckoutTokenPayload, 'v'>,
  secret = signingSecret(),
): string {
  if (!input.quoteId || !input.orgId || !Number.isSafeInteger(input.exp) || input.exp <= 0) {
    throw new Error('Invalid quote checkout token payload');
  }
  const payload: QuoteCheckoutTokenPayload = { v: TOKEN_VERSION, ...input };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${tokenSignature(encoded, secret)}`;
}

export function verifyQuoteCheckoutToken(
  token: string,
  expectedQuoteId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  secret = signingSecret(),
): QuoteCheckoutTokenPayload | null {
  try {
    const [encoded, suppliedSignature, extra] = token.split('.');
    if (!encoded || !suppliedSignature || extra) return null;
    const expectedSignature = tokenSignature(encoded, secret);
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    const expected = Buffer.from(expectedSignature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<QuoteCheckoutTokenPayload>;
    if (
      payload.v !== TOKEN_VERSION
      || payload.quoteId !== expectedQuoteId
      || typeof payload.orgId !== 'string'
      || !payload.orgId
      || !Number.isSafeInteger(payload.exp)
      || payload.exp! < nowSeconds
    ) {
      return null;
    }
    return payload as QuoteCheckoutTokenPayload;
  } catch {
    return null;
  }
}

export function quoteExpirySeconds(quote: QuoteRecord): number | null {
  const raw = firstString(quote.expiresAt, quote.expires_at);
  const milliseconds = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

export function isQuotePayable(
  quote: QuoteRecord,
  nowMilliseconds = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (String(quote.stripePaymentStatus ?? '').toLowerCase() === 'paid') {
    return { ok: false, reason: 'Quote has already been paid' };
  }
  const status = String(quote.status ?? 'draft').toLowerCase();
  if (TERMINAL_QUOTE_STATUSES.has(status)) {
    return { ok: false, reason: `Quote is ${status}` };
  }
  const exp = quoteExpirySeconds(quote);
  if (!exp) return { ok: false, reason: 'Quote expiry is missing or invalid' };
  if (exp * 1000 < nowMilliseconds) return { ok: false, reason: 'Quote has expired' };
  const total = Number(quote.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: 'Quote total must be greater than zero' };
  }
  return { ok: true };
}

export function buildPublicQuoteCheckoutUrl(
  quote: QuoteRecord,
  orgId: string,
  baseUrl: string,
): string {
  const quoteId = String(quote.id ?? '').trim();
  const exp = quoteExpirySeconds(quote);
  if (!quoteId || !orgId || !exp) throw new Error('Quote id, organization, and expiry are required');
  const token = signQuoteCheckoutToken({ quoteId, orgId, exp });
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/api/public/quotes/${encodeURIComponent(quoteId)}/checkout?t=${encodeURIComponent(token)}`;
}

async function resolveScopedOrgUuid(orgId: string): Promise<string | null> {
  if (orgId === 'default' || orgId === DEFAULT_ORG_UUID) return DEFAULT_ORG_UUID;
  const supabase = getSupabaseAdmin() as any;
  const { data: byId, error: idError } = await supabase
    .from('organizations')
    .select('id')
    .eq('id', orgId)
    .maybeSingle();
  if (idError) throw idError;
  if (byId?.id) return String(byId.id);
  const { data: byLegacy, error: legacyError } = await supabase
    .from('organizations')
    .select('id')
    .eq('legacy_id', orgId)
    .maybeSingle();
  if (legacyError) throw legacyError;
  return byLegacy?.id ? String(byLegacy.id) : null;
}

/** Persist an authenticated staff quote through the service-role backend (browser RLS stays strict). */
export async function upsertQuoteForOrg(quote: QuoteRecord, orgId: string): Promise<void> {
  const quoteId = String(quote.id ?? '').trim();
  if (!quoteId) throw new Error('Quote id is required');
  const payable = isQuotePayable(quote);
  if (!payable.ok) throw new Error(payable.reason);
  const orgUuid = await resolveScopedOrgUuid(orgId);
  if (!orgUuid) throw new Error('Organization not found in Supabase');
  const supabase = getSupabaseAdmin() as any;
  const status = firstString(quote.status) || 'draft';
  const total = Number(quote.total);
  const { error } = await supabase.from('quotes').upsert({
    id: quoteId,
    org_id: orgUuid,
    // Customer records may still be local-only under strict browser RLS; retain id in data JSON.
    customer_id: null,
    status,
    total,
    data: quote,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id,id' });
  if (error) throw error;
}

export async function getQuoteForOrg(quoteId: string, orgId: string): Promise<QuoteRecord | null> {
  try {
    const orgUuid = await resolveScopedOrgUuid(orgId);
    if (!orgUuid) throw new Error('Organization not found in Supabase');
    // Generated database types can lag deployed CRM tables; keep this adapter runtime-shaped.
    const supabase = getSupabaseAdmin() as any;
    const { data, error } = await supabase
      .from('quotes')
      .select('id, org_id, customer_id, status, total, data')
      .eq('org_id', orgUuid)
      .eq('id', quoteId)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      return {
        id: data.id,
        orgId: data.org_id,
        customerId: data.customer_id,
        status: data.status,
        total: data.total,
        ...(data.data as QuoteRecord),
      };
    }
  } catch (error) {
    console.warn('[quote-checkout] Supabase quote lookup unavailable:', error instanceof Error ? error.message : error);
  }
  return withOrgContext(orgId, () => {
    const quote = getDataStore(orgId).quotes.find((candidate) => String(candidate.id) === quoteId);
    return quote ? { ...quote } : null;
  });
}

type NormalizedLine = {
  description: string;
  quantity: number;
  unitAmountPence: number;
  recurring: boolean;
  interval: 'week' | 'year';
};

function quoteWizard(quote: QuoteRecord): QuoteRecord {
  return quote.wizardAnswers && typeof quote.wizardAnswers === 'object'
    ? quote.wizardAnswers as QuoteRecord
    : {};
}

function normalizeLine(
  line: QuoteRecord,
  defaults: { recurring: boolean; interval: 'week' | 'year' },
): NormalizedLine | null {
  const quantityRaw = Number(line.quantity ?? line.qty ?? 1);
  const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0
    ? Math.max(1, Math.floor(quantityRaw))
    : 1;
  const total = Number(line.total);
  const unit = Number(line.rate ?? line.price ?? line.unitPrice ?? line.amount);
  const unitAmountGbp = Number.isFinite(unit) && unit > 0
    ? unit
    : Number.isFinite(total) && total > 0
      ? total / quantity
      : 0;
  const unitAmountPence = Math.round(unitAmountGbp * 100);
  if (unitAmountPence <= 0) return null;
  const category = String(line.category ?? '').toLowerCase();
  const recurring = typeof line.recurring === 'boolean'
    ? line.recurring
    : category === 'extra' || category === 'setup'
      ? false
      : defaults.recurring;
  const rawInterval = String(line.interval ?? line.unit ?? '').toLowerCase();
  const interval = rawInterval === 'year' || rawInterval === 'annual'
    ? 'year'
    : rawInterval === 'week' || rawInterval === 'weekly'
      ? 'week'
      : defaults.interval;
  return {
    description: firstString(line.description, line.name, line.title) || 'Quote item',
    quantity,
    unitAmountPence,
    recurring,
    interval,
  };
}

export function quoteToCheckoutLines(quote: QuoteRecord): NormalizedLine[] {
  const wizard = quoteWizard(quote);
  const billingInterval = firstString(
    wizard.billingInterval,
    quote.billingInterval,
    quote.billing,
  ).toLowerCase() === 'annual' ? 'annual' : 'weekly';
  const isSaas = wizard.saas === true
    || Boolean(firstString(wizard.packageId, quote.packageId))
    || String(quote.tradeName ?? '').toLowerCase() === 'sync2dine saas';
  const defaults = {
    recurring: isSaas,
    interval: (billingInterval === 'annual' ? 'year' : 'week') as 'week' | 'year',
  };
  const explicitLines = Array.isArray(quote.lines) ? quote.lines as QuoteRecord[] : [];
  const sourceLines = explicitLines.length
    ? explicitLines
    : [
        ...(Array.isArray(quote.items) ? quote.items as QuoteRecord[] : []),
        ...(Array.isArray(quote.labour) ? quote.labour as QuoteRecord[] : []),
        ...(Array.isArray(quote.extras)
          ? (quote.extras as QuoteRecord[]).map((line) => ({ ...line, category: line.category ?? 'extra' }))
          : []),
      ];
  let lines = sourceLines
    .map((line) => normalizeLine(line, defaults))
    .filter((line): line is NormalizedLine => Boolean(line));

  const quoteTotalPence = Math.round(Number(quote.total ?? 0) * 100);
  const lineTotalPence = lines.reduce(
    (sum, line) => sum + line.unitAmountPence * line.quantity,
    0,
  );
  const adjustment = quoteTotalPence - lineTotalPence;
  if (!lines.length) {
    lines = [{
      description: firstString(quote.title, quote.tradeName) || `Quote ${String(quote.id ?? '')}`,
      quantity: 1,
      unitAmountPence: quoteTotalPence,
      recurring: isSaas,
      interval: defaults.interval,
    }];
  } else if (adjustment > 0) {
    lines.push({
      description: 'Quote balance',
      quantity: 1,
      unitAmountPence: adjustment,
      recurring: false,
      interval: defaults.interval,
    });
  } else if (adjustment < 0) {
    // Stripe cannot represent a negative line item. Fold discounts/rounding into the final line.
    const last = lines[lines.length - 1];
    const replacement = last.unitAmountPence * last.quantity + adjustment;
    if (replacement <= 0 || replacement % last.quantity !== 0) {
      return [{
        description: firstString(quote.title, quote.tradeName) || `Quote ${String(quote.id ?? '')}`,
        quantity: 1,
        unitAmountPence: quoteTotalPence,
        recurring: isSaas,
        interval: defaults.interval,
      }];
    }
    last.unitAmountPence = replacement / last.quantity;
  }
  return lines;
}

function quoteMetadata(quote: QuoteRecord, orgId: string): Record<string, string> {
  const wizard = quoteWizard(quote);
  const billingInterval = firstString(
    wizard.billingInterval,
    quote.billingInterval,
    quote.billing,
  ).toLowerCase() === 'annual' ? 'annual' : 'weekly';
  return {
    quoteId: String(quote.id ?? ''),
    customerId: firstString(quote.customerId, quote.customer_id),
    packageId: firstString(wizard.packageId, quote.packageId),
    billingInterval,
    orgId,
    source: 'quote_checkout',
  };
}

export async function createCheckoutSessionForQuote(
  quote: QuoteRecord,
  orgId: string,
  baseUrl: string,
): Promise<string> {
  const lines = quoteToCheckoutLines(quote);
  if (!lines.length || lines.some((line) => line.unitAmountPence <= 0)) {
    throw new Error('Quote does not contain payable line items');
  }
  const metadata = quoteMetadata(quote, orgId);
  const recurring = lines.some((line) => line.recurring);
  const stripe = getStripe();
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: recurring ? 'subscription' : 'payment',
    line_items: lines.map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency: 'gbp',
        unit_amount: line.unitAmountPence,
        product_data: { name: line.description.slice(0, 127) },
        ...(line.recurring ? { recurring: { interval: line.interval } } : {}),
      },
    })),
    metadata,
    success_url: `${baseUrl.replace(/\/+$/, '')}/quotes?stripe=success&quote=${encodeURIComponent(metadata.quoteId)}`,
    cancel_url: `${baseUrl.replace(/\/+$/, '')}/quotes?stripe=cancel&quote=${encodeURIComponent(metadata.quoteId)}`,
    ...(recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  };
  const email = firstString(quote.customerEmail, quote.email);
  if (email) params.customer_email = email;
  const session = await stripe.checkout.sessions.create(params);
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

export function paidQuotePatch(
  paidAt: string,
  eventId: string,
  details: {
    customerId?: string;
    subscriptionId?: string;
    sessionId?: string;
  } = {},
): QuoteRecord {
  return {
    stripePaymentStatus: 'paid',
    paidAt,
    status: 'paid',
    stripeEventId: eventId,
    ...(details.customerId ? { stripeCustomerId: details.customerId } : {}),
    ...(details.subscriptionId ? { stripeSubscriptionId: details.subscriptionId } : {}),
    ...(details.sessionId ? { stripeCheckoutSessionId: details.sessionId } : {}),
  };
}

export async function markQuotePaidFromStripe(input: {
  quoteId: string;
  orgId: string;
  eventId: string;
  paidAt?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
}): Promise<boolean> {
  const quote = await getQuoteForOrg(input.quoteId, input.orgId);
  if (!quote) return false;
  if (String(quote.stripePaymentStatus ?? '') === 'paid') return true;
  const paidAt = input.paidAt || new Date().toISOString();
  const patch = paidQuotePatch(paidAt, input.eventId, {
    customerId: input.stripeCustomerId,
    subscriptionId: input.stripeSubscriptionId,
    sessionId: input.stripeCheckoutSessionId,
  });
  const updated = { ...quote, ...patch, updatedAt: paidAt };
  let cloudUpdated = false;
  try {
    const orgUuid = await resolveScopedOrgUuid(input.orgId);
    if (!orgUuid) throw new Error('Organization not found');
    const supabase = getSupabaseAdmin() as any;
    const { error } = await supabase
      .from('quotes')
      .update({
        status: 'paid',
        data: Object.fromEntries(Object.entries(updated).filter(([key]) => ![
          'id',
          'orgId',
          'org_id',
          'customer_id',
        ].includes(key))),
        updated_at: paidAt,
      })
      .eq('org_id', orgUuid)
      .eq('id', input.quoteId);
    if (error) throw error;
    cloudUpdated = true;

    const customerId = firstString(quote.customerId, quote.customer_id);
    if (customerId) {
      const { data: customer } = await supabase
        .from('customers')
        .select('data')
        .eq('org_id', orgUuid)
        .eq('id', customerId)
        .maybeSingle();
      if (customer) {
        const customerData = (customer.data as QuoteRecord) ?? {};
        const activities = Array.isArray(customerData.activities)
          ? [...customerData.activities as unknown[]]
          : [];
        activities.unshift({
          id: `stripe-${input.eventId}`,
          type: 'payment',
          summary: `Quote ${input.quoteId} paid via Stripe`,
          createdAt: paidAt,
          createdBy: 'stripe_webhook',
        });
        await supabase
          .from('customers')
          .update({
            data: {
              ...customerData,
              status: 'won',
              lastContact: paidAt,
              activities: activities.slice(0, 50),
            },
            updated_at: paidAt,
          })
          .eq('org_id', orgUuid)
          .eq('id', customerId);
      }
    }
  } catch (error) {
    console.warn('[quote-checkout] Supabase payment reconciliation unavailable:', error instanceof Error ? error.message : error);
  }

  const localUpdated = withOrgContext(input.orgId, () => {
    const store = getDataStore(input.orgId);
    const index = store.quotes.findIndex((candidate) => String(candidate.id) === input.quoteId);
    if (index < 0) return false;
    store.quotes[index] = updated;
    const customerId = firstString(quote.customerId, quote.customer_id);
    const customer = store.customers.find((candidate) => String(candidate.id) === customerId);
    if (customer) {
      customer.status = 'won';
      customer.lastContact = paidAt;
      customer.updatedAt = paidAt;
    }
    syncData(store, input.orgId);
    return true;
  });
  return cloudUpdated || localUpdated;
}
