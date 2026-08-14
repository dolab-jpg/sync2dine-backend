import {
  enqueueOutboundCall,
  getAgentSettings,
  getDataStore,
  listOrderRecords,
  normalizePhoneExport,
  reloadCustomersFromSupabase,
  saveCustomerRecord,
  syncData,
} from './data-store';
import type { OutboundCampaignTemplate } from './telephony/types';
import { scheduleSallyOutboundDialWithResearch } from './sally/schedule-outbound';
import { assessContactEligibility } from './sally/call-eligibility';
import {
  normalizeVenueType,
  normalizeWeeklyHours,
  parseOpeningHoursHint,
  type Weekday,
  type WeeklyOpeningHours,
} from './sally/dial-windows';
import { isPlausibleUkE164, toUkE164 } from './phone/vapi-client';

/** Canonical campaign label for the venue lead list (never “Hindi” / scrape-date tags). */
export const LEEDS_CAMPAIGN_ID = 'Leeds';

const DEFAULT_SALLY_BRIEF =
  'Sally from sync Two dine: introduce the takeaway phone platform — AI answers, takes orders, and drives repeat business.';

/** Legacy batch/campaign/tags from earlier imports of this list. */
export function looksLikeLeedsLegacyLabel(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (/^leeds$/i.test(s)) return true;
  if (/hindi/i.test(s)) return true;
  if (/sync2dine\s*call\s*leads/i.test(s)) return true;
  if (/^scrape-\d{4}-\d{2}-\d{2}$/i.test(s)) return true;
  if (/^sales-\d{4}-\d{2}-\d{2}$/i.test(s)) return true;
  return false;
}

export function customerMatchesLeedsBatch(c: Record<string, unknown>, batchId = LEEDS_CAMPAIGN_ID): boolean {
  const want = String(batchId || LEEDS_CAMPAIGN_ID).trim() || LEEDS_CAMPAIGN_ID;
  const batch = String(c.leadBatchId ?? '').trim();
  const campaign = String(c.campaign ?? '').trim();
  if (batch === want || campaign === want) return true;
  if (looksLikeLeedsLegacyLabel(batch) || looksLikeLeedsLegacyLabel(campaign)) return true;
  const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t)) : [];
  if (tags.some((t) => t === want || looksLikeLeedsLegacyLabel(t))) return true;
  return false;
}

/** Remap Hindi / scrape-date labels → Leeds on a customer record. */
export function remapCustomerLeedsLabels(c: Record<string, unknown>): Record<string, unknown> | null {
  const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t)) : [];
  const batchLegacy = looksLikeLeedsLegacyLabel(c.leadBatchId);
  const campaignLegacy = looksLikeLeedsLegacyLabel(c.campaign);
  const tagLegacy = tags.some(looksLikeLeedsLegacyLabel);
  if (!batchLegacy && !campaignLegacy && !tagLegacy) return null;

  const nextTags = [
    ...tags.filter((t) => !looksLikeLeedsLegacyLabel(t)),
    LEEDS_CAMPAIGN_ID,
  ];

  return {
    ...c,
    leadBatchId: batchLegacy ? LEEDS_CAMPAIGN_ID : String(c.leadBatchId ?? LEEDS_CAMPAIGN_ID),
    campaign: campaignLegacy ? LEEDS_CAMPAIGN_ID : String(c.campaign ?? LEEDS_CAMPAIGN_ID),
    tags: [...new Set(nextTags)],
  };
}

export function remapAllLeedsLegacyCustomers(): { remapped: number } {
  const store = getDataStore();
  let remapped = 0;
  for (const c of store.customers) {
    const next = remapCustomerLeedsLabels(c as Record<string, unknown>);
    if (!next || !next.id) continue;
    try {
      saveCustomerRecord({
        id: next.id,
        leadBatchId: next.leadBatchId,
        campaign: next.campaign,
        tags: next.tags,
      });
      remapped += 1;
    } catch {
      /* continue */
    }
  }
  return { remapped };
}

function weeklyHoursFromDayParts(dayParts: Array<{ d: string; v: string }>): WeeklyOpeningHours | undefined {
  if (!dayParts.length) return undefined;
  const weekly: WeeklyOpeningHours = {};
  let any = false;
  for (const { d, v } of dayParts) {
    const day = d as Weekday;
    if (/^closed$/i.test(v) || v === '-') {
      weekly[day] = [];
      any = true;
      continue;
    }
    const hint = parseOpeningHoursHint(v);
    if (!hint) continue;
    weekly[day] = [{ openHour: hint.openHour, closeHour: hint.closeHour }];
    any = true;
  }
  return any ? weekly : undefined;
}

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
  weeklyHours?: WeeklyOpeningHours;
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
    const dayParts: Array<{ d: string; v: string }> = [];
    if (!openingHours?.trim()) {
      for (const { d, i: di } of dayCols) {
        if (di < 0) continue;
        const v = (parts[di] || '').trim();
        if (!v || /^closed$/i.test(v)) continue;
        dayParts.push({ d, v });
      }
      if (dayParts.length) openingHours = dayParts.map(({ d, v }) => `${d[0].toUpperCase()}${d.slice(1)}: ${v}`).join('; ');
    } else {
      for (const { d, i: di } of dayCols) {
        if (di < 0) continue;
        const v = (parts[di] || '').trim();
        if (!v) continue;
        dayParts.push({ d, v });
      }
    }
    const weeklyHours = weeklyHoursFromDayParts(dayParts);

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
      weeklyHours,
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
      .map((j) => normalizePhoneExport(toUkE164(String(j.to ?? '')))),
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
    const e164 = toUkE164(row.phone);
    const phone = normalizePhoneExport(e164);
    if (!phone || !isPlausibleUkE164(e164) || alreadyQueued.has(phone)) {
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
      weeklyHours: row.weeklyHours ? normalizeWeeklyHours(row.weeklyHours) || row.weeklyHours : undefined,
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
        weeklyHours: row.weeklyHours,
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
      weeklyHours: row.weeklyHours,
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
        aim: isSally ? 'sales_outreach' : template,
        agentPersona: isSally ? 'sally' : undefined,
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

const ALL_CRM_QUEUE_STATUSES = ['not_called', 'needs_retry'];

/** Queue Sally dials from existing CRM leads (not_called / batch) — same scheduler as CSV. */
export async function queueCrmCampaign(input: {
  batchId?: string;
  statuses?: string[];
  brief?: string;
  template?: string;
  dryRun?: boolean;
  remapLeeds?: boolean;
  /** When true, enqueue every dialable CRM lead (not Leeds/batch-only). */
  allCrm?: boolean;
  /** Default true for Leeds; false for allCrm so unknown hours do not become needs_hours. */
  venueAware?: boolean;
  /** Put failed outbound jobs back on the queue after a dialer fix. */
  requeueFailed?: boolean;
}): Promise<{
  queued: number;
  skipped: number;
  held: number;
  campaignId: string;
  remapped: number;
  matched: number;
  requeued?: number;
  jobs: Array<Record<string, unknown>>;
}> {
  const allCrm = input.allCrm === true;
  const shouldRemap = allCrm ? input.remapLeeds === true : input.remapLeeds !== false;
  const remapped = shouldRemap ? remapAllLeedsLegacyCustomers().remapped : 0;
  const campaignId = String(input.batchId || '').trim()
    || (allCrm ? `all-crm-${Date.now()}` : LEEDS_CAMPAIGN_ID);
  const statuses = (input.statuses?.length
    ? input.statuses
    : (allCrm ? ALL_CRM_QUEUE_STATUSES : ['not_called']))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  const venueAware = input.venueAware ?? (allCrm ? false : true);

  if (allCrm) {
    await reloadCustomersFromSupabase();
  }

  const store = getDataStore();

  const filtered = store.customers.filter((c) => {
    const rec = c as Record<string, unknown>;
    if (allCrm) {
      const phone = normalizePhoneExport(String(rec.phone ?? ''));
      if (!phone || phone.length < 7) return false;
      if (!assessContactEligibility(rec).eligible) return false;
      const pipeline = String(rec.status ?? '').trim().toLowerCase();
      if (pipeline && pipeline !== 'lead' && pipeline !== 'quoted') return false;
      const queueStatus = String(rec.callQueueStatus ?? '').trim().toLowerCase() || 'not_called';
      return statuses.includes(queueStatus);
    }
    const status = String(c.callQueueStatus ?? 'not_called').toLowerCase();
    if (!statuses.includes(status)) return false;
    if (campaignId === LEEDS_CAMPAIGN_ID || looksLikeLeedsLegacyLabel(campaignId)) {
      return customerMatchesLeedsBatch(rec, LEEDS_CAMPAIGN_ID);
    }
    const batch = String(c.leadBatchId ?? '').trim();
    const campaign = String(c.campaign ?? '').trim();
    const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t)) : [];
    return batch === campaignId || campaign === campaignId || tags.includes(campaignId);
  });

  const rows: CsvCampaignRow[] = filtered.map((c) => {
    const rec = c as Record<string, unknown>;
    const weekly = normalizeWeeklyHours(rec.weeklyHours) || undefined;
    return {
      name: String(rec.name ?? rec.contactName ?? 'Venue'),
      phone: String(rec.phone ?? ''),
      notes: rec.notes != null ? String(rec.notes) : undefined,
      address: rec.address != null ? String(rec.address) : undefined,
      customerId: String(rec.id),
      venueType: rec.venueType != null ? String(rec.venueType) : 'takeaway',
      openingHours: rec.openingHours != null ? String(rec.openingHours) : undefined,
      weeklyHours: weekly || undefined,
      closedDays: rec.closedDays != null ? String(rec.closedDays) : undefined,
      preferredContactTimes: rec.preferredContactTimes != null ? String(rec.preferredContactTimes) : undefined,
      timezone: rec.timezone != null ? String(rec.timezone) : 'Europe/London',
      consentToCall: rec.consentToCall === false || rec.doNotCall === true ? 'false' : 'true',
    };
  });

  if (input.dryRun) {
    return {
      queued: 0,
      skipped: 0,
      held: 0,
      campaignId,
      remapped,
      matched: rows.length,
      jobs: [],
    };
  }

  const result = await queueCsvCampaign({
    rows,
    template: input.template || 'sally_sales',
    brief: input.brief || DEFAULT_SALLY_BRIEF,
    batchId: campaignId,
    venueAware,
  });

  const repaired = input.requeueFailed === true ? requeueFailedOutboundJobs() : { requeued: 0 };

  return {
    ...result,
    remapped,
    matched: rows.length,
    requeued: repaired.requeued,
  };
}

/** Re-queue failed Sally jobs after a dialer/number fix. Rewrites `to` to UK E.164. */
export function requeueFailedOutboundJobs(): { requeued: number; skipped: number } {
  const store = getDataStore();
  const stamp = new Date().toISOString();
  let requeued = 0;
  let skipped = 0;
  for (const job of store.outboundQueue ?? []) {
    if (String(job.status ?? '') !== 'failed') continue;
    const e164 = toUkE164(String(job.to ?? ''));
    if (!isPlausibleUkE164(e164)) {
      skipped += 1;
      continue;
    }
    const prev = (job.context && typeof job.context === 'object')
      ? job.context as Record<string, unknown>
      : {};
    Object.assign(job, {
      to: e164,
      status: 'queued',
      error: undefined,
      requeuedAt: stamp,
      context: {
        ...prev,
        agentPersona: prev.agentPersona || 'sally',
        aim: prev.aim && !/sally|sales/i.test(String(prev.aim)) ? prev.aim : 'sales_outreach',
      },
    });
    requeued += 1;
  }
  if (requeued) syncData(store);
  return { requeued, skipped };
}
