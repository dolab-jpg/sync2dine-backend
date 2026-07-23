/**
 * 12-tool web domain facade (AI_TOOL_FACADE feature flag, default OFF).
 *
 * Each facade tool exposes a flat `type: object` parameter schema with an
 * `operation` string enum inside `properties` (never top-level oneOf/anyOf/enum,
 * which sanitizeToolsForOpenAI strips), a few common id fields, and a generic
 * `payload` object carrying the operation-specific write fields.
 *
 * expandFacadeCall() translates a facade call back to the CANONICAL action
 * name + flat args BEFORE role-permission filtering, AUTO_ACTION_NAMES checks,
 * and action splitting — so every existing gate (approveQuote manager gate,
 * sendContract confirmation, etc.) operates on canonical names exactly as it
 * does today. Phone / customer / cyrus modes never receive facade tools.
 */
import { PLANNING_ACTION_NAMES } from './planning-tools';

export function isFacadeEnabled(): boolean {
  return process.env.AI_TOOL_FACADE === 'true';
}

/** Modes that receive the facade when the flag is on. Phone and customer/cyrus are excluded. */
export const FACADE_WEB_STAFF_MODES = new Set(['staff', 'project', 'foreman', 'planning']);

type OperationMap = Readonly<Record<string, string>>;

const SEARCH_RECORDS_OPS: OperationMap = {
  customers: 'searchCustomers',
  projects: 'searchProjects',
  quotes: 'searchQuotes',
  leads: 'searchLeads',
  emails: 'searchEmails',
  businessSnapshot: 'getBusinessSnapshot',
  teamPerformance: 'getTeamPerformance',
  readCollection: 'readData',
  projectProfit: 'getProjectProfit',
  costBreakdown: 'getCostBreakdown',
};

const MANAGE_CUSTOMER_OPS: OperationMap = {
  link: 'linkCustomer',
  updateLead: 'updateLeadStatus',
  logFollowUp: 'logFollowUp',
  merge: 'mergeCustomers',
};

const MANAGE_QUOTE_OPS: OperationMap = {
  detectTrades: 'detectTrades',
  proposeFields: 'proposeQuoteFields',
  start: 'startQuote',
  save: 'saveQuote',
  update: 'updateQuote',
  addLines: 'addQuoteLines',
  updateLines: 'updateQuoteLines',
  duplicate: 'duplicateQuote',
  archive: 'archiveQuote',
  priceSmallJob: 'priceSmallJob',
  submitApproval: 'submitForApproval',
};

const MANAGE_PRICING_OPS: OperationMap = {
  approve: 'approveQuote',
  reject: 'rejectQuote',
  paymentSchedule: 'generatePaymentSchedule',
};

const MANAGE_CONTRACT_OPS: OperationMap = {
  draftQuote: 'draftQuote',
  generateQuotePdf: 'generateQuotePdf',
  draft: 'draftContract',
  save: 'saveContract',
  send: 'sendContract',
  generatePdf: 'generateContractPdf',
};

const MANAGE_PROJECT_OPS: OperationMap = {
  convertFromQuote: 'convertQuoteToProject',
  paymentPlan: 'proposePaymentPlan',
  schedule: 'proposeSchedule',
  changeOrder: 'proposeChangeOrder',
  handover: 'completeHandover',
  assignContractor: 'assignContractor',
  close: 'closeProject',
  markPaid: 'markPaymentReceived',
  // NOTE: the plan named sendClientReceipt, but the backend canonical name is
  // draftClientReceipt (schema + role permissions); the client alias table
  // routes it to the sendClientReceipt executor. Mapping to draftClientReceipt
  // keeps filterActionsForRole intact.
  receipt: 'draftClientReceipt',
};

const SITE_OPERATIONS_OPS: OperationMap = {
  builderBrief: 'sendBuilderBrief',
  contractorBrief: 'sendContractorBrief',
  plan: 'proposePlan',
  paymentGate: 'checkPaymentGate',
  sitePhotos: 'requestSitePhotos',
  taskStatus: 'updateTaskStatus',
  tagPhoto: 'tagPhoto',
  assessProgress: 'assessProgress',
  assessExtra: 'assessExtraFromPhotos',
  logBuilderReply: 'logBuilderReply',
  logBuilderPrice: 'logBuilderPrice',
  recordCost: 'recordCostEntry',
  logHours: 'logHours',
  fixCost: 'fixCostEntry',
  correctTimesheet: 'correctTimesheet',
  supplierOrder: 'draftSupplierOrder',
};

const MANAGE_INVOICES_OPS: OperationMap = {
  draft: 'draftInvoice',
  generatePdf: 'generateInvoicePdf',
  send: 'sendInvoice',
};

const MANAGE_PAYMENTS_OPS: OperationMap = {
  categorizeTxn: 'categorizeTransaction',
  matchTxn: 'matchTransactionToProject',
  flagTxn: 'flagTransaction',
  refund: 'processRefund',
  initiate: 'initiatePayment',
  subscription: 'manageSubscription',
};

const SEND_MESSAGE_OPS: OperationMap = {
  draftCustomer: 'draftCustomerMessage',
  draftBuilder: 'draftBuilderMessage',
  notifyChangeOrder: 'notifyCustomerChangeOrder',
  emailDraft: 'draftEmailReply',
  emailSend: 'sendEmailReply',
  emailAttach: 'sendEmailWithAttachment',
  sms: 'sendSms',
  whatsappTemplate: 'sendWhatsAppTemplate',
  whatsappMedia: 'sendWhatsAppMedia',
  callOutbound: 'placeOutboundCall',
};

/** Planning keeps the existing 17 operation names verbatim, mapped 1:1. */
const MANAGE_PLANNING_OPS: OperationMap = Object.fromEntries(
  PLANNING_ACTION_NAMES.map((name) => [name, name])
);

const APP_CONTROL_OPS: OperationMap = {
  navigate: 'navigate',
  staffCard: 'sendToStaffCynthia',
  report: 'generateOpsReport',
  calendarEvent: 'createCalendarEvent',
  reminder: 'createReminder',
  files: 'manageFiles',
  codeFix: 'requestCodeFix',
  escalate: 'escalateToStaff',
  portalLink: 'getPortalLink',
  writeData: 'writeData',
};

export const FACADE_OPERATION_MAP: Readonly<Record<string, OperationMap>> = {
  searchRecords: SEARCH_RECORDS_OPS,
  manageCustomer: MANAGE_CUSTOMER_OPS,
  manageQuote: MANAGE_QUOTE_OPS,
  managePricing: MANAGE_PRICING_OPS,
  manageContract: MANAGE_CONTRACT_OPS,
  manageProject: MANAGE_PROJECT_OPS,
  siteOperations: SITE_OPERATIONS_OPS,
  manageInvoices: MANAGE_INVOICES_OPS,
  managePayments: MANAGE_PAYMENTS_OPS,
  sendMessage: SEND_MESSAGE_OPS,
  managePlanning: MANAGE_PLANNING_OPS,
  appControl: APP_CONTROL_OPS,
};

export const FACADE_TOOL_NAMES = Object.keys(FACADE_OPERATION_MAP);

export function isFacadeToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FACADE_OPERATION_MAP, name);
}

type JsonSchema = Record<string, unknown>;

function operationProperty(map: OperationMap): JsonSchema {
  return {
    type: 'string',
    enum: Object.keys(map),
    description: 'Which operation to run — see the tool description for each operation\u2019s payload fields.',
  };
}

const PAYLOAD_PROPERTY: JsonSchema = {
  type: 'object',
  description: 'Operation-specific fields as documented in the tool description. Put all write/detail fields here.',
};

function facadeTool(
  name: string,
  description: string,
  map: OperationMap,
  idProperties: Record<string, JsonSchema> = {}
) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          operation: operationProperty(map),
          ...idProperties,
          payload: PAYLOAD_PROPERTY,
        },
        required: ['operation'],
      },
    },
  };
}

const ID = (description: string): JsonSchema => ({ type: 'string', description });

export const FACADE_TOOLS = [
  facadeTool(
    'searchRecords',
    `Read/search business records. Operations and payload fields:
- customers: search customers — payload { query (required), limit }.
- projects: search projects — payload { query (required), customerId, status, limit }.
- quotes: search quotes — payload { query, customerId, tradeId, status, limit }.
- leads: search CRM leads — payload { query, status (lead|quoted|won|lost), source, limit }.
- emails: search connected mailbox — payload { query, from, dateFrom, dateTo, limit, connectionId }.
- businessSnapshot: live counts of customers/quotes/projects/team — no payload.
- teamPerformance: office team roster + sales metrics (managers/admins only) — no payload.
- readCollection: read any app collection — payload { collection (required: customers|quotes|products|pricingRules|projects|builders|recruitmentAccess), query, id, limit }.
- projectProfit: profit summary — payload { projectId or projectName }.
- costBreakdown: detailed costs/receipts/timesheets — payload { projectId or projectName }.`,
    SEARCH_RECORDS_OPS,
    {
      query: ID('Search text (for customers/projects/quotes/leads/emails/readCollection).'),
      projectId: ID('Project id for projectProfit/costBreakdown.'),
    }
  ),
  facadeTool(
    'manageCustomer',
    `Create/update customers and leads. Operations and payload fields:
- link: match or save a customer — payload { interestedTrades (required array), customerId OR name/email/phone/address, isNew }.
- updateLead: move a lead through the pipeline — payload { customerId (required), status (required: lead|quoted|won|lost), note }.
- logFollowUp: record a contact note — payload { customerId (required), note, nextFollowUp (ISO date) }.
- merge: merge duplicate customers (destructive, requires confirmation) — payload { keepCustomerId (required), mergeCustomerId (required) }.`,
    MANAGE_CUSTOMER_OPS,
    { customerId: ID('Customer id when known.') }
  ),
  facadeTool(
    'manageQuote',
    `Build and maintain quotes. Operations and payload fields:
- detectTrades: payload { trades (required array of { tradeId, confidence, reason }) }.
- proposeFields: stage wizard fields — payload { tradeId (required), fields (required object of { value, confidence, reason }) }.
- start: open the quote wizard — payload { tradeId (required), customerId, jobGroupId, prefillFields }.
- save: save a full quote — payload { customerId (required), tradeId, customerName, status, total, discount, items, labour, extras, wizardAnswers, openQuote }.
- update: change an existing quote — payload { quoteId, items, labour, extras, total, status }.
- addLines: add line items — payload { quoteId or customerId+tradeId, lines/items (array) }.
- updateLines: replace line items — payload { quoteId (required), lines/items (array), total }.
- duplicate: clone into a new draft — payload { quoteId (required) }.
- archive: archive a stale quote — payload { quoteId (required), reason }.
- priceSmallJob: price a handyman task list (creates awaiting_approval quote) — payload { tasks (required, text or array), customerId, customerName, tradeName, postcode }.
- submitApproval: send to manager approval queue — payload { quoteId }.`,
    MANAGE_QUOTE_OPS,
    { quoteId: ID('Quote id when known.'), customerId: ID('Customer id when known.') }
  ),
  facadeTool(
    'managePricing',
    `Price approval and payment schedules. Operations and payload fields:
- approve: MANAGER/ADMIN ONLY, requires human confirmation — payload { quoteId (required), total, note }.
- reject: MANAGER/ADMIN ONLY — payload { quoteId (required), note }.
- paymentSchedule: suggest stage payments for an approved total — payload { quoteId or total, tradeName }.`,
    MANAGE_PRICING_OPS,
    { quoteId: ID('Quote id.') }
  ),
  facadeTool(
    'manageContract',
    `Contracts and quote/contract PDFs. Operations and payload fields:
- draftQuote: present a quote draft in chat (no PDF yet) — payload { customerName (required), total (required), tradeName, notes, lineItems (array of { description, amount }) }.
- generateQuotePdf: quote PDF after the draft is confirmed — payload { customerName (required), total (required), tradeName, quoteId, lineItems }.
- draft: draft contract terms for the project — payload { terms (required) }.
- save: build a draft contract from an APPROVED quote — payload { quoteId (required), templateId, stages }.
- send: email the signing link to the customer (requires confirmation) — payload { contractId (required) }.
- generatePdf: contract-of-works PDF — payload { customerName (required), terms (required), total (required), projectName, contractId, projectId }.`,
    MANAGE_CONTRACT_OPS,
    { quoteId: ID('Quote id.'), contractId: ID('Contract id.') }
  ),
  facadeTool(
    'manageProject',
    `Project lifecycle. Operations and payload fields:
- convertFromQuote: turn a won quote into a live project (never writeData-create projects) — payload { quoteId or customerName, markQuoteAccepted, withPaymentPlan }.
- paymentPlan: payload { stages (required array of { name, percentage, amount, notes }) }.
- schedule: payload { tasks (required array of { title, description, assignedTo, targetDate, priority }), milestones, workingDaysOff }.
- changeOrder: payload { title (required), amount (required), description, amountMin, amountMax, reason, estimatedDays, photoIds }.
- handover: mark handover complete — payload { projectId, customerNotes, signedBy }.
- assignContractor: payload { projectId, contractorId or name, tradeId, trade }.
- close: close as completed or archived — payload { projectId (required), status (required: completed|archived), note }.
- markPaid: mark a payment stage received — payload { projectId, stageId or stageName, paidDate }.
- receipt: draft/send a client payment receipt — payload { transactionId (required), projectId (required), customerId (required), stageId, message }.`,
    MANAGE_PROJECT_OPS,
    { projectId: ID('Project id.'), quoteId: ID('Quote id (convertFromQuote).') }
  ),
  facadeTool(
    'siteOperations',
    `Site/foreman work: briefs, tasks, photos, labour, costs. Operations and payload fields:
- builderBrief: payload { builderName (required), body (required), channels (required array), projectId }.
- contractorBrief: payload { body (required), channels (required array), contractorId or tradeId, projectId }.
- plan: foreman plan — payload { cadence (required: daily|weekly|monthly), title (required), tasks (required), milestones (required) }.
- paymentGate: payload { stageName (required), evidenceNeeded (required array) }.
- sitePhotos: request photos — payload { taskTitle (required), deadline (required) }.
- taskStatus: payload { taskTitle (required), status (required: todo|in_progress|completed), targetDate }.
- tagPhoto: payload { caption (required), fileId, tags }.
- assessProgress: assess progress from photos — payload { photoIds, tradeId }.
- assessExtra: chargeable-extra check from photos — payload { builderNote (required), photoIds, tradeId }.
- logBuilderReply: payload { fromPhone (required), body (required), projectId }.
- logBuilderPrice: payload { priceQuoted (required number), builderName, notes }.
- recordCost: payload { supplier (required), total (required number), projectId, items, aiSummary, builderId }.
- logHours: payload { hours (required number), projectId, builderId, date, notes, rate }.
- fixCost: payload { entryId (required), supplier, total, items, notes, projectId }.
- correctTimesheet: payload { timesheetId (required), hours (required number), notes, rate, projectId }.
- supplierOrder: payload { supplierName (required), items (required array of { description, quantity, unit }), supplierEmail, deliveryAddress, projectId, send }.`,
    SITE_OPERATIONS_OPS,
    { projectId: ID('Project id.') }
  ),
  facadeTool(
    'manageInvoices',
    `Invoices. Operations and payload fields:
- draft: draft an invoice for a payment stage — payload { lineItems (required array of { description, amount }), total (required number), stageName }.
- generatePdf: invoice PDF — payload { customerName (required), total (required number), projectName, invoiceId, projectId, lineItems }.
- send: email an invoice PDF (requires confirmation) — payload { to (required), invoiceId, projectId, subject, body, customerName, projectName, total, lineItems, connectionId }.`,
    MANAGE_INVOICES_OPS,
    { projectId: ID('Project id.'), invoiceId: ID('Invoice id.') }
  ),
  facadeTool(
    'managePayments',
    `Bank transactions, refunds, payments, subscriptions. Operations and payload fields:
- categorizeTxn: payload { transactionId (required), category (required), reason (required), description, amount, direction (in|out) }.
- matchTxn: payload { transactionId (required), projectId (required), customerId, invoiceId, stageId }.
- flagTxn: payload { transactionId (required), reason (required), flagType (dispute|query|duplicate) }.
- refund: Stripe refund (MANAGERS ONLY, requires confirmation) — payload { paymentIntentId or chargeId, amount (major units), reason }.
- initiate: Open Banking payment (MANAGERS ONLY, requires confirmation) — payload { amount (required), beneficiaryName (required), sortCode (required), accountNumber (required), reference (required), currency }.
- subscription: cancel/change a SaaS subscription (admin, requires confirmation) — payload { action (required: cancel|upgrade|downgrade), subscriptionId, orgId, newPlanId (starter|pro|enterprise) }.`,
    MANAGE_PAYMENTS_OPS,
    { transactionId: ID('Bank transaction id.'), projectId: ID('Project id (matchTxn).') }
  ),
  facadeTool(
    'sendMessage',
    `Outbound communication. Operations and payload fields:
- draftCustomer: customer update draft — payload { body (required) }.
- draftBuilder: builder message draft — payload { subject (required), body (required), priceQuoted }.
- notifyChangeOrder: ask customer to review a change order — payload { changeOrderId (required) }.
- emailDraft: prepare an email for review (does not send) — payload { to (required), subject (required), body (required) }.
- emailSend: send an email (requires confirmation) — payload { to (required), subject (required), body (required), connectionId }.
- emailAttach: send email with base64 attachments (requires confirmation) — payload { to (required), subject (required), body (required), attachments (array of { filename, mimeType, content }), connectionId }.
- sms: send an SMS (requires confirmation) — payload { to (required), body (required) }.
- whatsappTemplate: approved WhatsApp template (requires confirmation) — payload { to (required), templateName (required), templateParams, language }.
- whatsappMedia: WhatsApp image/document (requires confirmation) — payload { to (required), mediaUrl (required), mediaType (required: image|document|video), caption, filename }.
- callOutbound: place a phone call (requires confirmation) — payload { to (required), customerName, reason }.`,
    SEND_MESSAGE_OPS,
    { to: ID('Recipient email address or phone number.') }
  ),
  facadeTool(
    'managePlanning',
    `Planning & Consents (operation names match the planning actions 1:1). Payload fields:
- updateApplication: { title, address, applicationType, description, customerName, customerEmail }.
- setStage: { stage (required) }. setPricing: { amount, scope }.
- sendPricingEmail / sendReviewEmail / sendCourtesyEmail / sendCouncilReply: { body (required), subject } — auto-send.
- logDrawing: { filename (required), note }. recordCouncil: { name, reference, portalUrl, validationOfficer, validationOfficerEmail, targetDecisionDate, submittedAt }.
- raiseChangeRequest: { description (required), deadline, sourceEmail, aiComment }. resolveChangeRequest: { changeRequestId or description }.
- setDeadline: { deadline (required ISO date), changeRequestId }. addComment: { body (required) }.
- portalStatusCheck: { note (required) }. markDecision: { decision (required: approved|refused), note }.
- generatePostApprovalTasks: { workstream (required: engineering|buildingRegs|buildOver), tasks (required array), notes }.
- convertToProject: no payload.`,
    MANAGE_PLANNING_OPS,
    { applicationId: ID('Planning application id when not implied by context.') }
  ),
  facadeTool(
    'appControl',
    `App navigation, staff cards, reports, reminders, files, escalation, generic writes. Operations and payload fields:
- navigate: go to any app route — payload { route (required, e.g. /crm, /quotes, /projects), reason }.
- staffCard: push a rich card to the staff Cynthia inbox — payload { title (required), customerName, phone, address, amount, summary, notes, quoteId, projectId, customerId, staffUserId }.
- report: operations report — payload { title (required), reportType (sales_week|pipeline|jobs_on_site|quotes_awaiting|custom), markdown }.
- calendarEvent: .ics invite — payload { title (required), start (required), end (required), location, attendees, description, sendEmailTo }.
- reminder: staff follow-up task — payload { title (required), dueDate (required), customerId, projectId, assignee, note }.
- files: list or delete project files — payload { action (required: list|delete), projectId (required), fileId, fileName }.
- codeFix: offer a Cursor-powered code fix — payload { description (required), errorCode, route }.
- escalate: escalate to office staff — payload { reason (required) }.
- portalLink: customer portal link — payload { projectId (required) }.
- writeData: create/update/delete a record — payload { collection (required), operation (required: create|update|delete), id (update/delete), data (create/update) }. Deletes require confirmation.`,
    APP_CONTROL_OPS,
    { route: ID('Target route for navigate.'), projectId: ID('Project id for files/portalLink.') }
  ),
];

/** Facade args that are routing metadata, not canonical executor fields. */
const NON_FORWARDED_KEYS = new Set(['operation', 'payload']);

export interface ExpandedFacadeCall {
  canonicalAction: string;
  canonicalArgs: Record<string, unknown>;
}

/**
 * Expand a facade tool call into its canonical action + flat args.
 * Returns null when `name` is not a facade tool or the operation is unknown.
 * Top-level id fields (quoteId, projectId, …) override payload values only
 * when they are defined and non-empty.
 */
export function expandFacadeCall(
  name: string,
  args: Record<string, unknown> | undefined
): ExpandedFacadeCall | null {
  const map = FACADE_OPERATION_MAP[name];
  if (!map) return null;
  const input = args ?? {};
  const operation = typeof input.operation === 'string' ? input.operation : '';
  const canonicalAction = map[operation];
  if (!canonicalAction) return null;

  const payload =
    input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const canonicalArgs: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(input)) {
    if (NON_FORWARDED_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    canonicalArgs[key] = value;
  }
  return { canonicalAction, canonicalArgs };
}
