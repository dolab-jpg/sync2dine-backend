/**
 * Gap-closing orchestrator tools (G1–G30).
 * Additive schemas only — wired into getToolsForMode / AUTO_ACTION_NAMES.
 */
export const GAP_TOOL_NAMES = [
  // Wave 2 — revenue
  'generateInvoicePdf',
  'generateContractPdf',
  'sendQuote',
  'sendInvoice',
  'closeProject',
  'archiveQuote',
  // Wave 3 — CRM / comms
  'duplicateQuote',
  'createReminder',
  'schedulePaymentReminder',
  'mergeCustomers',
  'requestReview',
  'searchEmails',
  'sendSms',
  // Wave 4 — finance
  'processRefund',
  'flagTransaction',
  'exportReport',
  'manageSubscription',
  'initiatePayment',
  // Wave 5 — integrations
  'bulkUpdateLeadStatus',
  'scheduleRecurringJob',
  'sendWhatsAppTemplate',
  'sendWhatsAppMedia',
  'createCalendarEvent',
  'manageFiles',
  'draftSupplierOrder',
] as const;

export type GapToolName = (typeof GAP_TOOL_NAMES)[number];

export const GAP_AUTO_ACTIONS: readonly string[] = [
  'generateInvoicePdf',
  'generateContractPdf',
  'closeProject',
  'archiveQuote',
  'duplicateQuote',
  'createReminder',
  'schedulePaymentReminder',
  'requestReview',
  'searchEmails',
  'flagTransaction',
  'exportReport',
  'bulkUpdateLeadStatus',
  'scheduleRecurringJob',
  'createCalendarEvent',
  'manageFiles',
  'draftSupplierOrder',
];

/** Outbound / financial — require staff confirm */
export const GAP_SAFETY_CONFIRM_ACTIONS: readonly string[] = [
  'sendQuote',
  'sendInvoice',
  'mergeCustomers',
  'sendSms',
  'processRefund',
  'manageSubscription',
  'initiatePayment',
  'sendWhatsAppTemplate',
  'sendWhatsAppMedia',
];

export const GAP_CLOSING_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'generateInvoicePdf',
      description: 'Generate a multi-page invoice PDF for a project payment stage or draft invoice',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          projectName: { type: 'string' },
          total: { type: 'number' },
          invoiceId: { type: 'string' },
          projectId: { type: 'string' },
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
      name: 'generateContractPdf',
      description: 'Generate a contract-of-works PDF from terms and agreed value',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          projectName: { type: 'string' },
          terms: { type: 'string' },
          total: { type: 'number' },
          contractId: { type: 'string' },
          projectId: { type: 'string' },
        },
        required: ['customerName', 'terms', 'total'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendQuote',
      description: 'Email a quote PDF to the customer (generates PDF then sends via connected mailbox). Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          customerName: { type: 'string' },
          total: { type: 'number' },
          tradeName: { type: 'string' },
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
          connectionId: { type: 'string' },
        },
        required: ['to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendInvoice',
      description: 'Email an invoice PDF to the customer. Requires confirmation.',
      parameters: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string' },
          projectId: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          customerName: { type: 'string' },
          projectName: { type: 'string' },
          total: { type: 'number' },
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
          connectionId: { type: 'string' },
        },
        required: ['to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'closeProject',
      description: 'Close a live project as completed or archived (cancelled)',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'archived'] },
          note: { type: 'string' },
        },
        required: ['projectId', 'status'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'archiveQuote',
      description: 'Archive a stale quote so it no longer appears in active pipelines',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['quoteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'duplicateQuote',
      description: 'Clone an existing quote into a new draft for revisions',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
        },
        required: ['quoteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'createReminder',
      description: 'Create a follow-up reminder/task for staff',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dueDate: { type: 'string' },
          customerId: { type: 'string' },
          projectId: { type: 'string' },
          assignee: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['title', 'dueDate'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedulePaymentReminder',
      description: 'Schedule a reminder for a project payment stage',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          stageName: { type: 'string' },
          reminderDate: { type: 'string' },
          channel: { type: 'string', enum: ['email', 'whatsapp', 'sms', 'call'] },
        },
        required: ['projectId', 'stageName', 'reminderDate'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'mergeCustomers',
      description: 'Merge duplicate CRM customers into one keep record (destructive — requires confirmation)',
      parameters: {
        type: 'object',
        properties: {
          keepCustomerId: { type: 'string' },
          mergeCustomerId: { type: 'string' },
        },
        required: ['keepCustomerId', 'mergeCustomerId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'requestReview',
      description: 'Ask a customer for a post-completion review or testimonial',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          customerId: { type: 'string' },
          channel: { type: 'string', enum: ['email', 'whatsapp', 'sms'] },
          message: { type: 'string' },
          to: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'searchEmails',
      description: 'Search connected mailbox by keyword, sender, or date range',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          from: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          limit: { type: 'number' },
          connectionId: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendSms',
      description: 'Send an SMS via Twilio (requires confirmation)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'processRefund',
      description: 'Refund a Stripe payment (managers only — requires confirmation)',
      parameters: {
        type: 'object',
        properties: {
          paymentIntentId: { type: 'string' },
          chargeId: { type: 'string' },
          amount: { type: 'number', description: 'Amount in major currency units (e.g. GBP pounds)' },
          reason: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'flagTransaction',
      description: 'Flag a bank transaction as dispute, query, or duplicate',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          reason: { type: 'string' },
          flagType: { type: 'string', enum: ['dispute', 'query', 'duplicate'] },
        },
        required: ['transactionId', 'reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'exportReport',
      description: 'Export a CSV (or markdown PDF-ready) business report',
      parameters: {
        type: 'object',
        properties: {
          reportType: { type: 'string', enum: ['projects', 'quotes', 'costs', 'leads', 'customers'] },
          format: { type: 'string', enum: ['csv', 'markdown'] },
          limit: { type: 'number' },
        },
        required: ['reportType'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manageSubscription',
      description: 'Cancel or change a SaaS Stripe subscription for an organisation (admin)',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['cancel', 'upgrade', 'downgrade'] },
          subscriptionId: { type: 'string' },
          orgId: { type: 'string' },
          newPlanId: { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'initiatePayment',
      description: 'Initiate an Open Banking (TrueLayer) payment to a beneficiary (managers — confirmation required)',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          beneficiaryName: { type: 'string' },
          sortCode: { type: 'string' },
          accountNumber: { type: 'string' },
          reference: { type: 'string' },
          currency: { type: 'string' },
        },
        required: ['amount', 'beneficiaryName', 'sortCode', 'accountNumber', 'reference'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bulkUpdateLeadStatus',
      description: 'Update pipeline status for multiple leads at once',
      parameters: {
        type: 'object',
        properties: {
          customerIds: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['lead', 'quoted', 'won', 'lost'] },
          note: { type: 'string' },
        },
        required: ['customerIds', 'status'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scheduleRecurringJob',
      description: 'Attach a recurring maintenance/works cadence to a project',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          cadence: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] },
          scope: { type: 'string' },
          nextDate: { type: 'string' },
        },
        required: ['projectId', 'cadence', 'scope'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendWhatsAppTemplate',
      description: 'Send an approved WhatsApp HSM template message (requires confirmation)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          templateName: { type: 'string' },
          templateParams: { type: 'array', items: { type: 'string' } },
          language: { type: 'string' },
        },
        required: ['to', 'templateName'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sendWhatsAppMedia',
      description: 'Send an image or document via WhatsApp (requires confirmation)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          mediaUrl: { type: 'string' },
          caption: { type: 'string' },
          mediaType: { type: 'string', enum: ['image', 'document', 'video'] },
          filename: { type: 'string' },
        },
        required: ['to', 'mediaUrl', 'mediaType'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'createCalendarEvent',
      description: 'Create a calendar invite (.ics) and optionally email it to attendees',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          location: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          sendEmailTo: { type: 'string' },
        },
        required: ['title', 'start', 'end'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manageFiles',
      description: 'List or delete project files (upload is done via UI /api/files/upload)',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'delete'] },
          projectId: { type: 'string' },
          fileId: { type: 'string' },
          fileName: { type: 'string' },
        },
        required: ['action', 'projectId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'draftSupplierOrder',
      description: 'Draft (and optionally email) a materials order to a supplier',
      parameters: {
        type: 'object',
        properties: {
          supplierName: { type: 'string' },
          supplierEmail: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                quantity: { type: 'number' },
                unit: { type: 'string' },
              },
            },
          },
          deliveryAddress: { type: 'string' },
          projectId: { type: 'string' },
          send: { type: 'boolean' },
        },
        required: ['supplierName', 'items'],
      },
    },
  },
];
