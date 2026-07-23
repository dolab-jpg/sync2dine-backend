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

export const CONTRACT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'priceSmallJob',
      description: 'Price a small-jobs/handyman task list with live local price lookup; creates an awaiting_approval quote',
      parameters: {
        type: 'object',
        properties: {
          tasks: { type: 'string', description: 'Task list as text or newline-separated' },
          taskList: { type: 'string' },
          customerId: { type: 'string' },
          customerName: { type: 'string' },
          tradeName: { type: 'string' },
          postcode: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'submitForApproval',
      description: 'Send an existing quote to the manager approval queue',
      parameters: {
        type: 'object',
        properties: { quoteId: { type: 'string' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'approveQuote',
      description: 'Manager/admin only: approve a quote price (requires human confirmation)',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          total: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['quoteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'rejectQuote',
      description: 'Manager/admin only: reject a quote price',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['quoteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generatePaymentSchedule',
      description: 'Suggest stage payment schedule for an approved quote total',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          total: { type: 'number' },
          tradeName: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'saveContract',
      description: 'Build a draft contract from an APPROVED quote with AI stage payments',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          templateId: { type: 'string' },
          stages: { type: 'array', items: { type: 'object' } },
        },
        required: ['quoteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendContract',
      description: 'Email a saved contract to the customer (requires confirmation)',
      parameters: {
        type: 'object',
        properties: { contractId: { type: 'string' } },
        required: ['contractId'],
      },
    },
  },
];

