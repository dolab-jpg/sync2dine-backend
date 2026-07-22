/**
 * Shared validation for marketplace / HMAC inbound orders.
 * Maps lines to the org catalog (price wins) and applies delivery economics
 * from agentSettings — same rules as placeFoodOrder where practical.
 */
import { getDataStore } from '../data-store';
import { listMenuItemsForOrg } from '../menu-catalog';
import { matchDeliveryPostcode, normalizeDeliveryPrefixes } from '../delivery-areas';
import type { InboundConnectorOrder } from './types';
import { inboundOrderToSavePayload } from './inbound-orders';

export type InboundNormaliseResult =
  | { ok: true; savePayload: Record<string, unknown>; warnings: string[] }
  | { ok: false; error: string; status: number };

export async function normaliseInboundOrder(
  orgId: string,
  provider: string,
  parsed: InboundConnectorOrder,
  statusMap?: Record<string, string>,
): Promise<InboundNormaliseResult> {
  const settings = getDataStore().agentSettings;
  if (settings?.orderingEnabled === false) {
    return { ok: false, error: 'ordering_suspended', status: 503 };
  }

  let catalog: Awaited<ReturnType<typeof listMenuItemsForOrg>> = [];
  try {
    catalog = await listMenuItemsForOrg(orgId);
  } catch {
    catalog = [];
  }

  const warnings: string[] = [];
  const partnerTotal = parsed.total;
  const normalisedItems: Array<{ name: string; qty: number; price: number; notes?: string }> = [];

  for (const line of parsed.items) {
    const name = String(line.name ?? '').trim();
    if (!name) continue;
    const qty = Math.max(1, Number(line.qty ?? 1) || 1);
    const match = catalog.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      // Keep partner line but flag — hubs may use PLUs not yet mapped.
      warnings.push(`unmapped_item:${name}`);
      normalisedItems.push({
        name,
        qty,
        price: Number.isFinite(Number(line.price)) ? Number(line.price) : 0,
        ...(line.notes ? { notes: line.notes } : {}),
      });
      continue;
    }
    normalisedItems.push({
      name: match.name,
      qty,
      price: match.price,
      ...(line.notes ? { notes: line.notes } : {}),
    });
  }

  if (!normalisedItems.length) {
    return { ok: false, error: 'items_required', status: 400 };
  }

  const orderType = String(parsed.orderType ?? 'collection').toLowerCase();
  let foodTotal = normalisedItems.reduce((s, i) => s + i.qty * i.price, 0);
  foodTotal = Math.round(foodTotal * 100) / 100;

  if (orderType === 'delivery') {
    const postcode = String(parsed.postcode ?? '').trim();
    if (postcode) {
      const prefixes = normalizeDeliveryPrefixes(settings?.deliveryPostcodePrefixes);
      if (prefixes.length) {
        const match = matchDeliveryPostcode(postcode, prefixes);
        if (!match.ok) {
          return { ok: false, error: 'out_of_delivery_area', status: 400 };
        }
      }
    }
    const minOrder = Number(settings?.minOrderGbp ?? 0);
    if (Number.isFinite(minOrder) && minOrder > 0 && foodTotal + 1e-9 < minOrder) {
      return { ok: false, error: 'below_minimum_order', status: 400 };
    }
    const feeCfg = Number(settings?.deliveryFeeGbp ?? 0);
    const freeOver = Number(settings?.freeDeliveryOverGbp ?? 0);
    if (Number.isFinite(feeCfg) && feeCfg > 0) {
      const free = Number.isFinite(freeOver) && freeOver > 0 && foodTotal + 1e-9 >= freeOver;
      if (!free) foodTotal = Math.round((foodTotal + feeCfg) * 100) / 100;
    }
  }

  const enriched: InboundConnectorOrder = {
    ...parsed,
    items: normalisedItems,
    total: foodTotal,
    // HMAC-authenticated partner: accept onto board; allergy text still stored for kitchen.
    allergyConfirmed: true,
  };

  const savePayload = inboundOrderToSavePayload(enriched, provider, statusMap);
  savePayload.total = foodTotal;
  savePayload.items = normalisedItems;
  if (partnerTotal != null && Number.isFinite(Number(partnerTotal))) {
    const meta = (savePayload.providerMeta && typeof savePayload.providerMeta === 'object')
      ? { ...(savePayload.providerMeta as Record<string, unknown>) }
      : {};
    meta.partnerTotal = Number(partnerTotal);
    meta.catalogTotal = foodTotal;
    if (warnings.length) meta.inboundWarnings = warnings;
    savePayload.providerMeta = meta;
  } else if (warnings.length) {
    const meta = (savePayload.providerMeta && typeof savePayload.providerMeta === 'object')
      ? { ...(savePayload.providerMeta as Record<string, unknown>) }
      : {};
    meta.inboundWarnings = warnings;
    savePayload.providerMeta = meta;
  }

  return { ok: true, savePayload, warnings };
}
