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

export const CUSTOMER_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'lookupQuote',
      description: 'Find quote summaries by quote ID or customer ID',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'lookupProjectStatus',
      description: 'Find active project status by project ID or customer ID',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          customerId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getPortalLink',
      description: 'Get customer portal link for a specific project',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'escalateToStaff',
      description: 'Escalate customer concern to office staff for follow-up',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'navigateTo',
      description: "Change the customer's current page in the app. Allowed routes: /projects, /changes, /portfolio, /portal/{token}",
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['route'],
      },
    },
  },
];

export const LEAD_CYCLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'getTeamPerformance',
      description: 'Get office team roster with sales performance metrics (managers and admins only)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'searchLeads',
      description: 'Search CRM leads by name, status, source, or notes',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          status: { type: 'string', enum: ['lead', 'quoted', 'won', 'lost'] },
          source: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'updateLeadStatus',
      description: 'Update a lead/customer pipeline status (lead, quoted, won, lost)',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          status: { type: 'string', enum: ['lead', 'quoted', 'won', 'lost'] },
          note: { type: 'string' },
        },
        required: ['customerId', 'status'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logFollowUp',
      description: 'Log a follow-up note and schedule next contact for a lead',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          note: { type: 'string' },
          nextFollowUp: { type: 'string', description: 'ISO date for next follow-up' },
        },
        required: ['customerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getLeadBrief',
      description:
        'Load a lead/customer brief: status, notes, and recent conversation activities with aims. Use before calling or when discussing a lead so you do not invent history.',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          phone: { type: 'string' },
          query: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'addLeadNote',
      description: 'Append a conversation note (with optional aim and disposition) onto a CRM lead for staff and future Cynthia calls',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          detail: { type: 'string' },
          aim: {
            type: 'string',
            enum: ['discovery', 'demo_book', 'trial_followup', 'upgrade', 'past_due', 'win_back', 'callback', 'quote_chase', 'other'],
          },
          outcome: { type: 'string' },
          disposition: {
            type: 'string',
            enum: [
              'no_answer',
              'busy',
              'voicemail',
              'answered_interested',
              'answered_not_interested',
              'callback_requested',
              'wrong_number',
              'do_not_call',
              'transferred',
              'quote_requested',
              'appointment_booked',
              'failed',
              'other',
            ],
          },
        },
        required: ['customerId', 'detail'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'listPendingCallbacks',
      description: 'List leads with pending callbacks or follow-ups due soon',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'addQuoteLines',
      description: 'Add line items to an existing quote or stage lines for the quote wizard prefill',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          customerId: { type: 'string' },
          tradeId: { type: 'string' },
          lines: { type: 'array', items: { type: 'object' } },
          items: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'updateQuoteLines',
      description: 'Replace or update line items on an existing quote',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          lines: { type: 'array', items: { type: 'object' } },
          items: { type: 'array', items: { type: 'object' } },
        },
        required: ['quoteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'completeHandover',
      description: 'Mark project handover complete with optional customer notes',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          customerNotes: { type: 'string' },
          signedBy: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'assignContractor',
      description: 'Assign a subcontractor to a project by contractor id or name and trade',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          contractorId: { type: 'string' },
          name: { type: 'string' },
          tradeId: { type: 'string' },
          trade: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'markPaymentReceived',
      description: 'Mark a project payment stage as received/paid',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          stageId: { type: 'string' },
          stageName: { type: 'string' },
          paidDate: { type: 'string' },
        },
      },
    },
  },
];

export const NAVIGATION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'navigateTo',
      description: 'Navigate the app UI to a target route or workflow',
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string' },
          reason: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['route'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'searchCustomers',
      description: 'Search for customers by name, email, phone, or notes',
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
      name: 'searchProjects',
      description: 'Search projects by name, customer, builder, or status',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          customerId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'searchQuotes',
      description: 'Search quotes by customer, trade, status, or text',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          customerId: { type: 'string' },
          tradeId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getBusinessSnapshot',
      description: 'Get live counts and brief lists of customers, quotes, projects, and builders/staff',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

