import type { IncomingMessage, ServerResponse } from 'http';
import {
  getConversationMessages,
  appendConversationMessage,
  upsertTeamMember,
  listTeamMembers,
  publicTeamMember,
} from './conversation-store';
import { detectLanguage, translateToEnglish, translateFromEnglish } from './translation-service';
import { loadLanguagePacks, saveLanguagePacks, type LanguagePacksMap } from './language-packs';
import { enqueueOutboundCall, getDataStore, normalizePhoneExport } from './data-store';
import { resolveInboundChannel } from './channel-router';
import { hashPhonePin, isValidPhonePin } from './phone-auth';

const STAFF_ROLES = new Set(['super_admin', 'manager', 'staff', 'builder']);

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

  if (pathname === '/api/language-packs' && req.method === 'GET') {
    sendJson(res, 200, { packs: loadLanguagePacks() });
    return true;
  }

  if (pathname === '/api/language-packs' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    const packs = (body.packs ?? body) as LanguagePacksMap;
    if (!packs || typeof packs !== 'object') {
      sendJson(res, 400, { error: 'Expected packs object' });
      return true;
    }
    const saved = saveLanguagePacks(packs);
    sendJson(res, 200, { packs: saved });
    return true;
  }

  // Stubs: pack-backed, no OpenAI (kept for any old clients)
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
    const phone = normalizePhoneExport(String(body.phone ?? ''));
    if (!phone) {
      sendJson(res, 400, { error: 'phone is required' });
      return true;
    }
    const roleRaw = String(body.role ?? 'staff');
    const role = (STAFF_ROLES.has(roleRaw) ? roleRaw : 'staff') as
      'super_admin' | 'manager' | 'staff' | 'builder';
    const pinRaw = body.phonePin != null ? String(body.phonePin) : '';
    const existing = listTeamMembers().find(
      (m) => m.id === String(body.id ?? '') || normalizePhoneExport(m.phone) === phone,
    );
    let phonePinHash = existing?.phonePinHash;
    let phonePinUpdatedAt = existing?.phonePinUpdatedAt;
    if (pinRaw) {
      if (!isValidPhonePin(pinRaw)) {
        sendJson(res, 400, { error: 'phonePin must be exactly 4 digits' });
        return true;
      }
      phonePinHash = hashPhonePin(pinRaw);
      phonePinUpdatedAt = new Date().toISOString();
    } else if (!existing?.phonePinHash) {
      sendJson(res, 400, { error: 'phonePin is required when registering a new staff phone' });
      return true;
    }

    const preferredLanguageRaw = body.preferredLanguage != null
      ? String(body.preferredLanguage).trim().toLowerCase()
      : (existing?.preferredLanguage ?? 'en');
    const member = upsertTeamMember({
      id: String(body.id ?? body.userId ?? existing?.id ?? `tm-${Date.now()}`),
      userId: String(body.userId ?? body.id ?? existing?.userId ?? `user-${Date.now()}`),
      name: String(body.name ?? existing?.name ?? 'Staff'),
      phone,
      role,
      preferredLanguage: preferredLanguageRaw || existing?.preferredLanguage || 'en',
      phonePinHash,
      phonePinUpdatedAt,
    });
    sendJson(res, 200, {
      member: publicTeamMember(member),
      members: listTeamMembers().map(publicTeamMember),
      ...(pinRaw ? { phonePinOnce: pinRaw } : {}),
    });
    return true;
  }

  if (pathname === '/api/org/staff/phone-pin' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const phone = normalizePhoneExport(String(body.phone ?? ''));
    const id = body.id ? String(body.id) : '';
    const member = listTeamMembers().find(
      (m) => (id && m.id === id) || (phone && normalizePhoneExport(m.phone) === phone),
    );
    if (!member) {
      sendJson(res, 404, { error: 'Staff member not found' });
      return true;
    }
    const pinRaw = String(body.phonePin ?? '');
    if (!isValidPhonePin(pinRaw)) {
      sendJson(res, 400, { error: 'phonePin must be exactly 4 digits' });
      return true;
    }
    const updated = upsertTeamMember({
      ...member,
      phonePinHash: hashPhonePin(pinRaw),
      phonePinUpdatedAt: new Date().toISOString(),
    });
    sendJson(res, 200, {
      member: publicTeamMember(updated),
      members: listTeamMembers().map(publicTeamMember),
    });
    return true;
  }

  if (pathname === '/api/org/staff/list' && req.method === 'GET') {
    sendJson(res, 200, { members: listTeamMembers().map(publicTeamMember) });
    return true;
  }

  if (pathname === '/api/customer/pin/verify' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const pin = String(body.pin ?? '');
    const expected = process.env.CUSTOMER_PIN?.trim();
    if (!expected) {
      sendJson(res, 503, { error: 'Customer PIN is not configured', code: 'pin_not_configured' });
      return true;
    }
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
