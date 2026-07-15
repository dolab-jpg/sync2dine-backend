export type ServerAgentRole =
  | 'platform_owner'
  | 'super_admin'
  | 'manager'
  | 'staff'
  | 'builder'
  | 'recruitment'
  | 'customer'
  | 'agent'
  | 'unknown';

export function isGenericTool(action: string): boolean {
  return action === 'readData' || action === 'writeData' || action === 'navigate';
}

const GENERIC_ACTIONS = new Set(['readData', 'writeData', 'navigate']);

const CUSTOMER_SELF_SERVICE = new Set([
  'lookupQuote',
  'lookupProjectStatus',
  'getPortalLink',
  'escalateToStaff',
  'navigateTo',
  'approveChangeOrder',
  'rejectChangeOrder',
  'sendPaymentLink',
  'bookSurvey',
  'confirmHandover',
  'confirmContract',
]);

const SALES_QUOTING = new Set([
  'detectTrades',
  'proposeQuoteFields',
  'linkCustomer',
  'saveCustomer',
  'startQuote',
  'saveQuote',
  'updateQuote',
  'convertQuoteToProject',
  'searchCustomers',
  'searchProjects',
  'searchQuotes',
  'searchLeads',
  'updateLeadStatus',
  'logFollowUp',
  'addQuoteLines',
  'updateQuoteLines',
  'getBusinessSnapshot',
  'navigateTo',
]);

const MANAGER_INSIGHTS = new Set([
  'getTeamPerformance',
]);

const PROJECT_PM = new Set([
  'proposePaymentPlan',
  'savePaymentPlan',
  'proposeSchedule',
  'saveProjectSchedule',
  'proposePlan',
  'updateProject',
  'checkPaymentGate',
  'draftContract',
  'proposeChangeOrder',
  'updateTaskStatus',
  'completeHandover',
  'assignContractor',
  'markPaymentReceived',
]);

const FINANCIAL = new Set([
  'draftInvoice',
  'draftCustomerMessage',
  'draftBuilderMessage',
  'notifyCustomerChangeOrder',
]);

const CONTRACTS_PRICING = new Set([
  'priceSmallJob',
  'submitForApproval',
  'generatePaymentSchedule',
  'saveContract',
  'sendContract',
]);

const APPROVALS = new Set([
  'approveQuote',
  'rejectQuote',
]);

const FOREMAN = new Set([
  'sendBuilderBrief',
  'sendContractorBrief',
  'requestSitePhotos',
  'relayCustomerUpdate',
  'logBuilderReply',
  'logBuilderPrice',
  'tagPhoto',
  'assessExtraFromPhotos',
  'assessProgress',
]);

const COSTING = new Set([
  'recordCostEntry',
  'fixCostEntry',
  'logHours',
  'correctTimesheet',
]);

const PHONE_RECEPTION = new Set([
  'classifyCallIntent',
  'captureLead',
  'bookCallback',
  'scheduleAppointment',
  'screenCandidate',
  'bookInterview',
  'logCandidate',
  'transferToHuman',
  'enqueueOutboundCall',
  'captureMessage',
  'sendToStaffCynthia',
  'saveCustomer',
  'linkCustomer',
  'detectTrades',
  'indicativeEstimate',
]);

const RECRUITMENT = new Set([
  'screenCandidate',
  'bookInterview',
  'logCandidate',
]);

const COSTING_ADMIN = new Set([
  'getCostBreakdown',
  'getProjectProfit',
]);

const ACCOUNTS = new Set([
  'categorizeTransaction',
  'matchTransactionToProject',
  'draftClientReceipt',
]);

const CYNTHIA_OPS = new Set([
  'generateQuotePdf',
  'generateOpsReport',
  'placeOutboundCall',
  'sendToStaffCynthia',
  'sendEmailReply',
  'sendEmailWithAttachment',
  'requestCodeFix',
]);

const PLANNING = new Set([
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
]);

const ROLE_ACTIONS: Record<ServerAgentRole, Set<string>> = {
  customer: new Set([...CUSTOMER_SELF_SERVICE]),
  agent: new Set([...CUSTOMER_SELF_SERVICE, ...PHONE_RECEPTION, ...RECRUITMENT]),
  staff: new Set([...CUSTOMER_SELF_SERVICE, ...SALES_QUOTING, ...PROJECT_PM, ...FINANCIAL, ...FOREMAN, ...COSTING, ...ACCOUNTS, ...PHONE_RECEPTION, ...CONTRACTS_PRICING, ...PLANNING, ...CYNTHIA_OPS]),
  manager: new Set([...CUSTOMER_SELF_SERVICE, ...SALES_QUOTING, ...PROJECT_PM, ...FINANCIAL, ...FOREMAN, ...COSTING, ...COSTING_ADMIN, ...ACCOUNTS, ...PHONE_RECEPTION, ...RECRUITMENT, ...CONTRACTS_PRICING, ...APPROVALS, ...MANAGER_INSIGHTS, ...PLANNING, ...CYNTHIA_OPS]),
  super_admin: new Set([...CUSTOMER_SELF_SERVICE, ...SALES_QUOTING, ...PROJECT_PM, ...FINANCIAL, ...FOREMAN, ...COSTING, ...COSTING_ADMIN, ...ACCOUNTS, ...PHONE_RECEPTION, ...RECRUITMENT, ...CONTRACTS_PRICING, ...APPROVALS, ...MANAGER_INSIGHTS, ...PLANNING, ...CYNTHIA_OPS]),
  platform_owner: new Set([...CUSTOMER_SELF_SERVICE, ...SALES_QUOTING, ...PROJECT_PM, ...FINANCIAL, ...FOREMAN, ...COSTING, ...COSTING_ADMIN, ...ACCOUNTS, ...PHONE_RECEPTION, ...RECRUITMENT, ...CONTRACTS_PRICING, ...APPROVALS, ...MANAGER_INSIGHTS, ...PLANNING, ...CYNTHIA_OPS]),
  builder: new Set([
    ...FOREMAN,
    ...COSTING,
    'lookupProjectStatus',
    'proposeSchedule',
    'updateTaskStatus',
    'tagPhoto',
    'assessProgress',
    'assessExtraFromPhotos',
    'navigateTo',
    'searchProjects',
  ]),
  recruitment: new Set([...SALES_QUOTING, 'searchCustomers', ...RECRUITMENT, ...PHONE_RECEPTION]),
  unknown: new Set(['lookupQuote', 'lookupProjectStatus', 'escalateToStaff', ...PHONE_RECEPTION]),
};

export function canExecuteActionForRole(role: ServerAgentRole, action: string): boolean {
  if (GENERIC_ACTIONS.has(action)) return true;
  const allowed = ROLE_ACTIONS[role] ?? ROLE_ACTIONS.unknown;
  return allowed.has(action);
}

export function filterActionsForRole<T extends { action: string }>(
  role: ServerAgentRole,
  actions: T[]
): T[] {
  return actions.filter((a) => canExecuteActionForRole(role, a.action));
}

export function getRequestRole(body: {
  orchestratorMode?: string;
  staffContext?: { role?: string };
  customerContext?: { role?: string };
}): ServerAgentRole {
  const role =
    body.customerContext?.role
    ?? body.staffContext?.role
    ?? (body.orchestratorMode === 'phone' ? 'agent' : body.orchestratorMode === 'customer' || body.orchestratorMode === 'cyrus' ? 'customer' : 'staff');
  const valid: ServerAgentRole[] = [
    'platform_owner', 'super_admin', 'manager', 'staff', 'builder', 'recruitment', 'customer', 'agent', 'unknown',
  ];
  return valid.includes(role as ServerAgentRole) ? (role as ServerAgentRole) : 'unknown';
}
