import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_ORG_ID,
  listOrderRecords,
  setRequestOrgId,
  updateOrderRecord,
} from './data-store';
import { resolveOrgIdForRequest } from './auth';
import { notifyConnectorOrderStatusChange } from './connectors/routes';
import { placeFoodOrder } from './order-service';

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
 * Sync2Dine restaurant orders API — Supabase `public.orders` is primary;
 * disk JSON is write-through cache / offline fallback.
 * POST create always goes through shared OrderService (same rules as phone).
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
    const orders = await listOrderRecords(orgId);
    sendJson(res, 200, { orders });
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

    const result = await placeFoodOrder({
      items: Array.isArray(body.items) ? body.items : [],
      orderType: body.orderType != null ? String(body.orderType) : body.type != null ? String(body.type) : undefined,
      postcode: body.postcode != null ? String(body.postcode) : body.deliveryPostcode != null ? String(body.deliveryPostcode) : undefined,
      deliveryAddress: body.deliveryAddress != null
        ? String(body.deliveryAddress)
        : body.address != null
          ? String(body.address)
          : undefined,
      customerAllergies: body.customerAllergies != null ? String(body.customerAllergies) : undefined,
      allergyConfirmed: body.allergyConfirmed === true,
      customerPhone: body.customerPhone != null ? String(body.customerPhone) : body.phone != null ? String(body.phone) : undefined,
      customerName: body.customerName != null
        ? String(body.customerName)
        : body.customer != null
          ? String(body.customer)
          : undefined,
      customerId: body.customerId != null ? String(body.customerId) : undefined,
      specialName: body.specialName != null ? String(body.specialName) : undefined,
      notes: body.notes != null ? String(body.notes) : undefined,
      paymentStatus: body.paymentStatus != null
        ? String(body.paymentStatus)
        : body.payment != null
          ? String(body.payment)
          : undefined,
      total: body.total != null ? Number(body.total) : undefined,
      channel: body.channel != null ? String(body.channel) : 'staff',
      source: body.source != null ? String(body.source) : 'sync2dine',
      sourceCallId: body.sourceCallId != null ? String(body.sourceCallId) : undefined,
      orgId,
    });

    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        error: result.error,
        spokenHint: result.spokenHint,
        ...(result.postcode ? { postcode: result.postcode } : {}),
        ...(result.allergenWarnings ? { allergenWarnings: result.allergenWarnings } : {}),
      });
      return true;
    }

    sendJson(res, 201, {
      ok: true,
      order: result.order,
      syncState: result.syncState,
      spokenHint: result.spokenHint,
      posPush: result.posPush,
    });
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
    const updated = await updateOrderRecord(id, body, orgId);
    if (!updated) {
      sendJson(res, 404, { error: 'Order not found' });
      return true;
    }
    if (body.status != null) {
      void notifyConnectorOrderStatusChange(orgId, updated);
    }
    sendJson(res, 200, { order: updated });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
