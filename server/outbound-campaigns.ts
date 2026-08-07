import {
  enqueueOutboundCall,
  getAgentSettings,
  getDataStore,
  listOrderRecords,
  normalizePhoneExport,
  saveCustomerRecord,
} from './data-store';
import type { OutboundCampaignTemplate } from './telephony/types';
import { scheduleSallyOutboundDial } from './sally/schedule-outbound';
import { assessContactEligibility } from './sally/call-eligibility';
import { normalizeVenueType } from './sally/dial-windows';

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
export async function listCustomersWithLastOrderOlderThan(days: number): Promise<LapsedCustomerRow[]> {
  const cutoff = Date.now() - days * 86400000;
  const orders = await listOrderRecords();
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

export async function queueLapsedCampaign(input: {
  template: LapseCampaignTemplate;
  daysOlderThan: number;
  dryRun?: boolean;
}): Promise<{ queued: number; candidates: LapsedCustomerRow[]; jobs: Array<Record<string, unknown>> }> {
  if (!LAPSE_TEMPLATES.includes(input.template)) {
    throw new Error('Invalid campaign template');
  }
  const days = Math.max(1, Math.round(input.daysOlderThan));
  const candidates = await listCustomersWithLastOrderOlderThan(days);
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

export type CsvCampaignRow = {
  name: string;
  phone: string;
  notes?: string;
  customerId?: string;
  venueType?: string;
  openingHours?: string;
  closedDays?: string;
  preferredContactTimes?: string;
  timezone?: string;
  consentToCall?: string;
};

/** Parse CSV with headers name,phone[,notes][,customerId][,venueType][,openingHours][,closedDays][,preferredContactTimes][,timezone]. */
export function parseCampaignCsv(text: string): CsvCampaignRow[] {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase();
  const hasHeader = /name/.test(header) && /phone/.test(header);
  const start = hasHeader ? 1 : 0;
  const cols = hasHeader
    ? lines[0].split(',').map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''))
    : ['name', 'phone', 'notes', 'customerId'];
  const idx = (key: string) => cols.findIndex((c) => c === key || c.includes(key));
  const nameI = idx('name');
  const phoneI = idx('phone');
  const notesI = idx('note');
  const idI = idx('customer');
  const venueI = cols.findIndex((c) => c === 'venuetype' || c === 'venue_type' || c === 'venue');
  const hoursI = cols.findIndex((c) => c === 'openinghours' || c === 'opening_hours' || c === 'hours');
  const closedI = cols.findIndex((c) => c === 'closeddays' || c === 'closed_days' || c === 'closed');
  const prefI = cols.findIndex((c) => c.includes('preferred') || c === 'best_time' || c === 'call_window');
  const tzI = cols.findIndex((c) => c === 'timezone' || c === 'tz' || c === 'time_zone');
  const consentI = cols.findIndex((c) => c.includes('consent') || c === 'dnc');
  const rows: CsvCampaignRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].match(/("([^"]|"")*"|[^,]*)/g)?.map((p) => p.replace(/^"|"$/g, '').replace(/""/g, '"').trim())
      ?? lines[i].split(',').map((p) => p.trim());
    const phone = parts[phoneI >= 0 ? phoneI : 1] ?? '';
    const name = parts[nameI >= 0 ? nameI : 0] ?? 'Guest';
    if (!phone) continue;
    rows.push({
      name: name || 'Guest',
      phone,
      notes: notesI >= 0 ? parts[notesI] : undefined,
      customerId: idI >= 0 ? parts[idI] : undefined,
      venueType: venueI >= 0 ? parts[venueI] : undefined,
      openingHours: hoursI >= 0 ? parts[hoursI] : undefined,
      closedDays: closedI >= 0 ? parts[closedI] : undefined,
      preferredContactTimes: prefI >= 0 ? parts[prefI] : undefined,
      timezone: tzI >= 0 ? parts[tzI] : undefined,
      consentToCall: consentI >= 0 ? parts[consentI] : undefined,
    });
  }
  return rows;
}

export function queueCsvCampaign(input: {
  rows: CsvCampaignRow[];
  template?: string;
  brief?: string;
  dryRun?: boolean;
  /** Default true for Sally/sales templates — schedule into venue dial windows */
  venueAware?: boolean;
}): { queued: number; skipped: number; jobs: Array<Record<string, unknown>>; preview: CsvCampaignRow[] } {
  const template = String(input.template || 'sally_sales');
  const brief = String(input.brief || 'Sales outreach — introduce Sync2Dine.');
  const store = getDataStore();
  const alreadyQueued = new Set(
    store.outboundQueue
      .filter((j) => ['queued', 'dialling'].includes(String(j.status ?? '')))
      .map((j) => normalizePhoneExport(String(j.to ?? ''))),
  );
  const jobs: Array<Record<string, unknown>> = [];
  let skipped = 0;
  const campaignId = `camp-${Date.now()}`;
  const isSally =
    /sally|sales|lead_callback/i.test(template)
    || input.venueAware !== false;
  const venueAware = input.venueAware !== false && isSally;

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    const phone = normalizePhoneExport(row.phone);
    if (!phone || alreadyQueued.has(phone)) {
      skipped += 1;
      continue;
    }
    alreadyQueued.add(phone);
    if (input.dryRun) continue;

    let customerId = row.customerId;
    const consentDeclined = /^(0|false|no|n|dnc|do_not_call)$/i.test(String(row.consentToCall || '').trim());
    const customerPatch: Record<string, unknown> = {
      id: customerId,
      name: row.name,
      phone: phone.startsWith('+') ? phone : `+${phone}`,
      status: 'lead',
      notes: row.notes,
      source: 'csv_upload',
      consentSource: 'csv_upload',
      consentToCall: consentDeclined ? false : true,
      doNotCall: consentDeclined,
      venueType: row.venueType ? normalizeVenueType(row.venueType) : undefined,
      openingHours: row.openingHours,
      closedDays: row.closedDays,
      preferredContactTimes: row.preferredContactTimes,
      timezone: row.timezone || 'Europe/London',
      rawUpload: {
        notes: row.notes,
        venueType: row.venueType,
        openingHours: row.openingHours,
        closedDays: row.closedDays,
        preferredContactTimes: row.preferredContactTimes,
        timezone: row.timezone,
        consentToCall: row.consentToCall,
      },
    };
    try {
      const saved = saveCustomerRecord(customerPatch);
      customerId = String(saved.id);
    } catch {
      /* continue with phone-only queue */
    }

    const customer = customerId
      ? (getDataStore().customers.find((c) => String(c.id) === customerId) as Record<string, unknown> | undefined)
      : undefined;
    const eligibility = assessContactEligibility(customer || customerPatch);
    if (!eligibility.eligible) {
      skipped += 1;
      continue;
    }

    if (venueAware) {
      const result = scheduleSallyOutboundDial({
        to: phone.startsWith('+') ? phone : `+${phone}`,
        customerId,
        customerName: row.name,
        company: row.name,
        template,
        aim: 'sales_outreach',
        source: 'csv_campaign',
        brief: row.notes ? `${brief} Notes: ${row.notes}` : brief,
        venueAware: true,
        venueProfile: {
          venueType: row.venueType,
          openingHours: row.openingHours,
          closedDays: row.closedDays,
          preferredContactTimes: row.preferredContactTimes,
          timezone: row.timezone || 'Europe/London',
        },
        customer: customer || customerPatch,
        context: {
          campaignId,
          rowIndex: i,
        },
      });
      if (result.ok && result.job) {
        jobs.push(result.job);
      } else {
        skipped += 1;
      }
      continue;
    }

    const job = enqueueOutboundCall({
      to: phone.startsWith('+') ? phone : `+${phone}`,
      template,
      status: 'queued',
      customerId,
      context: {
        customerId,
        customerName: row.name,
        aim: template,
        brief: row.notes ? `${brief} Notes: ${row.notes}` : brief,
        source: 'csv_campaign',
        campaignId,
        rowIndex: i,
      },
    });
    jobs.push(job);
  }
  return {
    queued: jobs.length,
    skipped,
    jobs,
    preview: input.rows.slice(0, 10),
  };
}
