import {
  appendCustomerCallActivity,
  appendProjectMessageRecord,
  enqueueOutboundCall,
  getDataStore,
  getRequestOrgId,
  lookupContactByPhone,
  normalizePhoneExport,
  saveCall,
  saveCustomerRecord,
  saveQuoteRecord,
  saveRecruitmentCandidate,
  saveRecruitmentInterview,
  syncData,
} from '../../data-store';
import type { CallIntent, OutboundCampaignTemplate } from '../../telephony/types';
import type { OrchestratorRequest } from '../../orchestrator-types';
import { sendToStaffCynthiaInternal } from '../../cynthia-routes';
import { actionRequiresConfirmation } from '../../action-registry';
import { formatSpokenGbp } from '../spoken-money';
import { resolvePhoneCallerIdentity } from '../phone-auth';
import { ensureEnglishForCustomerSend } from '../../outbound-english-guard';
import { resolveTransferDestination, resolveTransferNumber } from '../transfer-numbers';
import { listMenuItemsForOrg } from '../../menu-catalog';
import {
  cancelReservation,
  checkTableAvailability,
  createReservation,
  listReservations,
  updateReservation,
} from '../../reservations-store';
import { executeRestaurantTool, RESTAURANT_TOOL_NAMES } from '../../restaurant-ai-tools';
import { SCORE_INTERVIEW_TOOL } from '../../sally/recruitment-interview';

const CAPTURE_LEAD_PROPERTIES = {
  name: {
    type: 'string',
    description: 'Restaurant or venue trading name — never the person on the line',
  },
  contactName: {
    type: 'string',
    description: 'Point of contact — owner, manager, or person spoken to',
  },
  phone: { type: 'string' },
  email: { type: 'string' },
  address: { type: 'string' },
  postcode: { type: 'string' },
  venueType: { type: 'string', description: 'takeaway | pub | restaurant | cafe | bar | multi_site' },
  openingHours: { type: 'string' },
  hasKitchen: { type: 'boolean' },
  interestedTrades: { type: 'array', items: { type: 'string' } },
  scope: { type: 'string' },
  budget: { type: 'number' },
  notes: { type: 'string' },
} as const;

function captureLeadTool(required: readonly string[], opts?: { sales?: boolean }) {
  const sales = opts?.sales === true || required.includes('contactName');
  return {
    type: 'function' as const,
    function: {
      name: 'captureLead',
      description: sales
        ? 'Save a CRM sales lead. `name` is the restaurant/venue trading name (from the account — never the person on the line). Pass `contactName` only if you genuinely learn who you are speaking to — never invent a name and never block the call to collect one.'
        : 'Capture a CRM lead. `name` is the restaurant/venue trading name (not the person). `contactName` is the point of contact when known. For diner bag-name, pass the guest as `name`.',
      parameters: {
        type: 'object',
        properties: CAPTURE_LEAD_PROPERTIES,
        required: [...required],
      },
    },
  };
}

/** Sally sales overlay — venue trading name required; contactName optional when volunteered. */
export const SALES_CAPTURE_LEAD_TOOL = captureLeadTool(['name'], { sales: true });

export const PHONE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'classifyCallIntent',
      description: 'Classify why the caller is calling: new_sales_lead, existing_customer, recruitment, supplier, complaint, general, after_hours',
      parameters: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['new_sales_lead', 'existing_customer', 'recruitment', 'supplier', 'complaint', 'general', 'after_hours'],
          },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['intent'],
      },
    },
  },
  captureLeadTool(['name']),
  {
    type: 'function' as const,
    function: {
      name: 'bookCallback',
      description: 'Schedule a staff callback. For staff callers, callbackTo must be the customer E.164 phone (not a name or CRM id).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string', description: 'Legacy alias for callbackTo' },
          callbackTo: { type: 'string', description: 'Customer phone in E.164 e.g. +447576442345' },
          reason: { type: 'string' },
          preferredTime: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'saveQuote',
      description: 'Create or update an indicative quote in CRM during a staff phone call',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          tradeName: { type: 'string' },
          total: { type: 'number' },
          notes: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendCustomerMessage',
      description: 'Send a WhatsApp (or SMS fallback) message to a customer. Fail closed if messaging is not configured — never invent success.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Customer phone E.164' },
          message: { type: 'string' },
          customerId: { type: 'string' },
          customerName: { type: 'string' },
        },
        required: ['to', 'message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scheduleAppointment',
      description: 'Book a site survey or appointment for a customer',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          type: { type: 'string', enum: ['site_survey', 'consultation', 'follow_up'] },
          preferredDate: { type: 'string' },
          preferredTime: { type: 'string' },
          address: { type: 'string' },
          tradeId: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'screenCandidate',
      description:
        'Write down what you have learned about a candidate mid-interview, like a recruiter taking notes. Safe to call more than once as the call goes on — later calls update the same record.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          desiredRole: { type: 'string' },
          experience: {
            type: 'string',
            description: 'CV walkthrough in their own words: roles, what they sold, to whom, targets/numbers, why they left, gaps',
          },
          fieldComfort: {
            type: 'string',
            description: 'Their real evidence of walking into new places cold / door-to-door / face-to-face approach',
          },
          outboundExperience: {
            type: 'string',
            description: 'Outbound phone, cold calling or hospitality experience',
          },
          rightToWork: { type: 'string' },
          notice: { type: 'string', description: 'Notice period / earliest start' },
          salaryExpectation: { type: 'string', description: 'What they say they want to earn — their words, never ours' },
          travelOk: { type: 'string', description: 'Can they cover Woking / Surrey and get into London' },
          availability: { type: 'string' },
          location: { type: 'string' },
          drivingLicence: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string', description: 'Anything else a recruiter would file' },
          jobId: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bookInterview',
      description:
        'Book a candidate in for their face-to-face. For the sales role this is type in-person at the Woking office to meet the founder. Only book when you are recommending hire and they gave you a day and a rough time.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          candidateName: { type: 'string' },
          jobId: { type: 'string' },
          jobTitle: { type: 'string' },
          scheduledDate: { type: 'string', description: 'Day they agreed, e.g. 2026-09-15 or "Thursday"' },
          scheduledTime: { type: 'string', description: 'Rough time they agreed, e.g. 14:00 or "early afternoon"' },
          type: { type: 'string', enum: ['phone', 'video', 'in-person'] },
          location: { type: 'string', description: 'Leave blank for the default hiring office' },
          notes: { type: 'string' },
        },
        required: ['scheduledDate', 'scheduledTime', 'type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logCandidate',
      description:
        'Create or update a candidate record. Use it during the call to save details as you get them — it merges into the same profile, so nothing is lost if the call drops.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          desiredRole: { type: 'string' },
          source: { type: 'string' },
          location: { type: 'string' },
          experience: { type: 'string', description: 'CV walkthrough so far' },
          fieldComfort: { type: 'string', description: 'Evidence of cold face-to-face approach' },
          rightToWork: { type: 'string' },
          notice: { type: 'string' },
          salaryExpectation: { type: 'string' },
          travelOk: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  SCORE_INTERVIEW_TOOL,
  {
    type: 'function' as const,
    function: {
      name: 'setHiringInstruction',
      description:
        'Owner line only. Save what the founder just told you about hiring so it steers your later candidate screens (what to ask, what to say, who to prioritise), and/or set where face-to-face interviews happen. Read it back to confirm.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'The founder’s instruction in plain words, e.g. "push harder on door-to-door evidence"',
          },
          interviewLocation: {
            type: 'string',
            description: 'Where candidates come in, e.g. "our Woking office, 12 High Street"',
          },
          clearInstruction: { type: 'boolean', description: 'True to wipe the standing instruction' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'queueRecruitmentCall',
      description:
        'Owner line only. Queue yourself an outbound hiring call from the Sync2Dine sales line — either a full phone screen or a call purely to arrange a face-to-face.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Candidate UK number in E.164, e.g. +447700900123' },
          candidateId: { type: 'string' },
          name: { type: 'string' },
          purpose: {
            type: 'string',
            enum: ['screen', 'arrange_interview'],
            description: 'screen = full HR interview, arrange_interview = book the face-to-face only',
          },
          note: { type: 'string', description: 'Anything specific to cover on that call' },
        },
        required: ['phone'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'transferToHuman',
      description:
        'Warm-transfer the live call to a human: put the caller on hold, dial staff, brief them, then connect. Use takeMessage if they only want a message.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          department: { type: 'string', enum: ['sales', 'projects', 'recruitment', 'accounts', 'general'] },
          takeMessage: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'enqueueOutboundCall',
      description: 'Queue an outbound call for later dialling',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          template: {
            type: 'string',
            enum: ['quote_chase', 'payment_reminder', 'appointment_reminder', 'recruitment_screening', 'satisfaction_check', 'lead_callback'],
          },
          context: { type: 'object' },
          scheduledAt: { type: 'string' },
        },
        required: ['to', 'template'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'captureMessage',
      description: 'Take a message from caller for a specific department or person',
      parameters: {
        type: 'object',
        properties: {
          callerName: { type: 'string' },
          callerPhone: { type: 'string' },
          department: { type: 'string' },
          message: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendToStaffCynthia',
      description:
        'When staff say "send it to me", "pop it in the chat", or "send me the details", push a rich card (address, amount, phone, summary) into their Cynthia APK chat so they can open it and call the customer.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Card title e.g. Quote ready — Mrs Smith' },
          customerName: { type: 'string' },
          phone: { type: 'string', description: 'Customer phone for Call button' },
          address: { type: 'string' },
          amount: { type: 'number', description: 'Quote or job amount in GBP' },
          summary: { type: 'string' },
          notes: { type: 'string' },
          quoteId: { type: 'string' },
          projectId: { type: 'string' },
          customerId: { type: 'string' },
          staffUserId: { type: 'string', description: 'Staff user id if known' },
          staffPhone: { type: 'string', description: 'Staff phone to resolve inbox' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'placeOutboundCall',
      description:
        'Place or queue an outbound customer call. Prefer payment_reminder when chasing an outstanding invoice. Require spoken confirmation before calling.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          template: {
            type: 'string',
            enum: ['quote_chase', 'payment_reminder', 'appointment_reminder', 'recruitment_screening', 'satisfaction_check', 'lead_callback'],
          },
          confirmed: { type: 'boolean', description: 'Must be true after the caller confirmed verbally' },
          context: { type: 'object' },
          scheduledAt: { type: 'string' },
        },
        required: ['to', 'template', 'confirmed'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'deliverCallFollowUp',
      description:
        'Fulfil a promised follow-up after the call: always send a staff Cynthia card; if the customer has portal/app access deliver customerMessage there; otherwise schedule a callback. Never claim success without tool success.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          customerMessage: { type: 'string' },
          customerId: { type: 'string' },
          projectId: { type: 'string' },
          assignedStaffUserId: { type: 'string' },
          confirmed: { type: 'boolean' },
          callback: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
              scheduledAt: { type: 'string' },
              template: { type: 'string', enum: ['lead_callback', 'payment_reminder', 'quote_chase'] },
              to: { type: 'string' },
            },
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getMenu',
      description:
        'Return the restaurant menu for validation / meal-deal choices. Do NOT recite the whole menu unless the caller asks what you have. Prefer asking what they want. Never read prices aloud — names only when listing. Order total is spoken from placeFoodOrder spokenTotal at the end.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional menu category filter e.g. mains, sides, drinks' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'checkDeliveryArea',
      description:
        'Check whether a UK postcode is inside the restaurant delivery area (configured postcode prefixes). Call before placeFoodOrder when orderType is delivery.',
      parameters: {
        type: 'object',
        properties: {
          postcode: { type: 'string', description: 'Full or partial UK postcode from the caller' },
        },
        required: ['postcode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getDeliveryAreas',
      description:
        'List the postcode beginnings this restaurant delivers to, plus any delivery fee / minimum notes. Use when the caller asks where you deliver.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'lookupCallerOrders',
      description:
        'Look up recent kitchen orders for this caller (by phone). MUST call this when they say they already ordered, want to change/add to an order, or ask if an order went through. Never invent "did not go through" — only say that if this tool returns no matching open orders.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max orders to return (default 5)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'placeFoodOrder',
      description:
        'Place a takeaway food order for collection, delivery, or table. Call this as soon as the caller answers cash or card — do not stall. Cash/card is pay-on-arrival metadata only (never charge on the phone; never paymentStatus paid). Always pass customerName (asked earlier) and customerPhone. After success, speak spokenHint: it includes spokenTotal, ready-in time (~40 minutes), and collection counter instructions. For delivery, pass postcode (and address) after checkDeliveryArea. For meal deals, pass qty plus dealChoices.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          orderType: { type: 'string', enum: ['collection', 'delivery', 'table'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                qty: { type: 'number' },
                price: { type: 'number' },
                dealChoices: {
                  type: 'array',
                  description:
                    'Required for meal deals: one entry per qty unit. Each entry maps role → chosen dish name (e.g. {main, side, drink}).',
                  items: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                  },
                },
              },
              required: ['name'],
            },
          },
          total: { type: 'number' },
          deliveryAddress: { type: 'string' },
          postcode: { type: 'string', description: 'UK postcode required for delivery orders' },
          specialName: {
            type: 'string',
            description: 'Named customer special applied on this order (from their CRM specialName)',
          },
          notes: { type: 'string' },
          customerAllergies: {
            type: 'string',
            description: 'Spoken allergy summary e.g. peanuts, sesame — ask once before placing',
          },
          allergyConfirmed: {
            type: 'boolean',
            description: 'True after you asked about allergies (even if none)',
          },
          paymentStatus: {
            type: 'string',
            enum: ['unpaid', 'cash', 'card'],
            description:
              'For collection/delivery: pass "cash" or "card" after asking how they will pay on arrival (order stays unpaid). Do not use "paid" on phone. If omitted, defaults to cash at the door.',
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'checkTableAvailability',
      description: 'Check table availability for a party size at a date/time. Use when caller wants to book a table.',
      parameters: {
        type: 'object',
        properties: {
          startsAt: { type: 'string', description: 'ISO datetime or spoken slot converted e.g. 2026-07-17T19:00:00Z' },
          partySize: { type: 'number' },
        },
        required: ['startsAt', 'partySize'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bookTable',
      description: 'Book a table reservation after confirming party size and time. Links this phone call automatically.',
      parameters: {
        type: 'object',
        properties: {
          startsAt: { type: 'string' },
          partySize: { type: 'number' },
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['startsAt', 'partySize'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'updateReservation',
      description: 'Change an existing table reservation (time, party size, notes). Lookup by reservationId or customer phone.',
      parameters: {
        type: 'object',
        properties: {
          reservationId: { type: 'string' },
          customerPhone: { type: 'string' },
          startsAt: { type: 'string' },
          partySize: { type: 'number' },
          notes: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancelReservation',
      description: 'Cancel a table reservation by id or customer phone for upcoming bookings.',
      parameters: {
        type: 'object',
        properties: {
          reservationId: { type: 'string' },
          customerPhone: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'listReservations',
      description: 'List reservations for a day or phone number (staff/agent lookup).',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD' },
          phone: { type: 'string' },
        },
      },
    },
  },
];

export const PHONE_AUTO_ACTIONS = new Set([
  'classifyCallIntent',
  'captureLead',
  'bookCallback',
  'scheduleAppointment',
  'screenCandidate',
  'bookInterview',
  'logCandidate',
  'scoreInterview',
  'setHiringInstruction',
  'queueRecruitmentCall',
  'transferToHuman',
  'enqueueOutboundCall',
  'placeOutboundCall',
  'captureMessage',
  'sendToStaffCynthia',
  'deliverCallFollowUp',
  'escalateToStaff',
  'saveCustomer',
  'saveQuote',
  'sendCustomerMessage',
  'briefInbox',
  'listRecentEmails',
  'getEmailThread',
  'composeSalesEmail',
  'readDraftAloud',
  'sendEmailReply',
  'scheduleSalesFollowUp',
  'getMenu',
  'lookupCallerOrders',
  'placeFoodOrder',
  'checkDeliveryArea',
  'getDeliveryAreas',
  'checkTableAvailability',
  'bookTable',
  'updateReservation',
  'cancelReservation',
  'listReservations',
  'upsertMenuItem',
  'deleteMenuItem',
  'listOrders',
  'markOrderPaid',
  'updateOrderStatus',
]);
