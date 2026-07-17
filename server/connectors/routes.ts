import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_ORG_ID,
  saveOrderRecord,
  setRequestOrgId,
  updateOrderRecord,
} from '../data-store';
import { resolveOrgIdForRequest } from '../auth';
import { exportMenuForOrg } from '../menu-catalog';
import { verifySignature, S2D_SIGNATURE_HEADER } from './hmac';
import {
  getConnectorConfig,
  maskConnectorConfig,
  resolveConnectorSecret,
  saveConnectorConfig,
} from './config-store';
import {
  checkIdempotency,
  listConnectorEvents,
  logConnectorEvent,
  recordIdempotency,
} from './event-log';
import {
  inboundOrderToSavePayload,
  parseDeliverectInboundOrder,
  parseGenericInboundOrder,
} from './inbound-orders';
import { mapInboundStatus, mapOutboundStatus } from './status-map';
import { emitOrderUpdatedWebhook, processOutboundQueue } from './outbound-queue';
import { forwardOrderToCommerceHub } from './commerce-outbound';
import { findOrderByExternalId } from '../supabase-orders';

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

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function ingestInboundOrder(
  provider: string,
  orgId: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const config = await getConnectorConfig(orgId);
  const secret = resolveConnectorSecret(config, provider);
  if (!secret) {
    return { status: 401, payload: { error: 'connector_secret_not_configured' } };
  }

  if (idempotencyKey) {
    const dup = await checkIdempotency(orgId, provider, idempotencyKey);
    if (dup.duplicate) {
      await logConnectorEvent({
        orgId,
        provider,
        direction: 'inbound',
        eventType: 'order.created',
        idempotencyKey,
        externalId: String(body.externalId ?? ''),
        status: 'duplicate',
        payload: body,
      });
      return {
        status: 200,
        payload: { ok: true, duplicate: true, orderId: dup.orderId },
      };
    }
  }

  const parsed = provider === 'deliverect'
    ? parseDeliverectInboundOrder(body)
    : parseGenericInboundOrder(body);
  if ('error' in parsed) {
    await logConnectorEvent({
      orgId,
      provider,
      direction: 'inbound',
      eventType: 'order.created',
      status: 'error',
      payload: body,
      error: parsed.error,
    });
    return { status: 400, payload: { error: parsed.error } };
  }

  const existing = await findOrderByExternalId(provider, parsed.externalId, orgId);
  if (existing) {
    return { status: 200, payload: { ok: true, duplicate: true, orderId: existing.id } };
  }

  const savePayload = inboundOrderToSavePayload(parsed, provider, config?.statusMap);
  const order = await saveOrderRecord(savePayload, orgId);
  if (idempotencyKey) await recordIdempotency(orgId, provider, idempotencyKey, String(order.id));

  await saveConnectorConfig(orgId, { lastInboundAt: new Date().toISOString(), lastError: '' });
  await logConnectorEvent({
    orgId,
    provider,
    direction: 'inbound',
    eventType: 'order.created',
    idempotencyKey,
    externalId: parsed.externalId,
    status: 'ok',
    payload: { orderId: order.id, externalId: parsed.externalId },
  });

  return { status: 201, payload: { ok: true, order } };
}

export async function handleConnectorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/connectors')) return false;

  const orgId = resolveOrgIdForRequest(req, {}) || DEFAULT_ORG_ID;
  setRequestOrgId(orgId);
  const rawBody = await readBody(req);
  let body: Record<string, unknown> = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
  }

  if (pathname === '/api/connectors/config' && req.method === 'GET') {
    const config = await getConnectorConfig(orgId);
    sendJson(res, 200, { config: config ? maskConnectorConfig(config) : null });
    return true;
  }

  if (pathname === '/api/connectors/config' && (req.method === 'PUT' || req.method === 'POST')) {
    const saved = await saveConnectorConfig(orgId, {
      provider: body.provider as import('./types').ConnectorProvider | undefined,
      enabled: body.enabled === true,
      direction: body.direction as import('./types').ConnectorDirection | undefined,
      outboundUrl: body.outboundUrl != null ? String(body.outboundUrl) : undefined,
      webhookSecret: body.webhookSecret != null ? String(body.webhookSecret) : undefined,
      statusMap: body.statusMap && typeof body.statusMap === 'object'
        ? body.statusMap as Record<string, string>
        : undefined,
      deliverectAccountId: body.deliverectAccountId != null ? String(body.deliverectAccountId) : undefined,
      deliverectLocationId: body.deliverectLocationId != null ? String(body.deliverectLocationId) : undefined,
    });
    sendJson(res, 200, { config: maskConnectorConfig(saved) });
    return true;
  }

  if (pathname === '/api/connectors/status' && req.method === 'GET') {
    const config = await getConnectorConfig(orgId);
    sendJson(res, 200, {
      integrationReady: true,
      certified: false,
      config: config ? maskConnectorConfig(config) : null,
    });
    return true;
  }

  if (pathname === '/api/connectors/events' && req.method === 'GET') {
    const events = await listConnectorEvents(orgId, 100);
    sendJson(res, 200, { events });
    return true;
  }

  if (pathname === '/api/connectors/menu' && req.method === 'GET') {
    const menu = await exportMenuForOrg(orgId);
    sendJson(res, 200, menu);
    return true;
  }

  if (pathname === '/api/connectors/menu/version' && req.method === 'GET') {
    const menu = await exportMenuForOrg(orgId);
    sendJson(res, 200, { version: menu.version, generatedAt: menu.generatedAt, itemCount: menu.items.length });
    return true;
  }

  if (pathname === '/api/connectors/menu/sync' && req.method === 'POST') {
    const menu = await exportMenuForOrg(orgId);
    await saveConnectorConfig(orgId, {
      lastMenuSyncAt: menu.generatedAt,
      menuVersion: menu.version,
    });
    const config = await getConnectorConfig(orgId);
    if (config?.enabled && config.outboundUrl) {
      await emitOrderUpdatedWebhook(orgId, { id: 'menu-sync', status: 'menu', externalId: menu.version });
    }
    sendJson(res, 200, { ok: true, ...menu });
    return true;
  }

  if (pathname === '/api/connectors/queue/process' && req.method === 'POST') {
    const n = await processOutboundQueue(20);
    sendJson(res, 200, { processed: n });
    return true;
  }

  const orderPost = pathname.match(/^\/api\/connectors\/([^/]+)\/orders$/);
  if (orderPost && req.method === 'POST') {
    const provider = decodeURIComponent(orderPost[1]);
    const config = await getConnectorConfig(orgId);
    const secret = resolveConnectorSecret(config, provider);
    const sig = header(req, S2D_SIGNATURE_HEADER) ?? header(req, 'x-s2d-signature');
    if (!verifySignature(secret, rawBody, sig)) {
      sendJson(res, 401, { error: 'invalid_signature' });
      return true;
    }
    const idempotencyKey = header(req, 'idempotency-key') ?? header(req, 'x-idempotency-key');
    const result = await ingestInboundOrder(provider, orgId, body, idempotencyKey);
    sendJson(res, result.status, result.payload);
    return true;
  }

  const statusPatch = pathname.match(/^\/api\/connectors\/([^/]+)\/orders\/([^/]+)\/status$/);
  if (statusPatch && req.method === 'PATCH') {
    const provider = decodeURIComponent(statusPatch[1]);
    const externalId = decodeURIComponent(statusPatch[2]);
    const config = await getConnectorConfig(orgId);
    const secret = resolveConnectorSecret(config, provider);
    const sig = header(req, S2D_SIGNATURE_HEADER) ?? header(req, 'x-s2d-signature');
    if (!verifySignature(secret, rawBody, sig)) {
      sendJson(res, 401, { error: 'invalid_signature' });
      return true;
    }
    const partnerStatus = String(body.status ?? body.sourceStatus ?? '');
    const mapped = mapInboundStatus(partnerStatus, config?.statusMap);
    const existing = await findOrderByExternalId(provider, externalId, orgId);
    if (!existing) {
      sendJson(res, 404, { error: 'order_not_found' });
      return true;
    }
    const updated = await updateOrderRecord(String(existing.id), {
      status: mapped,
      sourceStatus: partnerStatus,
      syncState: 'synced',
    }, orgId);
    sendJson(res, 200, { ok: true, order: updated });
    return true;
  }

  const webhookPost = pathname.match(/^\/api\/connectors\/([^/]+)\/webhook$/);
  if (webhookPost && req.method === 'POST') {
    const provider = decodeURIComponent(webhookPost[1]);
    const config = await getConnectorConfig(orgId);
    const secret = resolveConnectorSecret(config, provider);
    const sig = header(req, S2D_SIGNATURE_HEADER) ?? header(req, 'x-s2d-signature');
    if (!verifySignature(secret, rawBody, sig)) {
      sendJson(res, 401, { error: 'invalid_signature' });
      return true;
    }
    const eventType = String(body.event ?? body.type ?? 'order.created');
    if (eventType.includes('order') && (body.order || body.externalId)) {
      const idempotencyKey = header(req, 'idempotency-key') ?? header(req, 'x-idempotency-key');
      const payload = (body.order && typeof body.order === 'object') ? body.order as Record<string, unknown> : body;
      const result = await ingestInboundOrder(provider, orgId, payload, idempotencyKey);
      sendJson(res, result.status, result.payload);
      return true;
    }
    if (eventType.includes('status') && body.externalId) {
      const partnerStatus = String(body.status ?? '');
      const existing = await findOrderByExternalId(provider, String(body.externalId), orgId);
      if (existing) {
        await updateOrderRecord(String(existing.id), {
          status: mapInboundStatus(partnerStatus, config?.statusMap),
          sourceStatus: partnerStatus,
        }, orgId);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 200, { ok: true, ignored: true });
    return true;
  }

  if (pathname === '/api/connectors/commerce/forward' && req.method === 'POST') {
    const config = await getConnectorConfig(orgId);
    if (!config?.webhookSecret || !config.outboundUrl) {
      sendJson(res, 400, { error: 'connector_not_configured' });
      return true;
    }
    const result = await forwardOrderToCommerceHub(orgId, body.order && typeof body.order === 'object'
      ? body.order as Record<string, unknown>
      : body, {
      outboundUrl: config.outboundUrl,
      secret: config.webhookSecret,
      accountId: config.deliverectAccountId,
      locationId: config.deliverectLocationId,
    });
    sendJson(res, result.ok ? 200 : 502, result);
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

/** Called from order status updates to notify partner webhooks. */
export async function notifyConnectorOrderStatusChange(
  orgId: string,
  order: Record<string, unknown>,
): Promise<void> {
  const config = await getConnectorConfig(orgId);
  if (!config?.enabled) return;
  const partnerStatus = mapOutboundStatus(String(order.status ?? 'new'), config.statusMap);
  await emitOrderUpdatedWebhook(orgId, {
    ...order,
    sourceStatus: partnerStatus,
  });
}
