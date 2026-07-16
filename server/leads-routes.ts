import type { IncomingMessage, ServerResponse } from 'http';
import {
  countActionRequired,
  getCustomerSnapshots,
  getInboxItem,
  listInboxItems,
  markInboxHandled,
} from './leads/leadInboxStore';
import { DEFAULT_ORG_ID, getCallById, setRequestOrgId } from './data-store';
import { resolveOrgIdForRequest } from './auth';
import { captureOrUpdateLead } from './phone-tools';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseOrgId(req: IncomingMessage): string {
  return req.headers['x-org-id']?.toString() || 'default';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Staff-assisted "Create lead from this call" path — mirrors what Aria's
 * `captureLead` tool does automatically, but for a specific call row the
 * Call Centre UI already knows about (caller number pre-filled, no retyping).
 */
async function handleCreateLeadFromCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: {
    callId?: string;
    phone?: string;
    name?: string;
    email?: string;
    address?: string;
    notes?: string;
    orgId?: string;
  } = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const orgId = resolveOrgIdForRequest(req, body) || DEFAULT_ORG_ID;
  setRequestOrgId(orgId);

  const call = body.callId ? getCallById(body.callId) : undefined;
  if (body.callId && !call) {
    sendJson(res, 404, { error: 'Call not found' });
    return;
  }

  const metadata = (call?.metadata as Record<string, unknown> | undefined) ?? {};
  const phone = firstNonEmpty(body.phone, call?.from as string | undefined, metadata.partyPhone as string | undefined);
  if (!phone) {
    sendJson(res, 400, { error: 'phone is required (or a callId with a known caller number)' });
    return;
  }

  const callContactName = firstNonEmpty(call?.contactName as string | undefined);
  const fallbackName = callContactName && callContactName !== 'Guest' ? callContactName : undefined;
  const name = firstNonEmpty(body.name) ?? fallbackName;
  if (!name) {
    sendJson(res, 400, { error: 'name is required' });
    return;
  }

  const { customer, isNewLead, error, spokenHint } = captureOrUpdateLead(
    { name, phone, email: body.email, address: body.address, notes: body.notes },
    { callId: body.callId, fallbackPhone: phone },
  );

  if (error) {
    sendJson(res, 400, {
      success: false,
      error,
      message: spokenHint || error,
      customer: null,
      isNewLead: false,
    });
    return;
  }

  sendJson(res, 200, { success: true, customer, isNewLead });
}

export async function handleLeadsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
): Promise<boolean> {
  if (!pathname.startsWith('/api/leads')) return false;

  if (pathname === '/api/leads/from-call' && req.method === 'POST') {
    await handleCreateLeadFromCall(req, res);
    return true;
  }

  const orgId = parseOrgId(req);

  if (pathname === '/api/leads/inbox' && req.method === 'GET') {
    const since = url.searchParams.get('since') ?? undefined;
    const items = listInboxItems(orgId, since);
    const customerIds = items.map(i => i.customerId).filter(Boolean) as string[];
    const customers = getCustomerSnapshots(customerIds);
    const { getProcessedEmailCacheIds } = await import('./leads/leadInboxStore');
    sendJson(res, 200, {
      items,
      customers,
      actionRequired: countActionRequired(orgId),
      processedEmailCacheIds: [...getProcessedEmailCacheIds()],
    });
    return true;
  }

  const handleMatch = pathname.match(/^\/api\/leads\/inbox\/([^/]+)\/handle$/);
  if (handleMatch && req.method === 'POST') {
    const item = markInboxHandled(handleMatch[1]);
    if (!item) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    sendJson(res, 200, { item });
    return true;
  }

  const getMatch = pathname.match(/^\/api\/leads\/inbox\/([^/]+)$/);
  if (getMatch && req.method === 'GET') {
    const item = getInboxItem(getMatch[1]);
    if (!item) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    sendJson(res, 200, { item });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
