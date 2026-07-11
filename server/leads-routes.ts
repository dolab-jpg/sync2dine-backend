import type { IncomingMessage, ServerResponse } from 'http';
import {
  countActionRequired,
  getCustomerSnapshots,
  getInboxItem,
  listInboxItems,
  markInboxHandled,
} from './leads/leadInboxStore';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseOrgId(req: IncomingMessage): string {
  return req.headers['x-org-id']?.toString() || 'default';
}

export async function handleLeadsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL
): Promise<boolean> {
  if (!pathname.startsWith('/api/leads')) return false;

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
