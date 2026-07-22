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
} from './data-store';
import { getHomeOrgId } from './home-org';
import {
  draftToAboutUs,
  researchRestaurantProfile,
  spokenConfirmForField,
  type RestaurantProfileDraft,
  type RestaurantProfileField,
} from './restaurant-research';
import { END_CALL_FUNCTION_TOOL, SET_CALL_LANGUAGE_TOOL } from './phone-brain';
import { PHONE_TOOLS } from './phone-tools';
import { getSallyOfferStored, resolveStoredProductPrices, isLaunchOfferActive, allPackageSnapshots } from './sally-offer-store';
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
} from './saas-products';
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
} from './saas-packages';
import { PLAN_CONFIG } from './organizations';
import {
  assertContractSignedForCheckout,
  contractEmailBody,
  createSaasContract,
  getSaasContractById,
  markSaasContractSent,
} from './saas-contracts';

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

function formatOfferFactsBlock(): string {
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

function formatObjectionPlaybook(): string {
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

const sallyTermsBySession = new Map<string, SallyTermsRecord>();

function readTermsConfirmed(sessionKey: string, callId?: string): SallyTermsRecord | null {
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

function writeTermsConfirmed(
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

function requireTermsConfirmed(
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

const SALLY_TOOL_NAMES = new Set([
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
const sallyDraftBySession = new Map<string, RestaurantProfileDraft>();

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

export const SALLY_PHONE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'researchRestaurantProfile',
      description:
        'Look up the restaurant’s public business details online (website / Google / social) using OpenAI. Call when they want to sign up or you need hours/address/menu links. Then confirm fields with the owner.',
      parameters: {
        type: 'object',
        properties: {
          businessName: { type: 'string' },
          phone: { type: 'string' },
          website: { type: 'string' },
          addressHint: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getRestaurantSetupDraft',
      description: 'Read the current signup draft gathered for this call (researched + confirmed fields).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'confirmRestaurantField',
      description:
        'Mark a signup field as confirmed or apply a spoken correction. Use after asking e.g. "We have found these opening hours. Are they correct?"',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            enum: [
              'businessName',
              'address',
              'phone',
              'openingHours',
              'deliveryAvailable',
              'collectionAvailable',
              'deliveryAreas',
              'menuUrl',
              'paymentMethods',
              'reservations',
              'website',
              'socialMedia',
              'contactEmail',
            ],
          },
          confirmed: { type: 'boolean', description: 'true if the owner agreed the value is correct' },
          value: {
            type: 'string',
            description: 'Corrected value when they disagree (use "yes"/"no" for booleans)',
          },
        },
        required: ['field'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'provisionRestaurantClient',
      description:
        'Create a Sync2Dine restaurant organisation (tenant) after confirmSaleTerms and owner agreement. Requires contact email and confirmed:true.',
      parameters: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Must be true — owner agreed to create the account' },
          contactEmail: { type: 'string' },
          contactName: { type: 'string' },
          businessName: { type: 'string' },
          plan: { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
          adminPassword: {
            type: 'string',
            description: 'Optional — if omitted a temporary password is generated',
          },
        },
        required: ['confirmed', 'contactEmail'],
      },
    },
  },
];

export const SALLY_EXTENDED_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'bookDemo',
      description:
        'Book a Sync2Dine product demo with a restaurant prospect. Saves CRM aim demo_book, optional calendar ICS, and optional callback dial.',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          contactName: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          scheduledAt: { type: 'string', description: 'ISO datetime for the demo' },
          notes: { type: 'string' },
          alsoQueueCallback: { type: 'boolean' },
        },
        required: ['scheduledAt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'leaveVoicemail',
      description:
        'Record that a voicemail should be / was left, or schedule email/WhatsApp follow-up when live VM drop is unavailable. Pass left:true only when the call actually reached voicemail.',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          phone: { type: 'string' },
          left: { type: 'boolean' },
          messageSummary: { type: 'string' },
          scheduleFollowUpChannel: { type: 'string', enum: ['email', 'whatsapp', 'callback', 'none'] },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getOfferTerms',
      description:
        'Return the authoritative Sync2Dine intro offer (price, setup fee, billing, cancel policy, demo assets). Always use this instead of inventing numbers.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'confirmSaleTerms',
      description:
        'Record that the prospect confirmed Judie and/or Atmosphere, weekly or annual price, fare/overage action, billing, and cancel policy. Required before createSaasContract, provisionRestaurantClient, or sendStripeCheckoutLink.',
      parameters: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Must be true — they confirmed understanding' },
          packageId: {
            type: 'string',
            enum: [
              'judie_payg_inbound',
              'atmosphere',
              'judie_starter',
              'judie_pro',
              'judie_enterprise',
              'combined',
              'combined_pro',
              'atmosphere_enterprise',
              'combined_enterprise',
            ],
          },
          billingInterval: { type: 'string', enum: ['weekly', 'annual'] },
          overageAction: {
            type: 'string',
            enum: ['continue_bill', 'pause_transfer', 'approval_required'],
            description: 'What happens when weekly AI/outbound minutes are exceeded',
          },
          weeklyPriceGbp: { type: 'number' },
          monthlyPriceGbp: { type: 'number', description: 'Legacy — prefer weeklyPriceGbp' },
          setupFeeGbp: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['confirmed'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'createSaasContract',
      description:
        'Assemble a server-backed Sync2Dine SaaS subscription contract from the agreed package (after confirmSaleTerms). Returns signing URL; use sendContract to email it.',
      parameters: {
        type: 'object',
        properties: {
          packageId: {
            type: 'string',
            enum: [
              'judie_payg_inbound',
              'atmosphere',
              'judie_starter',
              'judie_pro',
              'judie_enterprise',
              'combined',
              'combined_pro',
              'atmosphere_enterprise',
              'combined_enterprise',
            ],
          },
          billingInterval: { type: 'string', enum: ['weekly', 'annual'] },
          overageAction: {
            type: 'string',
            enum: ['continue_bill', 'pause_transfer', 'approval_required'],
          },
          additionalSites: { type: 'number' },
          customerId: { type: 'string' },
          organizationId: { type: 'string' },
          restaurantName: { type: 'string' },
          contactName: { type: 'string' },
          contactEmail: { type: 'string' },
          contactPhone: { type: 'string' },
          address: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['packageId', 'restaurantName', 'contactName', 'contactEmail'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendSalesAssets',
      description:
        'Email and/or WhatsApp demo video, sales PDF, and/or demo phone number from configured offer assets.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['email', 'whatsapp', 'both'] },
          toEmail: { type: 'string' },
          toPhone: { type: 'string' },
          includeVideo: { type: 'boolean' },
          includePdf: { type: 'boolean' },
          includeDemoPhone: { type: 'boolean' },
          customerId: { type: 'string' },
        },
        required: ['channel'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'createSaasQuote',
      description:
        'Create a Sync2Dine SaaS quote. Prefer packageId (judie_starter, atmosphere, combined, …). Legacy products phone_agent/audio_management still accepted.',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          businessName: { type: 'string' },
          packageId: {
            type: 'string',
            enum: [
              'judie_payg_inbound',
              'atmosphere',
              'judie_starter',
              'judie_pro',
              'judie_enterprise',
              'combined',
              'combined_pro',
              'atmosphere_enterprise',
              'combined_enterprise',
            ],
          },
          billingInterval: { type: 'string', enum: ['weekly', 'annual'] },
          additionalSites: { type: 'number' },
          products: {
            type: 'array',
            items: { type: 'string', enum: ['phone_agent', 'audio_management'] },
            description: 'Legacy — prefer packageId',
          },
          quantities: {
            type: 'object',
            description: 'Optional quantity per product id (default 1)',
            additionalProperties: { type: 'number' },
          },
          plan: { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
          monthlyPriceGbp: {
            type: 'number',
            description: 'Optional override (legacy)',
          },
          weeklyPriceGbp: { type: 'number' },
          notes: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendStripeCheckoutLink',
      description:
        'After confirmSaleTerms AND signed contract: create Stripe Checkout (weekly or annual) and email/WhatsApp the link. Pass contractId (preferred) or organizationId with a signed contract on file.',
      parameters: {
        type: 'object',
        properties: {
          organizationId: { type: 'string' },
          customerId: { type: 'string' },
          contractId: { type: 'string', description: 'Signed Sync2Dine SaaS contract id' },
          quoteId: { type: 'string', description: 'SaaS quote id with products/lines for multi-product checkout' },
          channel: { type: 'string', enum: ['email', 'whatsapp', 'both'] },
          toEmail: { type: 'string' },
          toPhone: { type: 'string' },
        },
        required: ['channel'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'checkPaymentStatus',
      description:
        'Check whether a restaurant org (or CRM prospect linked to an org) has paid / is active on Stripe.',
      parameters: {
        type: 'object',
        properties: {
          organizationId: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bookOnboarding',
      description: 'Book post-signup onboarding for a provisioned restaurant (go-live checklist + optional callback).',
      parameters: {
        type: 'object',
        properties: {
          organizationId: { type: 'string' },
          customerId: { type: 'string' },
          scheduledAt: { type: 'string' },
          phone: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['scheduledAt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'requestGoogleReview',
      description: 'Ask a restaurant client for a Google review (uses company Google review URL when configured).',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          channel: { type: 'string', enum: ['whatsapp', 'email', 'note_only'] },
          googleReviewUrl: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'proposePlanUpsell',
      description: 'Propose upgrading a restaurant org plan (starter→pro→enterprise) and optionally create a checkout link.',
      parameters: {
        type: 'object',
        properties: {
          organizationId: { type: 'string' },
          targetPlan: { type: 'string', enum: ['pro', 'enterprise'] },
          createCheckout: { type: 'boolean' },
        },
        required: ['organizationId', 'targetPlan'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'chaseUnpaidInvoice',
      description: 'Chase a past-due Sync2Dine SaaS invoice — CRM note + optional callback / email reminder.',
      parameters: {
        type: 'object',
        properties: {
          organizationId: { type: 'string' },
          customerId: { type: 'string' },
          phone: { type: 'string' },
          channel: { type: 'string', enum: ['callback', 'email', 'whatsapp', 'note_only'] },
          notes: { type: 'string' },
        },
      },
    },
  },
];

function pickPhoneTools(...names: string[]) {
  return PHONE_TOOLS.filter((t) => names.includes(t.function.name));
}

const SALLY_CRM_NOTE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'addLeadNote',
    description: 'Save a sales call note / disposition on the prospect CRM row',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        detail: { type: 'string' },
        aim: { type: 'string' },
        outcome: { type: 'string' },
        disposition: { type: 'string' },
      },
      required: ['detail'],
    },
  },
};

/** Chat-completions tools for Sally phone — no food-order / menu tools. */
export function getSallyPhoneSessionChatTools() {
  return [
    ...SALLY_PHONE_TOOLS,
    ...SALLY_EXTENDED_TOOLS,
    ...pickPhoneTools(
      'bookCallback',
      'captureLead',
      'transferToHuman',
      'captureMessage',
      'classifyCallIntent',
      'sendCustomerMessage',
      'placeOutboundCall',
      'enqueueOutboundCall',
      'scheduleAppointment',
    ),
    SALLY_CRM_NOTE_TOOL,
    END_CALL_FUNCTION_TOOL,
    SET_CALL_LANGUAGE_TOOL,
  ];
}

/** Orchestrator (chat) tool pack for Sally mode. */
export function getSallyOrchestratorTools() {
  return [
    ...SALLY_PHONE_TOOLS,
    ...SALLY_EXTENDED_TOOLS,
    ...pickPhoneTools(
      'bookCallback',
      'captureLead',
      'sendCustomerMessage',
      'placeOutboundCall',
      'enqueueOutboundCall',
      'scheduleAppointment',
      'classifyCallIntent',
      'captureMessage',
    ),
    SALLY_CRM_NOTE_TOOL,
    {
      type: 'function' as const,
      function: {
        name: 'getLeadBrief',
        description: 'Load CRM lead notes and history for a prospect',
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string' },
            customerId: { type: 'string' },
            query: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'searchLeads',
        description: 'Search CRM leads/prospects by name, phone, or status',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'updateLeadStatus',
        description: 'Update CRM lead status (e.g. qualified, negotiating, won, lost)',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['customerId', 'status'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'logFollowUp',
        description: 'Log a sales follow-up on a lead',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'string' },
            detail: { type: 'string' },
            nextFollowUp: { type: 'string' },
          },
          required: ['customerId', 'detail'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'draftEmailReply',
        description: 'Draft a sales email to a restaurant prospect (mailbox)',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'sendEmailReply',
        description: 'Send a sales email via connected mailbox (requires confirmation)',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
            confirmed: { type: 'boolean' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'sendWhatsAppTemplate',
        description: 'Send a WhatsApp template message to a prospect',
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string' },
            templateName: { type: 'string' },
            confirmed: { type: 'boolean' },
          },
          required: ['phone'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'createCalendarEvent',
        description: 'Create a calendar/ICS invite for a demo or onboarding',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            startAt: { type: 'string' },
            endAt: { type: 'string' },
            attendees: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['title', 'startAt'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'sendContract',
        description: 'Email a Sync2Dine SaaS contract signing link (created via createSaasContract)',
        parameters: {
          type: 'object',
          properties: {
            contractId: { type: 'string' },
            customerId: { type: 'string' },
            toEmail: { type: 'string' },
            confirmed: { type: 'boolean' },
          },
          required: ['contractId'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'schedulePaymentReminder',
        description: 'Schedule a payment reminder for a past-due SaaS invoice',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'string' },
            organizationId: { type: 'string' },
            dueAt: { type: 'string' },
          },
        },
      },
    },
  ];
}

const SALLY_WEB_BLOCKED_TOOLS = new Set([
  'placeOutboundCall',
  'enqueueOutboundCall',
  'leaveVoicemail',
  'chaseUnpaidInvoice',
  'schedulePaymentReminder',
  'provisionRestaurantClient',
  'searchLeads',
  'updateLeadStatus',
  'logFollowUp',
  'getLeadBrief',
  'draftEmailReply',
  'sendEmailReply',
]);

/** Public website chat — Sally sales tools without staff CRM / outbound blast. */
export function getSallyWebOrchestratorTools() {
  return getSallyOrchestratorTools().filter((tool) => {
    const name = tool && typeof tool === 'object' && 'function' in tool
      ? String((tool as { function?: { name?: string } }).function?.name || '')
      : '';
    return name && !SALLY_WEB_BLOCKED_TOOLS.has(name);
  });
}

export function isSallyToolName(name: string): boolean {
  return SALLY_TOOL_NAMES.has(name);
}

export function isSallyExclusiveTool(name: string): boolean {
  return SALLY_EXCLUSIVE_TOOLS.has(name);
}

const SALLY_SALES_OS = [
  'You are Sally, Sync2Dine’s dedicated sales AI (phone and chat).',
  'IDENTITY: Your name is Sally. You work for Sync2Dine (sync2dine.io), the restaurant side of Sync2Gear. Never say you are Judie, Lizzie, Cynthia, or Builder Diddies. Never take food orders — Judie does that after they buy.',
  'AIM: Take a restaurant prospect from first contact to a signed contract and live paying customer, with minimal human help.',
  'HOW: Discovery 60–90s → authority (founder + patent + exclusive Atmosphere) → route to Atmosphere / Judie / Complete → handle objections → getOfferTerms → confirmSaleTerms → createSaasContract + sendContract → after signature sendStripeCheckoutLink → provision/onboard.',
  'GUARDRAILS:',
  '- NOT the restaurant food-order agent. No menus, orders, or diner reservations.',
  '- NEVER sell Sally as the product. The product is Judie and/or Atmosphere.',
  '- British English, warm professional sales tone. Phone: one or two spoken sentences. Chat: concise paragraphs OK.',
  '- Never invent price, terms, CRM facts, hours, or payment links — use getOfferTerms and tools.',
  '- Before provisionRestaurantClient or sendStripeCheckoutLink: confirmSaleTerms, then signed contract via createSaasContract/sendContract.',
  '- Payment links must be emailed and/or WhatsApp’d via sendStripeCheckoutLink (channel email|whatsapp|both) — do not rely on reading a long URL aloud.',
  '- Escalate only if stuck or they ask for a human. DNC/opt-out = stop.',
  '- Voicemail: use leaveVoicemail; if live drop unavailable, schedule email/WhatsApp follow-up — never fake a left message.',
].join('\n');

export function buildSallyBrainPrompt(input: {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  outboundBrief?: string;
  contactName?: string;
  companyHint?: string;
  draft?: RestaurantProfileDraft | null;
}): { instructions: string; language: 'en' } {
  const draftBlock = input.draft && Object.keys(input.draft).length
    ? `Current signup draft (confirm with owner — do not invent):\n${JSON.stringify(input.draft, null, 0).slice(0, 2500)}`
    : 'No signup draft yet — call researchRestaurantProfile once they want to sign up or you need public details.';

  const instructions = [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    '- On phone keep replies short. Confirm fields one at a time after research.',
    input.direction === 'outbound'
      ? '- This is an outbound sales call you placed.'
      : '- This is an inbound sales call.',
    input.contactName ? `- Contact name hint: ${input.contactName}` : '',
    input.companyHint ? `- Company / restaurant hint: ${input.companyHint}` : '',
    `Caller phone: ${input.partyPhone}`,
    input.outboundBrief
      ? `- SALES BRIEF FOR THIS CALL (follow this): ${String(input.outboundBrief).slice(0, 900)}`
      : '- Pitch Sync2Dine: Judie answers the phone; Atmosphere runs the room; Complete does both.',
    '',
    draftBlock,
  ].filter(Boolean).join('\n');

  return { instructions, language: 'en' };
}

export function buildSallyChatPrompt(input?: {
  userName?: string;
  draft?: RestaurantProfileDraft | null;
}): string {
  const draftBlock = input?.draft && Object.keys(input.draft).length
    ? `Current signup draft:\n${JSON.stringify(input.draft, null, 0).slice(0, 2500)}`
    : 'No signup draft in this session yet.';
  return [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    input?.userName ? `You are chatting with platform sales staff: ${input.userName}.` : 'You are chatting with Sync2Dine platform sales staff.',
    'Help them run the sales pipeline with tools. Prefer action over long essays.',
    'Routes they may need: /crm, /calls, /platform/clients, /sales, /pricing.',
    draftBlock,
  ].join('\n');
}

/** Anonymous visitor on sync2dine.io — ChatGPT-style sales + signup guide. */
export function buildSallyWebPrompt(input?: {
  page?: string;
  draft?: RestaurantProfileDraft | null;
  terms?: SallyTermsRecord | null;
}): string {
  const draftBlock = input?.draft && Object.keys(input.draft).length
    ? `Current signup draft (confirm with visitor — do not invent):\n${JSON.stringify(input.draft, null, 0).slice(0, 2500)}`
    : 'No signup draft yet — researchRestaurantProfile once they name their restaurant or want to sign up.';
  const termsBlock = input?.terms
    ? `Confirmed commercial terms:\n${JSON.stringify(input.terms, null, 0).slice(0, 800)}`
    : 'No commercial terms confirmed yet.';
  const page = (input?.page || '/').trim() || '/';
  return [
    SALLY_SALES_OS,
    formatOfferFactsBlock(),
    formatObjectionPlaybook(),
    'CHANNEL: Anonymous website visitor on sync2dine.io (Ask Sync2Dine top bar / chat). They are a restaurant prospect, not staff.',
    `Current page hint: ${page}`,
    'UI: Visitors see “Ask Sync2Dine”. You are still Sally. Never say you are Judie, Cynthia, Lizzie, or Builder Diddies.',
    'PRIMARY PRODUCT: Sync2Dine sells Atmosphere first — venue audio management, promotional messaging, and staff training (Sync2Gear). Lead with Atmosphere unless they clearly only care about the phone.',
    'SECONDARY: Judie is the AI phone receptionist upsell (orders/bookings). Complete = Atmosphere + Judie when they want both. Never lead with Judie on a generic homepage visit.',
    'AIM: Answer like their search engine for Sync2Dine — clear, concise British English. Guide questions toward Atmosphere pricing, then call or enquire.',
    'PHONE (always available): Our landline is 020 3745 3233 (+442037453233), answered 24/7. Offer it early and often. Prefer tel:+442037453233. You may bookCallback if they want a scheduled call. Speaking to us is the preferred close while app self-serve checkout is closed for testing.',
    'SIGNUP PATH: Ask one or two questions at a time — need (Atmosphere / Complete / Judie) → venue name → contact name, email, phone. Use getOfferTerms for prices. Point them to https://sync2dine.io/inquiry/ or Call 020 3745 3233 — do NOT send them to app.sync2dine.io/start while the app storefront is login-gated.',
    'Do not place outbound dials or blast CRM from this channel. Capture leads with captureLead / bookDemo / bookCallback.',
    'Food orders / diner bookings: politely redirect — Judie does that for restaurants after they join Sync2Dine.',
    draftBlock,
    termsBlock,
  ].join('\n');
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

function readDraft(sessionKey: string, callId?: string): RestaurantProfileDraft {
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

function writeDraft(
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

function parseBoolish(value: string | undefined, fallback: boolean | null | undefined): boolean | null {
  if (value == null || value === '') return fallback ?? null;
  const s = value.trim().toLowerCase();
  if (['yes', 'true', 'y', '1'].includes(s)) return true;
  if (['no', 'false', 'n', '0'].includes(s)) return false;
  return fallback ?? null;
}

function generateTempPassword(): string {
  return `Sd${randomBytes(4).toString('hex')}!${randomBytes(2).toString('hex')}`;
}

function linkCrmToSallyOrg(orgId: string, contactEmail: string, phone?: string) {
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

async function seedTenantProfile(
  orgId: string,
  draft: RestaurantProfileDraft,
  contactEmail: string,
): Promise<void> {
  try {
    const { canProvisionViaSupabase } = await import('./provision-org');
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

export type SallyToolContext = {
  callId?: string;
  partyPhone?: string;
  sessionKey?: string;
  staffUserId?: string;
};

async function sendSallyWhatsApp(
  toRaw: string,
  message: string,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const { normalizeDialableE164 } = await import('./phone-tools');
  const to = normalizeDialableE164(toRaw);
  if (!to) return { ok: false, error: 'invalid_phone' };
  const { isMetaWhatsAppEnabled, sendWhatsAppText } = await import('./whatsapp-webhook');
  const waToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!isMetaWhatsAppEnabled() || !waToken || !waPhoneId) {
    return { ok: false, error: 'whatsapp_not_configured' };
  }
  await sendWhatsAppText(waPhoneId, waToken, to.startsWith('+') ? to : `+${to}`, message);
  return { ok: true, to };
}

async function sendSallyEmail(
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sendPlainTextEmail } = await import('./email-service');
  const result = await sendPlainTextEmail({ to, subject, text });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

async function deliverSallyChannels(opts: {
  channel: 'email' | 'whatsapp' | 'both';
  toEmail?: string;
  toPhone?: string;
  emailSubject: string;
  emailBody: string;
  whatsappBody: string;
}): Promise<{ sentVia: string[]; errors: string[] }> {
  const sentVia: string[] = [];
  const errors: string[] = [];
  const wantEmail = opts.channel === 'email' || opts.channel === 'both';
  const wantWa = opts.channel === 'whatsapp' || opts.channel === 'both';

  if (wantEmail) {
    const email = (opts.toEmail || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      errors.push('email_required');
    } else {
      const r = await sendSallyEmail(email, opts.emailSubject, opts.emailBody);
      if (r.ok) sentVia.push('email');
      else errors.push(r.error);
    }
  }
  if (wantWa) {
    const phone = (opts.toPhone || '').trim();
    if (!phone) {
      errors.push('phone_required');
    } else {
      const r = await sendSallyWhatsApp(phone, opts.whatsappBody);
      if (r.ok) sentVia.push('whatsapp');
      else errors.push(r.error);
    }
  }
  return { sentVia, errors };
}

export async function executeSallyTool(
  name: string,
  args: Record<string, unknown>,
  callIdOrCtx: string | SallyToolContext,
  partyPhoneArg?: string,
): Promise<Record<string, unknown>> {
  const ctx: SallyToolContext = typeof callIdOrCtx === 'string'
    ? { callId: callIdOrCtx, partyPhone: partyPhoneArg || '' }
    : callIdOrCtx;
  const callId = ctx.callId || '';
  const partyPhone = ctx.partyPhone || '';
  const sessionKey = ctx.sessionKey
    || resolveSallySessionKey({ callId, staffUserId: ctx.staffUserId });

  if (name === 'getOfferTerms') {
    const terms = getSallyOfferTerms();
    const phone = terms.products.phone_agent;
    const audio = terms.products.audio_management;
    const plans = {
      starter: PLAN_CONFIG.starter,
      pro: PLAN_CONFIG.pro,
      enterprise: PLAN_CONFIG.enterprise,
    };
    const j = SAAS_PACKAGES.judie_starter;
    const a = SAAS_PACKAGES.atmosphere;
    const c = SAAS_PACKAGES.combined;
    const w = (pkg: typeof j) => (terms.launchActive ? pkg.launchWeeklyGbp : pkg.standardWeeklyGbp);
    return {
      ok: true,
      ...terms,
      plans,
      fareScheduleVersion: terms.fareScheduleVersion,
      spokenHint:
        `Lead with need: Judie from ${w(j)} pounds a week with ${j.weeklyAiMinutes} AI minutes, Atmosphere from ${w(a)} a week, or Complete at ${w(c)} a week best value. ` +
        `Launch is 40 percent off the standard weekly; annual prepay is 50 percent off. ` +
        `Minutes reset weekly — overage is published per package. ` +
        `Comparison monthly for Judie Starter is about ${phone.monthlyPriceGbp} pounds. Atmosphere add path is about ${audio.monthlyPriceGbp} monthly equivalent. ${terms.cancelPolicy}`,
    };
  }

  if (name === 'confirmSaleTerms') {
    if (args.confirmed !== true && args.confirmed !== 'true') {
      return {
        ok: false,
        error: 'confirmation_required',
        spokenHint:
          'Ask them to confirm they understand Judie and/or Atmosphere, the weekly or annual price, fare and overage action, billing, and cancel policy first.',
      };
    }
    const offer = getSallyOfferTerms();
    const packageRaw = String(args.packageId || args.package || '').trim();
    const packageId = isSaasPackageId(packageRaw) ? packageRaw : 'judie_starter';
    const pkg = getPackage(packageId);
    const billingInterval = String(args.billingInterval || args.interval || 'weekly').toLowerCase() === 'annual'
      ? 'annual' as const
      : 'weekly' as const;
    const overageRaw = String(args.overageAction || 'continue_bill').trim() as OverageAction;
    const overageAction: OverageAction =
      overageRaw === 'pause_transfer' || overageRaw === 'approval_required' || overageRaw === 'continue_bill'
        ? overageRaw
        : 'continue_bill';
    const weekly = Number(args.weeklyPriceGbp);
    const monthly = Number(args.monthlyPriceGbp);
    const setup = Number(args.setupFeeGbp);
    const weeklyPrice =
      Number.isFinite(weekly) && weekly > 0
        ? weekly
        : offer.launchActive
          ? pkg.launchWeeklyGbp
          : pkg.standardWeeklyGbp;
    const amountGbp =
      billingInterval === 'annual'
        ? pkg.annualPrepayGbp
        : weeklyPrice;
    const record: SallyTermsRecord = {
      confirmedAt: new Date().toISOString(),
      monthlyPriceGbp:
        Number.isFinite(monthly) && monthly > 0
          ? monthly
          : monthlyEquivalentFromWeekly(weeklyPrice),
      setupFeeGbp: Number.isFinite(setup) && setup >= 0 ? setup : offer.setupFeeGbp,
      weeklyPriceGbp: weeklyPrice,
      packageId,
      billingInterval,
      overageAction,
      amountGbp,
      summary: String(
        args.notes ||
          `Customer confirmed ${pkg.name}, ${billingInterval} £${amountGbp}, overageAction=${overageAction}, fare ${offer.fareScheduleVersion}`,
      ).trim(),
    };
    writeTermsConfirmed(sessionKey, record, callId || undefined);
    return {
      ok: true,
      ...record,
      fareSummary: formatFareSummary(pkg),
      spokenHint: `Noted — they confirmed ${pkg.name} at £${amountGbp}${billingInterval === 'annual' ? ' annual prepay' : '/week'}. Create and send the contract next, then checkout after they sign.`,
    };
  }

  if (name === 'sendSalesAssets') {
    const channel = String(args.channel || '').toLowerCase() as 'email' | 'whatsapp' | 'both';
    if (!['email', 'whatsapp', 'both'].includes(channel)) {
      return { ok: false, error: 'channel_required', spokenHint: 'Should I email, WhatsApp, or both for the demo materials?' };
    }
    const offer = getSallyOfferTerms();
    const parts: string[] = ['Here are your Sync2Dine details:'];
    if (args.includeVideo !== false && offer.demoVideoUrl) parts.push(`Demo video: ${offer.demoVideoUrl}`);
    if (args.includePdf !== false && offer.salesPdfUrl) parts.push(`Overview PDF: ${offer.salesPdfUrl}`);
    if (args.includeDemoPhone !== false && offer.demoPhone) parts.push(`Demo phone: ${offer.demoPhone}`);
    if (parts.length === 1) {
      return {
        ok: false,
        error: 'assets_not_configured',
        spokenHint: 'Demo assets are not configured yet — share the intro price verbally or escalate to set SALLY_DEMO_* env values.',
      };
    }
    const body = parts.join('\n');
    const toEmail = String(args.toEmail || '').trim();
    const toPhone = String(args.toPhone || partyPhone || '').trim();
    const delivered = await deliverSallyChannels({
      channel,
      toEmail,
      toPhone,
      emailSubject: 'Sync2Dine — demo materials',
      emailBody: body,
      whatsappBody: body,
    });
    if (!delivered.sentVia.length) {
      return {
        ok: false,
        error: delivered.errors.join(',') || 'send_failed',
        spokenHint: 'I could not send the materials on that channel — ask for another email or WhatsApp number, or escalate.',
        errors: delivered.errors,
      };
    }
    const customerId = String(args.customerId || '').trim();
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId || undefined,
        summary: `Sales assets sent via ${delivered.sentVia.join(' + ')}`,
        detail: body,
        aim: 'demo_book',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      sentVia: delivered.sentVia,
      errors: delivered.errors,
      spokenHint: `I've sent the Sync2Dine materials by ${delivered.sentVia.join(' and ')}.`,
    };
  }

  if (name === 'checkPaymentStatus') {
    let organizationId = String(args.organizationId || '').trim();
    const customerId = String(args.customerId || '').trim();
    if (!organizationId && customerId) {
      const store = getDataStore();
      const cust = (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
      organizationId = String(cust?.saasOrgId || cust?.organizationId || '').trim();
      if (!organizationId && callId) {
        const call = getCallById(callId);
        const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
        organizationId = String(meta.sallyProvisionedOrgId || '').trim();
      }
    }
    if (!organizationId && callId) {
      const call = getCallById(callId);
      const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
      organizationId = String(meta.sallyProvisionedOrgId || '').trim();
    }
    if (!organizationId) {
      return {
        ok: false,
        error: 'organizationId_required',
        spokenHint: 'Which organisation should I check payment for?',
      };
    }
    const { getOrgPaymentStatus } = await import('./stripe-service');
    const status = getOrgPaymentStatus(organizationId);
    if (!status) {
      return { ok: false, error: 'org_not_found', spokenHint: 'I could not find that organisation.' };
    }
    let crmPaid: string | null = null;
    if (customerId) {
      const store = getDataStore();
      const cust = (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
      crmPaid = cust ? String(cust.saasPaymentStatus || '') || null : null;
    }
    return {
      ok: true,
      ...status,
      crmPaymentStatus: crmPaid,
      spokenHint: status.paid
        ? 'Payment is confirmed — they are live on Sync2Dine.'
        : `Not paid yet — org status ${status.status}${status.subscriptionStatus ? `, subscription ${status.subscriptionStatus}` : ''}.`,
    };
  }

  if (name === 'researchRestaurantProfile') {
    const call = callId ? getCallById(callId) : undefined;
    const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
    const businessName = String(args.businessName || meta.company || call?.contactName || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const website = String(args.website || '').trim();
    const addressHint = String(args.addressHint || '').trim();

    const result = await researchRestaurantProfile({
      businessName,
      phone,
      website: website || undefined,
      addressHint: addressHint || undefined,
      orgId: getHomeOrgId(),
    });

    if (!result.ok) {
      return { ok: false, error: result.error, spokenHint: result.spokenHint };
    }

    const prev = readDraft(sessionKey, callId || undefined);
    const merged: RestaurantProfileDraft = {
      ...prev,
      ...result.draft,
      phone: result.draft.phone || phone || prev.phone,
      businessName: result.draft.businessName || businessName || prev.businessName,
      confirmedFields: prev.confirmedFields || [],
    };
    writeDraft(sessionKey, merged, callId || undefined, { sallyResearchAt: new Date().toISOString() });
    return {
      ok: true,
      draft: merged,
      spokenHint: result.spokenHint,
      nextField: merged.openingHours ? 'openingHours' : 'address',
    };
  }

  if (name === 'getRestaurantSetupDraft') {
    const draft = readDraft(sessionKey, callId || undefined);
    return {
      ok: true,
      draft,
      spokenHint: draft.businessName
        ? `Draft on file for ${draft.businessName}. Confirm remaining fields then provision.`
        : 'No draft yet — research the restaurant first.',
    };
  }

  if (name === 'confirmRestaurantField') {
    const field = String(args.field || '') as RestaurantProfileField;
    if (!field) {
      return { ok: false, error: 'field_required', spokenHint: 'Which field should I confirm?' };
    }
    const draft = { ...readDraft(sessionKey, callId || undefined) };
    const confirmed = args.confirmed !== false && args.confirmed !== 'false';
    if (args.value != null && String(args.value).trim()) {
      const raw = String(args.value).trim();
      if (field === 'deliveryAvailable' || field === 'collectionAvailable' || field === 'reservations') {
        (draft as Record<string, unknown>)[field] = parseBoolish(raw, draft[field] as boolean | null);
      } else {
        (draft as Record<string, unknown>)[field] = raw;
      }
    }
    const confirmedFields = new Set(draft.confirmedFields || []);
    if (confirmed) confirmedFields.add(field);
    else confirmedFields.delete(field);
    draft.confirmedFields = [...confirmedFields];
    writeDraft(sessionKey, draft, callId || undefined);
    const nextHints: RestaurantProfileField[] = [
      'openingHours', 'address', 'deliveryAvailable', 'collectionAvailable',
      'paymentMethods', 'website', 'contactEmail',
    ];
    const next = nextHints.find((f) => !confirmedFields.has(f) && f !== field);
    return {
      ok: true,
      field,
      confirmed: confirmedFields.has(field),
      draft,
      spokenHint: confirmed
        ? (next ? spokenConfirmForField(next, draft) : 'That looks solid. If they are ready, get their email and provision the restaurant account.')
        : spokenConfirmForField(field, draft),
      nextField: next || null,
    };
  }

  if (name === 'provisionRestaurantClient') {
    const termsGate = requireTermsConfirmed(sessionKey, callId || undefined, args);
    if (termsGate) return termsGate;
    if (args.confirmed !== true && args.confirmed !== 'true') {
      return {
        ok: false,
        error: 'confirmation_required',
        spokenHint: 'Ask them to confirm they want the Sync2Dine restaurant account created first.',
      };
    }
    const contactEmail = String(args.contactEmail || '').trim().toLowerCase();
    if (!contactEmail || !contactEmail.includes('@')) {
      return {
        ok: false,
        error: 'email_required',
        spokenHint: 'I need their email address to create the restaurant login.',
      };
    }

    const draft = readDraft(sessionKey, callId || undefined);
    const businessName = String(args.businessName || draft.businessName || 'New Restaurant').trim();
    const contactName = String(args.contactName || businessName).trim();
    const adminPassword = String(args.adminPassword || '').trim() || generateTempPassword();
    const plan = String(args.plan || 'starter').trim() || 'starter';
    const aboutNotes = draftToAboutUs({
      ...draft,
      businessName,
      phone: draft.phone || partyPhone,
      contactEmail,
    });

    try {
      const {
        canProvisionViaSupabase,
        provisionOrganizationInSupabase,
        mapSupabaseOrgToApi,
      } = await import('./provision-org');

      if (canProvisionViaSupabase()) {
        const provisioned = await provisionOrganizationInSupabase({
          name: businessName,
          contactName,
          contactEmail,
          contactPhone: draft.phone || partyPhone,
          address: draft.address,
          plan,
          adminPassword,
          notes: `Provisioned by Sally${callId ? ` on call ${callId}` : ''}.\n${aboutNotes}`,
        });
        const org = mapSupabaseOrgToApi(provisioned.organization);
        await seedTenantProfile(org.id, { ...draft, businessName, contactEmail, phone: draft.phone || partyPhone }, contactEmail);
        writeDraft(sessionKey, {
          ...draft,
          businessName,
          contactEmail,
          phone: draft.phone || partyPhone,
        }, callId || undefined, {
          sallyProvisionedOrgId: org.id,
          sallyProvisionedAt: new Date().toISOString(),
        });
        linkCrmToSallyOrg(org.id, contactEmail, draft.phone || partyPhone);
        return {
          ok: true,
          organizationId: org.id,
          organizationName: org.name,
          contactEmail,
          temporaryPassword: adminPassword,
          plan: org.plan,
          spokenHint: `All set — I've created ${org.name} on Sync2Dine. They can log in with ${contactEmail}. I've set a temporary password; tell them to change it after first login.`,
        };
      }

      const { createOrganization } = await import('./organizations');
      const local = createOrganization({
        name: businessName,
        contactName,
        contactEmail,
        contactPhone: String(draft.phone || partyPhone || ''),
        address: draft.address,
        plan: plan as 'starter' | 'pro' | 'enterprise',
        notes: `Provisioned by Sally${callId ? ` on call ${callId}` : ''}.\n${aboutNotes}`,
      });
      writeDraft(sessionKey, { ...draft, businessName, contactEmail }, callId || undefined, {
        sallyProvisionedOrgId: local.id,
        sallyProvisionedAt: new Date().toISOString(),
      });
      linkCrmToSallyOrg(local.id, contactEmail, draft.phone || partyPhone);
      return {
        ok: true,
        organizationId: local.id,
        organizationName: local.name,
        contactEmail,
        temporaryPassword: adminPassword,
        plan: local.plan,
        localOnly: true,
        spokenHint: `I've created ${local.name} on Sync2Dine (local record). Login email ${contactEmail}.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'provision_failed',
        spokenHint: 'Sorry — creating the restaurant account failed. Offer a callback and we will finish setup from the office.',
      };
    }
  }

  if (name === 'bookDemo') {
    const scheduledAt = String(args.scheduledAt || '').trim();
    if (!scheduledAt) {
      return { ok: false, error: 'scheduledAt_required', spokenHint: 'When should we book the demo?' };
    }
    const customerId = String(args.customerId || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const contactName = String(args.contactName || '').trim();
    const notes = String(args.notes || '').trim();
    const detail = `Demo booked for ${scheduledAt}${notes ? ` — ${notes}` : ''}`;
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId || undefined,
        summary: detail,
        detail,
        aim: 'demo_book',
        type: 'note',
        createdBy: 'sally',
      });
      const store = getDataStore();
      const cust = (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
      if (cust) {
        saveCustomerRecord({ ...cust, nextFollowUp: scheduledAt, status: cust.status || 'lead' });
        syncData({ customers: store.customers });
      }
    }
    if (args.alsoQueueCallback && phone) {
      enqueueOutboundCall({
        to: phone,
        template: 'lead_callback',
        status: 'queued',
        scheduledAt,
        context: {
          customerId: customerId || undefined,
          company: contactName,
          aim: 'demo_book',
          agentPersona: SALLY_PERSONA,
          brief: `Demo callback for ${contactName || 'prospect'} at ${scheduledAt}`,
          source: 'sally_book_demo',
        },
      });
    }
    return {
      ok: true,
      scheduledAt,
      customerId: customerId || null,
      spokenHint: `Demo booked for ${scheduledAt}. I've noted it on the CRM${args.alsoQueueCallback && phone ? ' and queued a reminder call' : ''}.`,
    };
  }

  if (name === 'leaveVoicemail') {
    const left = args.left === true || args.left === 'true';
    const customerId = String(args.customerId || '').trim();
    const summary = String(args.messageSummary || 'Voicemail follow-up').trim();
    const channel = String(args.scheduleFollowUpChannel || (left ? 'none' : 'whatsapp'));
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        callId: callId || undefined,
        summary: left ? `Voicemail left: ${summary}` : `Voicemail not available — follow up via ${channel}: ${summary}`,
        detail: summary,
        aim: 'sales_outreach',
        outcome: left ? 'voicemail' : 'callback_requested',
        disposition: left ? 'voicemail' : 'callback_requested',
        type: 'note',
        createdBy: 'sally',
        updateCallQueue: true,
      });
    }
    const phone = String(args.phone || partyPhone || '').trim();
    if (!left && channel === 'callback' && phone) {
      const retryMin = getAgentSettings().callQueueRetryMinutes ?? 60;
      enqueueOutboundCall({
        to: phone,
        template: 'lead_callback',
        status: 'queued',
        scheduledAt: new Date(Date.now() + retryMin * 60_000).toISOString(),
        context: {
          customerId: customerId || undefined,
          aim: 'sales_outreach',
          agentPersona: SALLY_PERSONA,
          brief: summary,
          source: 'sally_voicemail_followup',
        },
      });
    }
    return {
      ok: true,
      left,
      followUpChannel: channel,
      spokenHint: left
        ? 'Noted — voicemail left and CRM updated.'
        : `Live voicemail drop isn't available; I've logged it and scheduled a ${channel} follow-up.`,
    };
  }

  if (name === 'createSaasQuote') {
    const plan = String(args.plan || 'starter') as 'starter' | 'pro' | 'enterprise';
    const offer = getSallyOfferTerms();
    const packageRaw = String(args.packageId || '').trim();
    const billingInterval =
      String(args.billingInterval || args.interval || 'weekly').toLowerCase() === 'annual'
        ? ('annual' as const)
        : ('weekly' as const);
    const additionalSites = Math.max(0, Math.floor(Number(args.additionalSites) || 0));
    const customerId = String(args.customerId || '').trim();
    const businessName = String(args.businessName || '').trim() || 'Restaurant';

    let lines: ReturnType<typeof resolvePackageLine>;
    let products: SaasProductId[] = [];
    let packageId: SaasPackageId | undefined;
    let fareSummary: string;

    if (isSaasPackageId(packageRaw)) {
      packageId = packageRaw;
      const pkg = getPackage(packageId);
      lines = resolvePackageLine(packageId, {
        interval: billingInterval,
        useLaunch: offer.launchActive,
        additionalSites,
      });
      fareSummary = formatFareSummary(pkg);
    } else {
      products = normalizeSaasProductIds(args.products);
      if (!products.length) {
        products = ['phone_agent'];
      }
      const quantities = (args.quantities && typeof args.quantities === 'object'
        ? args.quantities
        : {}) as Partial<Record<SaasProductId, number>>;
      const monthlyArg = Number(args.monthlyPriceGbp);
      const weeklyArg = Number(args.weeklyPriceGbp);
      const priceOverrides: Partial<Record<SaasProductId, number>> = {};
      if (Number.isFinite(monthlyArg) && monthlyArg > 0 && products.includes('phone_agent')) {
        priceOverrides.phone_agent = monthlyArg;
      }
      if (Number.isFinite(weeklyArg) && weeklyArg > 0 && products.includes('phone_agent')) {
        priceOverrides.phone_agent = monthlyEquivalentFromWeekly(weeklyArg);
      }
      lines = resolveProductLines(products, offer.products, quantities, priceOverrides);
      const legacyPkg = products.length === 1 ? getPackage(SAAS_PRODUCTS[products[0]!].packageId) : getPackage('judie_starter');
      fareSummary = formatFareSummary(legacyPkg);
    }

    const monthly = sumMonthly(lines);
    const total = sumQuoteTotal(lines);
    const quoteId = `saas-${Date.now().toString(36)}`;
    const summary = formatProductsSummary(lines);
    const { saveQuoteRecord } = await import('./data-store');
    const quote = {
      id: quoteId,
      customerId: customerId || null,
      customerName: businessName,
      tradeId: 'sync2dine_saas',
      tradeName: 'Sync2Dine SaaS',
      status: 'draft',
      total,
      currency: 'GBP',
      billing: billingInterval === 'annual' ? 'annual' : 'weekly',
      billingInterval,
      plan,
      packageId: packageId || null,
      products,
      fareSummary,
      lines: lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        total: l.total,
        category: l.category,
        productId: l.productId,
        packageId: l.packageId,
        billingInterval: l.billingInterval,
      })),
      items: lines
        .filter((l) => l.category === 'product' || l.category === 'site')
        .map((l) => ({
          productId: l.productId,
          name: l.description,
          quantity: l.quantity,
          price: l.rate,
          total: l.total,
        })),
      extras: lines
        .filter((l) => l.category === 'extra')
        .map((l) => ({ description: l.description, price: l.total })),
      labour: [],
      discount: 0,
      notes: String(args.notes || `Sync2Dine ${plan} - ${summary}`),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      source: 'sally',
    };
    saveQuoteRecord(quote);
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: `SaaS quote ${quoteId}: ${summary} (total GBP ${total})`,
        detail: quote.notes as string,
        aim: 'quote_requested',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      quoteId,
      plan,
      packageId,
      products,
      billingInterval,
      fareSummary,
      lines,
      monthlyPriceGbp: monthly,
      total,
      spokenHint: `I've drafted a Sync2Dine quote for ${summary}, totalling ${total} pounds (${quoteId}).`,
    };
  }

  if (name === 'createSaasContract') {
    const termsGate = requireTermsConfirmed(sessionKey, callId || undefined, args);
    if (termsGate) return termsGate;
    const terms = readTermsConfirmed(sessionKey, callId || undefined);
    const packageRaw = String(args.packageId || terms?.packageId || '').trim();
    if (!isSaasPackageId(packageRaw)) {
      return {
        ok: false,
        error: 'packageId_required',
        spokenHint: 'Which Sync2Dine package did they agree to - Judie, Atmosphere, or Complete?',
      };
    }
    const billingInterval =
      String(args.billingInterval || terms?.billingInterval || 'weekly').toLowerCase() === 'annual'
        ? ('annual' as const)
        : ('weekly' as const);
    const overageRaw = String(args.overageAction || terms?.overageAction || 'continue_bill').trim() as OverageAction;
    const overageAction: OverageAction =
      overageRaw === 'pause_transfer' || overageRaw === 'approval_required' || overageRaw === 'continue_bill'
        ? overageRaw
        : 'continue_bill';
    const restaurantName = String(args.restaurantName || '').trim();
    const contactName = String(args.contactName || '').trim();
    const contactEmail = String(args.contactEmail || '').trim().toLowerCase();
    if (!restaurantName || !contactName || !contactEmail || !contactEmail.includes('@')) {
      return {
        ok: false,
        error: 'contact_required',
        spokenHint: 'I need restaurant name, contact name, and email to create the contract.',
      };
    }
    try {
      const contract = createSaasContract({
        packageId: packageRaw,
        billingInterval,
        overageAction,
        additionalSites: Number(args.additionalSites) || 0,
        customerId: String(args.customerId || '').trim() || undefined,
        organizationId: String(args.organizationId || '').trim() || undefined,
        restaurantName,
        contactName,
        contactEmail,
        contactPhone: String(args.contactPhone || partyPhone || '').trim() || undefined,
        address: String(args.address || '').trim() || undefined,
        notes: String(args.notes || terms?.summary || '').trim() || undefined,
        createdBy: 'sally',
      });
      const customerId = String(args.customerId || '').trim();
      if (customerId) {
        appendCustomerCallActivity({
          customerId,
          summary: `SaaS contract ${contract.id} drafted (${contract.packageId})`,
          detail: contract.signingUrl,
          aim: 'quote_requested',
          type: 'note',
          createdBy: 'sally',
        });
      }
      if (callId) {
        const call = getCallById(callId);
        const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
        saveCall({
          id: callId,
          metadata: {
            ...meta,
            sallyLastContractId: contract.id,
            sallyLastContractUrl: contract.signingUrl,
          },
        });
      }
      return {
        ok: true,
        contractId: contract.id,
        signingUrl: contract.signingUrl,
        packageId: contract.packageId,
        billingInterval: contract.billingInterval,
        fareSummary: contract.fareSummary,
        amountGbp: contract.amountGbp,
        spokenHint: `Contract ready for ${restaurantName}. Send it with sendContract, then checkout after they sign.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'contract_failed',
        spokenHint: 'Could not create the Sync2Dine contract - check the package and contact details.',
      };
    }
  }

  if (name === 'sendContract') {
    const contractId = String(args.contractId || '').trim();
    if (!contractId) {
      return {
        ok: false,
        error: 'contractId_required',
        spokenHint: 'Which contract should I email - create one with createSaasContract first.',
      };
    }
    const contract = getSaasContractById(contractId);
    if (!contract) {
      return {
        ok: false,
        error: 'contract_not_found',
        spokenHint: 'That contract id was not found - create a new one with createSaasContract.',
      };
    }
    const toEmail = String(args.toEmail || contract.contactEmail || '').trim().toLowerCase();
    if (!toEmail || !toEmail.includes('@')) {
      return {
        ok: false,
        error: 'email_required',
        spokenHint: 'What email should I send the signing link to?',
      };
    }
    const { subject, text } = contractEmailBody(contract);
    const delivered = await deliverSallyChannels({
      channel: 'email',
      toEmail,
      toPhone: String(contract.contactPhone || partyPhone || '').trim(),
      emailSubject: subject,
      emailBody: text,
      whatsappBody: text,
    });
    if (!delivered.sentVia.length) {
      return {
        ok: false,
        error: delivered.errors.join(',') || 'delivery_failed',
        contractId,
        signingUrl: contract.signingUrl,
        spokenHint: 'I could not email the contract - confirm their email or escalate.',
        errors: delivered.errors,
      };
    }
    markSaasContractSent(contractId);
    const customerId = String(args.customerId || contract.customerId || '').trim();
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: `Sync2Dine contract ${contractId} emailed`,
        detail: contract.signingUrl,
        aim: 'quote_requested',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      contractId,
      signingUrl: contract.signingUrl,
      sentVia: delivered.sentVia,
      spokenHint: `I've emailed the contract signing link to ${toEmail}. Once they sign, use sendStripeCheckoutLink for payment.`,
    };
  }

  if (name === 'sendStripeCheckoutLink') {
    const termsGate = requireTermsConfirmed(sessionKey, callId || undefined, args);
    if (termsGate) return termsGate;
    const channel = String(args.channel || args.sendVia || '').toLowerCase() as 'email' | 'whatsapp' | 'both';
    if (!['email', 'whatsapp', 'both'].includes(channel)) {
      return {
        ok: false,
        error: 'channel_required',
        spokenHint: 'Should I email, WhatsApp, or both for the payment link?',
      };
    }
    const contractIdArg = String(args.contractId || '').trim();
    let signedContract;
    try {
      signedContract = assertContractSignedForCheckout({
        contractId: contractIdArg || undefined,
        organizationId: String(args.organizationId || '').trim() || undefined,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'contract_not_signed',
        spokenHint:
          'They need a signed Sync2Dine contract before checkout - create and send the contract, then try again after they sign.',
      };
    }
    const organizationId = String(args.organizationId || signedContract.organizationId || '').trim();
    if (!organizationId) {
      return {
        ok: false,
        error: 'organizationId_required',
        spokenHint: 'Which organisation should get the Stripe checkout link? Provision the restaurant first if needed.',
      };
    }
    try {
      const { createCheckoutSessionForOrg } = await import('./stripe-service');
      const { getOrganizationById } = await import('./organizations');
      const org = getOrganizationById(organizationId);
      const toEmail = String(args.toEmail || signedContract.contactEmail || org?.contactEmail || '').trim();
      const toPhone = String(args.toPhone || partyPhone || signedContract.contactPhone || org?.contactPhone || '').trim();
      const quoteId = String(args.quoteId || '').trim();
      const stripeInterval = signedContract.billingInterval === 'annual' ? ('year' as const) : ('week' as const);
      let lineItems: Array<{
        description: string;
        unitAmountGbp: number;
        quantity?: number;
        recurring?: boolean;
        interval?: 'week' | 'month' | 'year';
      }> = resolvePackageLine(signedContract.packageId, {
        interval: signedContract.billingInterval,
        useLaunch: signedContract.useLaunch,
        additionalSites: signedContract.additionalSites,
      })
        .map((l) => ({
          description: l.description,
          unitAmountGbp: l.rate,
          quantity: l.quantity,
          recurring: l.category !== 'extra',
          interval: l.unit === 'year' ? 'year' : l.unit === 'week' ? 'week' : stripeInterval,
        }))
        .filter((l) => l.unitAmountGbp > 0);

      if (!lineItems.length && quoteId) {
        const { getDataStore } = await import('./data-store');
        const store = getDataStore();
        const quote = (store.quotes as Array<Record<string, unknown>>).find((q) => String(q.id) === quoteId);
        if (quote) {
          const qInterval =
            String(quote.billingInterval || quote.billing || 'weekly').toLowerCase() === 'annual' ? 'annual' : 'weekly';
          const qPackage = String(quote.packageId || '').trim();
          if (isSaasPackageId(qPackage)) {
            lineItems = resolvePackageLine(qPackage, {
              interval: qInterval,
              useLaunch: getSallyOfferTerms().launchActive,
              additionalSites: Number(quote.additionalSites) || 0,
            }).map((l) => ({
              description: l.description,
              unitAmountGbp: l.rate,
              quantity: l.quantity,
              recurring: l.category !== 'extra',
              interval: l.unit === 'year' ? 'year' : 'week',
            }));
          }
        }
      }

      const url = await createCheckoutSessionForOrg(organizationId, {
        metadata: {
          sallySession: sessionKey,
          customerEmail: toEmail || org?.contactEmail || '',
          contractId: signedContract.id,
          ...(quoteId ? { quoteId } : {}),
        },
        lineItems,
      });
      const msg = [
        'Your Sync2Dine payment link is ready.',
        `Pay securely here: ${url}`,
        'Once paid, your restaurant account stays live on the plan we discussed.',
      ].join('\n');
      const delivered = await deliverSallyChannels({
        channel,
        toEmail,
        toPhone,
        emailSubject: 'Sync2Dine - complete your subscription',
        emailBody: msg,
        whatsappBody: msg,
      });
      if (!delivered.sentVia.length) {
        return {
          ok: false,
          error: delivered.errors.join(',') || 'delivery_failed',
          checkoutUrl: url,
          organizationId,
          contractId: signedContract.id,
          spokenHint:
            'I created the payment link but could not send it - ask for another email or WhatsApp number, or escalate.',
          errors: delivered.errors,
        };
      }
      const customerId = String(args.customerId || signedContract.customerId || '').trim();
      if (customerId) {
        appendCustomerCallActivity({
          customerId,
          summary: `Stripe checkout sent via ${delivered.sentVia.join(' + ')}`,
          detail: url,
          aim: 'quote_requested',
          type: 'note',
          createdBy: 'sally',
        });
      }
      if (callId) {
        const call = getCallById(callId);
        const meta = (call?.metadata as Record<string, unknown> | undefined) || {};
        saveCall({
          id: callId,
          metadata: {
            ...meta,
            sallyCheckoutUrl: url,
            sallyCheckoutSentVia: delivered.sentVia,
            sallyCheckoutAt: new Date().toISOString(),
            sallyCheckoutContractId: signedContract.id,
            ...(quoteId ? { sallyCheckoutQuoteId: quoteId } : {}),
          },
        });
      }
      return {
        ok: true,
        checkoutUrl: url,
        organizationId,
        contractId: signedContract.id,
        quoteId: quoteId || undefined,
        sentVia: delivered.sentVia,
        errors: delivered.errors,
        spokenHint: `I've ${delivered.sentVia.includes('email') && delivered.sentVia.includes('whatsapp') ? 'emailed and WhatsAppd' : delivered.sentVia.includes('email') ? 'emailed' : 'WhatsAppd'} the payment link. They can open it now while we stay on the line.`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'stripe_failed',
        spokenHint: 'Could not create a Stripe checkout link - check Stripe is configured for that organisation.',
      };
    }
  }
  if (name === 'bookOnboarding') {
    const scheduledAt = String(args.scheduledAt || '').trim();
    if (!scheduledAt) {
      return { ok: false, error: 'scheduledAt_required', spokenHint: 'When should onboarding happen?' };
    }
    const customerId = String(args.customerId || '').trim();
    const organizationId = String(args.organizationId || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const detail = `Onboarding booked ${scheduledAt}${organizationId ? ` for org ${organizationId}` : ''}${args.notes ? ` — ${args.notes}` : ''}`;
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: detail,
        detail,
        aim: 'appointment_booked',
        type: 'note',
        createdBy: 'sally',
      });
    }
    if (phone) {
      enqueueOutboundCall({
        to: phone,
        template: 'lead_callback',
        status: 'queued',
        scheduledAt,
        context: {
          customerId: customerId || undefined,
          aim: 'onboarding',
          agentPersona: SALLY_PERSONA,
          brief: detail,
          source: 'sally_book_onboarding',
          organizationId: organizationId || undefined,
        },
      });
    }
    return {
      ok: true,
      scheduledAt,
      organizationId: organizationId || null,
      spokenHint: `Onboarding booked for ${scheduledAt}.`,
    };
  }

  if (name === 'requestGoogleReview') {
    const customerId = String(args.customerId || '').trim();
    const channel = String(args.channel || 'note_only');
    const url = String(args.googleReviewUrl || process.env.GOOGLE_REVIEW_URL || '').trim()
      || 'https://g.page/r/ — ask staff for the Google review link';
    const message = `We'd love a Google review if you're happy with Sync2Dine: ${url}`;
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: 'Google review requested',
        detail: message,
        aim: 'satisfaction',
        type: 'note',
        createdBy: 'sally',
      });
    }
    return {
      ok: true,
      googleReviewUrl: url,
      channel,
      message,
      spokenHint: channel === 'note_only'
        ? `Review ask ready: ${url}`
        : `Ask them for a Google review via ${channel}: ${url}`,
    };
  }

  if (name === 'proposePlanUpsell') {
    const organizationId = String(args.organizationId || '').trim();
    const targetPlan = String(args.targetPlan || 'pro') as 'pro' | 'enterprise';
    if (!organizationId) {
      return { ok: false, error: 'organizationId_required', spokenHint: 'Which organisation are we upselling?' };
    }
    const { getOrganizationById, updateOrganization } = await import('./organizations');
    const org = getOrganizationById(organizationId);
    if (!org) {
      return { ok: false, error: 'org_not_found', spokenHint: 'I could not find that organisation.' };
    }
    updateOrganization(organizationId, { plan: targetPlan, notes: `${org.notes || ''}\nSally proposed upsell to ${targetPlan}`.trim() });
    let checkoutUrl: string | undefined;
    if (args.createCheckout === true || args.createCheckout === 'true') {
      try {
        const { createCheckoutSessionForOrg } = await import('./stripe-service');
        checkoutUrl = await createCheckoutSessionForOrg(organizationId);
      } catch {
        /* optional */
      }
    }
    return {
      ok: true,
      organizationId,
      fromPlan: org.plan,
      targetPlan,
      checkoutUrl: checkoutUrl || null,
      spokenHint: checkoutUrl
        ? `Proposed upgrade to ${targetPlan}. Checkout: ${checkoutUrl}`
        : `Proposed upgrade from ${org.plan} to ${targetPlan}.`,
    };
  }

  if (name === 'chaseUnpaidInvoice') {
    const customerId = String(args.customerId || '').trim();
    const organizationId = String(args.organizationId || '').trim();
    const phone = String(args.phone || partyPhone || '').trim();
    const channel = String(args.channel || 'callback');
    const notes = String(args.notes || 'Past-due Sync2Dine invoice chase').trim();
    if (customerId) {
      appendCustomerCallActivity({
        customerId,
        summary: `Invoice chase (${channel})`,
        detail: notes,
        aim: 'past_due',
        type: 'note',
        createdBy: 'sally',
      });
    }
    if (channel === 'callback' && phone) {
      enqueueOutboundCall({
        to: phone,
        template: 'payment_reminder',
        status: 'queued',
        context: {
          customerId: customerId || undefined,
          organizationId: organizationId || undefined,
          aim: 'past_due',
          agentPersona: SALLY_PERSONA,
          brief: notes,
          source: 'sally_chase_unpaid',
        },
      });
    }
    return {
      ok: true,
      channel,
      organizationId: organizationId || null,
      spokenHint: `I've logged the unpaid chase${channel === 'callback' && phone ? ' and queued a payment reminder call' : ''}.`,
    };
  }

  return { ok: false, error: `unknown_sally_tool:${name}` };
}

/** Re-queue CRM leads marked needs_retry whose nextFollowUp/retry window has elapsed. */
export function enqueueSallyRetryLeads(): number {
  const settings = getAgentSettings();
  const maxAttempts = settings.callQueueMaxAttempts ?? 3;
  const retryMin = settings.callQueueRetryMinutes ?? 60;
  const store = getDataStore();
  const customers = (store.customers as Array<Record<string, unknown>>) || [];
  let queued = 0;
  const now = Date.now();
  for (const c of customers) {
    if (String(c.callQueueStatus || '') !== 'needs_retry') continue;
    const attempts = Number(c.callAttemptCount ?? 0);
    if (attempts >= maxAttempts) continue;
    const phone = String(c.phone || '').trim();
    if (!phone) continue;
    const lastAt = c.lastCallAt ? Date.parse(String(c.lastCallAt)) : NaN;
    const nextAt = c.nextFollowUp ? Date.parse(String(c.nextFollowUp)) : NaN;
    const readyAt = Number.isFinite(nextAt)
      ? nextAt
      : (Number.isFinite(lastAt) ? lastAt + retryMin * 60_000 : now);
    if (readyAt > now) continue;
    const already = (store.outboundQueue || []).some((j) =>
      String(j.status) === 'queued'
      && String((j.context as Record<string, unknown> | undefined)?.customerId || '') === String(c.id)
    );
    if (already) continue;
    enqueueOutboundCall({
      to: phone,
      template: 'lead_callback',
      status: 'queued',
      context: {
        customerId: String(c.id),
        company: String(c.name || ''),
        aim: 'sales_outreach',
        agentPersona: SALLY_PERSONA,
        brief: `Auto-retry (${attempts + 1}/${maxAttempts}) for ${c.name || phone}`,
        source: 'sally_needs_retry',
      },
    });
    saveCustomerRecord({ ...c, callQueueStatus: 'queued' });
    queued += 1;
  }
  if (queued) syncData({ customers: store.customers });
  return queued;
}
