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
import { resolveCallbackIso } from '../callback-time';

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
  {
    type: 'function' as const,
    function: {
      name: 'captureLead',
      description: 'Capture new sales lead details and create a customer record with status lead',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          postcode: { type: 'string' },
          interestedTrades: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          budget: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
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
      description: 'Pre-screen a recruitment candidate during a phone call',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          desiredRole: { type: 'string' },
          experience: { type: 'string' },
          availability: { type: 'string' },
          location: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
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
      description: 'Schedule a recruitment interview for a candidate',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          candidateName: { type: 'string' },
          jobId: { type: 'string' },
          jobTitle: { type: 'string' },
          scheduledDate: { type: 'string' },
          scheduledTime: { type: 'string' },
          type: { type: 'string', enum: ['phone', 'video', 'in-person'] },
          location: { type: 'string' },
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
      description: 'Create or update a recruitment candidate record',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          desiredRole: { type: 'string' },
          source: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name'],
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
        'Return the restaurant menu for Sync2Dine takeaway ordering (categories, item names, prices, UK 14 allergen contains/may-contain). Use before placing a food order.',
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
      name: 'placeFoodOrder',
      description:
        'Place a takeaway food order for collection, delivery, or table. Confirm items and total with the caller before calling. For collection/delivery: ask cash or card (pay on arrival) and pass paymentStatus cash or card — never paid. For delivery, pass postcode (and address) after checkDeliveryArea succeeds. For meal deals (getMenu items with a deal object), pass qty plus dealChoices — one object per unit with main/side/drink (or whatever roles the deal lists). The kitchen receives expanded component lines.',
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
