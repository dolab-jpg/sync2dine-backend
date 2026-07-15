import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getDataStore, getAgentSettings, normalizePhoneExport } from '../data-store';
import { listTeamMembers } from '../conversation-store';
import { sendWhatsAppText } from '../whatsapp-webhook';
import { listDeviceTokens } from '../push/deviceTokenStore';
import { sendPushToTokens } from '../push/pushSender';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const INBOX_FILE = join(DATA_DIR, 'lead-inbox.json');

export type LeadCallbackPolicy = 'alert_only' | 'outbound_first' | 'inbound_only';
export type LeadInboxStatus = 'action_required' | 'skipped' | 'unparsed' | 'handled';

export interface LeadInboxItem {
  id: string;
  orgId: string;
  messageId: string;
  emailCacheId: string;
  subject: string;
  fromAddr: string;
  fromName?: string;
  summary: string;
  recommendation: string;
  customerId?: string;
  customerName?: string;
  phone?: string;
  jobScope?: string;
  status: LeadInboxStatus;
  mergedDuplicate?: boolean;
  draftReply?: { to: string; subject: string; body: string };
  toolsUsed: string[];
  auditLog?: string;
  createdAt: string;
  notifiedAt?: string;
  handledAt?: string;
}

interface LeadInboxStoreData {
  processedMessageIds: string[];
  items: LeadInboxItem[];
}

function defaultStore(): LeadInboxStoreData {
  return { processedMessageIds: [], items: [] };
}

function loadStore(): LeadInboxStoreData {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(INBOX_FILE)) return defaultStore();
  try {
    const parsed = JSON.parse(readFileSync(INBOX_FILE, 'utf8')) as LeadInboxStoreData;
    return {
      processedMessageIds: Array.isArray(parsed.processedMessageIds) ? parsed.processedMessageIds : [],
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return defaultStore();
  }
}

function saveStore(data: LeadInboxStoreData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(INBOX_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function getLeadCallbackPolicy(): LeadCallbackPolicy {
  const settings = getAgentSettings() as { leadCallbackPolicy?: LeadCallbackPolicy };
  const env = process.env.LEAD_CALLBACK_POLICY as LeadCallbackPolicy | undefined;
  const policy = settings.leadCallbackPolicy ?? env ?? 'alert_only';
  if (policy === 'outbound_first' || policy === 'inbound_only') return policy;
  return 'alert_only';
}

export function isMessageProcessed(messageId: string): boolean {
  return loadStore().processedMessageIds.includes(messageId);
}

export function markMessageProcessed(messageId: string): void {
  const store = loadStore();
  if (!store.processedMessageIds.includes(messageId)) {
    store.processedMessageIds.push(messageId);
    if (store.processedMessageIds.length > 5000) {
      store.processedMessageIds = store.processedMessageIds.slice(-4000);
    }
    saveStore(store);
  }
}

export function addInboxItem(item: Omit<LeadInboxItem, 'id' | 'createdAt'>): LeadInboxItem {
  const store = loadStore();
  const record: LeadInboxItem = {
    ...item,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  store.items.unshift(record);
  if (store.items.length > 500) store.items = store.items.slice(0, 400);
  saveStore(store);
  return record;
}

export function listInboxItems(orgId: string, since?: string): LeadInboxItem[] {
  const sinceMs = since ? new Date(since).getTime() : 0;
  return loadStore()
    .items
    .filter(i => i.orgId === orgId && new Date(i.createdAt).getTime() >= sinceMs)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getInboxItem(id: string): LeadInboxItem | undefined {
  return loadStore().items.find(i => i.id === id);
}

export function markInboxHandled(id: string): LeadInboxItem | undefined {
  const store = loadStore();
  const idx = store.items.findIndex(i => i.id === id);
  if (idx < 0) return undefined;
  store.items[idx] = {
    ...store.items[idx],
    status: 'handled',
    handledAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.items[idx];
}

export function markInboxNotified(id: string): LeadInboxItem | undefined {
  const store = loadStore();
  const idx = store.items.findIndex(i => i.id === id);
  if (idx < 0) return undefined;
  store.items[idx] = {
    ...store.items[idx],
    notifiedAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.items[idx];
}

export function countActionRequired(orgId: string): number {
  return loadStore().items.filter(
    i => i.orgId === orgId && i.status === 'action_required'
  ).length;
}

function isWithinBusinessHours(): boolean {
  const start = process.env.VOICE_BUSINESS_HOURS_START ?? '09:00';
  const end = process.env.VOICE_BUSINESS_HOURS_END ?? '17:30';
  const now = new Date();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= sh * 60 + (sm || 0) && mins <= eh * 60 + (em || 0);
}

export async function notifyStaff(
  orgId: string,
  summary: string,
  customerId?: string,
  urgency: 'normal' | 'high' = 'normal'
): Promise<void> {
  const prefix = urgency === 'high' ? 'URGENT: ' : 'Lead: ';
  const text = `${prefix}${summary}${customerId ? ` (CRM: ${customerId})` : ''}`;

  if (!isWithinBusinessHours()) return;

  const { getWWebStatus, sendWWebMessage } = await import('../whatsapp-web-client');
  const { isMetaWhatsAppEnabled } = await import('../whatsapp-webhook');
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wwebReady = getWWebStatus() === 'ready';
  const metaOk = isMetaWhatsAppEnabled() && Boolean(phoneNumberId && accessToken);
  if (!wwebReady && !metaOk) return;

  const staff = listTeamMembers(orgId).filter(
    m => m.role === 'staff' || m.role === 'manager' || m.role === 'super_admin'
  );

  for (const member of staff) {
    const phone = normalizePhoneExport(member.phone);
    if (!phone) continue;
    try {
      if (wwebReady) {
        await sendWWebMessage(phone, text);
      } else if (phoneNumberId && accessToken) {
        await sendWhatsAppText(phoneNumberId, accessToken, phone, text);
      }
    } catch (err) {
      console.error(`Lead alert WhatsApp failed for ${member.name}:`, err);
    }
  }

  const pushTokens = listDeviceTokens({ orgId });
  if (pushTokens.length > 0) {
    try {
      await sendPushToTokens(pushTokens, {
        title: urgency === 'high' ? 'Urgent lead' : 'New lead',
        body: summary,
        route: '/crm',
      });
    } catch (err) {
      console.error('Lead alert push failed:', err);
    }
  }
}

export function getCustomerSnapshots(customerIds: string[]): Record<string, unknown>[] {
  const store = getDataStore();
  const idSet = new Set(customerIds.filter(Boolean));
  return store.customers.filter(c => idSet.has(String(c.id)));
}

export function getProcessedEmailCacheIds(): Set<string> {
  const store = loadStore();
  return new Set(store.items.map(i => i.emailCacheId));
}
