/**
 * Persist weekly usage billing periods (local JSON + Supabase when configured).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { WeeklyBillingBreakdown } from './weekly-usage-billing';

// Domain folder lives under server/billing/; JSON cache stays in server/data/.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA_DIR, 'billing-periods.json');

export type BillingPeriodStatus =
  | 'draft'
  | 'open'
  | 'paid'
  | 'past_due'
  | 'void'
  | 'skipped';

// 'open' = invoice finalized, awaiting payment / retry

export type BillingPeriodRecord = {
  id: string;
  orgId: string;
  weekStart: string;
  weekEnd: string;
  isoWeek: string;
  fareVersion: string;
  type: 'usage_overage';
  status: BillingPeriodStatus;
  customerSubtotalGbp: number;
  stripeInvoiceId?: string;
  stripeHostedInvoiceUrl?: string;
  customerBreakdownJson: Omit<WeeklyBillingBreakdown, 'internalMargins'>;
  internalMarginJson: WeeklyBillingBreakdown['internalMargins'];
  createdAt: string;
  updatedAt: string;
};

let memory: BillingPeriodRecord[] = [];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): BillingPeriodRecord[] {
  if (memory.length) return memory;
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
      memory = Array.isArray(parsed) ? parsed as BillingPeriodRecord[] : [];
    }
  } catch {
    memory = [];
  }
  return memory;
}

function persist() {
  ensureDir();
  try {
    writeFileSync(FILE, JSON.stringify(memory, null, 2));
  } catch {
    /* ignore */
  }
}

function newId(): string {
  return `bp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function upsertSupabase(row: BillingPeriodRecord): Promise<void> {
  try {
    const { getSupabaseAdmin } = await import('../supabase-admin.js');
    const supabase = getSupabaseAdmin();
    const payload = {
      id: row.id,
      org_id: row.orgId,
      week_start: row.weekStart,
      week_end: row.weekEnd,
      iso_week: row.isoWeek,
      fare_version: row.fareVersion,
      type: row.type,
      status: row.status,
      customer_subtotal_gbp: row.customerSubtotalGbp,
      stripe_invoice_id: row.stripeInvoiceId ?? null,
      stripe_hosted_invoice_url: row.stripeHostedInvoiceUrl ?? null,
      customer_breakdown_json: row.customerBreakdownJson,
      internal_margin_json: row.internalMarginJson,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
    // Table added by migration; generated DB types may lag.
    const { error } = await (supabase.from('billing_periods') as any).upsert(payload, {
      onConflict: 'org_id,week_start,type',
    });
    if (error) console.warn('[billing-periods] supabase upsert:', error.message);
  } catch (err) {
    console.warn('[billing-periods] supabase unavailable:', err instanceof Error ? err.message : err);
  }
}

export function findBillingPeriod(
  orgId: string,
  weekStart: string,
  type: 'usage_overage' = 'usage_overage',
): BillingPeriodRecord | undefined {
  return load().find(
    (r) => r.orgId === orgId && r.weekStart === weekStart && r.type === type,
  );
}

export function getBillingPeriodByStripeInvoiceId(
  invoiceId: string,
): BillingPeriodRecord | undefined {
  return load().find((r) => r.stripeInvoiceId === invoiceId);
}

export function listBillingPeriodsForOrg(orgId: string): BillingPeriodRecord[] {
  return load()
    .filter((r) => r.orgId === orgId)
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

export async function saveBillingPeriodFromBreakdown(
  breakdown: WeeklyBillingBreakdown,
  patch: Partial<Pick<
    BillingPeriodRecord,
    'status' | 'stripeInvoiceId' | 'stripeHostedInvoiceUrl'
  >> = {},
): Promise<BillingPeriodRecord> {
  const existing = findBillingPeriod(breakdown.orgId, breakdown.weekStart);
  const now = new Date().toISOString();
  const { internalMargins, ...customerSafe } = breakdown;
  const record: BillingPeriodRecord = {
    id: existing?.id ?? newId(),
    orgId: breakdown.orgId,
    weekStart: breakdown.weekStart,
    weekEnd: breakdown.weekEnd,
    isoWeek: breakdown.isoWeek,
    fareVersion: breakdown.fareVersion,
    type: 'usage_overage',
    status: patch.status ?? existing?.status ?? 'draft',
    customerSubtotalGbp: breakdown.customerSubtotalGbp,
    stripeInvoiceId: patch.stripeInvoiceId ?? existing?.stripeInvoiceId,
    stripeHostedInvoiceUrl: patch.stripeHostedInvoiceUrl ?? existing?.stripeHostedInvoiceUrl,
    customerBreakdownJson: customerSafe,
    internalMarginJson: internalMargins,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  memory = [record, ...load().filter((r) => r.id !== record.id)];
  persist();
  await upsertSupabase(record);
  return record;
}

export async function updateBillingPeriodStatus(
  id: string,
  status: BillingPeriodStatus,
  extra: Partial<Pick<BillingPeriodRecord, 'stripeInvoiceId' | 'stripeHostedInvoiceUrl'>> = {},
): Promise<BillingPeriodRecord | null> {
  const rows = load();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const next: BillingPeriodRecord = {
    ...rows[idx],
    ...extra,
    status,
    updatedAt: new Date().toISOString(),
  };
  memory = rows.map((r) => (r.id === id ? next : r));
  persist();
  await upsertSupabase(next);
  return next;
}

export async function updateBillingPeriodByStripeInvoice(
  invoiceId: string,
  status: BillingPeriodStatus,
  hostedUrl?: string,
): Promise<BillingPeriodRecord | null> {
  const existing = getBillingPeriodByStripeInvoiceId(invoiceId);
  if (!existing) return null;
  return updateBillingPeriodStatus(existing.id, status, {
    stripeHostedInvoiceUrl: hostedUrl ?? existing.stripeHostedInvoiceUrl,
  });
}
