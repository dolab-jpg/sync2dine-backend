import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BDIDDIES_HOME_ORG_LEGACY_ID, getHomeOrgId, sanitizeOrgId } from './home-org';
import {
  queueStatusAfterDisposition,
  type LeadCallDisposition,
} from './lead-call-disposition';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
export const DEFAULT_ORG_ID = 'default';

let requestOrgId = DEFAULT_ORG_ID;
const memoryStores = new Map<string, SyncedData>();
let legacyHomeMigrated = false;

function resolveStorageOrgId(orgId: string | null | undefined): string {
  const raw = orgId?.trim() || '';
  if (!raw || raw === DEFAULT_ORG_ID) {
    // Prefer configured home uuid so phone/API leads land with the CRM org
    const home = getHomeOrgId();
    return home || DEFAULT_ORG_ID;
  }
  return sanitizeOrgId(raw) ?? raw;
}

export function setRequestOrgId(orgId: string | null | undefined): void {
  requestOrgId = resolveStorageOrgId(orgId);
}

export function getRequestOrgId(): string {
  return requestOrgId;
}

export function withOrgContext<T>(orgId: string, fn: () => T): T {
  const prev = requestOrgId;
  requestOrgId = resolveStorageOrgId(orgId);
  try {
    return fn();
  } finally {
    requestOrgId = prev;
  }
}

function dataFileForOrg(orgId: string): string {
  return orgId === DEFAULT_ORG_ID
    ? join(DATA_DIR, 'synced-data.json')
    : join(DATA_DIR, `synced-data-${orgId}.json`);
}

export interface SyncedData {
  projects: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  builders: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  whatsappGroups: Record<string, Record<string, unknown>>;
  /** Cyrus / WhatsApp / phone shared conversation memory keyed by orgId:phone */
  whatsappConversations?: Record<string, WhatsAppConversationRecord>;
  teamMembers?: TeamMemberRecord[];
  pendingConfirmations?: PendingConfirmationRecord[];
  companySettings?: { website?: string; companyName?: string };
  calls: Array<Record<string, unknown>>;
  outboundQueue: Array<Record<string, unknown>>;
  recruitmentJobs: Array<Record<string, unknown>>;
  recruitmentCandidates: Array<Record<string, unknown>>;
  recruitmentInterviews: Array<Record<string, unknown>>;
  quotes: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  bankAccounts: Array<Record<string, unknown>>;
  bankTransactions: Array<Record<string, unknown>>;
  clientReceipts: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  planningApplications: Array<Record<string, unknown>>;
  /** Sync2Dine food orders (JSON fallback when Supabase orders table unavailable) */
  orders?: Array<Record<string, unknown>>;
  agentSettings: AgentSettings;
  phoneLines: PhoneLine[];
}

export type ConversationHandoffMode = 'ai_active' | 'human_takeover' | 'paused';

export interface WhatsAppConversationRecord {
  phone: string;
  orgId: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    bodyEnglish?: string;
    detectedLanguage?: string;
    timestamp: string;
    channel?: string;
    fromRole?: string;
  }>;
  updatedAt: string;
  channel?: string;
  contactName?: string;
  handoffMode?: ConversationHandoffMode;
}

export interface PendingConfirmationRecord {
  id: string;
  phone: string;
  orgId: string;
  action: string;
  input: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export type PhoneLineStatus = 'disconnected' | 'registering' | 'registered' | 'error';

export type PhoneLinePurpose = 'staff' | 'aria';

export interface PhoneLine {
  id: string;
  label: string;
  sipUsername: string;
  sipPassword: string;
  sipDomain: string;
  did: string;
  enabled: boolean;
  status: PhoneLineStatus;
  lastError?: string;
  registeredAt?: string;
  updatedAt: string;
  /** Profile / platform user id that owns this softphone extension */
  assignedUserId?: string;
  /** staff = human softphone; aria = AI bridge registration */
  purpose?: PhoneLinePurpose;
}

export interface TransferNumbers {
  general?: string;
  sales?: string;
  projects?: string;
  recruitment?: string;
  accounts?: string;
}

export interface AgentSettings {
  isActive: boolean;
  activeVoiceId?: string;
  leadCallbackPolicy?: 'alert_only' | 'outbound_first' | 'inbound_only';
  ivrTree?: Record<string, unknown>;
  /** Department → phone number for Cynthia live handoffs */
  transferNumbers?: TransferNumbers;
  /** Default text for CRM "Call this person" brief box */
  defaultOutboundBrief?: string;
  /** What Cynthia must capture after every outbound lead call */
  postCallNotePrompt?: string;
  /** Max dial attempts before marking called (no more retry) */
  callQueueMaxAttempts?: number;
  /** Minutes between retries for needs_retry leads */
  callQueueRetryMinutes?: number;
  /** Quiet hours start (HH:mm local) — skip auto dial */
  callQueueQuietStart?: string;
  /** Quiet hours end (HH:mm local) */
  callQueueQuietEnd?: string;
  /** Max simultaneous outbound dials (1–5) */
  callQueueMaxConcurrent?: number;
  /** Outbound worker state */
  outboundQueueState?: 'running' | 'paused' | 'stopped';
  /** Campaign brief stubs (review / reorder / winback) */
  campaignReviewBrief?: string;
  campaignReorderBrief?: string;
  campaignWinbackBrief?: string;
  /** Restaurant “about us” blurb for phone brain */
  aboutUs?: string;
  /** Optional daily spoken line (“say today”) for phone greetings */
  sayToday?: string;
  updatedAt: string;
}

const defaultAgentSettings: AgentSettings = {
  isActive: true,
  leadCallbackPolicy: 'alert_only',
  transferNumbers: {},
  defaultOutboundBrief: 'Follow up on their enquiry, confirm interest, and book a survey or quote if they want one.',
  postCallNotePrompt: 'After the call, note: interest level, any objection, next step, and best callback time if needed.',
  callQueueMaxAttempts: 3,
  callQueueRetryMinutes: 60,
  callQueueQuietStart: '20:00',
  callQueueQuietEnd: '08:00',
  callQueueMaxConcurrent: 2,
  outboundQueueState: 'running',
  campaignReviewBrief: 'Ask how their recent order was and invite them to leave a Google review.',
  campaignReorderBrief: 'Check if they would like to place another order — mention favourites or today\'s specials.',
  campaignWinbackBrief: 'We have not seen them in a while — offer a welcome-back discount on their next order.',
  updatedAt: new Date().toISOString(),
};

const defaultRecruitmentJobs = [
  { id: 'J001', title: 'Senior Sales Representative', department: 'sales', location: 'London, UK', status: 'open', description: 'Luxury bathroom sales.', salaryRange: '£35k-£45k', employmentType: 'full-time', requiredSkills: ['Sales'], qualifications: [], createdAt: '2026-03-15', positions: 2 },
  { id: 'J002', title: 'Microcement Installation Specialist', department: 'construction', location: 'Manchester, UK', status: 'open', description: 'Microcement specialist.', salaryRange: '£32k-£42k', employmentType: 'full-time', requiredSkills: ['Microcement'], qualifications: [], createdAt: '2026-03-20', positions: 3 },
  { id: 'J003', title: 'Office Administrator', department: 'office', location: 'Birmingham, UK', status: 'open', description: 'Office admin.', salaryRange: '£24k-£28k', employmentType: 'full-time', requiredSkills: ['Admin'], qualifications: [], createdAt: '2026-04-01', positions: 1 },
];

const defaultData: SyncedData = {
  projects: [],
  contacts: [],
  builders: [],
  sessions: [],
  whatsappGroups: {},
  whatsappConversations: {},
  teamMembers: [],
  pendingConfirmations: [],
  calls: [],
  outboundQueue: [],
  recruitmentJobs: defaultRecruitmentJobs,
  recruitmentCandidates: [],
  recruitmentInterviews: [],
  customers: [],
  quotes: [],
  bankAccounts: [],
  bankTransactions: [],
  clientReceipts: [],
  contracts: [],
  planningApplications: [],
  orders: [],
  agentSettings: { ...defaultAgentSettings },
  phoneLines: [],
};

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk(orgId: string): SyncedData {
  const DATA_FILE = dataFileForOrg(orgId);
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf-8')) as Partial<SyncedData>;
      const result: SyncedData = {
        ...defaultData,
        ...parsed,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
        builders: Array.isArray(parsed.builders) ? parsed.builders : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        whatsappGroups: parsed.whatsappGroups ?? {},
        whatsappConversations: parsed.whatsappConversations ?? {},
        teamMembers: Array.isArray(parsed.teamMembers) ? parsed.teamMembers : [],
        pendingConfirmations: Array.isArray(parsed.pendingConfirmations)
          ? parsed.pendingConfirmations
          : [],
        companySettings: parsed.companySettings && typeof parsed.companySettings === 'object'
          ? parsed.companySettings
          : undefined,
        calls: Array.isArray(parsed.calls) ? parsed.calls : [],
        outboundQueue: Array.isArray(parsed.outboundQueue) ? parsed.outboundQueue : [],
        recruitmentJobs: Array.isArray(parsed.recruitmentJobs) && parsed.recruitmentJobs.length
          ? parsed.recruitmentJobs
          : defaultRecruitmentJobs,
        recruitmentCandidates: Array.isArray(parsed.recruitmentCandidates) ? parsed.recruitmentCandidates : [],
        recruitmentInterviews: Array.isArray(parsed.recruitmentInterviews) ? parsed.recruitmentInterviews : [],
        customers: Array.isArray(parsed.customers) ? parsed.customers : [],
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
        bankAccounts: Array.isArray(parsed.bankAccounts) ? parsed.bankAccounts : [],
        bankTransactions: Array.isArray(parsed.bankTransactions) ? parsed.bankTransactions : [],
        clientReceipts: Array.isArray(parsed.clientReceipts) ? parsed.clientReceipts : [],
        contracts: Array.isArray(parsed.contracts) ? parsed.contracts : [],
        planningApplications: Array.isArray(parsed.planningApplications) ? parsed.planningApplications : [],
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        agentSettings: parsed.agentSettings && typeof parsed.agentSettings === 'object'
          ? { ...defaultAgentSettings, ...(parsed.agentSettings as AgentSettings) }
          : { ...defaultAgentSettings },
        phoneLines: Array.isArray(parsed.phoneLines) ? (parsed.phoneLines as PhoneLine[]) : [],
      };
      migrateLegacySoho66Line(result);
      return result;
    }
  } catch {
    // ignore
  }
  const data = { ...defaultData };
  migrateLegacySoho66Line(data);
  return data;
}

function migrateLegacySoho66Line(data: SyncedData): void {
  if (data.phoneLines.length > 0) return;
  const username = process.env.SOHO66_SIP_USERNAME?.trim();
  const password = process.env.SOHO66_SIP_PASSWORD?.trim();
  const did = process.env.SOHO66_FROM_NUMBER?.trim();
  if (!username || !password) return;
  const now = new Date().toISOString();
  data.phoneLines = [{
    id: 'line-legacy-1',
    label: 'Line 1 (migrated)',
    sipUsername: username,
    sipPassword: password,
    sipDomain: process.env.SOHO66_SIP_DOMAIN?.trim() || 'sbc.soho66.co.uk',
    did: did ?? '',
    enabled: true,
    status: 'disconnected',
    updatedAt: now,
  }];
}

function mergeRecordArrays(
  primary: Array<Record<string, unknown>>,
  secondary: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of secondary) {
    const id = String(item.id ?? '');
    if (id) map.set(id, item);
  }
  for (const item of primary) {
    const id = String(item.id ?? '');
    if (id) map.set(id, item);
  }
  return [...map.values()];
}

/** One-time: fold legacy "default" / "bdiddies" disk stores into the home org uuid file. */
function migrateLegacyOrgDiskStores(): void {
  if (legacyHomeMigrated) return;
  legacyHomeMigrated = true;
  const homeId = getHomeOrgId();
  if (!homeId || homeId === DEFAULT_ORG_ID) return;

  const home = loadFromDisk(homeId);
  const legacyDefault = loadFromDisk(DEFAULT_ORG_ID);
  const legacySlug = loadFromDisk(BDIDDIES_HOME_ORG_LEGACY_ID);

  const mergedCustomers = mergeRecordArrays(
    home.customers,
    mergeRecordArrays(legacyDefault.customers, legacySlug.customers),
  );
  const mergedQuotes = mergeRecordArrays(
    home.quotes,
    mergeRecordArrays(legacyDefault.quotes, legacySlug.quotes),
  );
  const mergedCalls = mergeRecordArrays(
    home.calls,
    mergeRecordArrays(legacyDefault.calls, legacySlug.calls),
  );
  const mergedContacts = mergeRecordArrays(
    home.contacts,
    mergeRecordArrays(legacyDefault.contacts, legacySlug.contacts),
  );

  const gained =
    mergedCustomers.length > home.customers.length
    || mergedQuotes.length > home.quotes.length
    || mergedCalls.length > home.calls.length
    || mergedContacts.length > home.contacts.length;

  if (!gained && home.customers.length > 0) {
    memoryStores.set(homeId, home);
    return;
  }

  const next: SyncedData = {
    ...home,
    customers: mergedCustomers,
    quotes: mergedQuotes,
    calls: mergedCalls,
    contacts: mergedContacts,
    projects: home.projects.length ? home.projects : (legacyDefault.projects.length ? legacyDefault.projects : legacySlug.projects),
    phoneLines: home.phoneLines.length ? home.phoneLines : (legacyDefault.phoneLines.length ? legacyDefault.phoneLines : legacySlug.phoneLines),
    agentSettings: home.agentSettings ?? legacyDefault.agentSettings ?? legacySlug.agentSettings,
    teamMembers: home.teamMembers?.length ? home.teamMembers : (legacyDefault.teamMembers?.length ? legacyDefault.teamMembers : legacySlug.teamMembers),
  };
  memoryStores.set(homeId, next);
  ensureDir();
  try {
    writeFileSync(dataFileForOrg(homeId), JSON.stringify(next, null, 2));
  } catch {
    // ignore
  }
}

function ensureOrgLoaded(orgId: string): SyncedData {
  migrateLegacyOrgDiskStores();
  const id = resolveStorageOrgId(orgId);
  let store = memoryStores.get(id);
  if (!store) {
    store = loadFromDisk(id);
    memoryStores.set(id, store);
  }
  return store;
}

export function getDataStore(orgId?: string): SyncedData {
  const id = resolveStorageOrgId(orgId ?? requestOrgId);
  const store = ensureOrgLoaded(id);
  if (store.projects.length === 0 && store.contacts.length === 0 && store.phoneLines.length === 0) {
    const loaded = loadFromDisk(id);
    memoryStores.set(id, loaded);
    return loaded;
  }
  return store;
}

export function syncData(data: Partial<SyncedData>, orgId?: string): void {
  const id = resolveStorageOrgId(orgId ?? requestOrgId);
  const memoryStore = ensureOrgLoaded(id);
  const next: SyncedData = {
    ...memoryStore,
    ...data,
    builders: data.builders ?? memoryStore.builders,
    whatsappGroups: data.whatsappGroups ?? memoryStore.whatsappGroups,
    whatsappConversations: data.whatsappConversations ?? memoryStore.whatsappConversations ?? {},
    teamMembers: data.teamMembers ?? memoryStore.teamMembers ?? [],
    pendingConfirmations: data.pendingConfirmations ?? memoryStore.pendingConfirmations ?? [],
    agentSettings: data.agentSettings ?? memoryStore.agentSettings,
    phoneLines: data.phoneLines ?? memoryStore.phoneLines,
  };
  // Never let an empty cloud snapshot wipe local CRM collections
  const preferNonEmpty = <T>(incoming: T[] | undefined, existing: T[] | undefined): T[] => {
    if (Array.isArray(incoming) && incoming.length > 0) return incoming;
    if (Array.isArray(existing) && existing.length > 0) return existing;
    return Array.isArray(incoming) ? incoming : (existing ?? []);
  };
  next.customers = preferNonEmpty(data.customers as Array<Record<string, unknown>> | undefined, memoryStore.customers);
  next.contacts = preferNonEmpty(data.contacts as Array<Record<string, unknown>> | undefined, memoryStore.contacts);
  next.projects = preferNonEmpty(data.projects as Array<Record<string, unknown>> | undefined, memoryStore.projects);
  next.quotes = preferNonEmpty(data.quotes as Array<Record<string, unknown>> | undefined, memoryStore.quotes);
  next.calls = preferNonEmpty(data.calls as Array<Record<string, unknown>> | undefined, memoryStore.calls);
  next.orders = preferNonEmpty(
    data.orders as Array<Record<string, unknown>> | undefined,
    memoryStore.orders as Array<Record<string, unknown>> | undefined,
  );
  next.phoneLines = preferNonEmpty(data.phoneLines, memoryStore.phoneLines);

  memoryStores.set(id, next);

  // Always keep a local JSON cache — Supabase adapter does not yet persist Cyrus threads.
  ensureDir();
  try {
    writeFileSync(dataFileForOrg(id), JSON.stringify(next, null, 2));
  } catch {
    // ignore write errors in dev
  }

  import('./supabase-data.js').then(({ isSupabaseConfigured, syncDataToSupabase }) => {
    if (isSupabaseConfigured()) {
      syncDataToSupabase(next, id).catch(() => { /* ignore async write errors */ });
    }
  }).catch(() => { /* ignore */ });
}

/** Preload org data from Supabase on server startup */
export async function initDataFromSupabase(orgId?: string): Promise<void> {
  // Resolve through home-org so hydration lands in the same store requests read from.
  const id = resolveStorageOrgId(orgId ?? DEFAULT_ORG_ID);
  try {
    const { isSupabaseConfigured, loadSyncedDataFromSupabase } = await import('./supabase-data.js');
    if (!isSupabaseConfigured()) return;
    const data = await loadSyncedDataFromSupabase(id);
    // Local disk wins when it has richer CRM (supabase shell orgs often look "populated" but incomplete)
    const disk = loadFromDisk(id);
    data.whatsappConversations = {
      ...(disk.whatsappConversations ?? {}),
      ...(data.whatsappConversations ?? {}),
    };
    data.teamMembers = (data.teamMembers?.length ? data.teamMembers : disk.teamMembers) ?? [];
    const richer = <T>(cloud: T[] | undefined, local: T[] | undefined): T[] => {
      const c = cloud ?? [];
      const l = local ?? [];
      return l.length >= c.length ? l : c;
    };
    data.phoneLines = richer(data.phoneLines, disk.phoneLines);
    data.customers = richer(data.customers, disk.customers);
    data.contacts = richer(data.contacts, disk.contacts);
    data.projects = richer(data.projects, disk.projects);
    data.quotes = richer(data.quotes, disk.quotes);
    memoryStores.set(id, data);
  } catch {
    // fall back to JSON files
  }
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('44')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

export function normalizePhoneExport(phone: string): string {
  return normalizePhone(phone);
}

export interface TeamMemberRecord {
  id: string;
  userId?: string;
  name: string;
  phone: string;
  role: string;
  preferredLanguage?: string | null;
  phonePinHash?: string;
  phonePinUpdatedAt?: string;
}

export function resolveStaffByPhone(phone: string, orgId?: string): TeamMemberRecord | null {
  const normalized = normalizePhone(phone);
  const members = (getDataStore(orgId).teamMembers ?? []) as TeamMemberRecord[];
  return members.find((m) => normalizePhone(String(m.phone ?? '')) === normalized) ?? null;
}

export function resolveContactByPhone(phone: string): {
  customerId: string | null;
  customerName: string;
  contactName: string;
  contactRole: string;
  projectId: string | null;
  activeQuotes: Array<{ tradeName?: string; total: number; status: string; expiresAt: string }>;
} {
  const store = getDataStore();
  const normalized = normalizePhone(phone);
  const contact = store.contacts.find(
    c => normalizePhone(String(c.phone ?? '')) === normalized
  );
  const customerId = contact ? String(contact.customerId) : null;
  const primaryContact = customerId
    ? store.contacts.find(c => String(c.customerId) === customerId && c.isPrimary)
    : null;
  const project = store.projects.find(
    p => String(p.customerId) === customerId && p.status !== 'completed'
  );
  const accountName = primaryContact
    ? String(primaryContact.name)
    : (contact ? String(contact.name) : 'Guest');
  return {
    customerId,
    customerName: accountName,
    contactName: contact ? String(contact.name) : 'Guest',
    contactRole: contact ? String(contact.role ?? 'primary') : 'guest',
    projectId: project ? String(project.id) : null,
    activeQuotes: getActiveQuotes(customerId),
  };
}

// Local copy (quote-lookup.ts imports this module, so importing it back would be a cycle).
function getActiveQuotes(customerId: string | null): Array<{
  tradeName?: string;
  total: number;
  status: string;
  expiresAt: string;
}> {
  if (!customerId) return [];
  const store = getDataStore();
  return (store.quotes ?? [])
    .filter((q) => String(q.customerId ?? '') === customerId)
    .filter((q) => !['rejected', 'expired'].includes(String(q.status ?? '')))
    .map((q) => ({
      tradeName: String(q.tradeName ?? q.tradeId ?? ''),
      total: Number(q.total ?? 0),
      status: String(q.status ?? 'draft'),
      expiresAt: String(q.expiresAt ?? ''),
    }));
}

export function getProjectById(id: string): Record<string, unknown> | undefined {
  return getDataStore().projects.find(p => String(p.id) === id);
}

export function saveQuoteRecord(quote: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const id = String(quote.id ?? `Q${Date.now()}`);
  const existing = store.quotes.findIndex((q) => String(q.id) === id);
  const record = {
    ...quote,
    id,
    updatedAt: new Date().toISOString(),
    createdAt: quote.createdAt ?? new Date().toISOString(),
  };
  if (existing >= 0) {
    store.quotes[existing] = { ...store.quotes[existing], ...record };
  } else {
    store.quotes.unshift(record);
  }
  syncData(store);
  return record;
}

export function updateQuoteRecord(id: string, patch: Record<string, unknown>): Record<string, unknown> | null {
  const store = getDataStore();
  const idx = store.quotes.findIndex((q) => String(q.id) === id);
  if (idx < 0) return null;
  store.quotes[idx] = { ...store.quotes[idx], ...patch, updatedAt: new Date().toISOString() };
  syncData(store);
  return store.quotes[idx];
}

export function listOrderRecords(): Array<Record<string, unknown>> {
  const store = getDataStore();
  return Array.isArray(store.orders) ? store.orders : [];
}

export function saveOrderRecord(order: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  if (!Array.isArray(store.orders)) store.orders = [];
  const id = String(order.id ?? `ord-${Date.now()}`);
  const existing = store.orders.findIndex((o) => String(o.id) === id);
  const maxNumber = store.orders.reduce((max, o) => {
    const n = Number(o.orderNumber ?? 0);
    return Number.isFinite(n) && n > max ? n : max;
  }, 100);
  const record = {
    ...order,
    id,
    orderNumber: Number(order.orderNumber ?? maxNumber + 1),
    status: String(order.status ?? 'new'),
    paymentStatus: String(order.paymentStatus ?? 'unpaid'),
    orderType: String(order.orderType ?? 'collection'),
    items: Array.isArray(order.items) ? order.items : [],
    total: Number(order.total ?? 0),
    updatedAt: new Date().toISOString(),
    createdAt: order.createdAt ?? new Date().toISOString(),
  };
  if (existing >= 0) {
    store.orders[existing] = { ...store.orders[existing], ...record };
  } else {
    store.orders.unshift(record);
  }
  syncData(store);
  return record;
}

export function updateOrderRecord(id: string, patch: Record<string, unknown>): Record<string, unknown> | null {
  const store = getDataStore();
  if (!Array.isArray(store.orders)) store.orders = [];
  const idx = store.orders.findIndex((o) => String(o.id) === id);
  if (idx < 0) return null;
  store.orders[idx] = { ...store.orders[idx], ...patch, updatedAt: new Date().toISOString() };
  syncData(store);
  return store.orders[idx];
}

/** Count live ringing / in-progress calls for the current org data store. */
export function countOpenCallsForOrg(): number {
  expireStaleOpenCalls();
  return getDataStore().calls.filter((c) => isOpenCallStatus(c.status)).length;
}

/** Max simultaneous live calls (inbound + outbound) per org. Default 5. */
export function getMaxConcurrentCallsPerOrg(): number {
  const fromSettings = getAgentSettings().callQueueMaxConcurrent;
  if (Number.isFinite(fromSettings) && fromSettings! > 0) {
    return Math.max(1, Math.min(5, Math.floor(fromSettings!)));
  }
  const n = Number(process.env.MAX_CONCURRENT_CALLS_PER_ORG ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.min(5, Math.floor(n)) : 5;
}

/** True when auto outbound dialling should be skipped (quiet hours). */
export function isWithinCallQueueQuietHours(now = new Date()): boolean {
  const { callQueueQuietStart, callQueueQuietEnd } = getAgentSettings();
  const start = String(callQueueQuietStart ?? '20:00').trim();
  const end = String(callQueueQuietEnd ?? '08:00').trim();
  const toMins = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map((v) => Number(v));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const startM = toMins(start);
  const endM = toMins(end);
  if (startM == null || endM == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (startM === endM) return false;
  if (startM < endM) return cur >= startM && cur < endM;
  return cur >= startM || cur < endM;
}

export function getOutboundQueueState(): 'running' | 'paused' | 'stopped' {
  const state = getAgentSettings().outboundQueueState;
  return state === 'paused' || state === 'stopped' ? state : 'running';
}

/** Cancel queued outbound jobs when the queue is stopped. */
export function cancelQueuedOutboundJobs(): number {
  const store = getDataStore();
  let count = 0;
  for (const job of store.outboundQueue) {
    if (String(job.status ?? '') !== 'queued') continue;
    Object.assign(job, { status: 'cancelled', cancelledAt: new Date().toISOString() });
    count += 1;
  }
  if (count) syncData(store);
  return count;
}

export function updateProjectRecord(
  projectId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const store = getDataStore();
  const idx = store.projects.findIndex((p) => String(p.id) === projectId);
  if (idx < 0) return null;
  store.projects[idx] = { ...store.projects[idx], ...patch, updatedAt: new Date().toISOString() };
  syncData(store);
  return store.projects[idx];
}

export function appendProjectMessageRecord(
  projectId: string,
  message: Record<string, unknown>,
): void {
  const store = getDataStore();
  const idx = store.projects.findIndex((p) => String(p.id) === projectId);
  if (idx < 0) return;
  const project = store.projects[idx];
  const messages = Array.isArray(project.messages) ? [...project.messages as unknown[]] : [];
  messages.push(message);
  store.projects[idx] = { ...project, messages };
  syncData(store);
}

export function getProjectByGroupId(groupId: string): Record<string, unknown> | undefined {
  const store = getDataStore();
  const entry = Object.entries(store.whatsappGroups).find(([, g]) => g.metaGroupId === groupId);
  if (!entry) return undefined;
  return store.projects.find(p => String(p.id) === entry[0]);
}

export function saveWhatsAppGroup(projectId: string, group: Record<string, unknown>): void {
  const store = getDataStore();
  store.whatsappGroups[projectId] = group;
  syncData(store);
}

export function updateWhatsAppSession(phone: string, channel: 'individual' | 'group' = 'individual', groupId?: string): void {
  const store = getDataStore();
  const normalized = normalizePhone(phone);
  store.sessions = store.sessions.filter(s => normalizePhone(String(s.phone)) !== normalized);
  store.sessions.push({
    phone: normalized,
    lastInboundAt: new Date().toISOString(),
    channel,
    groupId,
  });
  syncData(store);
}

export function isWithin24hWindow(phone: string): boolean {
  const normalized = normalizePhone(phone);
  const session = getDataStore().sessions.find(s => normalizePhone(String(s.phone)) === normalized);
  if (!session) return false;
  return Date.now() - new Date(String(session.lastInboundAt)).getTime() < 24 * 60 * 60 * 1000;
}

export function getCallById(id: string): Record<string, unknown> | undefined {
  return getDataStore().calls.find(c => String(c.id) === id);
}

export function getCallByProviderId(providerCallId: string): Record<string, unknown> | undefined {
  const id = String(providerCallId || '').trim();
  if (!id) return undefined;
  const matches = getDataStore().calls.filter((c) => String(c.providerCallId) === id);
  if (!matches.length) return undefined;
  if (matches.length === 1) return matches[0];
  // Prefer TradePro-owned rows over orphan webhook rows that used the Vapi UUID as local id
  const preferred = matches.find((c) => {
    const localId = String(c.id);
    const meta = (c.metadata as Record<string, unknown> | undefined) || {};
    return (
      localId.startsWith('out-')
      || localId.startsWith('call-')
      || localId.startsWith('vapi-out-')
      || String(meta.tradeproCallId || '') === localId
      || localId !== id
    );
  });
  return preferred || matches[0];
}

export function saveCall(call: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const id = String(call.id ?? `call-${Date.now()}`);
  const existing = store.calls.findIndex(c => String(c.id) === id);
  const record = { ...call, id, updatedAt: new Date().toISOString() };
  if (existing >= 0) {
    store.calls[existing] = { ...store.calls[existing], ...record };
  } else {
    store.calls.unshift(record);
  }
  syncData(store);
  return record;
}

export function appendCallTurn(callId: string, turn: Record<string, unknown>): void {
  const store = getDataStore();
  const call = store.calls.find(c => String(c.id) === callId);
  if (!call) return;
  const transcript = Array.isArray(call.transcript) ? [...call.transcript] : [];
  transcript.push({
    ...turn,
    timestamp: turn.timestamp ?? new Date().toISOString(),
  });
  call.transcript = transcript;
  syncData(store);
}

export function enqueueOutboundCall(job: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const id = String(job.id ?? `out-${Date.now()}`);
  const record = {
    ...job,
    id,
    status: job.status ?? 'queued',
    createdAt: job.createdAt ?? new Date().toISOString(),
  };
  store.outboundQueue.unshift(record);
  syncData(store);
  return record;
}

export function updateOutboundJob(id: string, patch: Record<string, unknown>): void {
  const store = getDataStore();
  const job = store.outboundQueue.find(j => String(j.id) === id);
  if (!job) return;
  Object.assign(job, patch);
  syncData(store);
}

/** Mark outbound queue rows tied to a call as completed (end-of-call, not dial-accept). */
export function completeOutboundJobsForCall(callId: string, patch?: Record<string, unknown>): void {
  if (!callId) return;
  const store = getDataStore();
  let changed = false;
  for (const job of store.outboundQueue) {
    if (String(job.callId ?? '') !== callId) continue;
    const status = String(job.status ?? '');
    if (status === 'completed' || status === 'cancelled') continue;
    Object.assign(job, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      ...(patch || {}),
    });
    changed = true;
  }
  if (changed) syncData(store);
}

/** Set customer call-queue status when an outbound dial is accepted. */
export function markCustomerDialling(customerId: string, callId?: string): void {
  if (!customerId) return;
  const store = getDataStore();
  const idx = store.customers.findIndex((c) => String(c.id) === customerId);
  if (idx < 0) return;
  const customer = store.customers[idx] as Record<string, unknown>;
  store.customers[idx] = {
    ...customer,
    callQueueStatus: 'dialling',
    lastCallId: callId ?? customer.lastCallId,
    lastContact: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  syncData(store);
}

export function resolveCandidateByPhone(phone: string): {
  candidateId: string | null;
  candidateName: string;
  desiredRole: string;
} {
  const store = getDataStore();
  const normalized = normalizePhone(phone);
  const candidate = store.recruitmentCandidates.find(
    c => normalizePhone(String(c.phone ?? '')) === normalized
  );
  return {
    candidateId: candidate ? String(candidate.id) : null,
    candidateName: candidate ? String(candidate.name ?? 'Guest') : 'Guest',
    desiredRole: candidate ? String(candidate.desiredRole ?? '') : '',
  };
}

export function saveRecruitmentCandidate(candidate: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const id = String(candidate.id ?? `CAND${Date.now()}`);
  const existing = store.recruitmentCandidates.findIndex(c => String(c.id) === id);
  const record = { ...candidate, id, updatedAt: new Date().toISOString() };
  if (existing >= 0) {
    store.recruitmentCandidates[existing] = { ...store.recruitmentCandidates[existing], ...record };
  } else {
    store.recruitmentCandidates.unshift(record);
  }
  syncData(store);
  return record;
}

export function saveRecruitmentInterview(interview: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const id = String(interview.id ?? `INT${Date.now()}`);
  const record = { ...interview, id, createdAt: interview.createdAt ?? new Date().toISOString() };
  store.recruitmentInterviews.unshift(record);
  syncData(store);
  return record;
}

export function saveCustomerRecord(customer: Record<string, unknown>): Record<string, unknown> {
  const store = getDataStore();
  const phone = String(customer.phone ?? '');
  const email = String(customer.email ?? '').trim().toLowerCase();

  let id = customer.id ? String(customer.id) : '';
  let existingIdx = id ? store.customers.findIndex(c => String(c.id) === id) : -1;

  // AI/phone/WhatsApp callers rarely pass an id — match by phone/email to avoid duplicate CRM rows.
  if (existingIdx < 0 && (phone || email)) {
    const dup = store.customers.find(c => {
      if (phone && normalizePhone(String(c.phone ?? '')) === normalizePhone(phone)) return true;
      if (email && String(c.email ?? '').trim().toLowerCase() === email && email.length > 3) return true;
      return false;
    });
    if (dup) {
      existingIdx = store.customers.findIndex(c => String(c.id) === String(dup.id));
      id = String(dup.id);
    }
  }

  if (!id) id = `C${Date.now()}`;

  const record = {
    ...customer,
    id,
    status: customer.status ?? 'lead',
    createdAt: customer.createdAt ?? new Date().toISOString(),
    mergedFromDuplicate: existingIdx >= 0 && !customer.id ? true : customer.mergedFromDuplicate,
  };
  if (existingIdx >= 0) {
    store.customers[existingIdx] = { ...store.customers[existingIdx], ...record };
  } else {
    store.customers.unshift(record);
  }
  syncData(store);
  const saved = store.customers.find(c => String(c.id) === id) ?? record;
  // Direct mirror to public.customers under the home-org uuid. syncData's full sync also upserts
  // customers, but it resolves the org via a cloud organizations lookup that can fall back to the
  // shared default org — this mirror guarantees the row lands where the CRM UI reads it.
  void import('./supabase-crm')
    .then(({ mirrorCustomerToSupabaseAsync }) => {
      mirrorCustomerToSupabaseAsync(saved as Record<string, unknown>, getRequestOrgId());
    })
    .catch((err) => {
      console.warn('[data-store] supabase mirror import failed:', err);
    });
  return saved;
}

/** Append a phone-call activity note onto the customer record. */
export function appendCustomerCallActivity(input: {
  customerId: string;
  callId?: string;
  summary: string;
  outcome?: string;
  disposition?: string;
  aim?: string;
  detail?: string;
  createdBy?: string;
  type?: string;
  /** When true, also update lastCall* / callQueueStatus denormalised fields */
  updateCallQueue?: boolean;
  transferredTo?: string;
}): Record<string, unknown> {
  const store = getDataStore();
  const idx = store.customers.findIndex(c => String(c.id) === input.customerId);
  const stamp = new Date().toISOString();
  const detail = (input.detail ?? input.summary).trim();
  const aimBit = input.aim ? ` Aim: ${input.aim}.` : '';
  const dispositionBit = input.disposition ? ` Disposition: ${input.disposition}.` : '';
  const line = [
    `[Cynthia call ${stamp.slice(0, 16).replace('T', ' ')}]`,
    detail,
    aimBit,
    dispositionBit,
    input.outcome ? `Outcome: ${input.outcome.trim()}` : '',
    input.transferredTo ? `Transferred to: ${input.transferredTo}` : '',
    input.callId ? `(callId ${input.callId})` : '',
  ].filter(Boolean).join(' ');

  const activity = {
    id: `CA${Date.now()}`,
    type: input.type ?? 'call',
    aim: input.aim ?? null,
    detail,
    summary: input.summary,
    outcome: input.outcome ?? null,
    disposition: input.disposition ?? null,
    callSessionId: input.callId ?? null,
    callId: input.callId ?? null,
    createdAt: stamp,
    createdBy: input.createdBy ?? 'cynthia',
  };

  if (idx < 0) {
    return { ...activity, logged: false };
  }

  const customer = store.customers[idx] as Record<string, unknown>;
  const prevNotes = String(customer.notes ?? '');
  const activities = Array.isArray(customer.activities)
    ? [...(customer.activities as unknown[])]
    : [];
  activities.unshift(activity);

  const patch: Record<string, unknown> = {
    ...customer,
    notes: prevNotes ? `${line}\n${prevNotes}` : line,
    activities: activities.slice(0, 50),
    lastContact: stamp,
    updatedAt: stamp,
  };

  if (input.updateCallQueue) {
    const prevAttempts = Number(customer.callAttemptCount ?? 0);
    const sameCall = input.callId && customer.lastCallId === input.callId;
    const attemptCount = input.callId && !sameCall ? prevAttempts + 1 : Math.max(prevAttempts, 1);
    const maxAttempts = getAgentSettings().callQueueMaxAttempts ?? 3;
    let callQueueStatus = customer.callQueueStatus;
    if (input.disposition) {
      callQueueStatus = queueStatusAfterDisposition(
        input.disposition as LeadCallDisposition,
        attemptCount,
        maxAttempts,
      );
    }
    Object.assign(patch, {
      lastCallAt: stamp,
      lastCallId: input.callId ?? customer.lastCallId,
      lastCallDisposition: input.disposition ?? customer.lastCallDisposition,
      lastCallSummary: (input.summary || detail).slice(0, 400),
      callAttemptCount: attemptCount,
      callQueueStatus: callQueueStatus ?? 'called',
    });
  }

  store.customers[idx] = patch;
  syncData(store);
  return { ...activity, logged: true };
}

/** Build a spoken/CRM brief from customer notes + activities for Cynthia. */
export function buildLeadBriefFromCustomer(customer: Record<string, unknown> | undefined): {
  found: boolean;
  customerId: string | null;
  name: string | null;
  status: string | null;
  phone: string | null;
  nextFollowUp: string | null;
  notesPreview: string | null;
  activities: Array<Record<string, unknown>>;
  spokenHint: string;
} {
  if (!customer) {
    return {
      found: false,
      customerId: null,
      name: null,
      status: null,
      phone: null,
      nextFollowUp: null,
      notesPreview: null,
      activities: [],
      spokenHint: 'No lead on file for that lookup.',
    };
  }
  const activitiesRaw = Array.isArray(customer.activities) ? customer.activities as Array<Record<string, unknown>> : [];
  const activities = activitiesRaw.slice(0, 8).map((a) => ({
    type: a.type ?? 'note',
    aim: a.aim ?? null,
    detail: String(a.detail ?? a.summary ?? '').slice(0, 280),
    outcome: a.outcome ?? null,
    createdAt: a.createdAt ?? null,
    createdBy: a.createdBy ?? null,
  }));
  const name = String(customer.name ?? 'Lead');
  const notes = String(customer.notes ?? '').slice(0, 400);
  const activityLines = activities
    .filter((a) => a.detail)
    .map((a) => {
      const aim = a.aim ? ` [${a.aim}]` : '';
      return `${String(a.createdAt ?? '').slice(0, 10)}${aim}: ${a.detail}`;
    });
  const spokenHint = [
    `${name} is on file as ${String(customer.status ?? 'lead')}.`,
    activityLines.length
      ? `Recent conversation: ${activityLines.slice(0, 3).join(' | ')}`
      : notes
        ? `Notes: ${notes.slice(0, 200)}`
        : 'No prior conversation notes yet.',
  ].join(' ');

  return {
    found: true,
    customerId: String(customer.id),
    name,
    status: customer.status != null ? String(customer.status) : null,
    phone: customer.phone != null ? String(customer.phone) : null,
    nextFollowUp: customer.nextFollowUp != null ? String(customer.nextFollowUp) : null,
    notesPreview: notes || null,
    activities,
    spokenHint,
  };
}

export function getAgentSettings(): AgentSettings {
  const store = getDataStore();
  if (!store.agentSettings) {
    store.agentSettings = { ...defaultAgentSettings };
    syncData(store);
  }
  return store.agentSettings;
}

export function isAgentActive(): boolean {
  return getAgentSettings().isActive !== false;
}

export function updateAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
  const store = getDataStore();
  store.agentSettings = {
    ...getAgentSettings(),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  syncData(store);
  return store.agentSettings;
}

export function getTransferNumbers(): TransferNumbers {
  return { ...(getAgentSettings().transferNumbers ?? {}) };
}

export function updateTransferNumbers(patch: TransferNumbers): TransferNumbers {
  const cleaned: TransferNumbers = {};
  const keys: Array<keyof TransferNumbers> = ['general', 'sales', 'projects', 'recruitment', 'accounts'];
  for (const key of keys) {
    const val = patch[key];
    if (typeof val === 'string' && val.trim()) cleaned[key] = val.trim();
  }
  updateAgentSettings({ transferNumbers: cleaned });
  return getTransferNumbers();
}

export function listPhoneLines(): PhoneLine[] {
  return [...getDataStore().phoneLines];
}

export function getPhoneLineById(id: string): PhoneLine | undefined {
  return getDataStore().phoneLines.find(l => l.id === id);
}

export function resolvePhoneLineByDid(did: string): PhoneLine | undefined {
  const normalized = normalizePhone(did);
  return getDataStore().phoneLines.find(l => normalizePhone(l.did) === normalized && l.enabled);
}

export function savePhoneLine(
  input: Partial<PhoneLine> & {
    label: string;
    sipUsername: string;
    sipPassword: string;
    did: string;
    assignedUserId?: string | null;
  },
): PhoneLine {
  const store = getDataStore();
  const now = new Date().toISOString();
  const id = input.id ?? `line-${Date.now()}`;
  const existing = store.phoneLines.findIndex(l => l.id === id);
  const prev = existing >= 0 ? store.phoneLines[existing] : undefined;
  const assignedUserId =
    input.assignedUserId === null || input.assignedUserId === ''
      ? undefined
      : (typeof input.assignedUserId === 'string' ? input.assignedUserId.trim() : undefined) || prev?.assignedUserId;
  const purpose: PhoneLinePurpose =
    input.purpose === 'aria' || input.purpose === 'staff'
      ? input.purpose
      : (prev?.purpose ?? 'staff');
  const record: PhoneLine = {
    id,
    label: input.label,
    sipUsername: input.sipUsername,
    sipPassword: input.sipPassword,
    sipDomain: input.sipDomain?.trim() || process.env.SOHO66_SIP_DOMAIN?.trim() || 'sbc.soho66.co.uk',
    did: input.did,
    enabled: input.enabled !== false,
    status: input.status ?? (prev?.status ?? 'disconnected'),
    lastError: input.lastError,
    registeredAt: input.registeredAt,
    updatedAt: now,
    assignedUserId,
    purpose,
  };
  if (existing >= 0) {
    store.phoneLines[existing] = { ...store.phoneLines[existing], ...record };
  } else {
    store.phoneLines.push(record);
  }
  syncData(store);
  return store.phoneLines.find(l => l.id === id)!;
}

export function getPhoneLineByAssignedUserId(userId: string): PhoneLine | undefined {
  const id = userId?.trim();
  if (!id) return undefined;
  return getDataStore().phoneLines.find(
    l => l.enabled && l.assignedUserId === id && (l.purpose ?? 'staff') === 'staff',
  );
}

export function deletePhoneLine(id: string): boolean {
  const store = getDataStore();
  const before = store.phoneLines.length;
  store.phoneLines = store.phoneLines.filter(l => l.id !== id);
  if (store.phoneLines.length === before) return false;
  syncData(store);
  return true;
}

export function updatePhoneLineStatus(
  id: string,
  patch: Partial<Pick<PhoneLine, 'status' | 'lastError' | 'registeredAt'>>,
): PhoneLine | undefined {
  const store = getDataStore();
  const line = store.phoneLines.find(l => l.id === id);
  if (!line) return undefined;
  Object.assign(line, patch, { updatedAt: new Date().toISOString() });
  syncData(store);
  return line;
}

export function maskPhoneLine(line: PhoneLine): Omit<PhoneLine, 'sipPassword'> & { sipPassword: string } {
  return {
    ...line,
    sipPassword: line.sipPassword ? '••••••' : '',
  };
}

/** Open call rows older than this are treated as abandoned (missed end-of-call webhook). */
export const STALE_OPEN_CALL_MAX_MS = Number(process.env.STALE_OPEN_CALL_MAX_MS ?? 45 * 60 * 1000);

function callStartedAtMs(call: Record<string, unknown>): number {
  const t = call.startedAt ? new Date(String(call.startedAt)).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** Persist-complete any ringing/in_progress call older than TTL. Returns how many were closed. */
export function expireStaleOpenCalls(nowMs: number = Date.now()): number {
  const store = getDataStore();
  const maxAge = STALE_OPEN_CALL_MAX_MS > 0 ? STALE_OPEN_CALL_MAX_MS : 45 * 60 * 1000;
  const stamp = new Date(nowMs).toISOString();
  let closed = 0;
  for (let i = 0; i < store.calls.length; i++) {
    const c = store.calls[i];
    const status = String(c.status ?? '');
    if (status !== 'ringing' && status !== 'in_progress') continue;
    if (c.endedAt) {
      // Already ended but status left open — normalize
      store.calls[i] = { ...c, status: 'completed', updatedAt: stamp };
      closed += 1;
      continue;
    }
    const started = callStartedAtMs(c);
    if (!Number.isFinite(started) || nowMs - started < maxAge) continue;
    store.calls[i] = {
      ...c,
      status: 'completed',
      endedAt: stamp,
      outcome: String(c.outcome ?? 'stale_timeout'),
      updatedAt: stamp,
    };
    closed += 1;
  }
  if (closed > 0) syncData(store);
  return closed;
}

function isOpenCallStatus(status: unknown): boolean {
  const s = String(status ?? '');
  return s === 'ringing' || s === 'in_progress';
}

export function getLinesSummary(): { total: number; registered: number; onCall: number } {
  expireStaleOpenCalls();
  const store = getDataStore();
  const total = store.phoneLines.filter(l => l.enabled).length;
  const registered = store.phoneLines.filter(l => l.enabled && l.status === 'registered').length;
  const activeLineIds = new Set(
    store.calls
      .filter(c => isOpenCallStatus(c.status))
      .map(c => String(c.lineId ?? ''))
      .filter(Boolean),
  );
  return { total, registered, onCall: activeLineIds.size };
}

export function resolveAvailableLineForOutbound(): PhoneLine | undefined {
  expireStaleOpenCalls();
  const store = getDataStore();
  const busyLineIds = new Set(
    store.calls
      .filter(c => isOpenCallStatus(c.status))
      .map(c => String(c.lineId ?? ''))
      .filter(Boolean),
  );
  const available = store.phoneLines.filter(
    l => l.enabled && l.status === 'registered' && !busyLineIds.has(l.id),
  );
  return (
    available.find(l => (l.purpose ?? 'staff') === 'aria')
    ?? available[0]
  );
}

export function computeCallSentiment(call: Record<string, unknown>): 'negative' | 'neutral' | 'positive' {
  if (call.escalated || call.intent === 'complaint') return 'negative';
  const outcome = String(call.outcome ?? '');
  if (/lead_captured|interview_booked|resolved|completed/i.test(outcome)) return 'positive';
  return 'neutral';
}

export function computeCallDurationSec(call: Record<string, unknown>): number | null {
  const start = call.startedAt ? new Date(String(call.startedAt)).getTime() : NaN;
  const end = call.endedAt ? new Date(String(call.endedAt)).getTime() : NaN;
  if (!Number.isFinite(start)) return null;
  const endMs = Number.isFinite(end) ? end : Date.now();
  return Math.max(0, Math.round((endMs - start) / 1000));
}

function startOfTodayLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getAgentStatusSnapshot(): {
  activeCall: Record<string, unknown> | null;
  activeCalls: Array<Record<string, unknown>>;
  linesSummary: { total: number; registered: number; onCall: number };
  todayStats: {
    totalCalls: number;
    avgDurationSec: number;
    aiResolvedPct: number;
    callbacksBooked: number;
  };
} {
  expireStaleOpenCalls();
  const store = getDataStore();
  const todayStart = startOfTodayLocal();
  const todayCalls = store.calls.filter(c => {
    const t = new Date(String(c.startedAt ?? '')).getTime();
    return Number.isFinite(t) && t >= todayStart;
  });

  const activeCalls = store.calls
    .filter(c => isOpenCallStatus(c.status))
    .map(call => ({
      ...call,
      elapsedSec: computeCallDurationSec(call),
      contactName: call.contactName ?? resolveContactByPhone(String(call.from ?? '')).customerName,
      lineLabel: call.lineLabel ?? store.phoneLines.find(l => l.id === call.lineId)?.label,
    }));

  const activeCall = activeCalls[0] ?? null;

  const completed = todayCalls.filter(c => c.endedAt || ['completed', 'failed', 'no_answer', 'busy'].includes(String(c.status ?? '')));
  const durations = completed.map(c => computeCallDurationSec(c)).filter((d): d is number => d !== null);
  const avgDurationSec = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  const resolved = todayCalls.filter(c => {
    const outcome = String(c.outcome ?? '');
    const escalated = Boolean(c.escalated);
    const transferred = outcome.includes('transferred') || outcome.includes('transfer');
    return !escalated && !transferred && String(c.status ?? '') === 'completed';
  });
  const aiResolvedPct = todayCalls.length
    ? Math.round((resolved.length / todayCalls.length) * 100)
    : 0;

  const callbacksFromCalls = todayCalls.filter(c => {
    const outcome = String(c.outcome ?? '');
    return /callback|message_captured/i.test(outcome);
  }).length;
  const callbacksFromQueue = store.outboundQueue.filter(j => {
    const t = new Date(String(j.createdAt ?? '')).getTime();
    return Number.isFinite(t) && t >= todayStart;
  }).length;

  return {
    activeCall: activeCall
      ? {
          ...activeCall,
        }
      : null,
    activeCalls,
    linesSummary: getLinesSummary(),
    todayStats: {
      totalCalls: todayCalls.length,
      avgDurationSec,
      aiResolvedPct,
      callbacksBooked: callbacksFromCalls + callbacksFromQueue,
    },
  };
}

export function lookupContactByPhone(phone: string): {
  found: boolean;
  name?: string;
  status?: string;
  accountValue?: number;
  lastInteraction?: string;
  customerId?: string;
  message?: string;
} {
  const store = getDataStore();
  const normalized = normalizePhone(phone);
  const resolved = resolveContactByPhone(phone);

  let customer = resolved.customerId
    ? store.customers.find(c => String(c.id) === resolved.customerId)
    : store.customers.find(c => normalizePhone(String(c.phone ?? '')) === normalized);

  if (!customer) {
    customer = store.contacts.find(c => normalizePhone(String(c.phone ?? '')) === normalized) as Record<string, unknown> | undefined;
  }

  if (!customer && !resolved.customerId) {
    return {
      found: false,
      message: 'Cynthia will create a new contact when this number calls.',
    };
  }

  const customerId = resolved.customerId ?? (customer ? String(customer.id ?? customer.customerId ?? '') : '');
  const name = resolved.customerName !== 'Guest'
    ? resolved.customerName
    : String(customer?.name ?? 'Unknown');

  const relatedCalls = store.calls
    .filter(c => normalizePhone(String(c.from ?? '')) === normalized)
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  const lastCall = relatedCalls[0];

  let lastInteraction = lastCall ? String(lastCall.startedAt) : undefined;
  if (resolved.projectId) {
    const project = store.projects.find(p => String(p.id) === resolved.projectId);
    const messages = Array.isArray(project?.messages) ? project.messages as Array<{ timestamp?: string }> : [];
    const lastMsg = messages.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))[0];
    if (lastMsg?.timestamp && (!lastInteraction || lastMsg.timestamp > lastInteraction)) {
      lastInteraction = lastMsg.timestamp;
    }
  }

  const customerRecord = store.customers.find(c => String(c.id) === customerId);
  const accountValue = customerRecord
    ? Number(customerRecord.accountValue ?? customerRecord.totalQuotes ?? 0)
    : 0;

  return {
    found: true,
    name,
    status: customerRecord ? String(customerRecord.status ?? 'lead') : 'lead',
    accountValue: accountValue || undefined,
    lastInteraction,
    customerId: customerId || undefined,
  };
}

export function isAfterHours(
  start = process.env.VOICE_BUSINESS_HOURS_START ?? '09:00',
  end = process.env.VOICE_BUSINESS_HOURS_END ?? '17:30',
): boolean {
  const now = new Date();
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const day = now.getDay();
  if (day === 0 || day === 6) return true;
  return minutes < startMinutes || minutes >= endMinutes;
}
