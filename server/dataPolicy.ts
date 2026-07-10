import type { ServerAgentRole } from './role-permissions';

/** Collections the AI may read/write via generic tools. */
export const DATA_COLLECTIONS = [
  'customers',
  'quotes',
  'products',
  'pricingRules',
  'projects',
  'builders',
  'contracts',
  'contractTemplates',
  'recruitmentAccess',
] as const;

export type DataCollection = (typeof DATA_COLLECTIONS)[number];

export type WriteOperation = 'create' | 'update' | 'delete';

export interface DataPolicyContext {
  role: ServerAgentRole;
  userId?: string | null;
  customerId?: string | null;
  builderId?: string | null;
  projectId?: string | null;
}

/** Fields stripped from records for non-internal roles. */
export const SENSITIVE_FIELD_KEYS = new Set([
  'builderCost',
  'margin',
  'marginPercent',
  'internalNotes',
  'contractorComms',
  'costPrice',
  'supplierPrice',
  'staffNotes',
  'profit',
  'revenue',
  'earnings',
  'totalProfit',
  'companyTotals',
  'grossProfit',
  'materialCosts',
  'labourCosts',
  'otherCosts',
  'totalCosts',
  'marginPct',
  'categoryBreakdown',
  'costEntries',
  'timesheets',
  'builderPayments',
  'invoices',
]);

const STAFF_ROLES = new Set<ServerAgentRole>(['super_admin', 'manager', 'staff']);

const READ_MATRIX: Record<ServerAgentRole, Set<DataCollection> | '*'> = {
  super_admin: '*',
  manager: '*',
  staff: '*',
  recruitment: new Set(['customers', 'quotes', 'projects', 'recruitmentAccess']),
  builder: new Set(['projects']),
  customer: new Set(['customers', 'quotes', 'projects']),
  unknown: new Set(),
};

const WRITE_MATRIX: Record<ServerAgentRole, Partial<Record<DataCollection, Set<WriteOperation>>>> = {
  super_admin: {
    customers: new Set(['create', 'update', 'delete']),
    quotes: new Set(['create', 'update', 'delete']),
    products: new Set(['create', 'update', 'delete']),
    pricingRules: new Set(['create', 'update', 'delete']),
    projects: new Set(['create', 'update', 'delete']),
    builders: new Set(['create', 'update', 'delete']),
    recruitmentAccess: new Set(['update']),
  },
  manager: {
    customers: new Set(['create', 'update', 'delete']),
    quotes: new Set(['create', 'update', 'delete']),
    products: new Set(['create', 'update']),
    pricingRules: new Set(['create', 'update']),
    projects: new Set(['create', 'update', 'delete']),
    builders: new Set(['create', 'update']),
    recruitmentAccess: new Set(['update']),
  },
  staff: {
    customers: new Set(['create', 'update']),
    quotes: new Set(['create', 'update']),
    products: new Set(['create', 'update']),
    projects: new Set(['create', 'update']),
  },
  recruitment: {
    customers: new Set(['create', 'update']),
    quotes: new Set(['create', 'update']),
    projects: new Set(['update']),
  },
  builder: {
    projects: new Set(['update']),
  },
  customer: {
    projects: new Set(['update']),
  },
  unknown: {},
};

function canAccessCollection(
  matrix: Record<ServerAgentRole, Set<DataCollection> | '*'>,
  role: ServerAgentRole,
  collection: DataCollection
): boolean {
  const allowed = matrix[role];
  if (allowed === '*') return true;
  return allowed?.has(collection) ?? false;
}

export function canReadCollection(role: ServerAgentRole, collection: DataCollection): boolean {
  return canAccessCollection(READ_MATRIX, role, collection);
}

export function canWriteCollection(
  role: ServerAgentRole,
  collection: DataCollection,
  operation: WriteOperation
): boolean {
  const ops = WRITE_MATRIX[role]?.[collection];
  return ops?.has(operation) ?? false;
}

function recordCustomerId(record: Record<string, unknown>): string | undefined {
  const id = record.customerId ?? record.id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

function recordProjectId(record: Record<string, unknown>): string | undefined {
  const id = record.id ?? record.projectId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

function builderAssignedToProject(record: Record<string, unknown>, builderId: string): boolean {
  if (String(record.assignedBuilder ?? '') === builderId) return true;
  const contractors = record.assignedContractors;
  if (!Array.isArray(contractors)) return false;
  return contractors.some((c) => {
    if (!c || typeof c !== 'object') return false;
    const row = c as Record<string, unknown>;
    return String(row.contractorId ?? row.id ?? '') === builderId;
  });
}

/** Whether a single record is visible to the role in context. */
export function isRecordInScope(
  collection: DataCollection,
  record: Record<string, unknown>,
  ctx: DataPolicyContext
): boolean {
  const { role, customerId, builderId, projectId } = ctx;

  if (STAFF_ROLES.has(role) || role === 'recruitment') {
    return true;
  }

  if (role === 'customer' && customerId) {
    if (collection === 'customers') {
      return String(record.id ?? '') === customerId;
    }
    if (collection === 'quotes' || collection === 'projects') {
      return String(record.customerId ?? '') === customerId;
    }
    return false;
  }

  if (role === 'builder' && builderId) {
    if (collection === 'projects') {
      if (projectId && recordProjectId(record) === projectId) return true;
      return builderAssignedToProject(record, builderId);
    }
    return false;
  }

  return false;
}

export function filterRecordsForRole<T extends Record<string, unknown>>(
  collection: DataCollection,
  records: T[],
  ctx: DataPolicyContext
): T[] {
  if (STAFF_ROLES.has(ctx.role)) return records;
  return records.filter((r) => isRecordInScope(collection, r, ctx));
}

function scrubValue(obj: unknown, role: ServerAgentRole): unknown {
  if (STAFF_ROLES.has(role)) return obj;
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => scrubValue(item, role));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_KEYS.has(k)) continue;
    out[k] = scrubValue(v, role);
  }
  return out;
}

export function redactRecord<T extends Record<string, unknown>>(
  role: ServerAgentRole,
  record: T
): T {
  return scrubValue(record, role) as T;
}

export function redactRecords<T extends Record<string, unknown>>(
  role: ServerAgentRole,
  records: T[]
): T[] {
  return records.map((r) => redactRecord(role, r));
}

export function buildPolicyContext(body: {
  staffContext?: { role?: string; userId?: string; customerId?: string | null };
  customerContext?: { customerId?: string | null; role?: string };
  projectContext?: { projectId?: string; builderId?: string };
}): DataPolicyContext {
  const role = (body.customerContext?.role
    ?? body.staffContext?.role
    ?? 'unknown') as ServerAgentRole;
  return {
    role,
    userId: body.staffContext?.userId ?? null,
    customerId: body.customerContext?.customerId
      ?? body.staffContext?.customerId
      ?? null,
    builderId: (body.projectContext?.builderId as string | undefined)
      ?? body.staffContext?.userId
      ?? null,
    projectId: (body.projectContext?.projectId as string | undefined) ?? null,
  };
}