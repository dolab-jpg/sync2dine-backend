import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type {
  CachedEmailAttachment,
  CachedEmailMessage,
  MailboxConnection,
  MailboxSyncState,
  MailboxTokenRow,
} from './types';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const MAILBOX_FILE = join(DATA_DIR, 'mailbox-data.json');

export interface MailboxStoreData {
  connections: MailboxConnection[];
  tokens: MailboxTokenRow[];
  syncState: MailboxSyncState[];
  messages: CachedEmailMessage[];
  attachments: CachedEmailAttachment[];
}

function defaultStore(): MailboxStoreData {
  return {
    connections: [],
    tokens: [],
    syncState: [],
    messages: [],
    attachments: [],
  };
}

function loadStore(): MailboxStoreData {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(MAILBOX_FILE)) return defaultStore();
  try {
    const parsed = JSON.parse(readFileSync(MAILBOX_FILE, 'utf8')) as MailboxStoreData;
    return { ...defaultStore(), ...parsed };
  } catch {
    return defaultStore();
  }
}

function saveStore(data: MailboxStoreData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MAILBOX_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function listConnections(orgId?: string, userId?: string): MailboxConnection[] {
  const store = loadStore();
  return store.connections.filter(c => {
    if (orgId && c.orgId !== orgId) return false;
    if (userId && c.userId !== userId) return false;
    return c.status !== 'disconnected';
  });
}

export function getConnection(id: string): MailboxConnection | undefined {
  return loadStore().connections.find(c => c.id === id);
}

export function upsertConnection(conn: MailboxConnection): MailboxConnection {
  const store = loadStore();
  const idx = store.connections.findIndex(c => c.id === conn.id);
  if (idx >= 0) store.connections[idx] = conn;
  else store.connections.push(conn);
  saveStore(store);
  return conn;
}

export function createConnection(input: Omit<MailboxConnection, 'id' | 'connectedAt'>): MailboxConnection {
  const conn: MailboxConnection = {
    ...input,
    id: randomUUID(),
    connectedAt: new Date().toISOString(),
  };
  return upsertConnection(conn);
}

export function deleteConnection(id: string): void {
  const store = loadStore();
  store.connections = store.connections.filter(c => c.id !== id);
  store.tokens = store.tokens.filter(t => t.connectionId !== id);
  store.syncState = store.syncState.filter(s => s.connectionId !== id);
  store.messages = store.messages.filter(m => m.connectionId !== id);
  saveStore(store);
}

export function saveTokenRow(row: MailboxTokenRow): void {
  const store = loadStore();
  const idx = store.tokens.findIndex(t => t.connectionId === row.connectionId);
  if (idx >= 0) store.tokens[idx] = row;
  else store.tokens.push(row);
  saveStore(store);
}

export function getTokenRow(connectionId: string): MailboxTokenRow | undefined {
  return loadStore().tokens.find(t => t.connectionId === connectionId);
}

export function deleteTokenRow(connectionId: string): void {
  const store = loadStore();
  store.tokens = store.tokens.filter(t => t.connectionId !== connectionId);
  saveStore(store);
}

export function getSyncState(connectionId: string): MailboxSyncState {
  const store = loadStore();
  const existing = store.syncState.find(s => s.connectionId === connectionId);
  if (existing) return existing;
  return {
    connectionId,
    folder: 'INBOX',
    lastUid: 0,
    pollIntervalSec: 180,
  };
}

export function saveSyncState(state: MailboxSyncState): void {
  const store = loadStore();
  const idx = store.syncState.findIndex(s => s.connectionId === state.connectionId);
  if (idx >= 0) store.syncState[idx] = state;
  else store.syncState.push(state);
  saveStore(store);
}

export function upsertMessage(msg: CachedEmailMessage): CachedEmailMessage {
  const store = loadStore();
  const idx = store.messages.findIndex(
    m => m.connectionId === msg.connectionId && m.messageId === msg.messageId
  );
  if (idx >= 0) store.messages[idx] = msg;
  else store.messages.push(msg);
  saveStore(store);
  return msg;
}

export function listMessages(connectionId: string, limit = 50): CachedEmailMessage[] {
  return loadStore()
    .messages
    .filter(m => m.connectionId === connectionId)
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    .slice(0, limit);
}

export function getMessage(id: string): CachedEmailMessage | undefined {
  return loadStore().messages.find(m => m.id === id);
}

export function listAttachments(messageCacheId: string): CachedEmailAttachment[] {
  return loadStore().attachments.filter(a => a.messageCacheId === messageCacheId);
}

export function saveAttachment(att: CachedEmailAttachment): void {
  const store = loadStore();
  const idx = store.attachments.findIndex(a => a.id === att.id);
  if (idx >= 0) store.attachments[idx] = att;
  else store.attachments.push(att);
  saveStore(store);
}

export function seedMockInbox(connectionId: string): void {
  const store = loadStore();
  if (store.messages.some(m => m.connectionId === connectionId)) return;
  const now = new Date();
  const msgs: CachedEmailMessage[] = [
    {
      id: randomUUID(),
      connectionId,
      uid: 1001,
      messageId: '<mock-john-quote@example.com>',
      threadId: 'thread-john-quote',
      subject: 'Re: Bathroom quote request',
      fromAddr: 'john.smith@example.com',
      fromName: 'John Smith',
      toAddrs: ['you@company.com'],
      snippet: 'Hi, can you send the updated quote with the walk-in shower option?',
      textBody: 'Hi,\n\nCan you send the updated quote with the walk-in shower option?\n\nThanks,\nJohn',
      receivedAt: new Date(now.getTime() - 3600000).toISOString(),
      hasAttachments: false,
      syncedAt: now.toISOString(),
    },
    {
      id: randomUUID(),
      connectionId,
      uid: 1002,
      messageId: '<mock-sarah-booking@example.com>',
      threadId: 'thread-sarah-booking',
      subject: 'Booking confirmation',
      fromAddr: 'sarah.jones@example.com',
      fromName: 'Sarah Jones',
      toAddrs: ['you@company.com'],
      snippet: 'Confirming our site visit for next Tuesday at 10am.',
      textBody: 'Hello,\n\nConfirming our site visit for next Tuesday at 10am.\n\nSarah',
      receivedAt: new Date(now.getTime() - 7200000).toISOString(),
      hasAttachments: false,
      syncedAt: now.toISOString(),
    },
  ];
  store.messages.push(...msgs);
  saveStore(store);
}

export function listActiveConnections(): MailboxConnection[] {
  return loadStore().connections.filter(c => c.status === 'connected');
}
