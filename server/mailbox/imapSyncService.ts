import { randomUUID } from 'crypto';
import {
  getConnection,
  getSyncState,
  saveSyncState,
  upsertConnection,
  upsertMessage,
  seedMockInbox,
} from './mailbox-store';
import { getProvider } from './providers';
import { getValidAccessToken } from './tokenService';
import { parseMime, persistAttachments } from './mimeParser';
import { processNewMessages } from './commsEventBus';
import { isMailboxMockMode } from './oauth-config';
import type { CachedEmailMessage } from './types';

export async function syncConnection(connectionId: string): Promise<{ synced: number; error?: string }> {
  const conn = getConnection(connectionId);
  if (!conn) return { synced: 0, error: 'Connection not found' };

  if (isMailboxMockMode()) {
    seedMockInbox(connectionId);
    upsertConnection({
      ...conn,
      lastSyncedAt: new Date().toISOString(),
      status: 'connected',
    });
    return { synced: 0 };
  }

  try {
    const accessToken = await getValidAccessToken(connectionId);
    const provider = getProvider(conn.provider);
    const { imap } = provider.getConfig();

    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: conn.emailAddress, accessToken },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const state = getSyncState(connectionId);
    let synced = 0;
    const newMsgs: CachedEmailMessage[] = [];

    try {
      const range = state.lastUid > 0 ? `${state.lastUid + 1}:*` : '1:50';
      for await (const msg of client.fetch(range, { uid: true, source: true, envelope: true })) {
        if (!msg.source) continue;
        const parsed = await parseMime(Buffer.from(msg.source));
        const cacheId = randomUUID();
        const cached: CachedEmailMessage = {
          id: cacheId,
          connectionId,
          uid: msg.uid,
          messageId: parsed.messageId,
          threadId: parsed.threadId,
          subject: parsed.subject,
          fromAddr: parsed.from.address,
          fromName: parsed.from.name,
          toAddrs: parsed.to.map(t => t.address),
          snippet: parsed.snippet,
          textBody: parsed.textBody,
          htmlBody: parsed.htmlBody,
          receivedAt: parsed.date.toISOString(),
          hasAttachments: parsed.attachments.length > 0,
          inReplyTo: parsed.inReplyTo,
          syncedAt: new Date().toISOString(),
        };
        upsertMessage(cached);
        if (parsed.attachments.length) persistAttachments(cacheId, parsed.attachments);
        newMsgs.push(cached);
        synced++;
        if (msg.uid > state.lastUid) state.lastUid = msg.uid;
      }
      state.lastSyncedAt = new Date().toISOString();
      state.lastError = undefined;
      saveSyncState(state);
    } finally {
      lock.release();
      await client.logout();
    }

    upsertConnection({
      ...conn,
      lastSyncedAt: new Date().toISOString(),
      status: 'connected',
      lastError: undefined,
    });

    if (newMsgs.length) await processNewMessages(newMsgs);
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    const isAuth = message.toLowerCase().includes('auth') || message.includes('invalid_grant');
    upsertConnection({
      ...conn,
      // A transient IMAP failure must not disable outbound Gmail SMTP.
      // Only an OAuth/auth failure requires reconnecting the mailbox.
      status: isAuth ? 'needs_reconnect' : 'connected',
      lastError: message,
    });
    const state = getSyncState(connectionId);
    state.lastError = message;
    state.pollIntervalSec = Math.min(state.pollIntervalSec * 2, 3600);
    saveSyncState(state);
    return { synced: 0, error: message };
  }
}

let pollerStarted = false;

export function startMailboxPoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;

  const tick = async () => {
    const { listActiveConnections } = await import('./mailbox-store');
    for (const conn of listActiveConnections()) {
      const state = getSyncState(conn.id);
      const due = !state.lastSyncedAt
        || Date.now() - new Date(state.lastSyncedAt).getTime() >= state.pollIntervalSec * 1000;
      if (due) {
        await syncConnection(conn.id).catch(err => {
          console.error(`Mailbox sync error ${conn.id}:`, err);
        });
      }
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
}

export async function syncAllConnections(): Promise<void> {
  const { listActiveConnections } = await import('./mailbox-store');
  for (const conn of listActiveConnections()) {
    await syncConnection(conn.id);
  }
}
