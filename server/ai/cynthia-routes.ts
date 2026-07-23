import type { IncomingMessage, ServerResponse } from 'http';
import { DEFAULT_ORG_ID } from '../data-store';
import { getHomeOrgId } from '../home-org';
import {
  appendStaffMessage,
  getStaffThread,
  listRecentCards,
  pushStaffCard,
  resolveStaffUserId,
  type CynthiaStaffCard,
} from './cynthia-staff-store';
import { sendPushToUser } from '../push/pushSender';
import { emitAgentActivity } from '../agent-activity';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function orgFrom(req: IncomingMessage, body?: Record<string, unknown>): string {
  const h = req.headers['x-org-id'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  if (typeof body?.orgId === 'string' && body.orgId.trim()) return body.orgId.trim();
  return DEFAULT_ORG_ID;
}

function userFrom(body: Record<string, unknown>, req: IncomingMessage): string | null {
  const h = req.headers['x-user-id'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  if (typeof body.userId === 'string' && body.userId.trim()) return body.userId.trim();
  return null;
}

async function notifyStaffPush(opts: {
  orgId: string;
  userId: string;
  title: string;
  body: string;
  cardId: string;
}): Promise<void> {
  try {
    await sendPushToUser(opts.orgId, opts.userId, {
      title: opts.title,
      body: opts.body,
      route: `/cynthia?card=${opts.cardId}`,
      data: { type: 'cynthia_card', route: `/cynthia?card=${opts.cardId}` },
    });
  } catch {
    // non-fatal
  }
}

export async function handleCynthiaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/cynthia')) return false;

  if (pathname === '/api/cynthia/thread' && req.method === 'GET') {
    const orgId = orgFrom(req);
    const url = new URL(req.url || '/', 'http://localhost');
    const headerUser = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const userId = headerUser || url.searchParams.get('userId') || '';
    if (!userId || userId === 'default-staff') {
      sendJson(res, 401, { error: 'Authenticated userId required', code: 'staff_not_resolved' });
      return true;
    }
    const thread = getStaffThread(orgId, userId);
    sendJson(res, 200, { thread });
    return true;
  }

  if (pathname === '/api/cynthia/thread' && req.method === 'POST') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const orgId = orgFrom(req, body);
    const userId = userFrom(body, req);
    if (!userId) {
      sendJson(res, 401, { error: 'Authenticated userId required', code: 'staff_not_resolved' });
      return true;
    }
    const artifact = body.artifact && typeof body.artifact === 'object'
      ? (body.artifact as {
          type: 'pdf' | 'report';
          title: string;
          dataUrl?: string;
          filename?: string;
          markdown?: string;
        })
      : undefined;
    const message = appendStaffMessage(orgId, userId, {
      role: (body.role as 'user' | 'assistant' | 'system') || 'user',
      content: String(body.content ?? ''),
      artifact,
      source: typeof body.source === 'string' ? body.source : 'cynthia',
    });
    sendJson(res, 200, { message });
    return true;
  }

  if (pathname === '/api/cynthia/cards' && req.method === 'GET') {
    const orgId = orgFrom(req);
    const url = new URL(req.url || '/', 'http://localhost');
    const headerUser = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
    const userId = headerUser || url.searchParams.get('userId') || '';
    if (!userId || userId === 'default-staff') {
      sendJson(res, 401, { error: 'Authenticated userId required', code: 'staff_not_resolved' });
      return true;
    }
    sendJson(res, 200, { cards: listRecentCards(orgId, userId) });
    return true;
  }

  if (pathname === '/api/cynthia/send-card' && req.method === 'POST') {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const orgId = orgFrom(req, body);
    const userId = resolveStaffUserId({
      userId:
        typeof body.userId === 'string'
          ? body.userId
          : typeof body.staffUserId === 'string'
            ? body.staffUserId
            : undefined,
      staffPhone: typeof body.staffPhone === 'string' ? body.staffPhone : undefined,
      orgId,
    });
    if (!userId) {
      sendJson(res, 422, { ok: false, error: 'Could not resolve staff recipient', code: 'staff_not_resolved' });
      return true;
    }

    const amount = body.amount != null ? Number(body.amount) : undefined;
    const card = pushStaffCard(orgId, userId, {
      title: String(body.title || 'Details from call'),
      customerName: typeof body.customerName === 'string' ? body.customerName : undefined,
      phone: typeof body.phone === 'string' ? body.phone : undefined,
      address: typeof body.address === 'string' ? body.address : undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      quoteId: typeof body.quoteId === 'string' ? body.quoteId : undefined,
      projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      customerId: typeof body.customerId === 'string' ? body.customerId : undefined,
      pdfDataUrl: typeof body.pdfDataUrl === 'string' ? body.pdfDataUrl : undefined,
      pdfFilename: typeof body.pdfFilename === 'string' ? body.pdfFilename : undefined,
      reportMarkdown: typeof body.reportMarkdown === 'string' ? body.reportMarkdown : undefined,
      source: (body.source as CynthiaStaffCard['source']) || 'phone',
      actions: Array.isArray(body.actions) ? (body.actions as CynthiaStaffCard['actions']) : undefined,
    });

    void notifyStaffPush({
      orgId,
      userId,
      title: card.title,
      body: [card.customerName, card.address, card.amount != null ? `£${card.amount}` : null]
        .filter(Boolean)
        .join(' · ') || 'Open Cynthia for details',
      cardId: card.id,
    });

    sendJson(res, 200, { ok: true, card, userId, route: `/cynthia?card=${card.id}` });
    return true;
  }

  return false;
}

/** Programmatic send used by phone tools / orchestrator. */
export function sendToStaffCynthiaInternal(input: {
  orgId?: string;
  userId?: string;
  staffPhone?: string;
  title: string;
  customerName?: string;
  phone?: string;
  address?: string;
  amount?: number;
  summary?: string;
  notes?: string;
  quoteId?: string;
  projectId?: string;
  customerId?: string;
  source?: CynthiaStaffCard['source'];
  toolCallId?: string;
}): { ok: boolean; card?: CynthiaStaffCard; userId?: string; route?: string; error?: string; code?: string } {
  // Prefer Sync2Dine home org UUID when caller did not pass orgId (legacy DEFAULT_ORG_ID is a slug)
  let orgId = input.orgId || DEFAULT_ORG_ID;
  if (!input.orgId || orgId === DEFAULT_ORG_ID || orgId === 'sync2dine') {
    orgId = getHomeOrgId();
  }
  const userId = resolveStaffUserId({
    userId: input.userId,
    staffPhone: input.staffPhone,
    orgId,
  });
  if (!userId) {
    return { ok: false, error: 'Could not resolve staff recipient', code: 'staff_not_resolved' };
  }
  const card = pushStaffCard(orgId, userId, {
    title: input.title,
    customerName: input.customerName,
    phone: input.phone,
    address: input.address,
    amount: input.amount,
    summary: input.summary,
    notes: input.notes,
    quoteId: input.quoteId,
    projectId: input.projectId,
    customerId: input.customerId,
    source: input.source || 'phone',
  });
  emitAgentActivity({ orgId, targetUserId: userId, channel: input.source || 'phone', action: 'sendToStaffCynthia', phase: 'changed', summary: `Card sent: ${card.title}`, route: `/cynthia?card=${card.id}` });
  void notifyStaffPush({
    orgId,
    userId,
    title: card.title,
    body: [card.customerName, card.address, card.amount != null ? `£${card.amount}` : null]
      .filter(Boolean)
      .join(' · ') || 'Open Cynthia for details',
    cardId: card.id,
  });
  return { ok: true, card, userId, route: `/cynthia?card=${card.id}` };
}
