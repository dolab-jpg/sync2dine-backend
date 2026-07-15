import {
  getDataStore,
  syncData,
  type ConversationHandoffMode,
  type WhatsAppConversationRecord,
} from './data-store';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  bodyEnglish?: string;
  detectedLanguage?: string;
  timestamp: string;
  channel?: string;
  fromRole?: string;
}

export interface WhatsAppConversation {
  phone: string;
  orgId: string;
  messages: ConversationMessage[];
  updatedAt: string;
  channel?: string;
  contactName?: string;
  handoffMode?: ConversationHandoffMode;
}

export interface ConversationThreadSummary {
  sessionId: string;
  phone: string;
  orgId: string;
  channel: string;
  contactName?: string;
  handoffMode: ConversationHandoffMode;
  messages: ConversationMessage[];
  lastAt: string;
  updatedAt: string;
}

export interface PendingConfirmation {
  id: string;
  phone: string;
  orgId: string;
  action: string;
  input: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  name: string;
  phone: string;
  role: 'super_admin' | 'manager' | 'staff' | 'builder';
  /** Worker UI / channel reply language: en | sq | uk | ru | zh | es | pl | fa */
  preferredLanguage?: string | null;
  /** scrypt$salt$hash — never return to clients */
  phonePinHash?: string;
  phonePinUpdatedAt?: string;
  updatedAt: string;
}

/** Normalize any session key (phone digits or web_/portal_ prefix). */
export function normalizeSessionKey(sessionId: string): string {
  const raw = (sessionId || '').trim();
  if (!raw) return '';
  if (/^(web_|portal_|email_)/i.test(raw)) {
    return raw.replace(/[^a-zA-Z0-9_.:-]/g, '');
  }
  return raw.replace(/\D/g, '');
}

export function convKey(orgId: string, phone: string): string {
  return `${orgId}:${normalizeSessionKey(phone)}`;
}

function ensureConversation(
  orgId: string,
  phone: string,
  extras?: Partial<Pick<WhatsAppConversationRecord, 'channel' | 'contactName' | 'handoffMode'>>,
): WhatsAppConversationRecord {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  const existing = (store.whatsappConversations ?? {})[key];
  if (existing) {
    if (extras?.channel && !existing.channel) existing.channel = extras.channel;
    if (extras?.contactName && !existing.contactName) existing.contactName = extras.contactName;
    return existing;
  }
  return {
    phone: normalizeSessionKey(phone),
    orgId,
    messages: [],
    updatedAt: new Date().toISOString(),
    handoffMode: 'ai_active',
    ...extras,
  };
}

export function getConversationMessages(orgId: string, phone: string, limit = 20): ConversationMessage[] {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  const conv = (store.whatsappConversations ?? {})[key];
  if (!conv?.messages?.length) return [];
  return conv.messages.slice(-limit) as ConversationMessage[];
}

export function getConversationRecord(orgId: string, phone: string): WhatsAppConversationRecord | null {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  return (store.whatsappConversations ?? {})[key] ?? null;
}

export function appendConversationMessage(
  orgId: string,
  phone: string,
  message: Omit<ConversationMessage, 'timestamp'> & { timestamp?: string },
  meta?: { channel?: string; contactName?: string },
): void {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  const existing = ensureConversation(orgId, phone, {
    channel: meta?.channel ?? message.channel,
    contactName: meta?.contactName,
  });
  const entry: ConversationMessage = {
    ...message,
    timestamp: message.timestamp ?? new Date().toISOString(),
  };
  existing.messages = [...(existing.messages ?? []), entry].slice(-100) as WhatsAppConversationRecord['messages'];
  existing.updatedAt = new Date().toISOString();
  if (meta?.channel) existing.channel = meta.channel;
  if (meta?.contactName) existing.contactName = meta.contactName;
  if (!existing.channel && message.channel) existing.channel = message.channel;
  if (!existing.handoffMode) existing.handoffMode = 'ai_active';
  store.whatsappConversations = { ...(store.whatsappConversations ?? {}), [key]: existing };
  syncData(store, orgId);
}

export function conversationToOrchestratorMessages(orgId: string, phone: string, limit = 20) {
  return getConversationMessages(orgId, phone, limit).map((m) => ({
    role: m.role,
    content: m.bodyEnglish ?? m.content,
  }));
}

export function getHandoffMode(orgId: string, phone: string): ConversationHandoffMode {
  const conv = getConversationRecord(orgId, phone);
  return conv?.handoffMode ?? 'ai_active';
}

export function setHandoffMode(orgId: string, phone: string, mode: ConversationHandoffMode): WhatsAppConversationRecord {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  const existing = ensureConversation(orgId, phone);
  existing.handoffMode = mode;
  existing.updatedAt = new Date().toISOString();
  store.whatsappConversations = { ...(store.whatsappConversations ?? {}), [key]: existing };
  syncData(store, orgId);
  return existing;
}

export function listConversationThreads(orgId: string): ConversationThreadSummary[] {
  const store = getDataStore(orgId);
  const all = store.whatsappConversations ?? {};
  const threads: ConversationThreadSummary[] = [];
  for (const [key, conv] of Object.entries(all)) {
    if (!key.startsWith(`${orgId}:`) && conv.orgId !== orgId) continue;
    const messages = (conv.messages ?? []) as ConversationMessage[];
    const last = messages[messages.length - 1];
    threads.push({
      sessionId: conv.phone || key.slice(orgId.length + 1),
      phone: conv.phone,
      orgId: conv.orgId || orgId,
      channel: conv.channel || last?.channel || 'whatsapp',
      contactName: conv.contactName,
      handoffMode: conv.handoffMode ?? 'ai_active',
      messages,
      lastAt: last?.timestamp ?? conv.updatedAt ?? '',
      updatedAt: conv.updatedAt ?? '',
    });
  }
  return threads.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
}

export function getThread(orgId: string, sessionId: string): ConversationThreadSummary | null {
  const conv = getConversationRecord(orgId, sessionId);
  if (!conv) return null;
  const messages = (conv.messages ?? []) as ConversationMessage[];
  const last = messages[messages.length - 1];
  return {
    sessionId: normalizeSessionKey(sessionId),
    phone: conv.phone,
    orgId: conv.orgId || orgId,
    channel: conv.channel || last?.channel || 'whatsapp',
    contactName: conv.contactName,
    handoffMode: conv.handoffMode ?? 'ai_active',
    messages,
    lastAt: last?.timestamp ?? conv.updatedAt ?? '',
    updatedAt: conv.updatedAt ?? '',
  };
}

export function setCompanySettings(
  orgId: string,
  settings: { website?: string; companyName?: string },
): void {
  const store = getDataStore(orgId);
  store.companySettings = {
    ...(store.companySettings ?? {}),
    ...settings,
  };
  syncData(store, orgId);
}

export function getCompanySettings(orgId: string): { website?: string; companyName?: string } {
  return getDataStore(orgId).companySettings ?? {};
}

export function savePendingConfirmation(
  orgId: string,
  phone: string,
  action: string,
  input: Record<string, unknown>
): PendingConfirmation {
  const store = getDataStore(orgId);
  const id = `pc-${Date.now()}`;
  const record: PendingConfirmation = {
    id,
    phone: normalizeSessionKey(phone),
    orgId,
    action,
    input,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  store.pendingConfirmations = [
    ...(store.pendingConfirmations ?? []).filter(
      (p) => !(p.phone === record.phone && p.orgId === orgId)
    ),
    record,
  ];
  syncData(store, orgId);
  return record;
}

export function consumePendingConfirmation(
  orgId: string,
  phone: string
): PendingConfirmation | null {
  const store = getDataStore(orgId);
  const normalized = normalizeSessionKey(phone);
  const pending = (store.pendingConfirmations ?? []).find(
    (p) => p.phone === normalized && p.orgId === orgId
  );
  if (!pending) return null;
  if (new Date(pending.expiresAt).getTime() < Date.now()) {
    store.pendingConfirmations = (store.pendingConfirmations ?? []).filter((p) => p.id !== pending.id);
    syncData(store, orgId);
    return null;
  }
  store.pendingConfirmations = (store.pendingConfirmations ?? []).filter((p) => p.id !== pending.id);
  syncData(store, orgId);
  return pending;
}

export function listTeamMembers(orgId?: string): TeamMember[] {
  return [...(getDataStore(orgId).teamMembers ?? [])];
}

export function upsertTeamMember(member: Omit<TeamMember, 'updatedAt'> & { updatedAt?: string }): TeamMember {
  const store = getDataStore();
  const now = new Date().toISOString();
  const record: TeamMember = { ...member, updatedAt: member.updatedAt ?? now };
  const idx = (store.teamMembers ?? []).findIndex((m) => m.id === record.id || m.phone === record.phone);
  const members = [...(store.teamMembers ?? [])];
  if (idx >= 0) {
    const prev = members[idx];
    // Preserve existing PIN hash unless a new one is explicitly provided
    members[idx] = {
      ...prev,
      ...record,
      phonePinHash: record.phonePinHash !== undefined ? record.phonePinHash : prev.phonePinHash,
      phonePinUpdatedAt: record.phonePinUpdatedAt !== undefined
        ? record.phonePinUpdatedAt
        : prev.phonePinUpdatedAt,
    };
  } else {
    members.push(record);
  }
  store.teamMembers = members;
  syncData(store);
  return members[idx >= 0 ? idx : members.length - 1];
}

export function publicTeamMember(m: TeamMember): Omit<TeamMember, 'phonePinHash'> & { hasPhonePin: boolean } {
  const { phonePinHash, ...rest } = m;
  return { ...rest, hasPhonePin: Boolean(phonePinHash) };
}
