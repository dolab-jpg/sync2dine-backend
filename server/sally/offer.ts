/**
 * Sally — Sync2Dine platform_owner outbound sales agent.
 * Sells Sync2Dine to restaurants; researches profile; confirms; provisions tenant org.
 * Hard-split from Lizzie (restaurant food-order agent).
 */
import { randomBytes } from 'crypto';
import {
  appendCustomerCallActivity,
  enqueueOutboundCall,
  getAgentSettings,
  getCallById,
  getDataStore,
  saveCall,
  saveCustomerRecord,
  syncData,
} from '../data-store';
import { getHomeOrgId } from '../home-org';
import {
  draftToAboutUs,
  researchRestaurantProfile,
  spokenConfirmForField,
  type RestaurantProfileDraft,
  type RestaurantProfileField,
} from '../restaurant-research';
import { END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL } from '../phone-brain';
import { PHONE_TOOLS } from '../phone-tools';
import { getSallyOfferStored, resolveStoredProductPrices, isLaunchOfferActive, allPackageSnapshots } from '../sally-offer-store';
import {
  SAAS_PRODUCTS,
  formatProductsSummary,
  normalizeSaasProductIds,
  resolveProductLines,
  resolvePackageLine,
  sumMonthly,
  sumQuoteTotal,
  type SaasProductId,
  type SaasProductPrices,
} from '../saas-products';
import {
  FARE_SCHEDULE_VERSION,
  OUTBOUND_OVERAGE,
  SAAS_PACKAGE_IDS,
  SAAS_PACKAGES,
  type OverageAction,
  type SaasPackageId,
  formatFareSummary,
  getPackage,
  isSaasPackageId,
  monthlyEquivalentFromWeekly,
} from '../saas-packages';
import { PLAN_CONFIG } from '../organizations';
import {
  assertContractSignedForCheckout,
  contractEmailBody,
  createSaasContract,
  getSaasContractById,
  markSaasContractSent,
} from '../saas-contracts';

export const SALLY_PERSONA = 'sally';

/** Exclusive Sally tools (executed in this module — not generic phone/CRM). */
export const SALLY_EXCLUSIVE_TOOLS = new Set([
  'researchRestaurantProfile',
  'getRestaurantSetupDraft',
  'confirmRestaurantField',
  'provisionRestaurantClient',
  'bookDemo',
  'leaveVoicemail',
  'createSaasQuote',
  'sendStripeCheckoutLink',
  'bookOnboarding',
  'requestGoogleReview',
  'proposePlanUpsell',
  'chaseUnpaidInvoice',
  'getOfferTerms',
  'confirmSaleTerms',
  'sendSalesAssets',
  'checkPaymentStatus',
  'createSaasContract',
  'sendContract',
]);

export type SallyOfferTerms = {
  /** Combined / phone-agent monthly equivalent — kept for legacy callers. */
  monthlyPriceGbp: number;
  setupFeeGbp: number;
  weeklyPriceGbp: number;
  standardWeeklyGbp: number;
  annualPrepayGbp: number;
  billing: string;
  minimumTerm: string;
  cancelPolicy: string;
  demoPhone: string;
  demoVideoUrl: string;
  salesPdfUrl: string;
  offerEndsAt: string | null;
  launchActive: boolean;
  fareScheduleVersion: string;
  patentRefs?: string;
  founderName?: string;
  authorityBlurb?: string;
  /** Per-SKU prices — legacy Phone Agents / Atmosphere. */
  products: SaasProductPrices;
  packages: ReturnType<typeof allPackageSnapshots>;
};

/** Authoritative Sync2Dine intro offer — UI store first, then env, then defaults. */
export function getSallyOfferTerms(): SallyOfferTerms {
  const stored = getSallyOfferStored();

  const envMonthly = Number(process.env.SALLY_INTRO_MONTHLY_GBP);
  const envSetup = Number(process.env.SALLY_SETUP_FEE_GBP);
  const monthlyFromEnv = Number.isFinite(envMonthly) && envMonthly > 0 ? envMonthly : SAAS_PRODUCTS.phone_agent.defaultMonthlyGbp;
  const setupFromEnv = Number.isFinite(envSetup) && envSetup >= 0 ? envSetup : 0;

  const withEnvFallback = { ...stored };
  if (!(Number.isFinite(Number(stored.monthlyPriceGbp)) && Number(stored.monthlyPriceGbp) > 0)
    && !(stored.products?.phone_agent?.monthlyPriceGbp)) {
    withEnvFallback.monthlyPriceGbp = monthlyFromEnv;
  }
  if (!(Number.isFinite(Number(stored.setupFeeGbp)) && Number(stored.setupFeeGbp) >= 0)
    && stored.products?.phone_agent?.setupFeeGbp == null) {
    withEnvFallback.setupFeeGbp = setupFromEnv;
  }

  const products = resolveStoredProductPrices(withEnvFallback);
  const starter = SAAS_PACKAGES.judie_starter;
  const launchActive = isLaunchOfferActive(stored);
  const weekly = launchActive ? starter.launchWeeklyGbp : starter.standardWeeklyGbp;

  return {
    monthlyPriceGbp: products.phone_agent.monthlyPriceGbp || monthlyEquivalentFromWeekly(weekly),
    setupFeeGbp: products.phone_agent.setupFeeGbp,
    weeklyPriceGbp: products.phone_agent.weeklyPriceGbp || weekly,
    standardWeeklyGbp: starter.standardWeeklyGbp,
    annualPrepayGbp: starter.annualPrepayGbp,
    products,
    packages: allPackageSnapshots(stored),
    billing: 'weekly subscription (Stripe). Annual prepay available at 50% off annualized launch price.',
    minimumTerm: (stored.minimumTerm || process.env.SALLY_MINIMUM_TERM || 'Weekly rolling; annual is 12-month prepay').trim(),
    cancelPolicy: (stored.cancelPolicy
      || process.env.SALLY_CANCEL_POLICY
      || 'Weekly: cancel before the next billing week. Annual: 12-month prepay; 30-day renewal notice. Signed launch rate is kept for the contracted term.').trim(),
    demoPhone: (stored.demoPhone || process.env.SALLY_DEMO_PHONE || '').trim(),
    demoVideoUrl: (stored.demoVideoUrl || process.env.SALLY_DEMO_VIDEO_URL || '').trim(),
    salesPdfUrl: (stored.salesPdfUrl || process.env.SALLY_SALES_PDF_URL || '').trim(),
    offerEndsAt: stored.offerEndsAt || null,
    launchActive,
    fareScheduleVersion: stored.fareScheduleVersion || FARE_SCHEDULE_VERSION,
    patentRefs: stored.patentRefs || undefined,
    founderName: stored.founderName || undefined,
    authorityBlurb: stored.authorityBlurb || undefined,
  };
}

export function formatOfferFactsBlock(): string {
  const t = getSallyOfferTerms();
  const stored = getSallyOfferStored();
  const founder = stored.founderName || 'Shervin Dolab';
  const authority =
    stored.authorityBlurb ||
    `Sync2Dine is the restaurant side of Sync2Gear—the system our founder ${founder} created and holds patent licences for. We’re leading in AI for venues. Judie is your AI phone receptionist—orders and bookings so your team isn’t stuck on the line. Plus Atmosphere: the only audio sustainable management of its kind worldwide—room, messaging, and staff training that runs the venue for revenue.`;
  const patent = stored.patentRefs ? `Patent refs: ${stored.patentRefs}` : '';

  const pkgLines = SAAS_PACKAGE_IDS.map((id) => {
    const p = SAAS_PACKAGES[id];
    const weekly = t.launchActive ? p.launchWeeklyGbp : p.standardWeeklyGbp;
    const mins =
      p.weeklyAiMinutes > 0
        ? ` · ${p.weeklyAiMinutes} Judie AI min/wk` +
          (p.inboundOnly ? ' inbound-only' : '') +
          (p.weeklyOutboundMinutes ? `, ${p.weeklyOutboundMinutes} outbound min/wk` : '') +
          ` · overage £${p.aiOverageGbpPerMinute}/min`
        : '';
    return `  - ${p.name}: normally £${p.standardWeeklyGbp}/wk — ${t.launchActive ? 'launch ' : ''}£${weekly}/wk · annual £${p.annualPrepayGbp}${mins}`;
  });

  const lines = [
    'OFFER FACTS (authoritative — never invent different prices or terms):',
    `AUTHORITY: ${authority}`,
    patent,
    'PRODUCT NAMES: Sell Judie (restaurant AI receptionist) and/or Atmosphere. NEVER sell Sally as the phone product. Sally is the sales agent only. Never say Cynthia on a Sync2Dine sale.',
    'ROUTING (after 60–90s discovery):',
    '  1) Room / reviews / spend / training pain → lead with Atmosphere (£139/wk launch).',
    '  2) Missed calls / orders / phone busy → lead with Judie Starter (£139/wk launch).',
    '  3) Both or growth appetite → lead with Complete (£208/wk launch = Atmosphere + Judie Starter, best value).',
    '  Always mention the other product briefly after the primary pitch. If they pick one, soft upsell Complete.',
    'BILLING: Weekly Stripe subscriptions. Monthly figures are comparison-only. Annual prepay = 50% off annualized launch weekly.',
    'LAUNCH: 40% off standard weekly while offer active' +
      (t.offerEndsAt ? ` (ends ${t.offerEndsAt})` : '') +
      '. Signed-before-deadline customers keep launch rate for contracted term.',
    'PACKAGES:',
    ...pkgLines,
    `Additional site: ≥ £1/week (contact Commercial if they need a custom multi-site deal).`,
    `Outbound overage: £${OUTBOUND_OVERAGE.mobileGbpPerMin}/min mobile · £${OUTBOUND_OVERAGE.landlineGbpPerMin}/min landline.`,
    'Minutes reset weekly; unused do not roll over. Alerts at ~80/100% of allowance. Customer must choose overageAction: continue_bill | pause_transfer | approval_required.',
    `Judie PAYG: inbound only, app notifications only, no outbound/SMS/WhatsApp/email/campaigns, AI overage £0.45/min, 125k tokens/week.`,
    `Fare schedule version: ${t.fareScheduleVersion}`,
    `- Billing: ${t.billing}`,
    `- Minimum term: ${t.minimumTerm}`,
    `- Cancel policy: ${t.cancelPolicy}`,
    'Close path: getOfferTerms → confirmSaleTerms (include packageId, weekly/annual, overageAction) → createSaasContract → sendContract → after signed → sendStripeCheckoutLink.',
  ];
  if (t.demoPhone) lines.push(`- Demo phone: ${t.demoPhone}`);
  if (t.demoVideoUrl) lines.push(`- Demo video: ${t.demoVideoUrl}`);
  if (t.salesPdfUrl) lines.push(`- Sales PDF: ${t.salesPdfUrl}`);
  return lines.filter(Boolean).join('\n');
}

export function formatObjectionPlaybook(): string {
  return [
    'OBJECTION PLAYBOOK (short, honest answers):',
    '- Too expensive / Spotify: Atmosphere is exclusive sustainable audio management + messaging + training — not a music stream. Founder patent licences. Judie frees staff from the phone.',
    '- We already answer the phone: Judie covers missed/overflow/after-hours, takes orders into the app, transfers exceptions to humans.',
    '- Afraid of unlimited bills: No unlimited minutes sold. Clear weekly allowance + published overage. They choose continue_bill / pause_transfer / approval_required.',
    '- Minutes too low: Upsell Judie Pro (420) or Enterprise (840), or explain £/min overage is transparent.',
    '- Annual too risky: Weekly rolling available; annual is optional 50% prepay with 30-day renewal notice.',
    '- What if Judie fails: Transfer-to-human; staff stay in control. Sally never pretends to take diner orders.',
    '- Multi-site discount: Additional sites ≥ £1/week floor; larger deals → Commercial handoff.',
  ].join('\n');
}

export type SallyTermsRecord = {
  confirmedAt: string;
  monthlyPriceGbp: number;
  setupFeeGbp: number;
  weeklyPriceGbp?: number;
  packageId?: SaasPackageId;
  billingInterval?: 'weekly' | 'annual';
  overageAction?: OverageAction;
  amountGbp?: number;
  summary: string;
};

export const sallyTermsBySession = new Map<string, SallyTermsRecord>();

export function readTermsConfirmed(sessionKey: string, callId?: string): SallyTermsRecord | null {
  const fromSession = sallyTermsBySession.get(sessionKey);
  if (fromSession) return fromSession;
  if (!callId) return null;
  const call = getCallById(callId);
  const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
  if (!meta.sallyTermsConfirmedAt) return null;
  return {
    confirmedAt: String(meta.sallyTermsConfirmedAt),
    monthlyPriceGbp: Number(meta.sallyTermsMonthlyGbp) || getSallyOfferTerms().monthlyPriceGbp,
    setupFeeGbp: Number(meta.sallyTermsSetupGbp) || 0,
    summary: String(meta.sallyTermsSummary || 'Terms confirmed'),
  };
}

export function writeTermsConfirmed(
  sessionKey: string,
  record: SallyTermsRecord,
  callId?: string,
) {
  sallyTermsBySession.set(sessionKey, record);
  if (!callId) return;
  const call = getCallById(callId);
  const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
  saveCall({
    id: callId,
    metadata: {
      ...meta,
      agentPersona: SALLY_PERSONA,
      sallyTermsConfirmedAt: record.confirmedAt,
      sallyTermsMonthlyGbp: record.monthlyPriceGbp,
      sallyTermsSetupGbp: record.setupFeeGbp,
      sallyTermsWeeklyGbp: record.weeklyPriceGbp,
      sallyTermsPackageId: record.packageId,
      sallyTermsBillingInterval: record.billingInterval,
      sallyTermsOverageAction: record.overageAction,
      sallyTermsAmountGbp: record.amountGbp,
      sallyTermsSummary: record.summary,
    },
  });
}

export function requireTermsConfirmed(
  sessionKey: string,
  callId: string | undefined,
  args?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (args?.termsConfirmed === true || args?.termsConfirmed === 'true') return null;
  if (readTermsConfirmed(sessionKey, callId)) return null;
  return {
    ok: false,
    error: 'terms_confirmation_required',
    spokenHint:
      'First confirm they understand Judie/Atmosphere, weekly or annual price, fare/overage action, billing, and cancel policy using confirmSaleTerms.',
  };
}

export const SALLY_TOOL_NAMES = new Set([
  ...SALLY_EXCLUSIVE_TOOLS,
  'bookCallback',
  'captureLead',
  'addLeadNote',
  'getLeadBrief',
  'searchLeads',
  'updateLeadStatus',
  'logFollowUp',
  'listPendingCallbacks',
  'transferToHuman',
  'captureMessage',
  'classifyCallIntent',
  'setCallLanguage',
  'endCall',
  'sendCustomerMessage',
  'placeOutboundCall',
  'enqueueOutboundCall',
  'sendEmailReply',
  'draftEmailReply',
  'sendWhatsAppTemplate',
  'createCalendarEvent',
  'scheduleAppointment',
  'sendContract',
  'schedulePaymentReminder',
  'manageSubscription',
]);

/** Chat/call draft store when no TradePro call row exists yet. */
export const sallyDraftBySession = new Map<string, RestaurantProfileDraft>();

export function resolveSallySessionKey(opts: {
  callId?: string;
  staffUserId?: string;
  conversationId?: string;
  webSessionId?: string;
}): string {
  if (opts.callId) return `call:${opts.callId}`;
  if (opts.webSessionId) return `web:${opts.webSessionId}`;
  if (opts.conversationId) return `conv:${opts.conversationId}`;
  if (opts.staffUserId) return `chat:${opts.staffUserId}`;
  return 'chat:default';
}

export function isSallySalesCall(
  meta?: Record<string, unknown> | null,
  opts?: { campaignTemplate?: string; agentPersona?: string },
): boolean {
  const m = meta || {};
  const persona = String(opts?.agentPersona || m.agentPersona || '').toLowerCase();
  if (persona === SALLY_PERSONA) return true;
  if (String(m.aim || '').toLowerCase() === 'sales_outreach') return true;
  if (String(m.source || '').toLowerCase() === 'sales_csv_dial') return true;
  return false;
}

export function getSallyDraftForSession(sessionKey: string): RestaurantProfileDraft {
  return readDraft(sessionKey);
}

export function getSallyTermsForSession(sessionKey: string): SallyTermsRecord | null {
  return readTermsConfirmed(sessionKey);
}

/** Map Sally web draft + terms into /start query + checkout draft fields. */
export function buildSallyCheckoutHandoff(sessionKey: string): {
  startPath: string;
  venueName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  packageId?: SaasPackageId;
  interval?: 'weekly' | 'annual';
  overageAction?: OverageAction;
} {
  const draft = readDraft(sessionKey);
  const terms = readTermsConfirmed(sessionKey);
  const packageId = terms?.packageId && isSaasPackageId(terms.packageId) ? terms.packageId : undefined;
  const interval = terms?.billingInterval === 'annual' ? 'annual' as const : terms?.billingInterval === 'weekly' ? 'weekly' as const : undefined;
  const params = new URLSearchParams();
  if (packageId) params.set('package', packageId);
  if (interval) params.set('interval', interval);
  if (draft.businessName) params.set('venue', draft.businessName);
  if (draft.contactEmail) params.set('email', draft.contactEmail);
  if (draft.phone) params.set('phone', draft.phone);
  if (draft.address) params.set('address', draft.address);
  const qs = params.toString();
  return {
    startPath: qs ? `/start?${qs}` : '/start',
    venueName: draft.businessName || undefined,
    email: draft.contactEmail || undefined,
    phone: draft.phone || undefined,
    address: draft.address || undefined,
    packageId,
    interval,
    overageAction: terms?.overageAction,
  };
}

export function readDraft(sessionKey: string, callId?: string): RestaurantProfileDraft {
  if (callId) {
    const call = getCallById(callId);
    const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
    const draft = meta.sallySetupDraft;
    if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
      return draft as RestaurantProfileDraft;
    }
  }
  return sallyDraftBySession.get(sessionKey) || {};
}

export function writeDraft(
  sessionKey: string,
  draft: RestaurantProfileDraft,
  callId?: string,
  extraMeta?: Record<string, unknown>,
) {
  sallyDraftBySession.set(sessionKey, draft);
  if (!callId) return;
  const call = getCallById(callId);
  const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
  saveCall({
    id: callId,
    metadata: {
      ...meta,
      ...extraMeta,
      agentPersona: SALLY_PERSONA,
      sallySetupDraft: draft,
    },
  });
}

export function parseBoolish(value: string | undefined, fallback: boolean | null | undefined): boolean | null {
  if (value == null || value === '') return fallback ?? null;
  const s = value.trim().toLowerCase();
  if (['yes', 'true', 'y', '1'].includes(s)) return true;
  if (['no', 'false', 'n', '0'].includes(s)) return false;
  return fallback ?? null;
}

export function generateTempPassword(): string {
  return `Sd${randomBytes(4).toString('hex')}!${randomBytes(2).toString('hex')}`;
}

export function linkCrmToSallyOrg(orgId: string, contactEmail: string, phone?: string) {
  try {
    const store = getDataStore();
    const email = contactEmail.trim().toLowerCase();
    const digits = (phone || '').replace(/\D/g, '');
    let touched = false;
    for (const c of (store.customers as Array<Record<string, unknown>>) || []) {
      const cEmail = String(c.email || '').trim().toLowerCase();
      const cPhone = String(c.phone || '').replace(/\D/g, '');
      const match = (email && cEmail === email)
        || (digits.length >= 8 && cPhone.endsWith(digits.slice(-10)));
      if (!match) continue;
      saveCustomerRecord({ ...c, saasOrgId: orgId });
      touched = true;
    }
    if (touched) syncData({ customers: store.customers });
  } catch {
    /* best-effort */
  }
}

export async function seedTenantProfile(
  orgId: string,
  draft: RestaurantProfileDraft,
  contactEmail: string,
): Promise<void> {
  try {
    const { canProvisionViaSupabase } = await import('../provision-org');
    if (!canProvisionViaSupabase()) return;
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) return;
    const supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const aboutUs = draftToAboutUs(draft);
    await supabase.from('agent_settings').upsert({
      org_id: orgId,
      is_active: true,
      data: {
        aboutUs,
        updatedAt: new Date().toISOString(),
        seededBy: 'sally',
      },
    }, { onConflict: 'org_id' });
    await supabase.from('integrations').upsert({
      org_id: orgId,
      integration_id: 'company',
      enabled: true,
      mock_mode: false,
      status: 'connected',
      values_encrypted: {
        companyName: draft.businessName || '',
        website: draft.website || '',
        email: contactEmail,
        phone: draft.phone || '',
        address: draft.address || '',
        autoSendReceiptOnPaid: 'true',
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,integration_id' });
  } catch (err) {
    console.warn('[sally] seedTenantProfile failed:', err instanceof Error ? err.message : err);
  }
}
