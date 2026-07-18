import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CALENDAR_FILE = join(DATA_DIR, 'calendar-data.json');

export interface CalendarConnection {
  id: string;
  orgId: string;
  userId: string;
  emailAddress: string;
  calendarId: string;
  status: 'connected' | 'needs_reconnect' | 'error' | 'disconnected';
  connectedAt: string;
  lastError?: string;
}

export interface CalendarTokenRow {
  connectionId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: string;
  scope?: string;
  updatedAt: string;
}

interface CalendarStoreData {
  connections: CalendarConnection[];
  tokens: CalendarTokenRow[];
}

function defaultStore(): CalendarStoreData {
  return { connections: [], tokens: [] };
}

function loadStore(): CalendarStoreData {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CALENDAR_FILE)) return defaultStore();
  try {
    const parsed = JSON.parse(readFileSync(CALENDAR_FILE, 'utf8')) as CalendarStoreData;
    return { ...defaultStore(), ...parsed };
  } catch {
    return defaultStore();
  }
}

function saveStore(data: CalendarStoreData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CALENDAR_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function listCalendarConnections(orgId?: string, userId?: string): CalendarConnection[] {
  return loadStore().connections.filter((c) => {
    if (c.status === 'disconnected') return false;
    if (orgId && c.orgId !== orgId) return false;
    if (userId && c.userId !== userId) return false;
    return true;
  });
}

export function getCalendarConnection(id: string): CalendarConnection | undefined {
  return loadStore().connections.find((c) => c.id === id);
}

export function getActiveCalendarConnection(orgId: string, userId?: string): CalendarConnection | undefined {
  const list = listCalendarConnections(orgId, userId);
  return list.find((c) => c.status === 'connected') || list[0];
}

export function upsertCalendarConnection(conn: CalendarConnection): CalendarConnection {
  const store = loadStore();
  const idx = store.connections.findIndex((c) => c.id === conn.id);
  if (idx >= 0) store.connections[idx] = conn;
  else store.connections.push(conn);
  saveStore(store);
  return conn;
}

export function createCalendarConnection(
  input: Omit<CalendarConnection, 'id' | 'connectedAt'>,
): CalendarConnection {
  // One active connection per user/org — replace prior
  const store = loadStore();
  store.connections = store.connections.map((c) => {
    if (c.orgId === input.orgId && c.userId === input.userId && c.status !== 'disconnected') {
      return { ...c, status: 'disconnected' as const };
    }
    return c;
  });
  saveStore(store);

  const conn: CalendarConnection = {
    ...input,
    id: randomUUID(),
    connectedAt: new Date().toISOString(),
  };
  return upsertCalendarConnection(conn);
}

export function deleteCalendarConnection(id: string): void {
  const store = loadStore();
  store.connections = store.connections.filter((c) => c.id !== id);
  store.tokens = store.tokens.filter((t) => t.connectionId !== id);
  saveStore(store);
}

export function saveCalendarTokenRow(row: CalendarTokenRow): void {
  const store = loadStore();
  const idx = store.tokens.findIndex((t) => t.connectionId === row.connectionId);
  if (idx >= 0) store.tokens[idx] = row;
  else store.tokens.push(row);
  saveStore(store);
}

export function getCalendarTokenRow(connectionId: string): CalendarTokenRow | undefined {
  return loadStore().tokens.find((t) => t.connectionId === connectionId);
}

export function deleteCalendarTokenRow(connectionId: string): void {
  const store = loadStore();
  store.tokens = store.tokens.filter((t) => t.connectionId !== connectionId);
  saveStore(store);
}
