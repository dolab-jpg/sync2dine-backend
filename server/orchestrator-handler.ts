import {
  isValidServerTradeId,
  TRADE_EXTRACTABLE_FIELDS,
  TRADE_PLAYBOOK_PHASES,
  TRADE_REGISTRY,
  TRADE_IDS_CSV,
} from './trade-registry';
import { getDataStore } from './data-store';
import {
  assessExtraFromVision,
  assessProgressFromVision,
  resolvePhotoUrlsFromContext,
} from './vision-handler';
import { canExecuteActionForRole, filterActionsForRole, getRequestRole, isGenericTool } from './role-permissions';
import { resolveSystemPrompt } from './orchestrator-prompt';
import {
  executeCustomerTool,
  executeServerReadTool,
  executeUpdateLeadStatus,
  SERVER_READ_TOOLS,
} from './orchestrator-tool-exec';
import { PHONE_TOOLS, executePhoneTool, PHONE_AUTO_ACTIONS } from './phone-tools';
import type {
  OrchestratorAction,
  OrchestratorMessage,
  OrchestratorMode,
  OrchestratorRequest,
  OrchestratorResult,
} from './orchestrator-types';
import { PLANNING_ACTION_NAMES, PLANNING_TOOLS } from './planning-tools';
import {
  buildClarifyIntro,
  classifyTaskIntent,
  isProceedMessage,
  shouldClarifyBeforeExecute,
} from './task-planner';

export type { OrchestratorAction, OrchestratorRequest, OrchestratorResult } from './orchestrator-types';

function hasPlanningContext(body?: OrchestratorRequest): boolean {
  if (!body) return false;
  if (body.orchestratorMode === 'planning') return true;
  if (body.planningApplicationContext?.id) return true;
  const route = body.staffContext?.route ?? '';
  if (route.startsWith('/planning')) return true;
  return Boolean(body.staffContext?.planningApplicationId);
}

const MAX_TOOL_ROUNDS = 3;

/** Generic data/navigation primitives — available to all roles; dataPolicy enforces scope. */
const GENERIC_TOOLS = [
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
      description: 'Navigate the user to any app route. Examples: /, /crm, /quotes, /projects, /recruitment, /team, /quote/bathroom/C001',
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

const STAFF_TOOLS = [
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
      description: 'Create or update a customer record in CRM with name, contact details, and interested trades',
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

const CONTRACT_TOOLS = [
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

const PROJECT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'proposePaymentPlan',
      description: 'Generate payment stages for a project from total cost',
      parameters: {
        type: 'object',
        properties: {
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                percentage: { type: 'number' },
                amount: { type: 'number' },
                notes: { type: 'string' },
              },
            },
          },
        },
        required: ['stages'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'proposeSchedule',
      description: 'Generate project tasks and milestones respecting working days off',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                assignedTo: { type: 'string' },
                targetDate: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'medium', 'high'] },
              },
            },
          },
          milestones: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                targetDate: { type: 'string' },
              },
            },
          },
          workingDaysOff: { type: 'array', items: { type: 'string' } },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftInvoice',
      description: 'Draft an invoice for a payment stage',
      parameters: {
        type: 'object',
        properties: {
          stageName: { type: 'string' },
          lineItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                amount: { type: 'number' },
              },
            },
          },
          total: { type: 'number' },
        },
        required: ['lineItems', 'total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftContract',
      description: 'Draft contract terms for the project',
      parameters: {
        type: 'object',
        properties: {
          terms: { type: 'string' },
        },
        required: ['terms'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftBuilderMessage',
      description: 'Draft a message to the assigned builder about scope or price',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
          priceQuoted: { type: 'number' },
        },
        required: ['subject', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftCustomerMessage',
      description: 'Draft a customer update message',
      parameters: {
        type: 'object',
        properties: {
          body: { type: 'string' },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'proposeChangeOrder',
      description: 'Propose a customer change order draft that requires staff financial approval',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          amount: { type: 'number' },
          amountMin: { type: 'number' },
          amountMax: { type: 'number' },
          reason: { type: 'string' },
          estimatedDays: { type: 'number' },
          photoIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'amount'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'notifyCustomerChangeOrder',
      description: 'Notify the customer to review a staff-approved change order',
      parameters: {
        type: 'object',
        properties: {
          changeOrderId: { type: 'string' },
        },
        required: ['changeOrderId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logBuilderPrice',
      description: 'Record a price quoted by the builder',
      parameters: {
        type: 'object',
        properties: {
          builderName: { type: 'string' },
          priceQuoted: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['priceQuoted'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'updateTaskStatus',
      description: 'Update a task status or target date',
      parameters: {
        type: 'object',
        properties: {
          taskTitle: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'completed'] },
          targetDate: { type: 'string' },
        },
        required: ['taskTitle', 'status'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'tagPhoto',
      description: 'Add caption/tags to a project photo',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string' },
          caption: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['caption'],
      },
    },
  },
];

const FOREMAN_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'sendBuilderBrief',
      description: 'Send a concise builder brief with scope, task focus, and payment context',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          builderName: { type: 'string' },
          body: { type: 'string' },
          channels: { type: 'array', items: { type: 'string' } },
        },
        required: ['builderName', 'body', 'channels'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendContractorBrief',
      description:
        `Send a scoped brief to a subcontractor. Provide either contractorId or tradeId (at least one required). tradeId must be one of: ${TRADE_IDS_CSV}.`,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          contractorId: { type: 'string' },
          tradeId: {
            type: 'string',
            description: `Trade id when contractorId is unknown. One of: ${TRADE_IDS_CSV}`,
          },
          body: { type: 'string' },
          channels: { type: 'array', items: { type: 'string' } },
        },
        required: ['body', 'channels'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'proposePlan',
      description: 'Propose a foreman plan by cadence with tasks and milestones',
      parameters: {
        type: 'object',
        properties: {
          cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
          title: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                owner: { type: 'string' },
                due: { type: 'string' },
              },
            },
          },
          milestones: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                targetDate: { type: 'string' },
              },
            },
          },
        },
        required: ['cadence', 'title', 'tasks', 'milestones'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'checkPaymentGate',
      description: 'Check if payment stage gate is ready and what evidence is required',
      parameters: {
        type: 'object',
        properties: {
          stageName: { type: 'string' },
          evidenceNeeded: { type: 'array', items: { type: 'string' } },
        },
        required: ['stageName', 'evidenceNeeded'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'requestSitePhotos',
      description: 'Request site photos for a task by deadline',
      parameters: {
        type: 'object',
        properties: {
          taskTitle: { type: 'string' },
          deadline: { type: 'string' },
        },
        required: ['taskTitle', 'deadline'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'relayCustomerUpdate',
      description: 'Relay a concise project update to the customer channel',
      parameters: {
        type: 'object',
        properties: {
          body: { type: 'string' },
          channels: { type: 'array', items: { type: 'string' } },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logBuilderReply',
      description: 'Log a builder inbound update by phone for project records',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          fromPhone: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['fromPhone', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'assessExtraFromPhotos',
      description: 'Assess if new photos indicate a customer-chargeable extra and return pricing confidence',
      parameters: {
        type: 'object',
        properties: {
          photoIds: { type: 'array', items: { type: 'string' } },
          builderNote: { type: 'string' },
          tradeId: { type: 'string' },
        },
        required: ['builderNote'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'assessProgress',
      description: 'Assess progress from site photos and suggest task status updates',
      parameters: {
        type: 'object',
        properties: {
          photoIds: { type: 'array', items: { type: 'string' } },
          tradeId: { type: 'string' },
        },
      },
    },
  },
];

const COSTING_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'recordCostEntry',
      description: 'Record a material or supplier cost on a project (from chat or manual input)',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          supplier: { type: 'string' },
          total: { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                qty: { type: 'number' },
                unitPrice: { type: 'number' },
                total: { type: 'number' },
                category: { type: 'string' },
              },
            },
          },
          aiSummary: { type: 'string' },
          builderId: { type: 'string' },
        },
        required: ['supplier', 'total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getProjectProfit',
      description: 'Get profit summary for a project: revenue, costs, labour, margin',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          projectName: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getCostBreakdown',
      description: 'Get detailed cost breakdown by category, receipts, and timesheets for a project',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          projectName: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logHours',
      description: 'Log builder working hours on a project',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          builderId: { type: 'string' },
          hours: { type: 'number' },
          date: { type: 'string' },
          notes: { type: 'string' },
          rate: { type: 'number' },
        },
        required: ['hours'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'correctTimesheet',
      description: 'Correct hours on an existing timesheet entry',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          timesheetId: { type: 'string' },
          hours: { type: 'number' },
          notes: { type: 'string' },
          rate: { type: 'number' },
        },
        required: ['timesheetId', 'hours'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fixCostEntry',
      description: 'Fix or approve a flagged cost entry',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          entryId: { type: 'string' },
          supplier: { type: 'string' },
          total: { type: 'number' },
          items: { type: 'array', items: { type: 'object' } },
          notes: { type: 'string' },
        },
        required: ['entryId'],
      },
    },
  },
];

const ACCOUNTS_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'categorizeTransaction',
      description: 'Categorise a bank transaction and explain what it is for (materials, subcontractor, stage payment, etc.)',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          description: { type: 'string' },
          amount: { type: 'number' },
          direction: { type: 'string', enum: ['in', 'out'] },
          category: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['transactionId', 'category', 'reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'matchTransactionToProject',
      description: 'Match a bank transaction to a CRM project, customer, invoice, or payment stage',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          projectId: { type: 'string' },
          customerId: { type: 'string' },
          invoiceId: { type: 'string' },
          stageId: { type: 'string' },
        },
        required: ['transactionId', 'projectId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftClientReceipt',
      description: 'Draft and send a payment receipt to the client for a matched incoming payment',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          projectId: { type: 'string' },
          customerId: { type: 'string' },
          stageId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['transactionId', 'projectId', 'customerId'],
      },
    },
  },
];

const CUSTOMER_TOOLS = [
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

const LEAD_CYCLE_TOOLS = [
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

const NAVIGATION_TOOLS = [
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

const FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS = new Set([
  'oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not',
]);

/** Ensure OpenAI function parameters are a plain object schema (no top-level combinators). */
export function sanitizeToolsForOpenAI<T extends { type: 'function'; function: { name: string; parameters?: Record<string, unknown> } }>(
  tools: T[],
): T[] {
  return tools.map((tool) => {
    const parameters = { ...(tool.function.parameters ?? {}) } as Record<string, unknown>;
    for (const key of FORBIDDEN_TOP_LEVEL_SCHEMA_KEYS) {
      delete parameters[key];
    }
    if (parameters.type !== 'object') {
      parameters.type = 'object';
    }
    if (!parameters.properties || typeof parameters.properties !== 'object') {
      parameters.properties = {};
    }
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters,
      },
    };
  });
}

function getToolsForMode(mode: OrchestratorMode, body?: OrchestratorRequest) {
  const hasProject = Boolean(body?.projectContext?.projectId);
  const planning = hasPlanningContext(body);
  let tools;
  if (mode === 'planning') {
    tools = [...GENERIC_TOOLS, ...STAFF_TOOLS, ...NAVIGATION_TOOLS, ...PLANNING_TOOLS];
  } else if (mode === 'staff') {
    tools = hasProject
      ? [...GENERIC_TOOLS, ...STAFF_TOOLS, ...CONTRACT_TOOLS, ...PROJECT_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS]
      : [...GENERIC_TOOLS, ...STAFF_TOOLS, ...CONTRACT_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS];
  } else if (mode === 'project' || mode === 'foreman') {
    tools = [...GENERIC_TOOLS, ...STAFF_TOOLS, ...CONTRACT_TOOLS, ...PROJECT_TOOLS, ...FOREMAN_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS];
  } else if (mode === 'customer' || mode === 'cyrus') {
    tools = [...GENERIC_TOOLS, ...CUSTOMER_TOOLS];
  } else if (mode === 'phone') {
    tools = [...GENERIC_TOOLS, ...CUSTOMER_TOOLS, ...PHONE_TOOLS];
  } else {
    tools = [...GENERIC_TOOLS, ...STAFF_TOOLS, ...CONTRACT_TOOLS, ...PROJECT_TOOLS, ...FOREMAN_TOOLS, ...COSTING_TOOLS, ...ACCOUNTS_TOOLS, ...LEAD_CYCLE_TOOLS, ...NAVIGATION_TOOLS];
  }

  if (planning && mode !== 'planning') {
    tools = [...tools, ...PLANNING_TOOLS];
  }

  // Generic tools are always available; specialized tools are role-gated.
  if (body) {
    const role = getRequestRole(body);
    if (role !== 'unknown') {
      tools = tools.filter((tool) =>
        isGenericTool(tool.function.name) || canExecuteActionForRole(role, tool.function.name)
      );
      // #region agent log
      try{const fs=require('fs');const names=tools.map((t)=>t.function.name);fs.appendFileSync('debug-75bc70.log',JSON.stringify({sessionId:'75bc70',timestamp:Date.now(),location:'orchestrator-handler.ts:getToolsForMode',message:'tools after role gate',hypothesisId:'A',runId:'post-fix',data:{role,contractToolsPresent:['priceSmallJob','saveContract','approveQuote'].map((n)=>({name:n,present:names.includes(n)}))}})+'\n');}catch{}
      // #endregion
    }
  }
  return sanitizeToolsForOpenAI(tools);
}

const AUTO_ACTION_NAMES = new Set([
  'navigateTo',
  'navigate',
  'writeData',
  'getTeamPerformance',
  'searchLeads',
  'updateLeadStatus',
  'logFollowUp',
  'addQuoteLines',
  'updateQuoteLines',
  'completeHandover',
  'assignContractor',
  'markPaymentReceived',
  'sendBuilderBrief',
  'sendContractorBrief',
  'requestSitePhotos',
  'relayCustomerUpdate',
  'logBuilderReply',
  'notifyCustomerChangeOrder',
  'escalateToStaff',
  'recordCostEntry',
  'logHours',
  'categorizeTransaction',
  'matchTransactionToProject',
  'draftClientReceipt',
  ...PHONE_AUTO_ACTIONS,
  ...PLANNING_ACTION_NAMES,
]);

function applyRoleGate(body: OrchestratorRequest, result: OrchestratorResult): OrchestratorResult {
  const role = getRequestRole(body);
  const gated = {
    ...result,
    proposedActions: filterActionsForRole(role, result.proposedActions),
    autoActions: filterActionsForRole(role, result.autoActions),
  };
  return gated;
}

function resolveMode(body: OrchestratorRequest): OrchestratorMode {
  if (body.orchestratorMode) return body.orchestratorMode;
  if (hasPlanningContext(body)) return 'planning';
  if (body.callContext?.callId) return 'phone';
  const staffRole = body.staffContext?.role;
  if (staffRole === 'customer' || (body.customerContext && !body.staffContext)) return 'customer';
  if (body.staffContext?.role === 'builder') return 'foreman';
  if (body.projectContext && staffRole && staffRole !== 'customer') return 'project';
  if (body.staffContext) return 'staff';
  if (body.customerContext) return 'customer';
  return 'auto';
}

function toMessageRole(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

function safeParseObject(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse failures and return empty object
  }
  return {};
}

function buildActionSummary(action: OrchestratorAction): string {
  if (action.action === 'detectTrades') {
    const trades = Array.isArray(action.output.trades)
      ? (action.output.trades as Array<{ tradeId?: string }>)
          .map(t => t.tradeId)
          .filter(Boolean)
          .join(', ')
      : '';
    return `Detected trades: ${trades || 'none'}`;
  }
  if (action.action === 'startQuote') return `Ready to start quote for ${String(action.output.tradeId ?? 'selected trade')}`;
  if (action.action === 'linkCustomer') return `Customer matched: ${String(action.output.name ?? action.output.customerId ?? 'ready')}`;
  if (action.action === 'saveCustomer') return `Customer saved: ${String(action.output.name ?? 'ready')}`;
  if (action.action === 'saveQuote') return `Quote saved: ${String(action.output.tradeId ?? 'trade')} — £${String(action.output.total ?? 'TBC')}`;
  if (action.action === 'updateQuote') return `Quote updated: ${String(action.output.quoteId ?? 'latest')}`;
  if (action.action === 'proposeQuoteFields') return `Quote fields prepared for ${String(action.output.tradeId ?? 'trade')}`;
  if (action.action === 'lookupQuote') return `Quote lookup complete (${String(action.output.count ?? 0)} result(s))`;
  if (action.action === 'lookupProjectStatus') return `Project lookup complete (${String(action.output.count ?? 0)} result(s))`;
  if (action.action === 'getPortalLink') return `Portal link ${action.output.portalLink ? 'ready' : 'unavailable'}`;
  if (action.action === 'escalateToStaff') return 'Escalation prepared for staff follow-up';
  if (action.action === 'proposeChangeOrder') return `Change order draft ready: ${String(action.output.title ?? 'Untitled')}`;
  if (action.action === 'notifyCustomerChangeOrder') return `Customer notification ready for change order ${String(action.output.changeOrderId ?? '')}`;
  if (action.action === 'assessExtraFromPhotos') return `Photo extra assessment ready (${String(action.output.title ?? 'variation')})`;
  if (action.action === 'assessProgress') return 'Photo progress assessment ready';
  if (action.action === 'getProjectProfit') return `Profit: £${String(action.output.grossProfit ?? 0)} (${String(action.output.marginPct ?? 0)}% margin)`;
  if (action.action === 'getCostBreakdown') return `Cost breakdown ready for ${String(action.output.projectName ?? 'project')}`;
  if (action.action === 'recordCostEntry') return `Cost recorded: ${String(action.output.supplier ?? '')} — £${String(action.output.total ?? 0)}`;
  if (action.action === 'logHours') return `Hours logged: ${String(action.output.hours ?? 0)}h (£${String(action.output.labourCost ?? 0)})`;
  if (AUTO_ACTION_NAMES.has(action.action)) return `${action.action}: ready to auto-run`;
  return `${action.action}: ready for review`;
}

function buildActionsSummaryText(actions: OrchestratorAction[]): string {
  if (!actions.length) return '';
  return actions.map(buildActionSummary).join('\n');
}

function extractCustomerFromMessage(text: string): {
  name?: string;
  email?: string;
  phone?: string;
  budget?: number;
} {
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/\b07\d{8,10}\b/) ?? text.match(/\b\+?44?\s*7\d{3}\s*\d{3}\s*\d{3,4}\b/);
  const budgetMatch = text.match(/£\s*(\d+(?:\.\d+)?)\s*k/i)
    ?? text.match(/£\s*(\d[\d,]*)/);
  let budget: number | undefined;
  if (budgetMatch) {
    const raw = budgetMatch[1].replace(/,/g, '');
    budget = text.toLowerCase().includes('k') && !raw.includes('.')
      ? Number(raw) * 1000
      : Number(raw);
  }
  const namePatterns = [
    /customer\s+name\s+([a-z]+(?:\s+[a-z]+)*)/i,
    /(?:for|customer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /(?:called|named)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  ];
  let name: string | undefined;
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      name = match[1].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      break;
    }
  }
  return {
    name,
    email: emailMatch?.[0],
    phone: phoneMatch?.[0]?.replace(/\s/g, ''),
    budget: Number.isFinite(budget) ? budget : undefined,
  };
}

function inferTradesFromText(text: string): Array<{ tradeId: string; confidence: number; reason?: string }> {
  const lower = text.toLowerCase();
  const detected: Array<{ tradeId: string; confidence: number; reason?: string }> = [];

  for (const trade of TRADE_REGISTRY) {
    const signals = trade.signals.split(', ').map(s => s.trim().toLowerCase());
    const matches = signals.filter(s => lower.includes(s));
    if (matches.length > 0) {
      detected.push({
        tradeId: trade.id,
        confidence: Math.min(0.95, 0.5 + matches.length * 0.15),
        reason: `Matched: ${matches.slice(0, 3).join(', ')}`,
      });
    }
  }

  return detected.sort((a, b) => b.confidence - a.confidence);
}

function mockFieldsForTrade(tradeId: string): Record<string, { value: unknown; confidence: number; reason?: string }> {
  const keys = TRADE_EXTRACTABLE_FIELDS[tradeId] ?? ['area'];
  const fields: Record<string, { value: unknown; confidence: number; reason?: string }> = {};
  for (const key of keys) {
    if (key === 'length') fields[key] = { value: 3.5, confidence: 0.6, reason: 'Mock estimate' };
    else if (key === 'width') fields[key] = { value: 2.5, confidence: 0.55 };
    else if (key === 'area') fields[key] = { value: 25, confidence: 0.5 };
    else if (key === 'rooms') fields[key] = { value: 3, confidence: 0.65 };
    else if (key === 'finish') fields[key] = { value: 'standard', confidence: 0.5 };
    else fields[key] = { value: 'standard', confidence: 0.45, reason: 'Mock — verify on site' };
  }
  return fields;
}

function inferRouteFromText(lower: string): string | undefined {
  if (lower.includes('site survey') || /\bsurveys?\b/.test(lower)) return '/site-survey';
  if (lower.includes('quote')) return '/quote';
  if (lower.includes('project')) return '/projects';
  if (lower.includes('customer')) return '/customers';
  if (lower.includes('staff')) return '/staff';
  if (lower.includes('dashboard') || lower.includes('home')) return '/';
  return undefined;
}

function extractSearchQuery(text: string, fallback: string): string {
  const quoted = text.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const cleaned = text.replace(/\b(search|find|lookup|look up|customer|project|quote|quotes|for|please)\b/gi, ' ').trim();
  return cleaned || fallback;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

interface ProjectContextContractor {
  id: string;
  name: string;
  tradeId?: string;
  trade?: string;
}

function readAssignedContractors(projectContext: Record<string, unknown> | undefined): ProjectContextContractor[] {
  const contractors = projectContext?.assignedContractors;
  if (!Array.isArray(contractors)) return [];
  return contractors
    .map((value) => {
      if (!value || typeof value !== 'object') return null;
      const raw = value as Record<string, unknown>;
      const id = firstString(raw.id, raw.contractorId);
      const name = firstString(raw.name);
      if (!id || !name) return null;
      return {
        id,
        name,
        tradeId: firstString(raw.tradeId),
        trade: firstString(raw.trade),
      } satisfies ProjectContextContractor;
    })
    .filter((item): item is ProjectContextContractor => Boolean(item));
}

function getTradePhaseSummary(tradeId: string | undefined): string {
  if (!tradeId || !isValidServerTradeId(tradeId)) return 'survey -> delivery -> handover';
  const phases = TRADE_PLAYBOOK_PHASES[tradeId] ?? ['survey', 'delivery', 'handover'];
  return phases.join(' -> ');
}

function readStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function buildChangeOrderFromAssessment(
  assessment: Record<string, unknown>,
  projectContext?: Record<string, unknown>
): Record<string, unknown> {
  const amountMin = Number(assessment.amountMin ?? 0);
  const amountMax = Number(assessment.amountMax ?? amountMin);
  const midpoint = amountMin > 0 && amountMax > 0
    ? Math.round((amountMin + amountMax) / 2)
    : Number(assessment.amount ?? 0);

  return {
    title: String(assessment.title ?? 'Variation request'),
    description: String(assessment.description ?? 'Variation identified from site photos.'),
    reason: String(assessment.reason ?? 'Builder photo assessment indicated additional scope.'),
    amount: midpoint,
    amountMin,
    amountMax,
    estimatedDays: Number(assessment.estimatedDays ?? 0),
    status: 'pending_customer',
    projectId: firstString(projectContext?.projectId),
    confidence: Number(assessment.confidence ?? 0.6),
    risks: Array.isArray(assessment.risks) ? assessment.risks : [],
  };
}

async function executeVisionTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest,
  apiKey: string
): Promise<Record<string, unknown> | null> {
  const photoIds = readStringArray(input.photoIds);
  const images = resolvePhotoUrlsFromContext(body.projectContext, photoIds);
  const tradeId = firstString(input.tradeId, body.staffContext?.tradeId, body.projectContext?.tradeId) ?? 'general';

  if (name === 'assessExtraFromPhotos') {
    const builderNote = firstString(input.builderNote) ?? 'Assess whether this is extra scope.';
    const extra = await assessExtraFromVision({
      apiKey,
      tradeId,
      builderNote,
      images,
      projectContext: body.projectContext,
    });
    return {
      ...extra,
      tradeId,
      photoCount: images.length,
      photoIds,
      proposeChangeOrder: buildChangeOrderFromAssessment(extra as unknown as Record<string, unknown>, body.projectContext),
    };
  }

  if (name === 'assessProgress') {
    const progress = await assessProgressFromVision({
      apiKey,
      tradeId,
      images,
      projectContext: body.projectContext,
    });
    return {
      ...progress,
      tradeId,
      photoCount: images.length,
      photoIds,
    };
  }

  return null;
}

function summarizeProjectStatus(project: Record<string, unknown>): Record<string, unknown> {
  const paymentStages = Array.isArray(project.paymentStages) ? project.paymentStages as Array<Record<string, unknown>> : [];
  const tasks = Array.isArray(project.tasks) ? project.tasks as Array<Record<string, unknown>> : [];
  const nextPayment = paymentStages.find((stage) => {
    const status = String(stage.status ?? '');
    return status === 'due' || status === 'pending';
  });
  const openTasks = tasks
    .filter((task) => String(task.status ?? '') !== 'completed')
    .slice(0, 3)
    .map((task) => String(task.title ?? 'Untitled task'));

  return {
    projectId: String(project.id ?? ''),
    customerId: String(project.customerId ?? ''),
    projectName: String(project.projectName ?? 'Project'),
    status: String(project.status ?? 'unknown'),
    tradeName: firstString(project.tradeName, project.tradeId),
    startDate: firstString(project.startDate),
    finishDate: firstString(project.finishDate),
    todayTasks: openTasks,
    nextPaymentDue: nextPayment
      ? {
          name: String(nextPayment.name ?? 'Payment stage'),
          amount: Number(nextPayment.amount ?? 0),
          status: String(nextPayment.status ?? 'pending'),
          dueDate: firstString(nextPayment.dueDate),
        }
      : null,
    portalToken: firstString(project.portalToken),
    escalated: Boolean(project.escalated),
  };
}

function buildCustomerReplyFromActions(actions: OrchestratorAction[]): string | null {
  const parts: string[] = [];

  const statusAction = actions.find(a => a.action === 'lookupProjectStatus');
  if (statusAction) {
    const projects = Array.isArray(statusAction.output.projects)
      ? statusAction.output.projects as Array<Record<string, unknown>>
      : [];
    if (projects.length > 0) {
      const p = projects[0];
      const trade = firstString(p.tradeName);
      const statusLabel = String(p.status ?? 'in progress').replace(/_/g, ' ');
      parts.push(`Your ${trade ? `${trade.toLowerCase()} ` : ''}project "${String(p.projectName)}" is currently ${statusLabel}.`);
      const tasks = Array.isArray(p.todayTasks) ? (p.todayTasks as string[]).filter(Boolean) : [];
      if (tasks.length) parts.push(`Next up on site: ${tasks.join(', ')}.`);
      const finish = firstString(p.finishDate);
      if (finish) parts.push(`Target completion: ${finish}.`);
      const pay = p.nextPaymentDue as Record<string, unknown> | null;
      if (pay && typeof pay === 'object') {
        parts.push(`Next payment stage: ${String(pay.name)} (£${Number(pay.amount ?? 0).toLocaleString('en-GB')}).`);
      }
    } else {
      parts.push('I could not see live schedule details for your project just now.');
    }
  }

  const quoteAction = actions.find(a => a.action === 'lookupQuote');
  if (quoteAction) {
    const quotes = Array.isArray(quoteAction.output.quotes)
      ? quoteAction.output.quotes as Array<Record<string, unknown>>
      : [];
    if (quotes.length > 0) {
      const q = quotes[0];
      parts.push(`Your latest quote${q.quoteId ? ` (${String(q.quoteId)})` : ''} for ${String(q.projectName ?? q.tradeName ?? 'your job')} comes to £${Number(q.total ?? 0).toLocaleString('en-GB')} — project status: ${String(q.projectStatus ?? 'in progress')}.`);
    } else {
      parts.push("I couldn't find a quote on file for you yet — the team can sort one out quickly.");
    }
  }

  const portalAction = actions.find(a => a.action === 'getPortalLink');
  if (portalAction) {
    parts.push(portalAction.output.portalLink
      ? `Here is your portal link: ${String(portalAction.output.portalLink)}`
      : 'Your portal link is not set up yet — I have asked the team to sort it.');
  }

  const escalateAction = actions.find(a => a.action === 'escalateToStaff');
  if (escalateAction) {
    parts.push("I've also passed your question to the office team — they'll come back to you shortly (usually within 4 hours).");
  }

  return parts.length ? parts.join(' ') : null;
}

function wrapMockResult(result: OrchestratorResult): OrchestratorResult {
  return { ...result, mockMode: true };
}

function staffMockGreetingContent(body: OrchestratorRequest, trimmed: string): string | null {
  const userName = body.staffContext?.userName ?? 'there';
  const role = body.staffContext?.role ?? 'staff';
  const humour = body.aiStudio?.humourLevel;
  if (/^(hi|hiya|hello|hey|yo|good\s+(morning|afternoon|evening))[\s!.,?]*$/i.test(trimmed)) {
    if (humour === 'del_boy') {
      return `Alright ${userName} — ${role} on deck today. Lovely jubbly. What are we sorting?`;
    }
    return `Hello ${userName} — you're logged in as ${role}. Ask about quotes, customers, or projects.`;
  }
  if (/\b(who am i|what is my name|my name)\b/i.test(trimmed)) {
    if (humour === 'del_boy') {
      return `You're ${userName}, boss — ${role} today. What do you need?`;
    }
    return `You are ${userName}, logged in as ${role}.`;
  }
  if (/\bhow many customers\b/i.test(trimmed)) {
    const count = body.businessSnapshot?.customerCount ?? body.staffContext?.customers?.length ?? 0;
    return `You've got ${count} customer${count === 1 ? '' : 's'} on file.`;
  }
  if (/\bhow many quotes\b/i.test(trimmed)) {
    const count = body.businessSnapshot?.quoteCount ?? body.staffContext?.quotes?.length ?? 0;
    return `There are ${count} quote${count === 1 ? '' : 's'} in the system.`;
  }
  return null;
}

function detectQuoteWonIntent(lower: string): boolean {
  return /\b(gone ahead|won the job|accepted|make.*job|convert.*project|into a job)\b/i.test(lower);
}

function extractCustomerNameFromMessage(
  message: string,
  customers?: Array<{ name: string }>
): string | undefined {
  const list = customers ?? [];
  const lower = message.toLowerCase();
  const match = list.find((c) => lower.includes(c.name.toLowerCase().split(' ')[0] ?? ''));
  if (match) return match.name;
  const nameMatch = message.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  return nameMatch?.[1];
}

function buildMockResult(userMessage: string, body: OrchestratorRequest): OrchestratorResult {
  const lower = userMessage.toLowerCase();
  const trimmed = userMessage.trim();
  const mode = resolveMode(body);
  const requestRole = getRequestRole(body);

  if (requestRole === 'customer' && /invoice|send bill|payment request|draft invoice/i.test(userMessage)) {
    return applyRoleGate(body, {
      content: "That's one for the office — I've flagged it for the team. They'll sort invoices and payments.",
      proposedActions: [],
      autoActions: [],
      detectedTrades: [],
    });
  }
  const includeStaffTools = mode === 'staff' || mode === 'auto';
  const includeProjectTools = mode === 'project' || mode === 'foreman' || mode === 'auto';
  const includeForemanTools = mode === 'project' || mode === 'foreman';
  const includeCustomerTools = mode === 'customer' || mode === 'cyrus';
  const proposedActions: OrchestratorAction[] = [];
  let detectedTrades: OrchestratorResult['detectedTrades'] = [];

  if (includeCustomerTools) {
    const trimmed = userMessage.trim();
    const isGreeting = /^(hi|hiya|hello|hey|yo|good\s+(morning|afternoon|evening))[\s!.,?]*$/i.test(trimmed);
    const isThanks = /^(thanks|thank\s+you|thanks\s+a\s+lot|thank\s+u|cheers|ta|nice one|much appreciated|appreciate it)[\s!.,]*$/i.test(trimmed);
    // Short acknowledgements ("ok", "great", "sounds good") are not questions — answering
    // them with a full status dump and a fresh escalation makes the bot feel robotic.
    const isAck = /^(ok|oka?y|okey|oky|k|kk|kay|right|righto|alright|all\s*right|cool|great|grand|perfect|brilliant|lovely|nice|sound|sounds\s+good|good|fine|sure|ok\s+thanks|okay\s+thanks|yep|yeah|yes|yup|no\s+worries|gotcha|got\s+it|understood|noted|fab|magic|champion|sweet|ace|will\s+do)[\s!.,]*$/i.test(trimmed);
    const alreadyEscalated = (body.messages ?? []).some(
      (m) => m.role === 'assistant' && /passed your question to the office team/i.test(m.content ?? ''),
    );
    const statusIntent = /(status|progress|project|working|work|tomorrow|today|when|schedule|start|finish|builder|team|anyone|update|happening|going|on\s*site)/i.test(lower);

    if (lower.includes('quote') || lower.includes('qoute') || lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
      proposedActions.push({
        action: 'lookupQuote',
        input: {},
        output: executeCustomerTool('lookupQuote', {}, body),
      });
    }
    if (statusIntent) {
      proposedActions.push({
        action: 'lookupProjectStatus',
        input: {},
        output: executeCustomerTool('lookupProjectStatus', {}, body),
      });
    }
    if (lower.includes('portal') || lower.includes('link')) {
      proposedActions.push({
        action: 'getPortalLink',
        input: {
          projectId: firstString(body.projectContext?.projectId, body.customerContext?.projectId),
        },
        output: executeCustomerTool('getPortalLink', {
          projectId: firstString(body.projectContext?.projectId, body.customerContext?.projectId),
        }, body),
      });
    }
    if (/upset|angry|unhappy|complaint|manager|human|person/i.test(userMessage)) {
      proposedActions.push({
        action: 'escalateToStaff',
        input: { reason: 'Customer sentiment indicates escalation request' },
        output: executeCustomerTool('escalateToStaff', { reason: 'Customer sentiment indicates escalation request' }, body),
      });
    }

    // Unmatched question: answer with live project data and flag for the team.
    // Skip acknowledgements/greetings/thanks, and don't re-escalate if the office
    // team has already been looped in earlier in this conversation.
    if (!proposedActions.length && !isGreeting && !isThanks && !isAck) {
      proposedActions.push({
        action: 'lookupProjectStatus',
        input: {},
        output: executeCustomerTool('lookupProjectStatus', {}, body),
      });
      if (!alreadyEscalated) {
        proposedActions.push({
          action: 'escalateToStaff',
          input: { reason: `Customer question needs a staff answer: "${trimmed}"` },
          output: executeCustomerTool('escalateToStaff', { reason: `Customer question needs a staff answer: "${trimmed}"` }, body),
        });
      }
    }

    const customerName = firstString(body.customerContext?.customerName);
    const firstName = customerName?.split(' ')[0];

    let content: string;
    if (isGreeting) {
      content = `Hello${firstName ? ` ${firstName}` : ''}! I can check your project progress, quotes, payments, or pass a question to the team. What would you like to know?`;
    } else if (isThanks) {
      content = "You're very welcome — give me a shout if you need anything else.";
    } else if (isAck) {
      content = alreadyEscalated
        ? "No problem — the office team will be in touch shortly. Anything else I can help with in the meantime?"
        : "No problem at all. I'm here if you need anything else — project progress, quotes or payments.";
    } else {
      content = buildCustomerReplyFromActions(proposedActions)
        ?? 'How can I help with your quote or project today?';
    }

    return applyRoleGate(body, {
      content,
      proposedActions: proposedActions.filter((a) => !AUTO_ACTION_NAMES.has(a.action)),
      autoActions: proposedActions.filter((a) => AUTO_ACTION_NAMES.has(a.action)),
      detectedTrades: [],
    });
  }

  if (includeStaffTools) {
    const greetingContent = staffMockGreetingContent(body, trimmed);
    if (greetingContent) {
      return applyRoleGate(body, {
        content: greetingContent,
        proposedActions: [],
        autoActions: [],
        detectedTrades: [],
      });
    }

    const classification = classifyTaskIntent(userMessage, body, body.messages ?? []);
    const autonomy = body.aiStudio?.autonomyLevel ?? 'balanced';
    if (
      shouldClarifyBeforeExecute(classification, autonomy, body, userMessage)
      && !body.pendingTask
      && !isProceedMessage(userMessage)
    ) {
      const pendingTaskId = `task-${Date.now()}`;
      const intro = buildClarifyIntro(classification.summary, body.aiStudio?.humourLevel);
      const numbered = classification.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      return applyRoleGate(body, {
        content: `${intro}\n\n${numbered}`,
        proposedActions: [],
        autoActions: [],
        detectedTrades: [],
        phase: 'clarify',
        clarifyingQuestions: classification.questions,
        taskSummary: classification.summary,
        pendingTaskId,
      });
    }

    if (detectQuoteWonIntent(lower)) {
      const customerName = extractCustomerNameFromMessage(userMessage, body.staffContext?.customers);
      const quote = body.staffContext?.quotes?.find((q) =>
        customerName ? q.customerName.toLowerCase().includes(customerName.toLowerCase().split(' ')[0] ?? '') : false
      ) ?? body.staffContext?.quotes?.[0];
      const withPaymentPlan = /payment plan|instalment|installment/i.test(lower);
      if (quote) {
        proposedActions.push({
          action: 'convertQuoteToProject',
          input: {},
          output: {
            quoteId: quote.id,
            customerName: quote.customerName,
            markQuoteAccepted: true,
            withPaymentPlan,
          },
        });
      }
    }

    const ctx = body.staffContext;
    detectedTrades = inferTradesFromText(userMessage);
    if (ctx?.tradeId && isValidServerTradeId(ctx.tradeId) && !detectedTrades.some(d => d.tradeId === ctx.tradeId)) {
      detectedTrades.unshift({ tradeId: ctx.tradeId, confidence: 0.7, reason: 'From current page context' });
    }

    if (detectedTrades.length > 0) {
      proposedActions.push({
        action: 'detectTrades',
        input: {},
        output: { trades: detectedTrades },
      });
    }

    const primaryTrade = detectedTrades[0]?.tradeId ?? ctx?.tradeId ?? null;
    const primaryConfidence = detectedTrades[0]?.confidence ?? (ctx?.tradeId ? 0.7 : 0);
    if (
      primaryTrade
      && isValidServerTradeId(primaryTrade)
      && primaryConfidence >= 0.5
      && (lower.includes('quote') || lower.includes('estimate') || lower.includes('measure') || detectedTrades.length > 0)
    ) {
      proposedActions.push({
        action: 'proposeQuoteFields',
        input: {},
        output: { tradeId: primaryTrade, fields: mockFieldsForTrade(primaryTrade) },
      });
    }

    const customers = ctx?.customers ?? [];
    const extracted = extractCustomerFromMessage(userMessage);
    const existing = extracted.name
      ? customers.find(c => c.name.toLowerCase().includes(extracted.name!.toLowerCase()))
      : undefined;

    if (extracted.name || existing || lower.includes('customer') || lower.includes('client') || lower.includes('make me')) {
      const tradeIds = detectedTrades.map(d => d.tradeId);
      const customerOutput = {
        customerId: existing?.id,
        name: existing?.name ?? extracted.name ?? '',
        email: existing?.email ?? extracted.email ?? '',
        phone: existing?.phone ?? extracted.phone ?? '',
        interestedTrades: tradeIds.length > 0 ? tradeIds : (primaryTrade ? [primaryTrade] : []),
        isNew: !existing,
      };
      proposedActions.push({
        action: 'saveCustomer',
        input: {},
        output: customerOutput,
      });

      if (
        primaryTrade
        && isValidServerTradeId(primaryTrade)
        && (lower.includes('quote') || lower.includes('qoute') || lower.includes('£') || extracted.budget || /\b\d+\s*k\b/i.test(lower))
      ) {
        const budget = extracted.budget ?? 5000;
        proposedActions.push({
          action: 'saveQuote',
          input: {},
          output: {
            tradeId: primaryTrade,
            customerName: customerOutput.name,
            status: 'draft',
            total: budget,
            openQuote: lower.includes('open') || lower.includes('save'),
            items: [{ name: `${primaryTrade} materials`, quantity: 1, price: Math.round(budget * 0.55), total: Math.round(budget * 0.55) }],
            labour: [{ description: 'Installation labour', rateType: 'fixed', rate: Math.round(budget * 0.35), total: Math.round(budget * 0.35) }],
            extras: [{ description: 'Fixings & sundries', price: Math.round(budget * 0.1) }],
            wizardAnswers: { finish: lower.includes('standard') ? 'standard' : undefined },
          },
        });
      }
    }

    if (
      primaryTrade
      && isValidServerTradeId(primaryTrade)
      && (lower.includes('open quote') || lower.includes('start quote'))
    ) {
      proposedActions.push({
        action: 'startQuote',
        input: {},
        output: {
          tradeId: primaryTrade,
          customerId: existing?.id ?? ctx?.customerId,
          prefillFields: mockFieldsForTrade(primaryTrade),
        },
      });
    }
  }

  if (includeProjectTools) {
    const projectName = String(body.projectContext?.projectName ?? 'the project');
    if (lower.includes('payment') || lower.includes('plan')) {
      proposedActions.push({
        action: 'proposePaymentPlan',
        input: {},
        output: {
          stages: [
            { name: 'Booking Deposit', percentage: 10, amount: 0, notes: 'Secures start date' },
            { name: 'Project Start', percentage: 40, amount: 0, notes: 'Released when work begins' },
            { name: 'Mid-point', percentage: 30, amount: 0, notes: 'At 50% completion' },
            { name: 'Completion', percentage: 20, amount: 0, notes: 'On sign-off' },
          ],
        },
      });
    }
    if (lower.includes('schedule') || lower.includes('task') || lower.includes('day off') || lower.includes('friday')) {
      proposedActions.push({
        action: 'proposeSchedule',
        input: {},
        output: {
          tasks: [
            { title: 'Strip out', description: 'Remove existing suite', assignedTo: 'Builder', targetDate: '', priority: 'high' },
            { title: 'First fix plumbing', description: 'Pipework and waste', assignedTo: 'Builder', targetDate: '', priority: 'high' },
            { title: 'Waterproofing', description: 'Tanking system', assignedTo: 'Builder', targetDate: '', priority: 'medium' },
            { title: 'Second fix', description: 'Fit sanitaryware', assignedTo: 'Builder', targetDate: '', priority: 'medium' },
          ],
          milestones: [{ title: 'Strip-out complete', targetDate: '' }],
          workingDaysOff: lower.includes('friday') ? ['Friday'] : [],
        },
      });
    }
    if (lower.includes('invoice')) {
      proposedActions.push({
        action: 'draftInvoice',
        input: {},
        output: {
          stageName: 'Project Start',
          lineItems: [{ description: `Bathroom installation — ${projectName}`, amount: 0 }],
          total: 0,
        },
      });
    }
    if (lower.includes('contract')) {
      proposedActions.push({
        action: 'draftContract',
        input: {},
        output: {
          terms: 'Standard UK home improvement contract. Subject to site inspection. 14-day cooling-off period applies.',
        },
      });
    }
    if (lower.includes('builder') || lower.includes('contractor') || lower.includes('price')) {
      proposedActions.push({
        action: 'draftBuilderMessage',
        input: {},
        output: {
          subject: `Price enquiry — ${projectName}`,
          body: 'Hi, please confirm your price for the attached scope of works.',
        },
      });
      if (/\d+/.test(userMessage)) {
        proposedActions.push({
          action: 'logBuilderPrice',
          input: {},
          output: { builderName: 'Builder', priceQuoted: 0, notes: userMessage },
        });
      }
    }
    if (
      lower.includes('change order')
      || lower.includes('variation')
      || lower.includes('scope change')
      || lower.includes('extra work')
    ) {
      proposedActions.push({
        action: 'proposeChangeOrder',
        input: {},
        output: {
          title: 'Variation request',
          description: 'Additional scope identified and drafted for staff financial approval.',
          amount: 0,
          reason: 'Scope update',
        },
      });
    }
    if ((lower.includes('notify') || lower.includes('send')) && lower.includes('change order')) {
      proposedActions.push({
        action: 'notifyCustomerChangeOrder',
        input: {},
        output: {
          changeOrderId: '',
        },
      });
    }
    if (lower.includes('complete') || lower.includes('done') || lower.includes('task')) {
      proposedActions.push({
        action: 'updateTaskStatus',
        input: {},
        output: { taskTitle: 'Strip out', status: 'completed' },
      });
    }
    if (lower.includes('photo') || lower.includes('tag') || lower.includes('caption')) {
      proposedActions.push({
        action: 'tagPhoto',
        input: {},
        output: { caption: 'Progress photo — site update', tags: ['progress'] },
      });
    }
  }

  if (includeForemanTools) {
    const projectName = String(body.projectContext?.projectName ?? 'the project');
    const projectId = String(body.projectContext?.projectId ?? '');
    const builderName = String(body.projectContext?.builderName ?? body.projectContext?.builderId ?? 'Builder');
    const assignedContractors = readAssignedContractors(body.projectContext);
    const scopedTradeId = firstString(body.projectContext?.tradeId, body.staffContext?.tradeId);

    if (lower.includes('brief') || lower.includes('builder update') || lower.includes('foreman')) {
      const tradeScopeLine = assignedContractors.length > 0
        ? assignedContractors
            .map((contractor) => {
              const trade = contractor.trade ?? contractor.tradeId ?? 'general';
              const firstPhase = getTradePhaseSummary(contractor.tradeId ?? scopedTradeId).split(' -> ')[0];
              return `${trade}: ${firstPhase}`;
            })
            .join('; ')
        : '';
      proposedActions.push({
        action: 'sendBuilderBrief',
        input: {},
        output: {
          projectId,
          builderName,
          body: `Morning brief for ${projectName}: confirm today's priorities, blockers, and H&S checks.${tradeScopeLine ? ` Trade scopes: ${tradeScopeLine}.` : ''}`,
          channels: ['app'],
        },
      });

      if (
        assignedContractors.length > 0
        && (lower.includes('contractor') || lower.includes('trade') || lower.includes('sub'))
      ) {
        const matchingTrade = scopedTradeId && isValidServerTradeId(scopedTradeId)
          ? assignedContractors.find((contractor) => contractor.tradeId === scopedTradeId)
          : undefined;
        const target = matchingTrade ?? assignedContractors[0];
        proposedActions.push({
          action: 'sendContractorBrief',
          input: {},
          output: {
            projectId,
            contractorId: target.id,
            tradeId: target.tradeId ?? scopedTradeId,
            body: `Trade brief for ${target.name}: focus on ${target.trade ?? target.tradeId ?? 'your scope'} work package and confirm blockers by 16:00.`,
            channels: ['app'],
          },
        });
      }
    }

    if (lower.includes('daily plan') || lower.includes('weekly plan') || lower.includes('monthly plan') || lower.includes('propose plan')) {
      const cadence = lower.includes('weekly')
        ? 'weekly'
        : lower.includes('monthly')
          ? 'monthly'
          : 'daily';
      const tradeScopedTasks = assignedContractors.slice(0, 4).map((contractor) => {
        const phases = getTradePhaseSummary(contractor.tradeId ?? scopedTradeId).split(' -> ');
        return {
          title: `${contractor.trade ?? contractor.tradeId ?? 'Trade'} package`,
          owner: contractor.name,
          due: '',
          phase: phases[0] ?? 'survey',
        };
      });
      proposedActions.push({
        action: 'proposePlan',
        input: {},
        output: {
          cadence,
          title: `${cadence[0].toUpperCase()}${cadence.slice(1)} foreman plan`,
          tasks: [
            { title: 'Review open tasks and dependencies', owner: builderName, due: '' },
            ...tradeScopedTasks,
            { title: 'Confirm materials and access windows', owner: 'Office', due: '' },
          ],
          milestones: tradeScopedTasks.length > 0
            ? tradeScopedTasks.map((task) => ({ title: `${task.title} phase checkpoint`, targetDate: '' }))
            : [{ title: 'Site progress checkpoint', targetDate: '' }],
        },
      });
    }

    if (lower.includes('payment gate') || lower.includes('stage gate') || lower.includes('ready to invoice')) {
      proposedActions.push({
        action: 'checkPaymentGate',
        input: {},
        output: {
          stageName: 'Project Start',
          evidenceNeeded: ['Progress photos', 'Task completion note', 'Customer acknowledgement'],
        },
      });
    }

    if (lower.includes('photo') || lower.includes('site photo') || lower.includes('site photos')) {
      proposedActions.push({
        action: 'requestSitePhotos',
        input: {},
        output: {
          taskTitle: 'Current active task',
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        },
      });
    }

    if (lower.includes('relay') || lower.includes('customer update')) {
      proposedActions.push({
        action: 'relayCustomerUpdate',
        input: {},
        output: {
          body: `Customer update for ${projectName}: work is progressing and next steps are on track.`,
          channels: ['app'],
        },
      });
    }

    if (lower.includes('builder replied') || lower.includes('builder response')) {
      proposedActions.push({
        action: 'logBuilderReply',
        input: {},
        output: {
          projectId,
          fromPhone: '',
          body: userMessage,
        },
      });
    }

    if (
      lower.includes('assess extra')
      || lower.includes('variation photo')
      || lower.includes('extra scope')
      || (lower.includes('photo') && (lower.includes('extra') || lower.includes('change order')))
    ) {
      const mockExtra = {
        title: 'Electric underfloor heating',
        description: 'Photos suggest prep and kit for underfloor heating not included in base scope.',
        amountMin: 720,
        amountMax: 1180,
        confidence: 0.66,
        risks: ['Confirm thermostat location and electrical loading.', 'Verify floor build-up tolerance before install.'],
      };
      proposedActions.push({
        action: 'assessExtraFromPhotos',
        input: {},
        output: {
          ...mockExtra,
          tradeId: firstString(body.projectContext?.tradeId, body.staffContext?.tradeId) ?? 'general',
          photoCount: 2,
          proposeChangeOrder: buildChangeOrderFromAssessment(mockExtra, body.projectContext),
        },
      });
      proposedActions.push({
        action: 'proposeChangeOrder',
        input: {},
        output: buildChangeOrderFromAssessment(mockExtra, body.projectContext),
      });
    }

    if (
      lower.includes('assess progress')
      || lower.includes('progress photo')
      || lower.includes('site progress')
    ) {
      const progressOutput = {
        snagList: ['Minor silicone touch-up needed at shower tray edge.'],
        suggestedTaskUpdates: [{ taskTitle: 'Second fix', status: 'in_progress', note: 'Visible fixtures now being installed.' }],
        summary: 'Photos show second-fix stage progressing with one minor snag.',
      };
      proposedActions.push({
        action: 'assessProgress',
        input: {},
        output: progressOutput,
      });
      proposedActions.push({
        action: 'updateTaskStatus',
        input: {},
        output: { taskTitle: 'Second fix', status: 'in_progress' },
      });
    }
  }

  if (lower.includes('search customer') || lower.includes('find customer') || lower.includes('lookup customer')) {
    proposedActions.push({
      action: 'searchCustomers',
      input: {},
      output: { query: extractSearchQuery(userMessage, 'customer'), limit: 10 },
    });
  }
  if (lower.includes('search project') || lower.includes('find project') || lower.includes('lookup project')) {
    proposedActions.push({
      action: 'searchProjects',
      input: {},
      output: { query: extractSearchQuery(userMessage, 'project'), limit: 10 },
    });
  }
  if (lower.includes('search quote') || lower.includes('find quote') || lower.includes('lookup quote')) {
    proposedActions.push({
      action: 'searchQuotes',
      input: {},
      output: { query: extractSearchQuery(userMessage, 'quote'), limit: 10 },
    });
  }
  if (lower.includes('go to') || lower.includes('open ') || lower.includes('navigate')) {
    const route = inferRouteFromText(lower);
    if (route) {
      proposedActions.push({
        action: 'navigateTo',
        input: {},
        output: { route, reason: 'Inferred from user navigation intent' },
      });
    }
  }

  const staffRole = body.staffContext?.role ?? body.customerContext?.role;
  if (staffRole === 'customer') {
    const customerActions = proposedActions.filter((a) =>
      ['lookupQuote', 'lookupProjectStatus', 'getPortalLink', 'escalateToStaff'].includes(a.action)
    );
    const autoActions = customerActions.filter((a) => AUTO_ACTION_NAMES.has(a.action));
    return applyRoleGate(body, {
      content: customerActions.length
        ? 'Right — here is what I found for you.'
        : 'How can I help with your quote or project today?',
      proposedActions: customerActions.filter((a) => !AUTO_ACTION_NAMES.has(a.action)),
      autoActions,
      detectedTrades: [],
    });
  }

  const filteredStaff = proposedActions.filter((a) => a.action !== 'detectTrades');
  const primaryOnly = filteredStaff;

  const autoActions = primaryOnly.filter(action => AUTO_ACTION_NAMES.has(action.action));
  const summaryText = buildActionsSummaryText(primaryOnly);
  if (primaryOnly.length > 0) {
    return applyRoleGate(body, {
      content: detectedTrades.length > 0
        ? `Right then — I've picked up ${detectedTrades.map((d) => d.tradeId).join(' and ')}. ${summaryText}`
        : summaryText || 'Sorted — here is what I suggest.',
      proposedActions: primaryOnly.filter((a) => !AUTO_ACTION_NAMES.has(a.action)),
      autoActions,
      detectedTrades,
    });
  }

  return applyRoleGate(body, {
    content: 'Demo mode — configure OpenAI in Settings → Integrations for full answers. Try asking about a quote, customer, or bathroom job.',
    proposedActions: [],
    autoActions: [],
    detectedTrades,
  });
}

type OpenAIChatClient = {
  chat: {
    completions: {
      create: (input: Record<string, unknown>) => Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments?: string };
            }>;
          };
        }>;
      }>;
    };
  };
};

async function runCustomerOrchestrator(
  openai: OpenAIChatClient,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): Promise<OrchestratorResult> {
  const model = body.model ?? 'gpt-4o-mini';
  const tools = getToolsForMode(resolveMode(body), body);
  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: resolveSystemPrompt(body) },
    ...messages.map((message) => ({
      role: toMessageRole(message.role),
      content: message.content,
    })),
  ];
  const proposedActions: OrchestratorAction[] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 900,
    });
    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls ?? [];

    if (!toolCalls.length) {
      finalContent = choice?.content ?? null;
      break;
    }

    chatMessages.push({
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const parsedInput = safeParseObject(call.function.arguments);
      const output = await executeServerReadTool(call.function.name, parsedInput, body);
      proposedActions.push({
        action: call.function.name,
        input: parsedInput,
        output,
      });
      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalContent) {
    const summaryPass = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        {
          role: 'user',
          content: 'Reply in warm, concise UK English using the tool results above. Keep it customer-friendly (2-4 sentences).',
        },
      ],
      max_tokens: 700,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  const autoActions = proposedActions.filter((action) => AUTO_ACTION_NAMES.has(action.action));
  const clientProposed = proposedActions.filter((action) => !AUTO_ACTION_NAMES.has(action.action));

  return applyRoleGate(body, {
    content: finalContent ?? 'How can I help with your project today?',
    proposedActions: clientProposed,
    autoActions: autoActions.length ? autoActions : proposedActions,
    detectedTrades: [],
  });
}

async function runPhoneOrchestrator(
  openai: OpenAIChatClient,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): Promise<OrchestratorResult> {
  const model = body.model ?? 'gpt-4o-mini';
  const tools = getToolsForMode('phone', body);
  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: resolveSystemPrompt(body) },
    ...messages.map((message) => ({
      role: toMessageRole(message.role),
      content: message.content,
    })),
  ];
  const proposedActions: OrchestratorAction[] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 400,
    });
    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls ?? [];

    if (!toolCalls.length) {
      finalContent = choice?.content ?? null;
      break;
    }

    chatMessages.push({
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const parsedInput = safeParseObject(call.function.arguments);
      const toolName = call.function.name;
      let output: Record<string, unknown>;

      if (SERVER_READ_TOOLS.has(toolName)) {
        output = await executeServerReadTool(toolName, parsedInput, body);
      } else if (['lookupQuote', 'lookupProjectStatus', 'getPortalLink', 'escalateToStaff'].includes(toolName)) {
        output = executeCustomerTool(toolName, parsedInput, body);
      } else {
        output = executePhoneTool(toolName, parsedInput, body);
      }

      proposedActions.push({ action: toolName, input: parsedInput, output });
      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalContent) {
    const summaryPass = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        {
          role: 'user',
          content: 'Reply in warm, concise UK English for a phone call. Maximum 2-3 short sentences. No markdown or lists.',
        },
      ],
      max_tokens: 200,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  const autoActions = proposedActions.filter((action) => AUTO_ACTION_NAMES.has(action.action));
  const clientProposed = proposedActions.filter((action) => !AUTO_ACTION_NAMES.has(action.action));

  return applyRoleGate(body, {
    content: finalContent ?? 'How can I help you today?',
    proposedActions: clientProposed,
    autoActions,
    detectedTrades: [],
  });
}

export async function handleOrchestrator(body: OrchestratorRequest): Promise<OrchestratorResult> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages[messages.length - 1]?.content ?? '';
  const { mapOpenAIError, createOpenAIClientForOrg } = await import('./openai-connection');
  const { resolveOrgIdFromBody } = await import('./org-context');
  const orgId = resolveOrgIdFromBody(body as { orgId?: string });
  const mode = resolveMode(body);

  if (getRequestRole(body) === 'customer' && /invoice|send bill|payment request|draft invoice/i.test(lastMessage)) {
    return applyRoleGate(body, {
      content: "That's one for the office — I've flagged it for the team. They'll sort invoices and payments.",
      proposedActions: [],
      autoActions: [],
      detectedTrades: [],
    });
  }

  try {
    const openai = await createOpenAIClientForOrg(orgId, '/api/ai/orchestrate', body.apiKey);

    if (mode === 'customer' || mode === 'cyrus') {
      return await runCustomerOrchestrator(openai as unknown as Parameters<typeof runCustomerOrchestrator>[0], body, messages);
    }

    if (mode === 'phone') {
      return await runPhoneOrchestrator(openai as unknown as Parameters<typeof runCustomerOrchestrator>[0], body, messages);
    }

    return await runStaffOrchestrator(openai as unknown as Parameters<typeof runStaffOrchestrator>[0], body, messages);
  } catch (err) {
    throw mapOpenAIError(err);
  }
}

async function runStaffOrchestrator(
  openai: OpenAIChatClient,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): Promise<OrchestratorResult> {
  const model = body.model ?? 'gpt-4o-mini';
  const mode = resolveMode(body);
  const lastMessage = messages[messages.length - 1]?.content ?? '';
  const autonomy = body.aiStudio?.autonomyLevel ?? 'balanced';
  const classification = classifyTaskIntent(lastMessage, body, messages);

  if (
    !isProceedMessage(lastMessage)
    && !body.pendingTask
    && shouldClarifyBeforeExecute(classification, autonomy, body, lastMessage)
  ) {
    const pendingTaskId = `task-${Date.now()}`;
    const intro = buildClarifyIntro(classification.summary, body.aiStudio?.humourLevel);
    const numbered = classification.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    return applyRoleGate(body, {
      content: `${intro}\n\n${numbered}`,
      proposedActions: [],
      autoActions: [],
      detectedTrades: [],
      phase: 'clarify',
      clarifyingQuestions: classification.questions,
      taskSummary: classification.summary,
      pendingTaskId,
    });
  }

  const tools = getToolsForMode(mode, body);
  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: resolveSystemPrompt(body) },
    ...messages.map((message) => ({
      role: toMessageRole(message.role),
      content: message.content,
    })),
  ];
  const proposedActions: OrchestratorAction[] = [];
  let detectedTrades: OrchestratorResult['detectedTrades'] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 1500,
    });
    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls ?? [];

    if (!toolCalls.length) {
      finalContent = choice?.content ?? null;
      break;
    }

    chatMessages.push({
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const parsedInput = safeParseObject(call.function.arguments);
      const toolName = call.function.name;
      let output: Record<string, unknown>;

      if (SERVER_READ_TOOLS.has(toolName)) {
        output = await executeServerReadTool(toolName, parsedInput, body);
      } else {
        output = toolName === 'updateLeadStatus'
          ? executeUpdateLeadStatus(parsedInput)
          : parsedInput;
        const executedOutput = await executeVisionTool(
          toolName,
          parsedInput,
          body,
          body.apiKey ?? process.env.OPENAI_API_KEY ?? ''
        );
        if (executedOutput) output = executedOutput;
        proposedActions.push({ action: toolName, input: parsedInput, output });
      }

      if (toolName === 'detectTrades' && Array.isArray(output.trades)) {
        detectedTrades = (output.trades as Array<{ tradeId?: string; confidence?: number; reason?: string }>).filter(
          (trade) => trade.tradeId && isValidServerTradeId(trade.tradeId)
        ) as OrchestratorResult['detectedTrades'];
      }

      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalContent) {
    const actionSummary = buildActionsSummaryText(proposedActions);
    const summaryPass = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        {
          role: 'user',
          content: `Summarise what you found or did in warm conversational UK English. Tool results:\n${actionSummary}\nInclude cost breakdowns as markdown tables when relevant.`,
        },
      ],
      max_tokens: 900,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  const autoActions = proposedActions.filter((action) => AUTO_ACTION_NAMES.has(action.action));
  const clientProposed = proposedActions.filter((action) => !AUTO_ACTION_NAMES.has(action.action));

  return applyRoleGate(body, {
    content: finalContent ?? buildActionsSummaryText(proposedActions) ?? 'How can I help with your quote or project today?',
    proposedActions: clientProposed,
    autoActions,
    detectedTrades,
    phase: proposedActions.length > 0 ? 'execute' : 'chat',
  });
}
