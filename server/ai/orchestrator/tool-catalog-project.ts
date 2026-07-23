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

export const PROJECT_TOOLS = [
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

export const FOREMAN_TOOLS = [
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

export const COSTING_TOOLS = [
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

export const ACCOUNTS_TOOLS = [
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

export const EMAIL_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'listRecentEmails',
      description: 'List recent emails from the connected mailbox inbox',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          connectionId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'getEmailThread',
      description: 'Get full email thread by threadId or messageId',
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          messageId: { type: 'string' },
          connectionId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftEmailReply',
      description: 'Prepare an email draft without sending (for user review)',
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
      description: 'Send an email reply from the connected mailbox',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          connectionId: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendEmailWithAttachment',
      description: 'Send email with base64 attachment from connected mailbox',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          connectionId: { type: 'string' },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filename: { type: 'string' },
                mimeType: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftQuote',
      description:
        'Present a structured quote draft in chat for staff review. Do NOT generate a PDF. Use this before generateQuotePdf so the user can confirm line items and totals.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          total: { type: 'number' },
          tradeName: { type: 'string' },
          notes: { type: 'string' },
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
        },
        required: ['customerName', 'total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generateQuotePdf',
      description:
        'Generate a multi-page quote PDF for Cynthia after the user has confirmed the draft in chat. Do not call until the user says the draft looks good.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          total: { type: 'number' },
          tradeName: { type: 'string' },
          quoteId: { type: 'string' },
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
        },
        required: ['customerName', 'total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generateOpsReport',
      description: 'Create an operations report (sales, pipeline, jobs) for Cynthia chat',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          reportType: {
            type: 'string',
            enum: ['sales_week', 'pipeline', 'jobs_on_site', 'quotes_awaiting', 'custom'],
          },
          markdown: { type: 'string', description: 'Optional pre-written report body in markdown' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'placeOutboundCall',
      description: 'Place an outbound phone call to a customer (requires staff confirmation)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          customerName: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendToStaffCynthia',
      description:
        'Push a rich card (address, amount, Call) into the staff Cynthia APK inbox — use when staff say send it to me',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          customerName: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          amount: { type: 'number' },
          summary: { type: 'string' },
          notes: { type: 'string' },
          quoteId: { type: 'string' },
          projectId: { type: 'string' },
          customerId: { type: 'string' },
          staffUserId: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'requestCodeFix',
      description: 'Offer a Cursor-powered code fix for a bug reported in chat',
      parameters: {
        type: 'object',
        properties: {
          errorCode: { type: 'string' },
          description: { type: 'string' },
          route: { type: 'string' },
        },
        required: ['description'],
      },
    },
  },
];

