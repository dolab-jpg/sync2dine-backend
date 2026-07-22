/**
 * Weekly job: rate overage for active subscribed orgs and auto-charge Stripe invoices.
 */
import { listOrganizationsWithSupabase } from './organizations';
import {
  buildWeeklyBillingBreakdown,
  resolveBillingWeek,
  weekRangeFromStart,
} from './weekly-usage-billing';
import { findBillingPeriod, saveBillingPeriodFromBreakdown } from './billing-periods';
import { createAndChargeUsageInvoice } from './stripe-service';

const POLL_MS = Number(process.env.WEEKLY_BILLING_POLL_MS ?? 60 * 60 * 1000); // hourly check
const RUN_HOUR_UTC = Number(process.env.WEEKLY_BILLING_HOUR_UTC ?? 6);

let lastRunIsoWeek = '';
let running = false;

export function startWeeklyBillingWorker(): void {
  if (process.env.DISABLE_WEEKLY_BILLING_WORKER === '1') return;
  setInterval(() => {
    void tickWeeklyBilling().catch((err) => {
      console.error('[weekly-billing] worker error:', err);
    });
  }, POLL_MS);
  console.log(`[weekly-billing] worker started (poll ${POLL_MS}ms, hour UTC ${RUN_HOUR_UTC})`);
  setTimeout(() => {
    void tickWeeklyBilling().catch(() => {});
  }, 15_000);
}

async function tickWeeklyBilling(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() < RUN_HOUR_UTC) return;
  const week = resolveBillingWeek(now);
  if (lastRunIsoWeek === week.isoWeek) return;
  const summary = await runWeeklyUsageBilling({ weekStartIso: week.weekStartIso });
  lastRunIsoWeek = week.isoWeek;
  console.log('[weekly-billing] run complete', summary);
}

export type WeeklyBillingRunSummary = {
  weekStart: string;
  isoWeek: string;
  processed: number;
  charged: number;
  skipped: number;
  failed: number;
  results: Array<{
    orgId: string;
    orgName?: string;
    skipped?: boolean;
    charged?: boolean;
    reason?: string;
    invoiceId?: string;
    amountGbp?: number;
    error?: string;
  }>;
};

export async function runWeeklyUsageBilling(options: {
  weekStartIso?: string;
  orgId?: string;
  dryRun?: boolean;
} = {}): Promise<WeeklyBillingRunSummary> {
  if (running) {
    return {
      weekStart: options.weekStartIso || '',
      isoWeek: '',
      processed: 0,
      charged: 0,
      skipped: 0,
      failed: 0,
      results: [{ orgId: '', skipped: true, reason: 'already_running' }],
    };
  }
  running = true;
  try {
    const resolved = options.weekStartIso
      ? weekRangeFromStart(options.weekStartIso)
      : resolveBillingWeek();

    const orgs = await listOrganizationsWithSupabase();
    const targets = orgs.filter((o) => {
      if (options.orgId && o.id !== options.orgId) return false;
      if (o.status === 'cancelled' || o.status === 'suspended') return false;
      return Boolean(o.stripeCustomerId)
        || o.status === 'active'
        || o.status === 'trial'
        || o.status === 'past_due';
    });

    const results: WeeklyBillingRunSummary['results'] = [];
    let charged = 0;
    let skipped = 0;
    let failed = 0;

    for (const org of targets) {
      try {
        const existing = findBillingPeriod(org.id, resolved.weekStartIso);
        if (existing?.stripeInvoiceId && existing.status !== 'draft' && existing.status !== 'void') {
          skipped += 1;
          results.push({
            orgId: org.id,
            orgName: org.name,
            skipped: true,
            reason: 'already_invoiced',
            invoiceId: existing.stripeInvoiceId,
            amountGbp: existing.customerSubtotalGbp,
          });
          continue;
        }

        const breakdown = buildWeeklyBillingBreakdown(org.id, {
          weekStartIso: resolved.weekStartIso,
        });

        if (breakdown.customerSubtotalGbp <= 0) {
          await saveBillingPeriodFromBreakdown(breakdown, { status: 'skipped' });
          skipped += 1;
          results.push({
            orgId: org.id,
            orgName: org.name,
            skipped: true,
            reason: 'no_overage',
            amountGbp: 0,
          });
          continue;
        }

        if (options.dryRun) {
          await saveBillingPeriodFromBreakdown(breakdown, { status: 'draft' });
          skipped += 1;
          results.push({
            orgId: org.id,
            orgName: org.name,
            skipped: true,
            reason: 'dry_run',
            amountGbp: breakdown.customerSubtotalGbp,
          });
          continue;
        }

        const charge = await createAndChargeUsageInvoice(org.id, breakdown);
        if (charge.skipped) {
          skipped += 1;
          results.push({
            orgId: org.id,
            orgName: org.name,
            skipped: true,
            reason: charge.reason,
            invoiceId: charge.invoiceId,
            amountGbp: charge.amountGbp,
          });
        } else if (charge.charged) {
          charged += 1;
          results.push({
            orgId: org.id,
            orgName: org.name,
            charged: true,
            invoiceId: charge.invoiceId,
            amountGbp: charge.amountGbp,
            reason: 'charged',
          });
        } else {
          skipped += 1;
          results.push({
            orgId: org.id,
            orgName: org.name,
            charged: false,
            invoiceId: charge.invoiceId,
            amountGbp: charge.amountGbp,
            reason: 'invoice_open',
          });
        }
      } catch (err) {
        failed += 1;
        results.push({
          orgId: org.id,
          orgName: org.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      weekStart: resolved.weekStartIso,
      isoWeek: resolved.isoWeek,
      processed: results.length,
      charged,
      skipped,
      failed,
      results,
    };
  } finally {
    running = false;
  }
}
