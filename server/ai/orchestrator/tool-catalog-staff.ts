import {
  isValidServerTradeId,
  TRADE_EXTRACTABLE_FIELDS,
  TRADE_PLAYBOOK_PHASES,
  TRADE_REGISTRY,
  TRADE_IDS_CSV,
} from '../../trade-registry';
import { getDataStore } from '../../data-store';
import {
  assessExtraFromVision,
  assessProgressFromVision,
  resolvePhotoUrlsFromContext,
} from '../vision-handler';
import { canExecuteActionForRole, filterActionsForRole, getRequestRole, isGenericTool } from '../../role-permissions';
import { resolveSystemPrompt } from '../orchestrator-prompt';
import {
  executeCustomerTool,
  executeServerReadTool,
  executeUpdateLeadStatus,
  SERVER_READ_TOOLS,
} from '../../orchestrator-tool-exec';
import { PHONE_TOOLS, executePhoneTool, PHONE_AUTO_ACTIONS } from '../../phone-tools';
import {
  RESTAURANT_TOOL_DEFS,
  RESTAURANT_TOOL_NAMES,
  executeRestaurantTool,
} from '../restaurant-ai-tools';
import type {
  OrchestratorAction,
  OrchestratorMessage,
  OrchestratorMode,
  OrchestratorRequest,
  OrchestratorResult,
} from '../orchestrator-types';
import { PLANNING_ACTION_NAMES, PLANNING_TOOLS } from '../planning-tools';
import { GAP_AUTO_ACTIONS, GAP_CLOSING_TOOLS } from '../gap-closing-tools';
import { expandFacadeCall, FACADE_TOOLS, FACADE_WEB_STAFF_MODES, isFacadeEnabled } from '../tool-facade';
import {
  buildClarifyIntro,
  classifyTaskIntent,
  isProceedMessage,
  shouldClarifyBeforeExecute,
} from '../../task-planner';


export function hasPlanningContext(body?: OrchestratorRequest): boolean {
  if (!body) return false;
  if (body.orchestratorMode === 'planning') return true;
  if (body.planningApplicationContext?.id) return true;
  const route = body.staffContext?.route ?? '';
  if (route.startsWith('/planning')) return true;
  return Boolean(body.staffContext?.planningApplicationId);
}

export const MAX_TOOL_ROUNDS = 3;

/** Generic data/navigation primitives — available to all roles; dataPolicy enforces scope. */

export const STAFF_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'detectTrades',
      description: 'Detect which construction trades apply from the user message and context',
      parameters: {
        type: 'object',
        properties: {
          trades: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tradeId: {
                  type: 'string',
                  description: `Trade id. One of: ${TRADE_IDS_CSV}`,
                },
                confidence: { type: 'number' },
                reason: { type: 'string' },
              },
              required: ['tradeId', 'confidence'],
            },
          },
        },
        required: ['trades'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'proposeQuoteFields',
      description: 'Suggest wizard field values for a specific trade quote',
      parameters: {
        type: 'object',
        properties: {
          tradeId: { type: 'string' },
          fields: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                value: {},
                confidence: { type: 'number' },
                reason: { type: 'string' },
              },
            },
          },
        },
        required: ['tradeId', 'fields'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'linkCustomer',
      description: 'Match or propose customer details and set interested trades',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          interestedTrades: { type: 'array', items: { type: 'string' } },
          isNew: { type: 'boolean' },
        },
        required: ['interestedTrades'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'startQuote',
      description: 'Navigate staff to quote wizard for a trade and customer',
      parameters: {
        type: 'object',
        properties: {
          tradeId: { type: 'string' },
          customerId: { type: 'string' },
          jobGroupId: { type: 'string' },
          prefillFields: { type: 'object' },
        },
        required: ['tradeId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'saveCustomer',
      description: 'Create or update a customer record in CRM with name, contact details, interested trades, and preferred language pack',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          interestedTrades: { type: 'array', items: { type: 'string' } },
          preferredLanguage: {
            type: 'string',
            description: 'Saved language pack code: en, sq, uk, zh, es, pl, or fa',
          },
          isNew: { type: 'boolean' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'saveQuote',
      description: 'Save a full quote with line items, labour, extras, and total directly to the app',
      parameters: {
        type: 'object',
        properties: {
          tradeId: { type: 'string' },
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          status: { type: 'string', enum: ['indicative', 'draft', 'awaiting_approval', 'approved', 'rejected', 'sent', 'accepted', 'expired'] },
          total: { type: 'number' },
          discount: { type: 'number' },
          openQuote: { type: 'boolean' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                quantity: { type: 'number' },
                price: { type: 'number' },
                total: { type: 'number' },
              },
            },
          },
          labour: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                rate: { type: 'number' },
                total: { type: 'number' },
                rateType: { type: 'string' },
              },
            },
          },
          extras: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                price: { type: 'number' },
              },
            },
          },
          wizardAnswers: { type: 'object' },
          prefillFields: { type: 'object' },
        },
        required: ['customerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'updateQuote',
      description: 'Update an existing quote line items, labour, extras, or total',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          items: { type: 'array', items: { type: 'object' } },
          labour: { type: 'array', items: { type: 'object' } },
          extras: { type: 'array', items: { type: 'object' } },
          total: { type: 'number' },
          status: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'convertQuoteToProject',
      description:
        'Convert an accepted/won quote into a live project. Use when customer has gone ahead — never use writeData create on projects.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string', description: 'Quote id if known' },
          customerName: { type: 'string', description: 'Customer name to find quote (e.g. Olivia Martin)' },
          markQuoteAccepted: { type: 'boolean', description: 'Mark quote accepted before creating project' },
          withPaymentPlan: { type: 'boolean', description: 'Apply default 10/40/30/20 payment stages' },
        },
      },
    },
  },
];

