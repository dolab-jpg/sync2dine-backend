import type { IncomingMessage, ServerResponse } from 'http';
import {
  listOrderRecords,
  setRequestOrgId,
  updateOrderRecord,
} from '../data-store';
import { resolveOrgIdForRequest, requireAuth } from '../auth';
import { getProfileByBearer } from '../account-auth';
import { notifyConnectorOrderStatusChange } from '../connectors/routes';
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

const ALLOWED_PATCH_KEYS = new Set([
  'status',
  'paymentStatus',
  'paymentMethod',
]);

const STATUS_TRANSITIONS: Record<string, string[]> = {
  new: ['cooking', 'preparing', 'coming', 'ready', 'cancelled', 'completed', 'paid'],
  cooking: ['ready', 'preparing', 'coming', 'cancelled', 'completed', 'delivery', 'out'],
  preparing: ['ready', 'cooking', 'cancelled', 'completed', 'delivery', 'out'],
  coming: ['ready', 'cooking', 'cancelled', 'completed', 'preparing'],
  // Legacy board status used as a cooking alias
  paid: ['ready', 'coming', 'cooking', 'cancelled', 'completed'],
  ready: ['delivery', 'out', 'completed', 'cancelled', 'cooking', 'coming'],
  delivery: ['completed', 'cancelled', 'ready'],
  out: ['completed', 'cancelled', 'ready'],
  completed: [],
  cancelled: [],
};

function normalizeStatus(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

function allowStatusTransition(from: string, to: string): boolean {
  if (!to) return false;
  if (from === to) return true;
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed) return true; // unknown prior status — allow board bump
  if (allowed.includes(to)) return true;
  // permissive aliases used by the kitchen board
  const aliases: Record<string, string> = {
    preparing: 'cooking',
    coming: 'cooking',
    out: 'delivery',
  };
  const fromN = aliases[from] ?? from;
  const toN = aliases[to] ?? to;
  if (fromN === toN) return true;
  const allowedN = STATUS_TRANSITIONS[fromN];
  return !!allowedN?.includes(to) || !!allowedN?.includes(toN);
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

  // SEC-001: staff orders API requires first-page login (Supabase session or legacy JWT).
  // Never serve the home-org dump to anonymous callers.
  let profile: Awaited<ReturnType<typeof getProfileByBearer>> = null;
  try {
    profile = await getProfileByBearer(req);
  } catch {
    profile = null;
  }
  const legacy = requireAuth(req);
  if (!profile && !legacy) {
    sendJson(res, 401, { error: 'Unauthorized', hint: 'Sign in at /login' });
    return true;
  }

  const headerOrg = typeof req.headers['x-org-id'] === 'string' ? req.headers['x-org-id'].trim() : '';
  let orgId = '';
  if (profile) {
    if (profile.role === 'platform_owner' && headerOrg) orgId = headerOrg;
    else if (typeof profile.org_id === 'string' && profile.org_id.trim()) orgId = profile.org_id.trim();
    else if (headerOrg) orgId = headerOrg;
  }
  if (!orgId && legacy) {
    orgId =
      resolveOrgIdForRequest(req, { orgId: legacy.orgId ?? undefined })
      || (legacy.orgId ? String(legacy.orgId) : '')
      || headerOrg;
  }
  if (!orgId) {
    sendJson(res, 400, { error: 'org_required' });
    return true;
  }
  setRequestOrgId(orgId);
  const actorUserId = profile?.id != null ? String(profile.id) : legacy?.userId;
  const actorEmail = profile?.email != null ? String(profile.email) : legacy?.email;

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

    // SEC-002: allowlist board fields only — no items/total rewrites via PATCH.
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED_PATCH_KEYS) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (!Object.keys(patch).length) {
      sendJson(res, 400, { error: 'no_allowed_fields', allowed: [...ALLOWED_PATCH_KEYS] });
      return true;
    }

    if (patch.status != null) {
      const orders = await listOrderRecords(orgId);
      const current = orders.find((o) => String(o.id) === id);
      if (!current) {
        sendJson(res, 404, { error: 'Order not found' });
        return true;
      }
      const from = normalizeStatus(current.status);
      const to = normalizeStatus(patch.status);
      if (!allowStatusTransition(from, to)) {
        sendJson(res, 400, {
          error: 'invalid_status_transition',
          from,
          to,
        });
        return true;
      }
      patch.status = to;
    }

    if (actorUserId) {
      patch.lastActorUserId = actorUserId;
      patch.lastActorEmail = actorEmail;
      patch.lastActorAt = new Date().toISOString();
    }

    const updated = await updateOrderRecord(id, patch, orgId);
    if (!updated) {
      sendJson(res, 404, { error: 'Order not found' });
      return true;
    }
    if (patch.status != null) {
      void notifyConnectorOrderStatusChange(orgId, updated);
    }
    sendJson(res, 200, { order: updated });
    return true;
  }

  return false;
}
