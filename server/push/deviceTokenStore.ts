import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TOKENS_FILE = join(DATA_DIR, 'device-tokens.json');

export interface DeviceTokenRecord {
  token: string;
  platform: 'ios' | 'android' | 'web';
  userId?: string;
  orgId?: string;
  updatedAt: string;
}

interface TokenStore {
  tokens: DeviceTokenRecord[];
}

function loadStore(): TokenStore {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(TOKENS_FILE)) return { tokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as TokenStore;
    return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch {
    return { tokens: [] };
  }
}

function saveStore(data: TokenStore): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function upsertDeviceToken(record: Omit<DeviceTokenRecord, 'updatedAt'>): DeviceTokenRecord {
  const store = loadStore();
  const now = new Date().toISOString();
  const idx = store.tokens.findIndex(t => t.token === record.token);
  const next: DeviceTokenRecord = { ...record, updatedAt: now };
  if (idx >= 0) {
    store.tokens[idx] = { ...store.tokens[idx], ...next };
  } else {
    store.tokens.push(next);
  }
  saveStore(store);
  return idx >= 0 ? store.tokens[idx] : next;
}

export function listDeviceTokens(filters?: { userId?: string; orgId?: string }): DeviceTokenRecord[] {
  const store = loadStore();
  return store.tokens.filter(t => {
    if (filters?.userId && t.userId !== filters.userId) return false;
    if (filters?.orgId && t.orgId !== filters.orgId) return false;
    return true;
  });
}

export function removeDeviceToken(token: string): boolean {
  const store = loadStore();
  const before = store.tokens.length;
  store.tokens = store.tokens.filter(t => t.token !== token);
  if (store.tokens.length === before) return false;
  saveStore(store);
  return true;
}

/** Test helper — reset store. */
export function clearDeviceTokensForTests(): void {
  saveStore({ tokens: [] });
}
