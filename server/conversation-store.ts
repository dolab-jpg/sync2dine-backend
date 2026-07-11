import { getDataStore, syncData } from './data-store';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  bodyEnglish?: string;
  detectedLanguage?: string;
  timestamp: string;
  channel?: string;
}

export interface WhatsAppConversation {
  phone: string;
  orgId: string;
  messages: ConversationMessage[];
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
  updatedAt: string;
}

function convKey(orgId: string, phone: string): string {
  return `${orgId}:${phone.replace(/\D/g, '')}`;
}

export function getConversationMessages(orgId: string, phone: string, limit = 20): ConversationMessage[] {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  const conv = (store.whatsappConversations ?? {})[key];
  if (!conv?.messages?.length) return [];
  return conv.messages.slice(-limit);
}

export function appendConversationMessage(
  orgId: string,
  phone: string,
  message: Omit<ConversationMessage, 'timestamp'> & { timestamp?: string }
): void {
  const store = getDataStore(orgId);
  const key = convKey(orgId, phone);
  const existing = (store.whatsappConversations ?? {})[key] ?? {
    phone,
    orgId,
    messages: [],
    updatedAt: new Date().toISOString(),
  };
  const entry: ConversationMessage = {
    ...message,
    timestamp: message.timestamp ?? new Date().toISOString(),
  };
  existing.messages = [...(existing.messages ?? []), entry].slice(-100);
  existing.updatedAt = new Date().toISOString();
  store.whatsappConversations = { ...(store.whatsappConversations ?? {}), [key]: existing };
  syncData(store, orgId);
}

export function conversationToOrchestratorMessages(orgId: string, phone: string, limit = 20) {
  return getConversationMessages(orgId, phone, limit).map((m) => ({
    role: m.role,
    content: m.bodyEnglish ?? m.content,
  }));
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
    phone: phone.replace(/\D/g, ''),
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
  const normalized = phone.replace(/\D/g, '');
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
  if (idx >= 0) members[idx] = { ...members[idx], ...record };
  else members.push(record);
  store.teamMembers = members;
  syncData(store);
  return record;
}
