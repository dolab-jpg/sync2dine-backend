import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_ORG_ID,
  listOrderRecords,
  saveOrderRecord,
  setRequestOrgId,
  updateOrderRecord,
} from './data-store';
import { resolveOrgIdForRequest } from './auth';

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Sync2Dine restaurant orders API — JSON data-store primary with optional
 * Supabase mirror later. Mirrors BD quote/customer record patterns.
 */
export async function handleOrdersRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/orders')) return false;

  const orgId = resolveOrgIdForRequest(req, {}) || DEFAULT_ORG_ID;
  setRequestOrgId(orgId);

  if (pathname === '/api/orders' && req.method === 'GET') {
    sendJson(res, 200, { orders: listOrderRecords() });
    return true;
  }

  if (pathname === '/api/orders' && req.method === 'POST') {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const record = saveOrderRecord({
      ...body,
      orgId,
      customerName: body.customerName ?? body.customer ?? 'Guest',
      customerPhone: body.customerPhone ?? body.phone ?? '',
      channel: body.channel ?? 'phone',
      orderType: body.orderType ?? body.type ?? 'collection',
      status: body.status ?? 'new',
      paymentStatus: body.paymentStatus ?? body.payment ?? 'unpaid',
      items: body.items ?? [],
      total: body.total ?? 0,
      deliveryAddress: body.deliveryAddress ?? body.address,
      notes: body.notes ?? '',
    });
    sendJson(res, 201, { order: record });
    return true;
  }

  const patchMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (patchMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const id = decodeURIComponent(patchMatch[1]);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const updated = updateOrderRecord(id, body);
    if (!updated) {
      sendJson(res, 404, { error: 'Order not found' });
      return true;
    }
    sendJson(res, 200, { order: updated });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
