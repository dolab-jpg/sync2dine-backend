import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeklyBillingBreakdown,
  resolveBillingWeek,
  toCustomerBreakdown,
  weekRangeFromStart,
} from './weekly-usage-billing';
import {
  buildSaasUsageInvoiceContent,
  buildSaasUsageInvoiceEmail,
  customerArtifactContainsInternalLeak,
  generateSaasUsageInvoicePdf,
} from './saas-usage-invoice';
import { createOrganization, deleteOrganization, listOrganizations } from './organizations';
import type { UsageEvent } from './usage';

function seedOrg() {
  const org = createOrganization({
    name: 'Weekly Billing Test Venue',
    contactName: 'Test Owner',
    contactEmail: 'billing-test@example.com',
    contactPhone: '02000000000',
    plan: 'starter',
    status: 'active',
    notes: 'packageId=judie_starter',
  });
  return org;
}

function event(partial: Partial<UsageEvent> & Pick<UsageEvent, 'endpoint' | 'quantity'>): UsageEvent {
  return {
    id: `use_test_${Math.random().toString(36).slice(2, 8)}`,
    orgId: partial.orgId || 'x',
    endpoint: partial.endpoint,
    model: partial.model || 'test',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: partial.totalTokens || 0,
    costUsd: partial.costUsd ?? 0,
    createdAt: partial.createdAt || new Date().toISOString(),
    provider: partial.provider || 'phone',
    unit: partial.unit || 'seconds',
    quantity: partial.quantity,
    metadata: partial.metadata,
  };
}

describe('weekly usage billing', () => {
  it('rates AI and outbound overage sell lines from fare catalog', async () => {
    const org = seedOrg();
    try {
      const week = weekRangeFromStart('2026-07-13T00:00:00.000Z'); // Monday
      const mid = '2026-07-15T12:00:00.000Z';
      // Included: 140 AI min, 25 outbound. Push well over.
      const events: UsageEvent[] = [
        event({
          orgId: org.id,
          endpoint: 'phone.ai',
          quantity: 200 * 60,
          createdAt: mid,
          metadata: { billAs: 'ai' },
        }),
        event({
          orgId: org.id,
          endpoint: 'phone.outbound',
          quantity: 40 * 60,
          model: 'mobile',
          createdAt: mid,
          metadata: { numberType: 'mobile' },
        }),
        event({
          orgId: org.id,
          endpoint: 'phone.outbound',
          quantity: 20 * 60,
          model: 'landline',
          createdAt: mid,
          metadata: { numberType: 'landline' },
        }),
      ];

      const breakdown = buildWeeklyBillingBreakdown(org.id, {
        weekStartIso: week.weekStartIso,
        events,
      });

      assert.equal(breakdown.packageId, 'judie_starter');
      assert.ok(breakdown.overage.aiMinutes > 0);
      assert.ok(breakdown.customerSubtotalGbp > 0);
      assert.ok(breakdown.customerLines.some((l) => l.code === 'ai_overage'));
      assert.ok(breakdown.customerLines.some((l) => l.code === 'outbound_mobile'));
      assert.ok(breakdown.internalMargins.totalMarginGbp !== undefined);
      assert.ok(breakdown.internalMargins.totalSellGbp === breakdown.customerSubtotalGbp);

      const customer = toCustomerBreakdown(breakdown);
      assert.equal('internalMargins' in customer, false);

      const content = buildSaasUsageInvoiceContent({
        breakdown,
        customerName: org.name,
        customerEmail: org.contactEmail,
        status: 'due',
      });
      const email = buildSaasUsageInvoiceEmail(content);
      assert.equal(customerArtifactContainsInternalLeak(email.html), false);
      assert.equal(customerArtifactContainsInternalLeak(email.text), false);
      assert.match(email.subject, /Usage invoice/i);
      assert.match(email.html, /INVOICE/i);
      assert.doesNotMatch(email.html, /internalMargins|marginGbp|wholesale|costGbp|providerCost/i);
      assert.doesNotMatch(email.text, /wholesale|marginGbp|internalMargins|costGbp/i);

      // PDF bytes are binary; assert content model + PDF generation succeed without internal fields.
      assert.equal('internalMargins' in content, false);
      const pdf = await generateSaasUsageInvoicePdf(content);
      assert.equal(pdf.mimeType, 'application/pdf');
      assert.ok(pdf.bytes.byteLength > 500);
      assert.match(pdf.filename, /usage-invoice/);
    } finally {
      deleteOrganization(org.id);
    }
  });

  it('skips customer lines when within allowance', () => {
    const org = seedOrg();
    try {
      const week = resolveBillingWeek(new Date('2026-07-22T12:00:00.000Z'));
      const events: UsageEvent[] = [
        event({
          orgId: org.id,
          endpoint: 'phone.ai',
          quantity: 10 * 60,
          createdAt: new Date(week.weekStart.getTime() + 86400000).toISOString(),
          metadata: { billAs: 'ai' },
        }),
      ];
      const breakdown = buildWeeklyBillingBreakdown(org.id, {
        weekStartIso: week.weekStartIso,
        events,
      });
      assert.equal(breakdown.customerSubtotalGbp, 0);
      assert.equal(breakdown.customerLines.length, 0);
    } finally {
      deleteOrganization(org.id);
    }
  });

  it('worker keeps non-zero draft when a later rate returns zero', async () => {
    const org = seedOrg();
    try {
      const week = weekRangeFromStart('2026-07-13T00:00:00.000Z');
      const { recordProviderUsage, clearUsageEventsForOrg } = await import('./usage');
      const { saveBillingPeriodFromBreakdown, findBillingPeriod } = await import('./billing-periods');
      const { runWeeklyUsageBilling } = await import('./weekly-billing-worker');

      recordProviderUsage({
        orgId: org.id,
        provider: 'phone',
        unit: 'seconds',
        quantity: 200 * 60,
        endpoint: 'phone.ai',
        createdAt: '2026-07-15T12:00:00.000Z',
        metadata: { billAs: 'ai' },
      });

      const rated = buildWeeklyBillingBreakdown(org.id, { weekStartIso: week.weekStartIso });
      assert.ok(rated.customerSubtotalGbp > 0);
      await saveBillingPeriodFromBreakdown(rated, { status: 'draft' });
      const keptAmount = rated.customerSubtotalGbp;

      // Clear usage so a naive re-rate would be £0 — worker must keep the draft.
      clearUsageEventsForOrg(org.id);
      const summary = await runWeeklyUsageBilling({
        orgId: org.id,
        weekStartIso: week.weekStartIso,
        dryRun: true,
      });
      const row = summary.results.find((r) => r.orgId === org.id);
      assert.equal(row?.reason, 'keep_existing_nonzero');
      assert.equal(row?.amountGbp, keptAmount);

      const after = findBillingPeriod(org.id, week.weekStartIso);
      assert.equal(after?.customerSubtotalGbp, keptAmount);
      assert.equal(after?.status, 'draft');
    } finally {
      deleteOrganization(org.id);
    }
  });
});

// Keep listOrganizations warm in case home-org seeding interferes
void listOrganizations;
