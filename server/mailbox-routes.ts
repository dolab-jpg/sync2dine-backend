import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  createConnection,
  deleteConnection,
  getConnection,
  getMessage,
  listAttachments,
  listConnections,
  listMessages,
  seedMockInbox,
  upsertConnection,
} from './mailbox/mailbox-store';
import { getProvider } from './mailbox/providers';
import { saveTokens, revokeConnectionTokens } from './mailbox/tokenService';
import { syncConnection, startMailboxPoller } from './mailbox/imapSyncService';
import { sendFromMailbox, sendMockEmail } from './mailbox/sendService';
import { groupThreads } from './mailbox/mimeParser';
import {
  decodeOAuthState,
  encodeOAuthState,
  getRedirectUri,
  isMailboxMockMode,
  shouldUseLiveMailbox,
} from './mailbox/oauth-config';
import type { MailProviderId, SendMailboxPayload } from './mailbox/types';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseAuth(req: IncomingMessage): { userId: string; orgId: string } {
  const userId = req.headers['x-user-id']?.toString() || 'default-user';
  const orgId = req.headers['x-org-id']?.toString() || 'default';
  return { userId, orgId };
}

export async function handleMailboxRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
): Promise<boolean> {
  if (pathname === '/webhooks/gmail' || pathname === '/webhooks/outlook') {
    // fall through to webhook handlers below
  } else if (!pathname.startsWith('/api/mailbox')) {
    return false;
  }

  startMailboxPoller();

  if (pathname === '/api/mailbox/connect' && req.method === 'GET') {
    const provider = (url.searchParams.get('provider') || 'google') as MailProviderId;
    const { userId, orgId } = parseAuth(req);
    const loginHint = url.searchParams.get('loginHint') ?? undefined;

    if (!shouldUseLiveMailbox(req)) {
      const conn = createConnection({
        orgId,
        userId,
        provider,
        emailAddress: loginHint || `mock-${provider}@tradepro.dev`,
        displayName: 'Mock Mailbox',
        status: 'connected',
      });
      seedMockInbox(conn.id);
      sendJson(res, 200, { mock: true, connection: conn });
      return true;
    }

    const state = encodeOAuthState({ userId, orgId, provider, ts: Date.now() });
    const authUrl = getProvider(provider).buildAuthUrl(state, loginHint);
    sendJson(res, 200, { authUrl, redirectUri: getRedirectUri() });
    return true;
  }

  if (pathname === '/api/mailbox/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const appBase = process.env.VITE_APP_URL || process.env.APP_BASE_URL || 'http://localhost:5174';

    if (error || !code || !stateRaw) {
      res.statusCode = 302;
      res.setHeader('Location', `${appBase}/settings?mailbox=error`);
      res.end();
      return true;
    }

    const state = decodeOAuthState(stateRaw);
    const userId = String(state?.userId ?? 'default-user');
    const orgId = String(state?.orgId ?? 'default');
    const provider = (state?.provider as MailProviderId) || 'google';

    try {
      const tokens = await getProvider(provider).exchangeCode(code);
      const conn = createConnection({
        orgId,
        userId,
        provider,
        emailAddress: tokens.email || 'unknown@mailbox.local',
        displayName: tokens.email,
        status: 'connected',
      });
      await saveTokens(conn.id, tokens);
      await syncConnection(conn.id);
      res.statusCode = 302;
      res.setHeader('Location', `${appBase}/settings?mailbox=connected`);
      res.end();
    } catch (err) {
      res.statusCode = 302;
      res.setHeader('Location', `${appBase}/settings?mailbox=error&message=${encodeURIComponent(err instanceof Error ? err.message : 'OAuth failed')}`);
      res.end();
    }
    return true;
  }

  if (pathname === '/api/mailbox/connections' && req.method === 'GET') {
    const { userId, orgId } = parseAuth(req);
    sendJson(res, 200, { connections: listConnections(orgId, userId) });
    return true;
  }

  const disconnectMatch = pathname.match(/^\/api\/mailbox\/connections\/([^/]+)$/);
  if (disconnectMatch && req.method === 'DELETE') {
    const id = disconnectMatch[1];
    const conn = getConnection(id);
    if (!conn) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    await revokeConnectionTokens(id);
    deleteConnection(id);
    sendJson(res, 200, { success: true });
    return true;
  }

  if (pathname === '/api/mailbox/sync' && req.method === 'POST') {
    let body: { connectionId?: string } = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!body.connectionId) {
      sendJson(res, 400, { error: 'connectionId required' });
      return true;
    }
    const result = await syncConnection(body.connectionId);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/mailbox/messages' && req.method === 'GET') {
    const connectionId = url.searchParams.get('connectionId');
    if (!connectionId) {
      sendJson(res, 400, { error: 'connectionId required' });
      return true;
    }
    const limit = Number(url.searchParams.get('limit') || 50);
    const messages = listMessages(connectionId, limit);
    const threads = groupThreads(messages);
    sendJson(res, 200, { threads, messages });
    return true;
  }

  const messageMatch = pathname.match(/^\/api\/mailbox\/messages\/([^/]+)$/);
  if (messageMatch && req.method === 'GET') {
    const msg = getMessage(messageMatch[1]);
    if (!msg) {
      sendJson(res, 404, { error: 'Message not found' });
      return true;
    }
    sendJson(res, 200, {
      message: msg,
      attachments: listAttachments(msg.id),
    });
    return true;
  }

  if (pathname === '/api/mailbox/send' && req.method === 'POST') {
    let payload: SendMailboxPayload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!payload.connectionId || !payload.to || !payload.subject) {
      sendJson(res, 400, { error: 'connectionId, to, and subject required' });
      return true;
    }
    const result = isMailboxMockMode()
      ? await sendMockEmail(payload)
      : await sendFromMailbox(payload);
    sendJson(res, result.success ? 200 : 500, result);
    return true;
  }

  if (pathname === '/webhooks/gmail' && req.method === 'POST') {
    let body = '';
    try {
      body = await readBody(req);
      const parsed = JSON.parse(body) as { message?: { data?: string } };
      if (parsed.message?.data) {
        const decoded = JSON.parse(Buffer.from(parsed.message.data, 'base64').toString('utf8')) as {
          emailAddress?: string;
        };
        const { listActiveConnections } = await import('./mailbox/mailbox-store');
        for (const conn of listActiveConnections()) {
          if (!decoded.emailAddress || conn.emailAddress === decoded.emailAddress) {
            await syncConnection(conn.id);
          }
        }
      }
    } catch {
      // Pub/Sub ack anyway
    }
    sendJson(res, 200, { received: true });
    return true;
  }

  if (pathname === '/webhooks/outlook' && req.method === 'POST') {
    const validationToken = url.searchParams.get('validationToken');
    if (validationToken) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end(validationToken);
      return true;
    }
    const { listActiveConnections } = await import('./mailbox/mailbox-store');
    for (const conn of listActiveConnections()) {
      if (conn.provider === 'microsoft') await syncConnection(conn.id);
    }
    sendJson(res, 200, { received: true });
    return true;
  }

  sendJson(res, 404, { error: 'Mailbox route not found' });
  return true;
}

export async function executeMailboxTool(
  toolName: string,
  input: Record<string, unknown>,
  orgId: string,
  userId: string
): Promise<Record<string, unknown>> {
  const connections = listConnections(orgId, userId);
  const connectionId = String(input.connectionId ?? connections[0]?.id ?? '');
  if (!connectionId) return { error: 'No mailbox connected' };

  if (toolName === 'listRecentEmails') {
    const limit = Number(input.limit) || 10;
    const messages = listMessages(connectionId, limit);
    return {
      count: messages.length,
      emails: messages.map(m => ({
        id: m.id,
        from: m.fromAddr,
        subject: m.subject,
        snippet: m.snippet,
        receivedAt: m.receivedAt,
      })),
    };
  }

  if (toolName === 'getEmailThread') {
    const threadId = String(input.threadId ?? '');
    const messageId = String(input.messageId ?? '');
    const messages = listMessages(connectionId, 100).filter(m =>
      threadId ? m.threadId === threadId : m.id === messageId
    );
    return { threadId: threadId || messages[0]?.threadId, messages };
  }

  if (toolName === 'draftEmailReply') {
    return {
      draft: {
        to: String(input.to ?? ''),
        subject: String(input.subject ?? ''),
        body: String(input.body ?? ''),
      },
      readyToSend: Boolean(input.to && input.subject && input.body),
    };
  }

  if (toolName === 'sendEmailReply' || toolName === 'sendEmailWithAttachment') {
    const payload: SendMailboxPayload = {
      connectionId,
      to: String(input.to ?? ''),
      subject: String(input.subject ?? ''),
      body: String(input.body ?? ''),
      attachments: Array.isArray(input.attachments)
        ? input.attachments as SendMailboxPayload['attachments']
        : undefined,
    };
    const result = isMailboxMockMode()
      ? await sendMockEmail(payload)
      : await sendFromMailbox(payload);
    return { ...result, to: payload.to, subject: payload.subject };
  }

  return { error: `Unknown mailbox tool: ${toolName}` };
}

/** Mock connect for tests */
export function connectMockMailbox(orgId: string, userId: string, email: string) {
  const conn = createConnection({
    orgId,
    userId,
    provider: 'google',
    emailAddress: email,
    status: 'connected',
  });
  seedMockInbox(conn.id);
  return conn;
}

export { randomUUID };
