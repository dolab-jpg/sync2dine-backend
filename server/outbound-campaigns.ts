import {
  enqueueOutboundCall,
  getAgentSettings,
  getDataStore,
  listOrderRecords,
  normalizePhoneExport,
} from './data-store';
import type { OutboundCampaignTemplate } from './telephony/types';

export type LapseCampaignTemplate = 'customer_review' | 'customer_reorder' | 'lapse_winback';

const LAPSE_TEMPLATES: LapseCampaignTemplate[] = [
  'customer_review',
  'customer_reorder',
  'lapse_winback',
];

export function getCampaignTemplates() {
  const settings = getAgentSettings();
  return [
    {
      id: 'customer_review' as const,
      label: 'Customer review call',
      defaultDays: 3,
      brief: settings.campaignReviewBrief ?? 'Ask how their recent order was and invite a review.',
    },
    {
      id: 'customer_reorder' as const,
      label: 'Reorder reminder',
      defaultDays: 14,
      brief: settings.campaignReorderBrief ?? 'Invite them to place another order.',
    },
    {
      id: 'lapse_winback' as const,
      label: 'Lapse win-back',
      defaultDays: 30,
      brief: settings.campaignWinbackBrief ?? 'Welcome-back offer for customers who have not ordered recently.',
    },
  ];
}

export interface LapsedCustomerRow {
  customerId?: string;
  customerName: string;
  phone: string;
  lastOrderAt: string;
  daysSinceOrder: number;
  orderCount: number;
}

/** Customers whose most recent order is older than `days` days. */
export function listCustomersWithLastOrderOlderThan(days: number): LapsedCustomerRow[] {
  const cutoff = Date.now() - days * 86400000;
  const orders = listOrderRecords();
  const byKey = new Map<string, { name: string; phone: string; customerId?: string; lastAt: number; count: number }>();

  for (const order of orders) {
    const created = Date.parse(String(order.createdAt ?? order.updatedAt ?? ''));
    if (!Number.isFinite(created)) continue;
    const phone = normalizePhoneExport(String(order.customerPhone ?? order.phone ?? ''));
    if (!phone || phone.length < 7) continue;
    const customerId = order.customerId ? String(order.customerId) : undefined;
    const key = customerId || phone;
    const name = String(order.customerName ?? order.customer ?? 'Customer');
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { name, phone, customerId, lastAt: created, count: 1 });
    } else {
      prev.count += 1;
      if (created > prev.lastAt) {
        prev.lastAt = created;
        prev.name = name;
        prev.phone = phone;
      }
    }
  }

  const rows: LapsedCustomerRow[] = [];
  for (const entry of byKey.values()) {
    if (entry.lastAt >= cutoff) continue;
    rows.push({
      customerId: entry.customerId,
      customerName: entry.name,
      phone: entry.phone,
      lastOrderAt: new Date(entry.lastAt).toISOString(),
      daysSinceOrder: Math.floor((Date.now() - entry.lastAt) / 86400000),
      orderCount: entry.count,
    });
  }

  return rows.sort((a, b) => a.daysSinceOrder - b.daysSinceOrder);
}

function briefForTemplate(template: LapseCampaignTemplate): string {
  const settings = getAgentSettings();
  if (template === 'customer_review') return settings.campaignReviewBrief ?? 'Review follow-up';
  if (template === 'customer_reorder') return settings.campaignReorderBrief ?? 'Reorder reminder';
  return settings.campaignWinbackBrief ?? 'Win-back call';
}

export function queueLapsedCampaign(input: {
  template: LapseCampaignTemplate;
  daysOlderThan: number;
  dryRun?: boolean;
}): { queued: number; candidates: LapsedCustomerRow[]; jobs: Array<Record<string, unknown>> } {
  if (!LAPSE_TEMPLATES.includes(input.template)) {
    throw new Error('Invalid campaign template');
  }
  const days = Math.max(1, Math.round(input.daysOlderThan));
  const candidates = listCustomersWithLastOrderOlderThan(days);
  if (input.dryRun) {
    return { queued: 0, candidates, jobs: [] };
  }

  const store = getDataStore();
  const alreadyQueued = new Set(
    store.outboundQueue
      .filter((j) => ['queued', 'dialling'].includes(String(j.status ?? '')))
      .map((j) => normalizePhoneExport(String(j.to ?? ''))),
  );

  const brief = briefForTemplate(input.template);
  const jobs: Array<Record<string, unknown>> = [];
  for (const row of candidates) {
    const phone = normalizePhoneExport(row.phone);
    if (!phone || alreadyQueued.has(phone)) continue;
    alreadyQueued.add(phone);
    const job = enqueueOutboundCall({
      to: phone,
      template: input.template as OutboundCampaignTemplate,
      status: 'queued',
      context: {
        customerId: row.customerId,
        customerName: row.customerName,
        aim: input.template,
        brief,
        source: 'lapse_campaign',
        daysSinceOrder: row.daysSinceOrder,
      },
    });
    jobs.push(job);
  }

  return { queued: jobs.length, candidates, jobs };
}
