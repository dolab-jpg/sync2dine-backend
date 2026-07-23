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

export const GENERIC_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'readData',
      description:
        'Read records from app collections. Collections: customers, quotes, products, pricingRules, projects, builders, recruitmentAccess. Use query to search, id for a single record, limit to cap results. Confidential fields are automatically hidden for your role.',
      parameters: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            enum: ['customers', 'quotes', 'products', 'pricingRules', 'projects', 'builders', 'recruitmentAccess'],
          },
          query: { type: 'string', description: 'Optional text search within collection' },
          id: { type: 'string', description: 'Optional record id' },
          limit: { type: 'number' },
        },
        required: ['collection'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'writeData',
      description:
        'Create, update, or delete a record in an app collection. create/update run immediately; delete requires user confirmation. Collections: customers, quotes, products, pricingRules, projects, builders, recruitmentAccess.',
      parameters: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            enum: ['customers', 'quotes', 'products', 'pricingRules', 'projects', 'builders', 'recruitmentAccess'],
          },
          operation: { type: 'string', enum: ['create', 'update', 'delete'] },
          id: { type: 'string', description: 'Required for update and delete' },
          data: { type: 'object', description: 'Fields for create or update' },
        },
        required: ['collection', 'operation'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'navigate',
      description:
        'Navigate the user to any app route. Restaurant: /, /orders/kitchen, /orders/delivery, /menu, /customers, /calls, /accounts, /settings. Sales: /crm, /quotes, /projects, etc.',
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

export const RESTAURANT_TOOLS = RESTAURANT_TOOL_DEFS;

