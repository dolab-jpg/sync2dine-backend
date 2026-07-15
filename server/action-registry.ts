/**
 * Metadata-driven phone/chat action registry.
 * The model only receives tools allowed for channel + role + PIN state;
 * server rechecks before execution.
 */

export type ActionChannel = 'cynthia_chat' | 'vapi_phone' | 'realtime_phone';
export type ActionRole = 'staff' | 'manager' | 'super_admin' | 'builder' | 'customer' | 'foreman';
export type ActionRisk = 'read' | 'low_write' | 'outbound' | 'financial' | 'destructive';

export interface ActionRegistryEntry {
  name: string;
  channels: ActionChannel[];
  roles: ActionRole[];
  risk: ActionRisk;
  requiresPin: boolean;
  requiresConfirmation: boolean;
  idempotent: boolean;
}

/** Reviewed phone-safe staff tool surface (not the full web STAFF_TOOLS list). */
export const PHONE_ACTION_REGISTRY: ActionRegistryEntry[] = [
  { name: 'verifyStaffPhonePin', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman'], risk: 'read', requiresPin: false, requiresConfirmation: false, idempotent: true },
  { name: 'setCallLanguage', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'read', requiresPin: false, requiresConfirmation: false, idempotent: true },
  { name: 'transferToHuman', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'outbound', requiresPin: false, requiresConfirmation: false, idempotent: false },
  { name: 'captureMessage', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'low_write', requiresPin: false, requiresConfirmation: false, idempotent: false },
  { name: 'endCall', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'read', requiresPin: false, requiresConfirmation: false, idempotent: true },
  { name: 'lookupCustomerByPhone', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'getAccountBriefing', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'lookupQuote', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'customer'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'lookupProjectStatus', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman', 'customer'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'getPortalLink', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'customer'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'logCallActivity', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman'], risk: 'low_write', requiresPin: true, requiresConfirmation: false, idempotent: false },
  { name: 'searchCustomers', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'searchProjects', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'builder', 'foreman'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'searchQuotes', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'getBusinessSnapshot', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'getTeamPerformance', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['manager', 'super_admin', 'staff'], risk: 'read', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'sendToStaffCynthia', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'low_write', requiresPin: true, requiresConfirmation: false, idempotent: true },
  { name: 'deliverCallFollowUp', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin'], risk: 'outbound', requiresPin: true, requiresConfirmation: true, idempotent: false },
  { name: 'placeOutboundCall', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'outbound', requiresPin: true, requiresConfirmation: true, idempotent: false },
  { name: 'enqueueOutboundCall', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'outbound', requiresPin: true, requiresConfirmation: true, idempotent: false },
  { name: 'bookCallback', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'customer'], risk: 'low_write', requiresPin: true, requiresConfirmation: false, idempotent: false },
  { name: 'scheduleAppointment', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin'], risk: 'low_write', requiresPin: true, requiresConfirmation: false, idempotent: false },
  { name: 'captureLead', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'customer'], risk: 'low_write', requiresPin: false, requiresConfirmation: false, idempotent: false },
  { name: 'saveQuote', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin'], risk: 'low_write', requiresPin: true, requiresConfirmation: false, idempotent: false },
  { name: 'sendCustomerMessage', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin'], risk: 'outbound', requiresPin: true, requiresConfirmation: false, idempotent: false },
  { name: 'classifyCallIntent', channels: ['vapi_phone', 'realtime_phone'], roles: ['staff', 'manager', 'super_admin', 'customer'], risk: 'read', requiresPin: false, requiresConfirmation: false, idempotent: true },
  { name: 'escalateToStaff', channels: ['vapi_phone', 'realtime_phone', 'cynthia_chat'], roles: ['staff', 'manager', 'super_admin', 'customer'], risk: 'low_write', requiresPin: true, requiresConfirmation: false, idempotent: false },
  { name: 'requestCodeFix', channels: ['cynthia_chat'], roles: ['manager', 'super_admin'], risk: 'destructive', requiresPin: false, requiresConfirmation: true, idempotent: false },
];

export function getActionEntry(name: string): ActionRegistryEntry | undefined {
  return PHONE_ACTION_REGISTRY.find((e) => e.name === name);
}

export function listActionsForContext(opts: {
  channel: ActionChannel;
  role: string;
  pinVerified: boolean;
  kind?: string;
}): ActionRegistryEntry[] {
  const role = String(opts.role || 'customer').toLowerCase() as ActionRole;
  const kindRole = opts.kind === 'foreman' ? 'foreman' : role;
  return PHONE_ACTION_REGISTRY.filter((entry) => {
    if (!entry.channels.includes(opts.channel)) return false;
    if (!entry.roles.includes(kindRole) && !entry.roles.includes(role)) return false;
    if (entry.requiresPin && !opts.pinVerified && kindRole !== 'customer') return false;
    return true;
  });
}

export function isActionAllowedByRegistry(
  name: string,
  opts: { channel: ActionChannel; role: string; pinVerified: boolean; kind?: string },
): boolean {
  const entry = getActionEntry(name);
  if (!entry) return false;
  return listActionsForContext(opts).some((e) => e.name === name);
}

export function actionRequiresConfirmation(name: string): boolean {
  return Boolean(getActionEntry(name)?.requiresConfirmation);
}
