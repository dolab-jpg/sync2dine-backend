import {
  enqueueOutboundCall,
  getAgentSettings,
  getDataStore,
  listOrderRecords,
  normalizePhoneExport,
  saveCustomerRecord,
} from './data-store';
import type { OutboundCampaignTemplate } from './telephony/types';
import { scheduleSallyOutboundDialWithResearch } from './sally/schedule-outbound';
import { assessContactEligibility } from './sally/call-eligibility';
import { normalizeVenueType } from './sally/dial-windows';
import { toUkE164 } from './phone/vapi-client';

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
  address?: string;
  customerId?: string;
  venueType?: string;
  openingHours?: string;
  closedDays?: string;
  preferredContactTimes?: string;
  timezone?: string;
  consentToCall?: string;
};

/** Parse CSV with headers name|company_name,phone[,notes][,opening_hours][,hours_mon…]. */
export function parseCampaignCsv(text: string): CsvCampaignRow[] {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].toLowerCase();
  const hasHeader =
    /phone/.test(header)
    && (/company_name/.test(header) || /\bname\b/.test(header) || /company/.test(header));
  const start = hasHeader ? 1 : 0;
  const cols = hasHeader
    ? lines[0].split(',').map((c) => c.trim().toLowerCase().replace(/^"|"$/g, '').replace(/\s+/g, '_'))
    : ['name', 'phone', 'notes', 'customerId'];

  const exact = (...keys: string[]) => cols.findIndex((c) => keys.includes(c));
  const nameI = (() => {
    const preferred = exact('company_name', 'company', 'business_name', 'name');
    if (preferred >= 0) return preferred;
    return cols.findIndex((c) => c !== 'lead_id' && c.includes('name'));
  })();
  const phoneI = exact('phone', 'telephone', 'tel', 'mobile');
  const notesI = cols.findIndex((c) => c === 'notes' || c === 'note');
  const idI = exact('customer_id', 'customerid', 'lead_id', 'id');
  const venueI = exact('venuetype', 'venue_type', 'venue', 'category');
  const hoursI = exact('openinghours', 'opening_hours', 'hours');
  const closedI = exact('closeddays', 'closed_days', 'closed');
  const prefI = cols.findIndex((c) => c.includes('preferred') || c === 'best_time' || c === 'call_window');
  const tzI = exact('timezone', 'tz', 'time_zone');
  const consentI = cols.findIndex((c) => c.includes('consent') || c === 'dnc');
  const dayCols = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => ({
    d,
    i: exact(`hours_${d}`, `${d}_hours`, d),
  }));

  const rows: CsvCampaignRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const parts = raw.includes('"')
      ? (raw.match(/("[^"]*(?:""[^"]*)*"|[^,]+)/g) || []).map((p) => p.replace(/^"|"$/g, '').replace(/""/g, '"').trim())
      : raw.split(',').map((p) => p.trim());
    const phone = parts[phoneI >= 0 ? phoneI : 1] ?? '';
    let name = parts[nameI >= 0 ? nameI : 0] ?? 'Guest';
    if (/^\d+$/.test(name) || (idI >= 0 && name === parts[idI])) {
      const companyAlt = exact('company_name', 'company', 'business_name');
      if (companyAlt >= 0) name = parts[companyAlt] || name;
    }
    if (!phone) continue;

    let openingHours = hoursI >= 0 ? parts[hoursI] : undefined;
    if (!openingHours?.trim()) {
      const dayParts: string[] = [];
      for (const { d, i: di } of dayCols) {
        if (di < 0) continue;
        const v = (parts[di] || '').trim();
        if (!v || /^closed$/i.test(v)) continue;
        dayParts.push(`${d[0].toUpperCase()}${d.slice(1)}: ${v}`);
      }
      if (dayParts.length) openingHours = dayParts.join('; ');
    }

    const category = venueI >= 0 ? parts[venueI] : undefined;
    const addressBits = [
      exact('address') >= 0 ? parts[exact('address')] : '',
      exact('city') >= 0 ? parts[exact('city')] : '',
      exact('postcode', 'postal_code') >= 0 ? parts[exact('postcode', 'postal_code')] : '',
    ].filter(Boolean);
    const extraNotes = [
      notesI >= 0 ? parts[notesI] : '',
      addressBits.length ? `Address: ${addressBits.join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    rows.push({
      name: name || 'Guest',
      phone,
      notes: extraNotes || undefined,
      address: addressBits.length ? addressBits.join(', ') : undefined,
      customerId: idI >= 0 ? parts[idI] : undefined,
      venueType: category || 'takeaway',
      openingHours: openingHours || undefined,
      closedDays: closedI >= 0 ? parts[closedI] : undefined,
      preferredContactTimes: prefI >= 0 ? parts[prefI] : undefined,
      timezone: tzI >= 0 ? parts[tzI] : undefined,
      consentToCall: consentI >= 0 ? parts[consentI] : undefined,
    });
  }
  return rows;
}

const CSV_RESEARCH_CONCURRENCY = 3;

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: items.length ? n : 0 }, () => worker()));
  return results;
}

export async function queueCsvCampaign(input: {
  rows: CsvCampaignRow[];
  template?: string;
  brief?: string;
  dryRun?: boolean;
  batchId?: string;
  /** Default true for Sally/sales templates — schedule into venue dial windows */
  venueAware?: boolean;
}): Promise<{
  queued: number;
  skipped: number;
  held: number;
  campaignId: string;
  jobs: Array<Record<string, unknown>>;
  preview: CsvCampaignRow[];
}> {
  const template = String(input.template || 'sally_sales');
  const brief = String(input.brief || 'Sales outreach — introduce Sync2Dine.');
  const store = getDataStore();
  const alreadyQueued = new Set(
    store.outboundQueue
      .filter((j) => ['queued', 'dialling', 'needs_hours'].includes(String(j.status ?? '')))
      .map((j) => normalizePhoneExport(String(j.to ?? ''))),
  );
  const jobs: Array<Record<string, unknown>> = [];
  let skipped = 0;
  let held = 0;
  const campaignId = String(input.batchId || '').trim() || `camp-${Date.now()}`;
  const isSally =
    /sally|sales|lead_callback/i.test(template)
    || input.venueAware !== false;
  const venueAware = input.venueAware !== false && isSally;

  type WorkItem = { row: CsvCampaignRow; phone: string; index: number };
  const work: WorkItem[] = [];

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    const phone = normalizePhoneExport(row.phone);
    if (!phone || alreadyQueued.has(phone)) {
      skipped += 1;
      continue;
    }
    alreadyQueued.add(phone);
    if (input.dryRun) continue;
    work.push({ row, phone, index: i });
  }

  await mapPool(work, CSV_RESEARCH_CONCURRENCY, async ({ row, phone, index }) => {
    let customerId = row.customerId;
    const consentDeclined = /^(0|false|no|n|dnc|do_not_call)$/i.test(String(row.consentToCall || '').trim());
    const e164 = toUkE164(row.phone);
    const customerPatch: Record<string, unknown> = {
      id: customerId,
      name: row.name,
      phone: e164,
      status: 'lead',
      notes: row.notes,
      address: row.address,
      source: 'csv_upload',
      consentSource: 'csv_upload',
      consentToCall: consentDeclined ? false : true,
      doNotCall: consentDeclined,
      venueType: row.venueType ? normalizeVenueType(row.venueType) : undefined,
      openingHours: row.openingHours,
      closedDays: row.closedDays,
      preferredContactTimes: row.preferredContactTimes,
      timezone: row.timezone || 'Europe/London',
      leadBatchId: campaignId,
      campaign: campaignId,
      callQueueStatus: 'queued',
      rawUpload: {
        notes: row.notes,
        venueType: row.venueType,
        openingHours: row.openingHours,
        closedDays: row.closedDays,
        preferredContactTimes: row.preferredContactTimes,
        timezone: row.timezone,
        consentToCall: row.consentToCall,
        address: row.address,
      },
    };
    try {
      const saved = saveCustomerRecord(customerPatch);
      customerId = String(saved.id);
    } catch {
      /* continue with phone-only queue */
    }

    const customer = customerId
      ? (getDataStore().customers.find((c) => String(c.id) === String(customerId)) as Record<string, unknown> | undefined)
      : undefined;
    const eligibility = assessContactEligibility(customer || customerPatch);
    if (!eligibility.eligible) {
      skipped += 1;
      if (customerId) {
        try {
          saveCustomerRecord({
            id: customerId,
            callQueueStatus: consentDeclined ? 'do_not_call' : 'not_called',
          });
        } catch { /* keep skip count even if CRM stamp fails */ }
      }
      return;
    }

    const rowBrief = row.notes ? `${brief} Notes: ${row.notes}` : brief;
    const venueProfile = {
      venueType: row.venueType || 'takeaway',
      openingHours: row.openingHours,
      closedDays: row.closedDays,
      preferredContactTimes: row.preferredContactTimes,
      timezone: row.timezone || 'Europe/London',
    };

    if (venueAware) {
      const result = await scheduleSallyOutboundDialWithResearch({
        to: e164,
        customerId,
        customerName: row.name,
        company: row.name,
        template,
        aim: 'sales_outreach',
        source: 'csv_campaign',
        brief: rowBrief,
        venueAware: true,
        addressHint: row.address || row.notes,
        venueProfile,
        customer: customer || customerPatch,
        context: {
          campaignId,
          batchId: campaignId,
          rowIndex: index,
        },
      });
      if (result.held) {
        held += 1;
        if (result.job) jobs.push(result.job);
        if (customerId) {
          try { saveCustomerRecord({ id: customerId, callQueueStatus: 'needs_hours' }); } catch { /* ignore */ }
        }
        return;
      }
      if (result.ok && result.job) {
        jobs.push(result.job);
        return;
      }
      skipped += 1;
      if (customerId) {
        try { saveCustomerRecord({ id: customerId, callQueueStatus: 'not_called' }); } catch { /* ignore */ }
      }
      return;
    }

    const job = enqueueOutboundCall({
      to: e164,
      template,
      status: 'queued',
      customerId,
      context: {
        customerId,
        customerName: row.name,
        aim: template,
        brief: rowBrief,
        source: 'csv_campaign',
        campaignId,
        batchId: campaignId,
        rowIndex: index,
      },
    });
    jobs.push(job);
  });

  const queued = jobs.filter((j) => String(j.status ?? '') === 'queued').length;
  return {
    queued,
    skipped,
    held,
    campaignId,
    jobs,
    preview: input.rows.slice(0, 10),
  };
}
