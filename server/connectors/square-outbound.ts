/**
 * Square Orders API outbound — CreateOrder + EXTERNAL/CASH payment so tickets hit POS.
 */
import { randomUUID } from 'crypto';
import { listMenuItemsForOrg, type MenuItem } from '../menu-catalog';
import type { ConnectorConfig } from './types';
import {
  listSquareCatalogVariations,
  listSquareLocations,
  refreshSquareAccessToken,
  squareFetch,
  type SquareCatalogVariation,
} from './square-api';
import { saveConnectorConfig } from './config-store';

export type PosPushResult = {
  ok: boolean;
  externalId?: string;
  error?: string;
  raw?: unknown;
};

async function resolveAccessToken(config: ConnectorConfig): Promise<{
  token?: string;
  error?: string;
  config: ConnectorConfig;
}> {
  let cfg = config;
  const token = cfg.oauthAccessToken?.trim();
  if (!token) return { error: 'square_not_connected', config: cfg };

  const expiresAt = cfg.oauthExpiresAt ? Date.parse(cfg.oauthExpiresAt) : NaN;
  const needsRefresh = Number.isFinite(expiresAt) && expiresAt < Date.now() + 60_000;
  if (needsRefresh && cfg.oauthRefreshToken?.trim()) {
    const refreshed = await refreshSquareAccessToken(cfg.oauthRefreshToken.trim());
    if (refreshed.ok && refreshed.accessToken) {
      cfg = await saveConnectorConfig(cfg.orgId, {
        oauthAccessToken: refreshed.accessToken,
        oauthRefreshToken: refreshed.refreshToken ?? cfg.oauthRefreshToken,
        oauthExpiresAt: refreshed.expiresAt,
        lastError: '',
      });
      return { token: refreshed.accessToken, config: cfg };
    }
    return { error: refreshed.error || 'square_token_refresh_failed', config: cfg };
  }
  return { token, config: cfg };
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveCatalogId(
  line: Record<string, unknown>,
  menuByName: Map<string, MenuItem>,
  menuById: Map<string, MenuItem>,
): { catalogObjectId?: string; error?: string; label: string } {
  const label = String(line.name ?? line.label ?? '').trim();
  const menuId = line.menuItemId != null ? String(line.menuItemId).trim() : '';
  const byId = menuId ? menuById.get(menuId) : undefined;
  const byName = label ? menuByName.get(normalizeName(label)) : undefined;
  const item = byId ?? byName;
  const catalogObjectId = item?.externalIds?.square?.trim();
  if (!catalogObjectId) {
    return {
      label: label || menuId || 'item',
      error: `unmapped_item:${label || menuId || 'unknown'}`,
    };
  }
  return { catalogObjectId, label: label || item?.name || 'item' };
}

function moneyMinor(amount: number, currency = 'GBP'): { amount: number; currency: string } {
  return { amount: Math.max(0, Math.round(amount * 100)), currency };
}

function buildFulfillment(
  order: Record<string, unknown>,
  config: ConnectorConfig,
): Record<string, unknown> {
  const orderType = String(order.orderType ?? 'collection').toLowerCase();
  const isDelivery = orderType === 'delivery';
  const customerName = String(
    order.customerName
      || config.defaultPickupName
      || 'Guest',
  ).trim();
  const phone = String(
    order.customerPhone
      || config.defaultPickupPhone
      || '',
  ).trim();

  const deliveryAddress = String(order.deliveryAddress ?? '').trim();
  const postcode = String(order.deliveryPostcode ?? order.postcode ?? '').trim()
    || (config.fulfillmentAddressPostcode ?? '').trim();

  const recipient: Record<string, unknown> = {
    display_name: customerName,
  };
  if (phone) recipient.phone_number = phone;

  if (isDelivery) {
    const line1 = deliveryAddress
      || (config.fulfillmentAddressLine1 ?? '').trim()
      || 'Delivery';
    recipient.address = {
      address_line_1: line1,
      locality: (config.fulfillmentAddressCity ?? '').trim() || undefined,
      postal_code: postcode || undefined,
      country: (config.fulfillmentAddressCountry ?? 'GB').trim() || 'GB',
    };
    return {
      type: 'DELIVERY',
      state: 'PROPOSED',
      delivery_details: {
        recipient,
        schedule_type: 'ASAP',
      },
    };
  }

  return {
    type: 'PICKUP',
    state: 'PROPOSED',
    pickup_details: {
      recipient,
      schedule_type: 'ASAP',
    },
  };
}

export async function pushOrderToSquare(
  orgId: string,
  order: Record<string, unknown>,
  config: ConnectorConfig,
): Promise<PosPushResult> {
  if (config.provider !== 'square') {
    return { ok: false, error: 'provider_not_square' };
  }
  if (!config.enabled) return { ok: false, error: 'connector_disabled' };
  if (config.direction !== 'outbound' && config.direction !== 'both') {
    return { ok: false, error: 'direction_not_outbound' };
  }

  const auth = await resolveAccessToken(config);
  if (!auth.token) return { ok: false, error: auth.error || 'square_not_connected' };
  const cfg = auth.config;
  const locationId = cfg.squareLocationId?.trim();
  if (!locationId) return { ok: false, error: 'square_location_required' };

  const menu = await listMenuItemsForOrg(orgId);
  const menuByName = new Map(menu.map((m) => [normalizeName(m.name), m]));
  const menuById = new Map(menu.map((m) => [m.id, m]));

  const items = Array.isArray(order.items) ? order.items as Array<Record<string, unknown>> : [];
  if (!items.length) return { ok: false, error: 'order_has_no_items' };

  const lineItems: Array<Record<string, unknown>> = [];
  for (const line of items) {
    const mapped = resolveCatalogId(line, menuByName, menuById);
    if (!mapped.catalogObjectId) {
      return { ok: false, error: mapped.error };
    }
    const qty = Math.max(1, Number(line.qty ?? line.quantity ?? 1) || 1);
    lineItems.push({
      quantity: String(qty),
      catalog_object_id: mapped.catalogObjectId,
      note: line.notes != null ? String(line.notes).slice(0, 500) : undefined,
    });
  }

  const noteParts = [
    order.notes != null ? String(order.notes) : '',
    order.customerAllergies ? `Allergies: ${order.customerAllergies}` : '',
    order.allergyConfirmed === true ? 'Allergies confirmed' : '',
    `Sync2Dine #${order.orderNumber ?? order.id}`,
  ].filter(Boolean);

  const idempotencyKey = `s2d-order-${String(order.id ?? randomUUID())}`;
  const createBody = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: locationId,
      reference_id: String(order.id ?? '').slice(0, 40),
      line_items: lineItems,
      fulfillments: [buildFulfillment(order, cfg)],
      state: 'OPEN',
      note: noteParts.join(' | ').slice(0, 500),
    },
  };

  const created = await squareFetch<{ order?: { id?: string; total_money?: { amount?: number; currency?: string } } }>(
    '/v2/orders',
    { accessToken: auth.token, method: 'POST', body: createBody },
  );
  if (!created.ok || !created.data?.order?.id) {
    return { ok: false, error: created.error || 'square_create_order_failed', raw: created.data };
  }

  const squareOrderId = String(created.data.order.id);
  const totalMoney = created.data.order.total_money;
  const amount = Number(totalMoney?.amount ?? moneyMinor(Number(order.total ?? 0)).amount);
  const currency = String(totalMoney?.currency ?? 'GBP');

  const payIdempotency = `s2d-pay-${String(order.id ?? squareOrderId)}`;
  const useCash = String(order.paymentMethod ?? '').toLowerCase() === 'cash'
    || String(order.paymentStatus ?? '').toLowerCase() !== 'paid';

  const paymentBody: Record<string, unknown> = {
    idempotency_key: payIdempotency,
    amount_money: { amount, currency },
    order_id: squareOrderId,
    location_id: locationId,
    autocomplete: true,
  };

  if (useCash) {
    paymentBody.source_id = 'EXTERNAL';
    paymentBody.external_details = {
      type: 'OTHER',
      source: 'Sync2Dine phone',
      source_fee_money: { amount: 0, currency },
    };
  } else {
    paymentBody.source_id = 'EXTERNAL';
    paymentBody.external_details = {
      type: 'OTHER',
      source: 'Sync2Dine paid',
      source_fee_money: { amount: 0, currency },
    };
  }

  const paid = await squareFetch('/v2/payments', {
    accessToken: auth.token,
    method: 'POST',
    body: paymentBody,
  });
  if (!paid.ok) {
    // Order exists but payment failed — still return external id so staff can reconcile
    return {
      ok: false,
      externalId: squareOrderId,
      error: paid.error || 'square_payment_failed',
      raw: { order: created.data, payment: paid.data },
    };
  }

  return {
    ok: true,
    externalId: squareOrderId,
    raw: { order: created.data, payment: paid.data },
  };
}

export async function syncSquareCatalogSuggestions(
  orgId: string,
  config: ConnectorConfig,
): Promise<{
  ok: boolean;
  variations?: SquareCatalogVariation[];
  suggestions?: Array<{ menuItemId: string; menuName: string; variationId?: string; label?: string }>;
  error?: string;
}> {
  const auth = await resolveAccessToken(config);
  if (!auth.token) return { ok: false, error: auth.error || 'square_not_connected' };
  const catalog = await listSquareCatalogVariations(auth.token);
  if (!catalog.ok || !catalog.variations) return { ok: false, error: catalog.error };

  const menu = await listMenuItemsForOrg(orgId);
  const byNorm = new Map<string, SquareCatalogVariation>();
  for (const v of catalog.variations) {
    byNorm.set(normalizeName(v.itemName), v);
    byNorm.set(normalizeName(v.label), v);
  }

  const suggestions = menu.map((m) => {
    const hit = byNorm.get(normalizeName(m.name));
    return {
      menuItemId: m.id,
      menuName: m.name,
      variationId: m.externalIds?.square || hit?.variationId,
      label: hit?.label,
    };
  });

  return { ok: true, variations: catalog.variations, suggestions };
}

export async function fetchSquareLocationsForConfig(config: ConnectorConfig): Promise<{
  ok: boolean;
  locations?: Awaited<ReturnType<typeof listSquareLocations>>['locations'];
  error?: string;
}> {
  const auth = await resolveAccessToken(config);
  if (!auth.token) return { ok: false, error: auth.error || 'square_not_connected' };
  return listSquareLocations(auth.token);
}

export function squareConnectionStatus(config: ConnectorConfig): 'not_connected' | 'connected' | 'token_expired' {
  if (!config.oauthAccessToken?.trim()) return 'not_connected';
  const expiresAt = config.oauthExpiresAt ? Date.parse(config.oauthExpiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt < Date.now() && !config.oauthRefreshToken?.trim()) {
    return 'token_expired';
  }
  return 'connected';
}
