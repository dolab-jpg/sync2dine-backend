/** Planning & Consents tool definitions shared by planning-ai-handler and orchestrator-handler. */

export const PLANNING_ACTION_NAMES = [
  'updateApplication',
  'setStage',
  'setPricing',
  'sendPricingEmail',
  'logDrawing',
  'sendReviewEmail',
  'recordCouncil',
  'raiseChangeRequest',
  'resolveChangeRequest',
  'setDeadline',
  'addComment',
  'portalStatusCheck',
  'sendCouncilReply',
  'sendCourtesyEmail',
  'markDecision',
  'generatePostApprovalTasks',
  'convertToProject',
] as const;

export type PlanningActionName = (typeof PLANNING_ACTION_NAMES)[number];

export const PLANNING_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'updateApplication',
      description: 'Update core fields on the planning application (title, address, applicationType, description, customer details).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          address: { type: 'string' },
          applicationType: {
            type: 'string',
            enum: ['householder', 'full', 'outline', 'lawful_development', 'listed_building', 'prior_approval'],
          },
          description: { type: 'string' },
          customerName: { type: 'string' },
          customerEmail: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'setStage',
      description: 'Set the display stage of the application. Stages are labels only; you may move to any stage in any order.',
      parameters: {
        type: 'object',
        properties: {
          stage: {
            type: 'string',
            enum: ['pricing', 'drawings', 'customer_approval', 'submitted', 'validation', 'changes_requested', 'approved', 'refused', 'post_approval', 'completed'],
          },
        },
        required: ['stage'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'setPricing',
      description: 'Set the planning-services price and scope for this application.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Fee in GBP' },
          scope: { type: 'string', description: 'What the planning service includes' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendPricingEmail',
      description: 'Draft and send the planning-services pricing/proposal email to the customer. Auto-sends.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'logDrawing',
      description: 'Record a drawing reference against the application (when a PDF has been produced externally).',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendReviewEmail',
      description: 'Draft and send the "please review and approve your drawings" email to the customer with their approval link. Auto-sends.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recordCouncil',
      description: 'Record council submission details: authority name, application reference, portal URL, validation officer, target decision date, submitted date.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Local Planning Authority name' },
          reference: { type: 'string', description: 'Council application reference' },
          portalUrl: { type: 'string' },
          validationOfficer: { type: 'string' },
          validationOfficerEmail: { type: 'string' },
          targetDecisionDate: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
          submittedAt: { type: 'string', description: 'ISO date the application was submitted' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'raiseChangeRequest',
      description: 'Log a change/amendment the validation team or planning officer has requested. Parse pasted council emails into one call per distinct change.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          deadline: { type: 'string', description: 'ISO date (YYYY-MM-DD) if a deadline is given' },
          sourceEmail: { type: 'string', description: 'Snippet of the source email if pasted' },
          aiComment: { type: 'string', description: 'Your suggested response / next action for this change' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'resolveChangeRequest',
      description: 'Mark an outstanding change request as resolved.',
      parameters: {
        type: 'object',
        properties: {
          changeRequestId: { type: 'string' },
          description: { type: 'string', description: 'Match by description if id unknown' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'setDeadline',
      description: 'Set a deadline on a specific change request, or the target decision date on the application.',
      parameters: {
        type: 'object',
        properties: {
          changeRequestId: { type: 'string' },
          deadline: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
        },
        required: ['deadline'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'addComment',
      description: 'Add a note/comment to the application timeline.',
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
      name: 'portalStatusCheck',
      description: 'You cannot browse the council portal directly. Use this to record a status-check note and remind staff to open the portal URL. Optionally draft what to look for.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string' },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendCouncilReply',
      description: 'Draft and send a reply to the validation team / planning officer. Auto-sends if an officer email is on file, otherwise logged.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendCourtesyEmail',
      description: 'Send a courtesy email to the customer before approval (e.g. "looks likely to be approved, come and view it"). Auto-sends.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'markDecision',
      description: 'Record the council decision on the application.',
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['approved', 'refused'] },
          note: { type: 'string' },
        },
        required: ['decision'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generatePostApprovalTasks',
      description: 'Create a post-approval checklist for a workstream: engineering (structural calcs), buildingRegs (Building Control), or buildOver (water-authority build-over agreement).',
      parameters: {
        type: 'object',
        properties: {
          workstream: { type: 'string', enum: ['engineering', 'buildingRegs', 'buildOver'] },
          tasks: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['workstream', 'tasks'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'convertToProject',
      description: 'After approval, spin up a live delivery project from this application.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export function isPlanningActionName(action: string): boolean {
  return (PLANNING_ACTION_NAMES as readonly string[]).includes(action);
}
