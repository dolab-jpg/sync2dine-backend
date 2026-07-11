import { encrypt, decrypt } from './crypto';
import { getProvider } from './providers';
import {
  getConnection,
  getTokenRow,
  saveTokenRow,
  deleteTokenRow,
} from './mailbox-store';
import type { TokenSet } from './types';

const refreshLocks = new Map<string, Promise<string>>();

const BUFFER_MS = 5 * 60 * 1000;

export async function saveTokens(connectionId: string, tokens: TokenSet): Promise<void> {
  saveTokenRow({
    connectionId,
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: encrypt(tokens.refreshToken),
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
    updatedAt: new Date().toISOString(),
  });
}

export async function getValidAccessToken(connectionId: string): Promise<string> {
  const row = getTokenRow(connectionId);
  if (!row) throw new Error('No tokens for connection');

  const expiresAt = new Date(row.expiresAt).getTime();
  if (expiresAt - Date.now() > BUFFER_MS) {
    return decrypt(row.accessTokenEnc);
  }

  const existing = refreshLocks.get(connectionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const fresh = getTokenRow(connectionId);
      if (!fresh) throw new Error('No tokens for connection');
      const freshExpiry = new Date(fresh.expiresAt).getTime();
      if (freshExpiry - Date.now() > BUFFER_MS) {
        return decrypt(fresh.accessTokenEnc);
      }
      const conn = getConnection(connectionId);
      if (!conn) throw new Error('Connection not found');
      const provider = getProvider(conn.provider);
      const refreshToken = decrypt(fresh.refreshTokenEnc);
      const tokens = await provider.refreshToken(refreshToken);
      await saveTokens(connectionId, tokens);
      return tokens.accessToken;
    } finally {
      refreshLocks.delete(connectionId);
    }
  })();

  refreshLocks.set(connectionId, promise);
  return promise;
}

export async function revokeConnectionTokens(connectionId: string): Promise<void> {
  const row = getTokenRow(connectionId);
  const conn = getConnection(connectionId);
  if (row && conn) {
    try {
      const provider = getProvider(conn.provider);
      await provider.revokeToken(decrypt(row.refreshTokenEnc));
    } catch {
      // ignore revoke errors
    }
  }
  deleteTokenRow(connectionId);
}
