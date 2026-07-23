/**
 * Public Ask Sync2Dine website chat — Sally sales brain for marketing visitors.
 * CORS allowlist for sync2dine.io apex + app + localhost.
 *
 * Channel adapter only: business intelligence lives in server/sally/* (web-chat).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { OpenAIConnectionError, mapOpenAIError } from './openai-connection';
import { setRequestOrgId } from './data-store';
import { getHomeOrgId } from './home-org';
import type { OrchestratorMessage } from './orchestrator-types';
import { buildSallyCheckoutHandoff, resolveSallySessionKey } from './sally/offer';
import { runSallyWebChat } from './sally/web-chat';

const ALLOWED_HOSTS = new Set([
  'sync2dine.io',
  'www.sync2dine.io',
  'app.sync2dine.io',
  'localhost',
  '127.0.0.1',
]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 30;
const rateByKey = new Map<string, number[]>();

const historyBySession = new Map<string, OrchestratorMessage[]>();
const MAX_HISTORY = 40;

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

function originHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostAllowed(host: string | null): boolean {
  if (!host) return false;
  return ALLOWED_HOSTS.has(host);
}

function isAllowedOrigin(originHeader: string | undefined, referer?: string): boolean {
  if (!originHeader) {
    if (referer) {
      try {
        return hostAllowed(new URL(referer).host.toLowerCase());
      } catch {
        return false;
      }
    }
    return true;
  }
  if (originHeader === 'null') return false;
  const host = originHost(originHeader);
  return hostAllowed(host);
}

function setCors(res: ServerResponse, origin: string | undefined) {
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Org-Id');
}

function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(key: string): boolean {
  const now = Date.now();
  const prev = (rateByKey.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (prev.length >= RATE_MAX_PER_WINDOW) {
    rateByKey.set(key, prev);
    return false;
  }
  prev.push(now);
  rateByKey.set(key, prev);
  return true;
}

function normalizeSessionId(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (trimmed.startsWith('web_') && trimmed.length >= 8 && trimmed.length < 120) return trimmed;
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return `web_${safe || Date.now().toString(36)}`;
}

function appendHistory(sessionId: string, role: 'user' | 'assistant', content: string) {
  const list = historyBySession.get(sessionId) || [];
  list.push({ role, content });
  while (list.length > MAX_HISTORY) list.shift();
  historyBySession.set(sessionId, list);
}

export async function handleSallyWebRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/sally/web')) return false;

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (!isAllowedOrigin(origin, referer)) {
    sendJson(res, 403, { error: 'Origin not allowed' });
    return true;
  }

  if (pathname === '/api/sally/web' && req.method === 'POST') {
    let body: {
      sessionId?: string;
      text?: string;
      page?: string;
      utm?: string;
      visitorName?: string;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const text = String(body.text ?? '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return true;
    }
    if (text.length > 4000) {
      sendJson(res, 400, { error: 'text too long' });
      return true;
    }

    const sessionId = normalizeSessionId(body.sessionId || '');
    const ip = clientIp(req);
    if (!rateLimit(`${ip}:${sessionId}`)) {
      sendJson(res, 429, { error: 'Too many requests — please wait a moment.' });
      return true;
    }

    const orgId = getHomeOrgId();
    setRequestOrgId(orgId);
    const requestId = `sw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    appendHistory(sessionId, 'user', text);
    const messages = [...(historyBySession.get(sessionId) || [])];

    try {
      const result = await runSallyWebChat({
        orgId,
        sessionId,
        text,
        page: body.page,
        visitorName: body.visitorName,
        messages,
        requestId,
      });

      appendHistory(sessionId, 'assistant', result.reply);
      const handoff = buildSallyCheckoutHandoff(result.sessionKey);
      sendJson(res, 200, {
        sessionId,
        reply: result.reply,
        messages: historyBySession.get(sessionId) || [],
        checkoutHandoff: handoff,
        requestId: result.requestId,
        toolsUsed: result.toolsUsed,
        landline: {
          display: '020 3745 3233',
          tel: '+442037453233',
          hours: '24/7',
        },
      });
    } catch (err) {
      const mapped = mapOpenAIError(err);
      sendJson(res, mapped instanceof OpenAIConnectionError ? 503 : 500, {
        error: mapped.message,
        code: mapped instanceof OpenAIConnectionError ? mapped.code : 'error',
        requestId,
      });
    }
    return true;
  }

  if (pathname === '/api/sally/web/poll' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const sessionId = normalizeSessionId(url.searchParams.get('sessionId') || '');
    const sessionKey = resolveSallySessionKey({ webSessionId: sessionId });
    sendJson(res, 200, {
      sessionId,
      messages: historyBySession.get(sessionId) || [],
      checkoutHandoff: buildSallyCheckoutHandoff(sessionKey),
    });
    return true;
  }

  return false;
}
