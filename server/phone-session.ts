/**
 * Shared phone session helpers — staff orch body + identity binding.
 * Used by Vapi and Realtime so both providers share one identity contract.
 */
import {
  DEFAULT_ORG_ID,
  getDataStore,
  getPhoneLineByAssignedUserId,
  listPhoneLines,
  resolveContactByPhone,
} from './data-store';
import type { OrchestratorRequest } from './orchestrator-types';
import type { PhoneCallerIdentity } from './phone-auth';

/** Canonical profile UUID for a verified staff/foreman caller, or null if unbound. */
export function resolveBoundStaffUserId(identity: PhoneCallerIdentity): string | null {
  const fromMember = String(identity.member?.userId || '').trim();
  if (fromMember) return fromMember;
  const fromRoute = String((identity.route as { userId?: string })?.userId || '').trim();
  if (fromRoute) return fromRoute;
  return null;
}

export function buildStaffOrchBody(opts: {
  call: Record<string, unknown>;
  callId: string;
  partyPhone: string;
  identity: PhoneCallerIdentity;
  orgId?: string;
  assignedStaffUserId?: string | null;
}): OrchestratorRequest {
  const orgId = opts.orgId || DEFAULT_ORG_ID;
  const isStaffParty = opts.identity.kind === 'staff' || opts.identity.kind === 'foreman';
  // Staff/foreman handsets must NOT bind to a CRM customer by caller ID (phone collision).
  const resolvedCustomer = isStaffParty
    ? {
        customerId: null as string | null,
        customerName: '',
        contactName: '',
        contactRole: '',
        projectId: null as string | null,
      }
    : resolveContactByPhone(opts.partyPhone);

  const dataStore = getDataStore();
  const customers = (Array.isArray(dataStore.customers) ? dataStore.customers : [])
    .map((c: Record<string, unknown>) => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      email: String(c.email ?? ''),
      phone: String(c.phone ?? ''),
    }));
  const quotes = (Array.isArray(dataStore.quotes) ? dataStore.quotes : [])
    .map((q: Record<string, unknown>) => ({
      id: String(q.id ?? ''),
      customerId: String(q.customerId ?? ''),
      customerName: String(q.customerName ?? ''),
      tradeName: String(q.tradeName ?? q.tradeId ?? ''),
      total: Number(q.total ?? q.totalCustomerCost ?? 0),
      status: String(q.status ?? ''),
    }));

  const orchMode = opts.identity.kind === 'foreman'
    ? 'foreman'
    : opts.identity.kind === 'staff'
      ? 'staff'
      : 'phone';

  const boundUserId = opts.assignedStaffUserId
    || resolveBoundStaffUserId(opts.identity)
    || undefined;

  return {
    orgId,
    messages: [],
    orchestratorMode: orchMode as OrchestratorRequest['orchestratorMode'],
    callContext: {
      callId: opts.callId,
      direction: (opts.call.direction as 'inbound' | 'outbound') || 'outbound',
      from: String(opts.call.from || ''),
      to: String(opts.call.to || ''),
    },
    customerContext: isStaffParty
      ? {
          phone: opts.partyPhone,
          customerId: null,
          customerName: opts.identity.name || 'Staff',
          contactName: opts.identity.name,
          projectId: null,
          role: opts.identity.role,
        }
      : {
          phone: opts.partyPhone,
          customerId: resolvedCustomer.customerId,
          customerName: resolvedCustomer.customerName,
          contactName: resolvedCustomer.contactName,
          projectId: resolvedCustomer.projectId,
          role: 'customer',
        },
    staffContext: {
      userId: boundUserId,
      role: opts.identity.role,
      customers,
      quotes,
    },
    projectContext: resolvedCustomer.projectId ? { projectId: resolvedCustomer.projectId } : undefined,
  };
}

/** Prefer authenticated soft-phone assignment, then bound identity. */
export function resolveAssignedStaffForCall(opts: {
  identity: PhoneCallerIdentity;
  headerUserId?: string | null;
  orgId?: string;
}): string | null {
  const header = String(opts.headerUserId || '').trim();
  if (header) {
    const line = getPhoneLineByAssignedUserId(header);
    if (line) return header;
    const bound = resolveBoundStaffUserId(opts.identity);
    if (bound === header) return header;
    if (bound) return bound;
    return header;
  }
  const bound = resolveBoundStaffUserId(opts.identity);
  if (bound) return bound;

  const phone = opts.identity.phone.replace(/\D/g, '');
  const lines = listPhoneLines();
  for (const line of lines) {
    const assigned = String(line.assignedUserId || '').trim();
    if (!assigned) continue;
    const lineDigits = String(line.did || '').replace(/\D/g, '');
    if (lineDigits && phone && (lineDigits.endsWith(phone.slice(-10)) || phone.endsWith(lineDigits.slice(-10)))) {
      return assigned;
    }
  }
  return null;
}
