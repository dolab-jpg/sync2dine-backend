import type { IncomingMessage, ServerResponse } from 'http';
import {
  DEFAULT_ORG_ID,
  listOrderRecords,
  saveOrderRecord,
  setRequestOrgId,
  updateOrderRecord,
} from '../data-store';
import { resolveOrgIdForRequest, isAuthEnforced, requireAuth } from '../auth';
import {
  exportMenuForOrg,
  listMenuItemsForOrg,
  setMenuItemExternalIds,
  squareMenuCompleteness,
} from '../menu-catalog';
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
import {
  buildSquareOAuthAuthorizeUrl,
  exchangeSquareOAuthCode,
  squareAppCredentials,
} from './square-api';
import {
  fetchSquareLocationsForConfig,
  syncSquareCatalogSuggestions,
} from './square-outbound';
import { forwardOrderIfPosEnabled, pushOrderToPos } from './pos-outbound';

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

  // Admin mutating routes require staff auth when AUTH_ENFORCED (HMAC inbound stays public).
  const isInboundHmac =
    /\/api\/connectors\/[^/]+\/(orders|webhook|status)/.test(pathname)
    || /^\/api\/connectors\/[^/]+\/orders\/[^/]+\/status$/.test(pathname);
  const isAdminMutating =
    !isInboundHmac
    && (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE')
    && (
      pathname === '/api/connectors/config'
      || pathname === '/api/connectors/queue/process'
      || pathname.startsWith('/api/connectors/orders/')
      || pathname.startsWith('/api/connectors/square/')
      || pathname === '/api/connectors/menu/sync'
      || pathname === '/api/connectors/menu/mapping'
      || pathname === '/api/connectors/commerce/forward'
    );
  if (isAdminMutating && isAuthEnforced() && !requireAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

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
    const completeness = config?.provider === 'square'
      ? await squareMenuCompleteness(orgId)
      : undefined;
    sendJson(res, 200, {
      config: config
        ? {
            ...maskConnectorConfig(config),
            ...(completeness ? { menuCompleteness: completeness } : {}),
          }
        : null,
    });
    return true;
  }

  if (pathname === '/api/connectors/config' && (req.method === 'PUT' || req.method === 'POST')) {
    const patch: Parameters<typeof saveConnectorConfig>[1] = {
      provider: body.provider as import('./types').ConnectorProvider | undefined,
      enabled: body.enabled === true ? true : body.enabled === false ? false : undefined,
      direction: body.direction as import('./types').ConnectorDirection | undefined,
      outboundUrl: body.outboundUrl != null ? String(body.outboundUrl) : undefined,
      webhookSecret: body.webhookSecret != null ? String(body.webhookSecret) : undefined,
      statusMap: body.statusMap && typeof body.statusMap === 'object'
        ? body.statusMap as Record<string, string>
        : undefined,
      deliverectAccountId: body.deliverectAccountId != null ? String(body.deliverectAccountId) : undefined,
      deliverectLocationId: body.deliverectLocationId != null ? String(body.deliverectLocationId) : undefined,
      squareLocationId: body.squareLocationId != null ? String(body.squareLocationId) : undefined,
      defaultPickupName: body.defaultPickupName != null ? String(body.defaultPickupName) : undefined,
      defaultPickupPhone: body.defaultPickupPhone != null ? String(body.defaultPickupPhone) : undefined,
      fulfillmentAddressLine1: body.fulfillmentAddressLine1 != null ? String(body.fulfillmentAddressLine1) : undefined,
      fulfillmentAddressCity: body.fulfillmentAddressCity != null ? String(body.fulfillmentAddressCity) : undefined,
      fulfillmentAddressPostcode: body.fulfillmentAddressPostcode != null ? String(body.fulfillmentAddressPostcode) : undefined,
      fulfillmentAddressCountry: body.fulfillmentAddressCountry != null ? String(body.fulfillmentAddressCountry) : undefined,
      posPush: body.posPush === 'on_place' || body.posPush === 'off' || body.posPush === 'manual_only'
        ? body.posPush
        : undefined,
    };
    // Sandbox / PAT: allow storing a personal access token via oauthAccessToken field
    if (body.oauthAccessToken != null && String(body.oauthAccessToken).trim()) {
      patch.oauthAccessToken = String(body.oauthAccessToken).trim();
      patch.oauthExpiresAt = undefined;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    const saved = await saveConnectorConfig(orgId, patch);
    const completeness = saved.provider === 'square'
      ? await squareMenuCompleteness(orgId)
      : undefined;
    sendJson(res, 200, {
      config: {
        ...maskConnectorConfig(saved),
        ...(completeness ? { menuCompleteness: completeness } : {}),
      },
    });
    return true;
  }

  if (pathname === '/api/connectors/status' && req.method === 'GET') {
    const config = await getConnectorConfig(orgId);
    const completeness = config?.provider === 'square'
      ? await squareMenuCompleteness(orgId)
      : undefined;
    sendJson(res, 200, {
      integrationReady: true,
      certified: false,
      config: config
        ? {
            ...maskConnectorConfig(config),
            ...(completeness ? { menuCompleteness: completeness } : {}),
          }
        : null,
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
    const config = await getConnectorConfig(orgId);
    if (config?.provider === 'square') {
      const sync = await syncSquareCatalogSuggestions(orgId, config);
      if (!sync.ok) {
        sendJson(res, 502, { error: sync.error || 'square_catalog_sync_failed' });
        return true;
      }
      const menu = await exportMenuForOrg(orgId);
      await saveConnectorConfig(orgId, {
        lastMenuSyncAt: menu.generatedAt,
        menuVersion: menu.version,
        lastError: '',
      });
      const completeness = await squareMenuCompleteness(orgId);
      sendJson(res, 200, {
        ok: true,
        ...menu,
        variations: sync.variations,
        suggestions: sync.suggestions,
        menuCompleteness: completeness,
      });
      return true;
    }
    const menu = await exportMenuForOrg(orgId);
    await saveConnectorConfig(orgId, {
      lastMenuSyncAt: menu.generatedAt,
      menuVersion: menu.version,
    });
    if (config?.enabled && config.outboundUrl) {
      await emitOrderUpdatedWebhook(orgId, { id: 'menu-sync', status: 'menu', externalId: menu.version });
    }
    sendJson(res, 200, { ok: true, ...menu });
    return true;
  }

  if (pathname === '/api/connectors/menu/mapping' && req.method === 'GET') {
    const config = await getConnectorConfig(orgId);
    const items = await listMenuItemsForOrg(orgId);
    let variations: unknown[] = [];
    let suggestions: unknown[] = [];
    if (config?.provider === 'square' && config.oauthAccessToken) {
      const sync = await syncSquareCatalogSuggestions(orgId, config);
      if (sync.ok) {
        variations = sync.variations ?? [];
        suggestions = sync.suggestions ?? [];
      }
    }
    const completeness = await squareMenuCompleteness(orgId);
    sendJson(res, 200, {
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        category: i.category,
        squareVariationId: i.externalIds?.square ?? '',
      })),
      variations,
      suggestions,
      menuCompleteness: completeness,
    });
    return true;
  }

  if (pathname === '/api/connectors/menu/mapping' && (req.method === 'PUT' || req.method === 'POST')) {
    const mappings = Array.isArray(body.mappings) ? body.mappings as Array<Record<string, unknown>> : [];
    const applySuggested = body.applySuggested === true;
    let updated = 0;
    if (applySuggested) {
      const config = await getConnectorConfig(orgId);
      if (config?.provider === 'square') {
        const sync = await syncSquareCatalogSuggestions(orgId, config);
        for (const s of sync.suggestions ?? []) {
          if (!s.variationId) continue;
          const current = (await listMenuItemsForOrg(orgId)).find((m) => m.id === s.menuItemId);
          if (current?.externalIds?.square) continue;
          const r = await setMenuItemExternalIds(orgId, s.menuItemId, { square: s.variationId });
          if (r.ok) updated += 1;
        }
      }
    }
    for (const row of mappings) {
      const menuItemId = String(row.menuItemId ?? row.id ?? '').trim();
      if (!menuItemId) continue;
      const square = row.squareVariationId != null
        ? String(row.squareVariationId).trim()
        : row.square != null
          ? String(row.square).trim()
          : '';
      const r = await setMenuItemExternalIds(orgId, menuItemId, {
        square: square || null,
      });
      if (r.ok) updated += 1;
    }
    const completeness = await squareMenuCompleteness(orgId);
    sendJson(res, 200, { ok: true, updated, menuCompleteness: completeness });
    return true;
  }

  if (pathname === '/api/connectors/queue/process' && req.method === 'POST') {
    const n = await processOutboundQueue(20);
    sendJson(res, 200, { processed: n });
    return true;
  }

  // ——— Square POS ———
  function squareRedirectUri(req: IncomingMessage): string {
    if (process.env.SQUARE_OAUTH_REDIRECT_URI?.trim()) {
      return process.env.SQUARE_OAUTH_REDIRECT_URI.trim();
    }
    const proto = header(req, 'x-forwarded-proto') || 'https';
    const host = header(req, 'x-forwarded-host') || header(req, 'host') || 'localhost:3001';
    return `${proto}://${host}/api/connectors/square/oauth/callback`;
  }

  function settingsReturnUrl(): string {
    return (
      process.env.SQUARE_OAUTH_SUCCESS_REDIRECT?.trim()
      || process.env.PUBLIC_APP_URL?.trim()
      || 'https://app.b-diddies.com/settings'
    );
  }

  if (pathname === '/api/connectors/square/oauth/start' && req.method === 'GET') {
    // #region agent log
    fetch('http://127.0.0.1:7756/ingest/45011e36-ac12-4dbc-b7c1-e1827334fcf5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6b4e46'},body:JSON.stringify({sessionId:'6b4e46',runId:'debug-square',hypothesisId:'D',location:'routes.ts:square-oauth-start',message:'square oauth start hit',data:{orgId,hasAppId:Boolean(squareAppCredentials().applicationId)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const { applicationId } = squareAppCredentials();
    if (!applicationId) {
      sendJson(res, 503, { error: 'square_app_not_configured', hint: 'Set SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET' });
      return true;
    }
    const state = Buffer.from(JSON.stringify({ orgId, t: Date.now() }), 'utf8').toString('base64url');
    const url = buildSquareOAuthAuthorizeUrl({
      redirectUri: squareRedirectUri(req),
      state,
    });
    if (!url) {
      sendJson(res, 503, { error: 'square_app_not_configured' });
      return true;
    }
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
    return true;
  }

  if (pathname === '/api/connectors/square/oauth/callback' && req.method === 'GET') {
    const url = new URL(req.url || '', 'http://localhost');
    const code = url.searchParams.get('code') || '';
    const stateRaw = url.searchParams.get('state') || '';
    let stateOrg = orgId;
    try {
      const parsed = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8')) as { orgId?: string };
      if (parsed.orgId) stateOrg = parsed.orgId;
    } catch {
      /* keep orgId from header */
    }
    setRequestOrgId(stateOrg);
    if (!code) {
      res.statusCode = 302;
      res.setHeader('Location', `${settingsReturnUrl()}?square=error&reason=missing_code`);
      res.end();
      return true;
    }
    const exchanged = await exchangeSquareOAuthCode({
      code,
      redirectUri: squareRedirectUri(req),
    });
    if (!exchanged.ok || !exchanged.accessToken) {
      res.statusCode = 302;
      res.setHeader('Location', `${settingsReturnUrl()}?square=error&reason=${encodeURIComponent(exchanged.error || 'oauth_failed')}`);
      res.end();
      return true;
    }
    await saveConnectorConfig(stateOrg, {
      provider: 'square',
      direction: 'outbound',
      oauthAccessToken: exchanged.accessToken,
      oauthRefreshToken: exchanged.refreshToken,
      oauthExpiresAt: exchanged.expiresAt,
      squareMerchantId: exchanged.merchantId,
      lastError: '',
    });
    res.statusCode = 302;
    res.setHeader('Location', `${settingsReturnUrl()}?square=connected`);
    res.end();
    return true;
  }

  if (pathname === '/api/connectors/square/locations' && req.method === 'GET') {
    const config = await getConnectorConfig(orgId);
    if (!config?.oauthAccessToken) {
      sendJson(res, 400, { error: 'square_not_connected' });
      return true;
    }
    const result = await fetchSquareLocationsForConfig(config);
    sendJson(res, result.ok ? 200 : 502, result);
    return true;
  }

  if (pathname === '/api/connectors/square/disconnect' && req.method === 'POST') {
    await saveConnectorConfig(orgId, {
      oauthAccessToken: '',
      oauthRefreshToken: '',
      oauthExpiresAt: undefined,
      squareMerchantId: '',
      enabled: false,
      lastError: '',
    });
    const config = await getConnectorConfig(orgId);
    sendJson(res, 200, { ok: true, config: config ? maskConnectorConfig(config) : null });
    return true;
  }

  if (pathname === '/api/connectors/square/test-push' && req.method === 'POST') {
    const config = await getConnectorConfig(orgId);
    if (!config || config.provider !== 'square') {
      sendJson(res, 400, { error: 'square_not_configured' });
      return true;
    }
    const items = await listMenuItemsForOrg(orgId);
    const mapped = items.find((i) => i.externalIds?.square);
    if (!mapped) {
      sendJson(res, 400, { error: 'no_mapped_menu_items', hint: 'Map at least one menu item to Square first' });
      return true;
    }
    const testOrder = {
      id: `test-${Date.now()}`,
      orderNumber: 'TEST',
      customerName: String(body.customerName ?? config.defaultPickupName ?? 'Sync2Dine Test'),
      customerPhone: String(body.customerPhone ?? config.defaultPickupPhone ?? ''),
      orderType: String(body.orderType ?? 'collection'),
      paymentStatus: 'unpaid',
      paymentMethod: 'cash',
      items: [{ name: mapped.name, qty: 1, price: mapped.price, menuItemId: mapped.id }],
      total: mapped.price,
      notes: 'Sync2Dine Square test order — safe to void',
      allergyConfirmed: true,
    };
    const push = await pushOrderToPos(orgId, testOrder, { ...config, enabled: true, direction: 'outbound' });
    await saveConnectorConfig(orgId, {
      lastTestPushAt: new Date().toISOString(),
      lastTestPushOk: push.ok,
      lastError: push.ok ? '' : (push.error || 'test_push_failed'),
      lastOutboundAt: new Date().toISOString(),
    });
    await logConnectorEvent({
      orgId,
      provider: 'square',
      direction: 'outbound',
      eventType: 'order.created',
      externalId: push.externalId,
      status: push.ok ? 'ok' : 'error',
      payload: { test: true, orderId: testOrder.id },
      error: push.ok ? undefined : push.error,
    });
    sendJson(res, push.ok ? 200 : 502, { ...push, ok: push.ok });
    return true;
  }

  const orderPush = pathname.match(/^\/api\/connectors\/orders\/([^/]+)\/push$/);
  if (orderPush && req.method === 'POST') {
    const orderId = decodeURIComponent(orderPush[1]);
    const config = await getConnectorConfig(orgId);
    const orders = await listOrderRecords(orgId);
    const order = orders.find((o) => String(o.id) === orderId);
    if (!order) {
      sendJson(res, 404, { error: 'order_not_found' });
      return true;
    }
    const result = await forwardOrderIfPosEnabled(orgId, order, config);
    sendJson(res, result.push?.ok === false ? 502 : 200, {
      ok: result.push?.ok !== false,
      order: result.order,
      push: result.push,
    });
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
