import type { IncomingMessage, ServerResponse } from 'http';
import {
  appendConversationMessage,
  conversationToOrchestratorMessages,
  getCompanySettings,
  getHandoffMode,
  getThread,
  listConversationThreads,
  normalizeSessionKey,
  setCompanySettings,
  setHandoffMode,
} from './conversation-store';
import { handleChannelInbound } from './channel-inbound-handler';
import { OpenAIConnectionError, mapOpenAIError } from './openai-connection';
import { DEFAULT_ORG_ID, getDataStore, setRequestOrgId } from './data-store';
import type { ConversationHandoffMode } from './data-store';
import { ensureEnglishForCustomerSend } from './outbound-english-guard';

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

function resolveOrgId(req: IncomingMessage, body?: { orgId?: string }): string {
  const header = req.headers['x-org-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
  if (body?.orgId?.trim()) return body.orgId.trim();
  return DEFAULT_ORG_ID;
}

function originHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedWebOrigin(orgId: string, originHeader: string | undefined): boolean {
  if (!originHeader) return true; // same-origin / curl
  const origin = originHeader.trim().toLowerCase();
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) return true;
  const appBase = process.env.APP_BASE_URL?.trim();
  if (appBase && originHost(appBase) === originHost(origin)) return true;
  const website = getCompanySettings(orgId).website?.trim();
  if (website) {
    const allowed = originHost(website);
    const requestHost = originHost(origin);
    if (allowed && requestHost && (requestHost === allowed || requestHost.endsWith(`.${allowed}`))) {
      return true;
    }
  }
  // Dev without company website configured
  if (!website) return true;
  return false;
}

function setCorsForWeb(res: ServerResponse, origin: string | undefined) {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Org-Id');
    res.setHeader('Vary', 'Origin');
  }
}

async function maybeSendWhatsApp(sessionId: string, text: string): Promise<boolean> {
  // Only real phone numbers get WhatsApp outbound
  if (!/^\d{10,15}$/.test(normalizeSessionKey(sessionId)) && !/^\+?\d{10,15}$/.test(sessionId)) {
    return false;
  }
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneId) return false;
  try {
    const { sendWhatsAppText } = await import('./whatsapp-webhook');
    await sendWhatsAppText(phoneId, token, sessionId.startsWith('+') ? sessionId : `+${normalizeSessionKey(sessionId)}`, text);
    return true;
  } catch {
    return false;
  }
}

export async function handleCyrusRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/cyrus')) return false;

  // --- Sync company website for embed origin checks ---
  if (pathname === '/api/cyrus/company-settings' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req)) as {
      orgId?: string;
      website?: string;
      companyName?: string;
    };
    const orgId = resolveOrgId(req, body);
    setRequestOrgId(orgId);
    setCompanySettings(orgId, {
      website: body.website,
      companyName: body.companyName,
    });
    sendJson(res, 200, { ok: true, settings: getCompanySettings(orgId) });
    return true;
  }

  if (pathname === '/api/cyrus/company-settings' && req.method === 'GET') {
    const orgId = resolveOrgId(req);
    setRequestOrgId(orgId);
    sendJson(res, 200, { settings: getCompanySettings(orgId) });
    return true;
  }

  // --- Embed snippet helper ---
  if (pathname === '/api/cyrus/embed-snippet' && req.method === 'GET') {
    const orgId = resolveOrgId(req);
    setRequestOrgId(orgId);
    const settings = getCompanySettings(orgId);
    const appBase = (process.env.APP_BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
    const apiBase = (process.env.VITE_API_BASE_URL || process.env.APP_BASE_URL || appBase).replace(/\/$/, '');
    const snippet = `<script src="${appBase}/cyrus-widget.js" data-org-id="${orgId}" data-api="${apiBase}" async></script>`;
    sendJson(res, 200, {
      snippet,
      website: settings.website ?? '',
      companyName: settings.companyName ?? '',
      appBase,
      apiBase,
      orgId,
    });
    return true;
  }

  // --- List threads ---
  if (pathname === '/api/cyrus/threads' && req.method === 'GET') {
    const orgId = resolveOrgId(req);
    setRequestOrgId(orgId);
    const threads = listConversationThreads(orgId).map((t) => ({
      ...t,
      messages: t.messages.slice(-50),
    }));
    sendJson(res, 200, { threads });
    return true;
  }

  // --- Single thread + actions ---
  const threadMatch = pathname.match(/^\/api\/cyrus\/threads\/([^/]+)(?:\/(reply|ask|handoff))?$/);
  if (threadMatch) {
    const sessionId = decodeURIComponent(threadMatch[1]);
    const action = threadMatch[2];
    const orgId = resolveOrgId(req);
    setRequestOrgId(orgId);

    if (!action && req.method === 'GET') {
      const thread = getThread(orgId, sessionId);
      if (!thread) {
        sendJson(res, 404, { error: 'Thread not found' });
        return true;
      }
      sendJson(res, 200, { thread });
      return true;
    }

    if (action === 'handoff' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { mode?: ConversationHandoffMode; orgId?: string };
      const mode = body.mode === 'human_takeover' ? 'human_takeover' : 'ai_active';
      const record = setHandoffMode(orgId, sessionId, mode);
      const notice = mode === 'human_takeover'
        ? 'A team member has joined this conversation.'
        : 'Cyrus AI is handling this conversation again.';
      appendConversationMessage(orgId, sessionId, {
        role: 'assistant',
        content: notice,
        bodyEnglish: notice,
        channel: record.channel ?? 'app',
        fromRole: 'system',
      });
      sendJson(res, 200, { ok: true, handoffMode: mode, thread: getThread(orgId, sessionId) });
      return true;
    }

    if (action === 'reply' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        orgId?: string;
        text?: string;
        staffName?: string;
      };
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(res, 400, { error: 'text is required' });
        return true;
      }
      // Staff/workers may type this reply in their own language — it must be canonical
      // English before it goes out to a customer over WhatsApp.
      const guard = await ensureEnglishForCustomerSend(text, undefined, orgId);
      if (!guard.ok) {
        sendJson(res, 502, {
          error: 'Could not translate your reply to English — message was not sent. Please try again or send it in English.',
        });
        return true;
      }
      const englishText = guard.english;
      const thread = getThread(orgId, sessionId);
      const channel = thread?.channel ?? 'whatsapp';
      appendConversationMessage(orgId, sessionId, {
        role: 'assistant',
        content: text,
        bodyEnglish: englishText,
        channel,
        fromRole: 'staff',
      }, { channel, contactName: body.staffName });
      // Auto-enter human takeover when staff replies
      if (getHandoffMode(orgId, sessionId) !== 'human_takeover') {
        setHandoffMode(orgId, sessionId, 'human_takeover');
      }
      let whatsappSent = false;
      if (channel === 'whatsapp') {
        whatsappSent = await maybeSendWhatsApp(sessionId, englishText);
      }
      sendJson(res, 200, {
        ok: true,
        whatsappSent,
        thread: getThread(orgId, sessionId),
      });
      return true;
    }

    if (action === 'ask' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        orgId?: string;
        text?: string;
        contactName?: string;
      };
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(res, 400, { error: 'text is required' });
        return true;
      }
      // Temporarily ensure AI can answer
      const prev = getHandoffMode(orgId, sessionId);
      if (prev === 'human_takeover') setHandoffMode(orgId, sessionId, 'ai_active');
      try {
        const thread = getThread(orgId, sessionId);
        const result = await handleChannelInbound({
          orgId,
          phone: sessionId,
          text,
          channel: (thread?.channel as 'whatsapp' | 'web' | 'portal') || 'web',
          contactName: body.contactName ?? thread?.contactName,
        });
        if (prev === 'human_takeover') setHandoffMode(orgId, sessionId, 'human_takeover');
        sendJson(res, 200, {
          ok: true,
          reply: result.replyLocalized || result.replyEnglish,
          thread: getThread(orgId, sessionId),
        });
      } catch (err) {
        if (prev === 'human_takeover') setHandoffMode(orgId, sessionId, 'human_takeover');
        const mapped = mapOpenAIError(err);
        sendJson(res, mapped instanceof OpenAIConnectionError ? 503 : 500, {
          error: mapped.message,
          code: mapped instanceof OpenAIConnectionError ? mapped.code : 'error',
        });
      }
      return true;
    }
  }

  // --- Public website widget inbound ---
  if (pathname === '/api/cyrus/web' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as {
      orgId?: string;
      sessionId?: string;
      text?: string;
      visitorName?: string;
    };
    const orgId = resolveOrgId(req, body);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    setCorsForWeb(res, origin);
    if (!isAllowedWebOrigin(orgId, origin)) {
      sendJson(res, 403, { error: 'Origin not allowed for this company website' });
      return true;
    }
    setRequestOrgId(orgId);
    const text = String(body.text ?? '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return true;
    }
    const visitorId = String(body.sessionId ?? '').trim() || `web_${Date.now()}`;
    const sessionId = visitorId.startsWith('web_') ? visitorId : `web_${normalizeSessionKey(visitorId) || Date.now()}`;
    try {
      const result = await handleChannelInbound({
        orgId,
        phone: sessionId,
        text,
        channel: 'web',
        contactName: body.visitorName || 'Website visitor',
      });
      sendJson(res, 200, {
        sessionId,
        reply: result.replyLocalized || result.replyEnglish,
        handoffMode: getHandoffMode(orgId, sessionId),
        messages: getThread(orgId, sessionId)?.messages.slice(-40) ?? [],
      });
    } catch (err) {
      const mapped = mapOpenAIError(err);
      sendJson(res, mapped instanceof OpenAIConnectionError ? 503 : 500, {
        error: mapped.message,
        code: mapped instanceof OpenAIConnectionError ? mapped.code : 'error',
      });
    }
    return true;
  }

  // OPTIONS for widget CORS
  if (pathname === '/api/cyrus/web' && req.method === 'OPTIONS') {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*';
    setCorsForWeb(res, origin);
    res.statusCode = 204;
    res.end();
    return true;
  }

  // --- Widget poll for staff replies ---
  if (pathname === '/api/cyrus/web/poll' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const orgId = url.searchParams.get('orgId') || resolveOrgId(req);
    const sessionId = url.searchParams.get('sessionId') || '';
    const after = url.searchParams.get('after') || '';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    setCorsForWeb(res, origin);
    if (!isAllowedWebOrigin(orgId, origin)) {
      sendJson(res, 403, { error: 'Origin not allowed' });
      return true;
    }
    setRequestOrgId(orgId);
    const thread = getThread(orgId, sessionId);
    if (!thread) {
      sendJson(res, 200, { messages: [], handoffMode: 'ai_active' });
      return true;
    }
    const messages = after
      ? thread.messages.filter((m) => m.timestamp > after)
      : thread.messages.slice(-40);
    sendJson(res, 200, {
      messages,
      handoffMode: thread.handoffMode,
      updatedAt: thread.updatedAt,
    });
    return true;
  }

  // --- Portal Cyrus ---
  if (pathname === '/api/cyrus/portal' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as {
      orgId?: string;
      token?: string;
      text?: string;
      speak?: boolean;
    };
    const orgId = resolveOrgId(req, body);
    setRequestOrgId(orgId);
    const token = String(body.token ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (!token || !text) {
      sendJson(res, 400, { error: 'token and text are required' });
      return true;
    }
    const project = getDataStore(orgId).projects.find((p) => String(p.portalToken) === token);
    if (!project) {
      // Also check default store
      const fallback = getDataStore().projects.find((p) => String(p.portalToken) === token);
      if (!fallback) {
        sendJson(res, 404, { error: 'Invalid portal token' });
        return true;
      }
    }
    const proj = project ?? getDataStore().projects.find((p) => String(p.portalToken) === token)!;
    const sessionId = `portal_${token}`;
    const customerName = String(proj.customerName ?? proj.projectName ?? 'Customer');
    try {
      const result = await handleChannelInbound({
        orgId,
        phone: sessionId,
        text,
        channel: 'portal',
        contactName: customerName,
        projectId: String(proj.id ?? ''),
      });
      sendJson(res, 200, {
        sessionId,
        reply: result.replyLocalized || result.replyEnglish,
        handoffMode: getHandoffMode(orgId, sessionId),
        messages: getThread(orgId, sessionId)?.messages.slice(-40) ?? [],
        history: conversationToOrchestratorMessages(orgId, sessionId, 40),
      });
    } catch (err) {
      const mapped = mapOpenAIError(err);
      sendJson(res, mapped instanceof OpenAIConnectionError ? 503 : 500, {
        error: mapped.message,
        code: mapped instanceof OpenAIConnectionError ? mapped.code : 'error',
      });
    }
    return true;
  }

  if (pathname === '/api/cyrus/portal/thread' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const orgId = url.searchParams.get('orgId') || resolveOrgId(req);
    const token = url.searchParams.get('token') || '';
    setRequestOrgId(orgId);
    const thread = getThread(orgId, `portal_${token}`);
    sendJson(res, 200, { thread, messages: thread?.messages ?? [] });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
