import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
export const DEFAULT_ORG_ID = 'default';

let requestOrgId = DEFAULT_ORG_ID;
const memoryStores = new Map<string, SyncedData>();

export function setRequestOrgId(orgId: string | null | undefined): void {
  requestOrgId = orgId?.trim() || DEFAULT_ORG_ID;
}

export function getRequestOrgId(): string {
  return requestOrgId;
}

export function withOrgContext<T>(orgId: string, fn: () => T): T {
  const prev = requestOrgId;
  requestOrgId = orgId?.trim() || DEFAULT_ORG_ID;
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
  agentSettings: AgentSettings;
  phoneLines: PhoneLine[];
}

export type PhoneLineStatus = 'disconnected' | 'registering' | 'registered' | 'error';

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
}

export interface AgentSettings {
  isActive: boolean;
  activeVoiceId?: string;
  updatedAt: string;
}

const defaultAgentSettings: AgentSettings = {
  isActive: true,
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
    sipDomain: process.env.SOHO66_SIP_DOMAIN?.trim() || 'sip.soho66.com',
    did: did ?? '',
    enabled: true,
    status: 'disconnected',
    updatedAt: now,
  }];
}

function ensureOrgLoaded(orgId: string): SyncedData {
  let store = memoryStores.get(orgId);
  if (!store) {
    store = loadFromDisk(orgId);
    memoryStores.set(orgId, store);
  }
  return store;
}

export function getDataStore(orgId?: string): SyncedData {
  const id = orgId ?? requestOrgId;
  const store = ensureOrgLoaded(id);
  if (store.projects.length === 0 && store.contacts.length === 0 && store.phoneLines.length === 0) {
    const loaded = loadFromDisk(id);
    memoryStores.set(id, loaded);
    return loaded;
  }
  return store;
}

export function syncData(data: Partial<SyncedData>, orgId?: string): void {
  const id = orgId ?? requestOrgId;
  const memoryStore = ensureOrgLoaded(id);
  const next = {
    ...memoryStore,
    ...data,
    builders: data.builders ?? memoryStore.builders,
    whatsappGroups: data.whatsappGroups ?? memoryStore.whatsappGroups,
    agentSettings: data.agentSettings ?? memoryStore.agentSettings,
    phoneLines: data.phoneLines ?? memoryStore.phoneLines,
  };
  memoryStores.set(id, next);

  // Supabase is primary when configured
  import('./supabase-data.js').then(({ isSupabaseConfigured, syncDataToSupabase }) => {
    if (isSupabaseConfigured()) {
      syncDataToSupabase(next, id).catch(() => { /* ignore async write errors */ });
      return;
    }
    ensureDir();
    try {
      writeFileSync(dataFileForOrg(id), JSON.stringify(next, null, 2));
    } catch {
      // ignore write errors in dev
    }
  }).catch(() => {
    ensureDir();
    try {
      writeFileSync(dataFileForOrg(id), JSON.stringify(next, null, 2));
    } catch { /* ignore */ }
  });
}

/** Preload org data from Supabase on server startup */
export async function initDataFromSupabase(orgId?: string): Promise<void> {
  const id = orgId ?? DEFAULT_ORG_ID;
  try {
    const { isSupabaseConfigured, loadSyncedDataFromSupabase } = await import('./supabase-data.js');
    if (!isSupabaseConfigured()) return;
    const data = await loadSyncedDataFromSupabase(id);
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
    activeQuotes: [],
  };
}

export function getProjectById(id: string): Record<string, unknown> | undefined {
  return getDataStore().projects.find(p => String(p.id) === id);
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
  return getDataStore().calls.find(c => String(c.providerCallId) === providerCallId);
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
  const id = String(customer.id ?? `C${Date.now()}`);
  const existing = store.customers.findIndex(c => String(c.id) === id);
  const record = {
    ...customer,
    id,
    status: customer.status ?? 'lead',
    createdAt: customer.createdAt ?? new Date().toISOString(),
  };
  if (existing >= 0) {
    store.customers[existing] = { ...store.customers[existing], ...record };
  } else {
    store.customers.unshift(record);
  }
  syncData(store);
  return record;
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

export function savePhoneLine(input: Partial<PhoneLine> & { label: string; sipUsername: string; sipPassword: string; did: string }): PhoneLine {
  const store = getDataStore();
  const now = new Date().toISOString();
  const id = input.id ?? `line-${Date.now()}`;
  const existing = store.phoneLines.findIndex(l => l.id === id);
  const record: PhoneLine = {
    id,
    label: input.label,
    sipUsername: input.sipUsername,
    sipPassword: input.sipPassword,
    sipDomain: input.sipDomain?.trim() || 'sip.soho66.com',
    did: input.did,
    enabled: input.enabled !== false,
    status: input.status ?? (existing >= 0 ? store.phoneLines[existing].status : 'disconnected'),
    lastError: input.lastError,
    registeredAt: input.registeredAt,
    updatedAt: now,
  };
  if (existing >= 0) {
    store.phoneLines[existing] = { ...store.phoneLines[existing], ...record };
  } else {
    store.phoneLines.push(record);
  }
  syncData(store);
  return store.phoneLines.find(l => l.id === id)!;
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

export function getLinesSummary(): { total: number; registered: number; onCall: number } {
  const store = getDataStore();
  const total = store.phoneLines.filter(l => l.enabled).length;
  const registered = store.phoneLines.filter(l => l.enabled && l.status === 'registered').length;
  const activeLineIds = new Set(
    store.calls
      .filter(c => ['ringing', 'in_progress'].includes(String(c.status ?? '')))
      .map(c => String(c.lineId ?? ''))
      .filter(Boolean),
  );
  return { total, registered, onCall: activeLineIds.size };
}

export function resolveAvailableLineForOutbound(): PhoneLine | undefined {
  const store = getDataStore();
  const busyLineIds = new Set(
    store.calls
      .filter(c => ['ringing', 'in_progress'].includes(String(c.status ?? '')))
      .map(c => String(c.lineId ?? ''))
      .filter(Boolean),
  );
  return store.phoneLines.find(l => l.enabled && l.status === 'registered' && !busyLineIds.has(l.id));
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
  const store = getDataStore();
  const todayStart = startOfTodayLocal();
  const todayCalls = store.calls.filter(c => {
    const t = new Date(String(c.startedAt ?? '')).getTime();
    return Number.isFinite(t) && t >= todayStart;
  });

  const activeCalls = store.calls
    .filter(c => {
      const status = String(c.status ?? '');
      return status === 'ringing' || status === 'in_progress';
    })
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
      message: 'Aria will create a new contact when this number calls.',
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
