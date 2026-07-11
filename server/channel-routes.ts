import type { IncomingMessage, ServerResponse } from 'http';
import {
  getConversationMessages,
  appendConversationMessage,
  upsertTeamMember,
  listTeamMembers,
} from './conversation-store';
import { detectLanguage, translateToEnglish, translateFromEnglish } from './translation-service';
import { enqueueOutboundCall, getDataStore } from './data-store';
import { resolveInboundChannel } from './channel-router';

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

export async function handleChannelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/([^/]+)$/);
  if (convMatch) {
    const orgId = decodeURIComponent(convMatch[1]);
    const sessionId = decodeURIComponent(convMatch[2]);
    if (req.method === 'GET') {
      sendJson(res, 200, { messages: getConversationMessages(orgId, sessionId, 100) });
      return true;
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      appendConversationMessage(orgId, sessionId, {
        role: body.role ?? 'user',
        content: body.content ?? '',
        bodyEnglish: body.bodyEnglish,
        detectedLanguage: body.detectedLanguage,
        channel: body.channel ?? 'app',
      });
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (pathname === '/api/translate/detect' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const lang = await detectLanguage(String(body.text ?? ''));
    sendJson(res, 200, { language: lang });
    return true;
  }

  if (pathname === '/api/translate/to-english' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const english = await translateToEnglish(String(body.text ?? ''), body.fromLang);
    sendJson(res, 200, { english });
    return true;
  }

  if (pathname === '/api/translate/from-english' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const translated = await translateFromEnglish(String(body.text ?? ''), String(body.toLang ?? 'en'));
    sendJson(res, 200, { translated });
    return true;
  }

  if (pathname === '/api/org/staff/register-phone' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const member = upsertTeamMember({
      id: String(body.id ?? body.userId ?? `tm-${Date.now()}`),
      userId: String(body.userId ?? body.id ?? `user-${Date.now()}`),
      name: String(body.name ?? 'Staff'),
      phone: String(body.phone ?? ''),
      role: body.role ?? 'staff',
    });
    sendJson(res, 200, { member, members: listTeamMembers() });
    return true;
  }

  if (pathname === '/api/org/staff/list' && req.method === 'GET') {
    sendJson(res, 200, { members: listTeamMembers() });
    return true;
  }

  if (pathname === '/api/customer/pin/verify' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const pin = String(body.pin ?? '');
    const expected = process.env.CUSTOMER_PIN ?? '1234';
    sendJson(res, 200, { verified: pin === expected });
    return true;
  }

  if (pathname === '/api/concierge/outbound' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const to = String(body.to ?? body.phone ?? '');
    const channel = String(body.channel ?? 'phone');
    if (channel === 'phone') {
      const job = enqueueOutboundCall({
        to,
        template: String(body.template ?? 'callback'),
        context: body.context ?? {},
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
      sendJson(res, 200, { queued: true, job });
      return true;
    }
    sendJson(res, 200, { queued: true, channel, note: 'WhatsApp template send via /api/messages/send' });
    return true;
  }

  return false;
}

export function buildStaffSnapshot(orgId?: string) {
  const store = getDataStore(orgId);
  return {
    customerCount: store.customers.length,
    quoteCount: (store.quotes ?? []).length,
    projectCount: store.projects.length,
  };
}

export function resolveRouteForPhone(phone: string, orgId?: string) {
  return resolveInboundChannel(phone, orgId);
}
