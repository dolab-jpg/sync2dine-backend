import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readStudioMeta } from './ai-studio-routes';
import { isAuthEnforced, requireAuth } from '../auth';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '..', 'data', 'conversation-logs.json');

interface LogEntry {
  id: string;
  threadId: string;
  userId: string;
  userName: string;
  role: string;
  scope: string;
  route?: string;
  role_message: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

const AUDIT_DELETE_ROLES = new Set(['super_admin', 'manager', 'platform_owner']);

function readLogs(): LogEntry[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    return JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as LogEntry[];
  } catch {
    return [];
  }
}

function writeLogs(logs: LogEntry[]): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const retention = readStudioMeta().conversationRetentionDays || 365;
  const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
  const trimmed = logs
    .filter((l) => new Date(l.timestamp).getTime() > cutoff)
    .slice(-50000);
  writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function requireAuditDeleteAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAuthEnforced()) return true;
  const auth = requireAuth(req);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  if (!AUDIT_DELETE_ROLES.has(auth.role)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return false;
  }
  return true;
}

export async function handleConversationAudit(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith('/api/ai/conversation-log')) return false;

  if (req.method === 'GET' && pathname === '/api/ai/conversation-log') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const roleFilter = url.searchParams.get('role');
    const search = url.searchParams.get('search')?.toLowerCase();
    const logs = readLogs();
    const threadMap = new Map<string, {
      id: string;
      userId: string;
      userName: string;
      role: string;
      scope: string;
      lastMessage: string;
      lastAt: string;
      messageCount: number;
    }>();

    for (const log of logs) {
      if (roleFilter && log.role !== roleFilter) continue;
      if (search && !log.content.toLowerCase().includes(search) && !log.userName.toLowerCase().includes(search)) {
        continue;
      }
      const existing = threadMap.get(log.threadId);
      if (!existing || log.timestamp > existing.lastAt) {
        threadMap.set(log.threadId, {
          id: log.threadId,
          userId: log.userId,
          userName: log.userName,
          role: log.role,
          scope: log.scope,
          lastMessage: log.content.slice(0, 120),
          lastAt: log.timestamp,
          messageCount: (existing?.messageCount ?? 0) + 1,
        });
      } else if (existing) {
        existing.messageCount += 1;
      }
    }

    const threads = [...threadMap.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    sendJson(res, 200, { threads });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/ai/conversation-log/delete-batch') {
    if (!requireAuditDeleteAuth(req, res)) return true;
    let body: { threadIds?: string[]; all?: boolean } = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as { threadIds?: string[]; all?: boolean };
    } catch {
      body = {};
    }
    const logs = readLogs();
    let remaining: LogEntry[];
    let deletedThreads = 0;
    if (body.all) {
      deletedThreads = new Set(logs.map((l) => l.threadId)).size;
      remaining = [];
    } else {
      const ids = new Set((body.threadIds ?? []).filter(Boolean));
      if (ids.size === 0) {
        sendJson(res, 400, { error: 'threadIds required (or all: true)' });
        return true;
      }
      deletedThreads = ids.size;
      remaining = logs.filter((l) => !ids.has(l.threadId));
    }
    writeLogs(remaining);
    sendJson(res, 200, { ok: true, deletedThreads });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/ai/conversation-log') {
    const body = JSON.parse(await readBody(req));
    const logs = readLogs();
    const threadId = `${body.userId}:${body.scope}`;
    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      threadId,
      userId: String(body.userId ?? 'unknown'),
      userName: String(body.userName ?? 'Unknown'),
      role: String(body.role ?? 'unknown'),
      scope: String(body.scope ?? 'global'),
      route: body.route ? String(body.route) : undefined,
      role_message: body.role_message ?? 'user',
      content: String(body.content ?? '').slice(0, 10000),
      timestamp: body.timestamp ?? new Date().toISOString(),
    };
    logs.push(entry);
    writeLogs(logs);
    sendJson(res, 200, { ok: true, id: entry.id });
    return true;
  }

  const match = pathname.match(/^\/api\/ai\/conversation-log\/(.+)$/);
  if (match) {
    const threadId = decodeURIComponent(match[1]);
    if (req.method === 'GET') {
      const messages = readLogs().filter((l) => l.threadId === threadId);
      sendJson(res, 200, { messages });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!requireAuditDeleteAuth(req, res)) return true;
      const logs = readLogs();
      const remaining = logs.filter((l) => l.threadId !== threadId);
      const removed = logs.length - remaining.length;
      if (removed === 0) {
        sendJson(res, 404, { error: 'Thread not found' });
        return true;
      }
      writeLogs(remaining);
      sendJson(res, 200, { ok: true, deleted: removed });
      return true;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
