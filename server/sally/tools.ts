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
import {
  SALLY_PERSONA,
  SALLY_EXCLUSIVE_TOOLS,
  SALLY_TOOL_NAMES,
} from './offer';

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

export function pickPhoneTools(...names: string[]) {
  return PHONE_TOOLS.filter((t) => names.includes(t.function.name));
}

export const SALLY_CRM_NOTE_TOOL = {
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

export const SALLY_WEB_BLOCKED_TOOLS = new Set([
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

export { SALLY_SALES_OS } from './sales-os';
