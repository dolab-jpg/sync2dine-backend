/**
 * Shared place-order engine for phone, staff till, and POST /api/orders.
 * Phone tools must call this ù do not duplicate pricing/delivery/allergy rules.
 */
import {
  getDataStore,
  getRequestOrgId,
  lookupContactByPhone,
  saveOrderRecord,
} from './data-store';
import { formatSpokenGbp } from './spoken-money';
import { expandMealDealOrderItems, listMenuItemsForOrg, type OrderLineInput } from './menu-catalog';
import { allergenSafetyHint, customerAllergenConflict } from './allergens';
import { getConnectorConfig } from './connectors/config-store';
import { forwardOrderIfPosEnabled, isPosOutboundEnabled } from './connectors/pos-outbound';
import type { ConnectorConfig } from './connectors/types';

export type PosPushMode = 'manual_only' | 'on_place' | 'off';

export interface PlaceFoodOrderInput {
  items: unknown[];
  orderType?: string;
  postcode?: string;
  deliveryAddress?: string;
  customerAllergies?: string;
  allergyConfirmed?: boolean;
  customerPhone?: string;
  customerName?: string;
  customerId?: string;
  specialName?: string;
  notes?: string;
  paymentStatus?: string;
  total?: number;
  channel?: string;
  source?: string;
  sourceCallId?: string;
  callIds?: string[];
  orgId?: string;
  /** When set, used for CRM phone fallback (phone agent). */
  callerPhone?: string;
}

export type PlaceFoodOrderResult =
  | {
      ok: true;
      orderId: string;
      orderNumber: string | number | undefined;
      total: number;
      spokenTotal: string;
      specialName: string | null;
      deliveryAddress: string | null;
      deliveryPostcode: string | null;
      customerId: string | null;
      syncState: string;
      spokenHint: string;
      order: Record<string, unknown>;
      posPush?: { attempted: boolean; ok?: boolean; error?: string };
    }
  | {
      ok: false;
      error: string;
      spokenHint: string;
      postcode?: string;
      allergenWarnings?: string[];
    };

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolvePosPushMode(config: ConnectorConfig | null | undefined): PosPushMode {
  const raw = (config as ConnectorConfig & { posPush?: string } | null | undefined)?.posPush;
  if (raw === 'on_place' || raw === 'off' || raw === 'manual_only') return raw;
  return 'manual_only';
}

function buildSpokenHint(opts: {
  orderNumber: string | number | undefined;
  spokenTotal: string;
  orderType: string;
  deliveryAddress?: string;
  specialSpeak: string;
  syncState: string;
  posMode: PosPushMode;
  posOk?: boolean;
}): string {
  const where =
    opts.orderType === 'delivery' && opts.deliveryAddress
      ? ` Delivery to ${opts.deliveryAddress}.`
      : opts.orderType === 'collection'
        ? ' Collection.'
        : '';
  const base = `Order ${opts.orderNumber} is on the kitchen board ù ${opts.spokenTotal}.${where}${opts.specialSpeak}`;
  if (opts.posMode === 'on_place') {
    if (opts.posOk) return `${base} POS synced.`;
    if (opts.syncState === 'error' || opts.syncState === 'pending_out') {
      return `${base} POS pending or failed ù staff can retry from the board.`;
    }
  }
  return base;
}

/**
 * Validate, price, persist a food order. Optional POS push when pos_push === on_place.
 */
export async function placeFoodOrder(input: PlaceFoodOrderInput): Promise<PlaceFoodOrderResult> {
  const orgId = firstString(input.orgId) ?? getRequestOrgId();
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length) {
    return { ok: false, error: 'items_required', spokenHint: 'Tell me what you would like to order first.' };
  }

  const orderType = firstString(input.orderType) ?? 'collection';
  const postcode = firstString(input.postcode);
  const streetAddress = firstString(input.deliveryAddress);

  if (orderType === 'delivery') {
    if (!postcode && !streetAddress) {
      return {
        ok: false,
        error: 'delivery_address_required',
        spokenHint: 'For delivery I need the street address and postcode first.',
      };
    }
    if (!postcode) {
      return {
        ok: false,
        error: 'postcode_required',
        spokenHint: 'I just need the postcode so I can check we deliver there.',
      };
    }
    const { matchDeliveryPostcode, normalizeDeliveryPrefixes } = await import('./delivery-areas');
    const prefixes = normalizeDeliveryPrefixes(getDataStore().agentSettings?.deliveryPostcodePrefixes);
    if (!prefixes.length) {
      return {
        ok: false,
        error: 'delivery_areas_not_configured',
        spokenHint: 'Delivery areas are not set up yet ù shall I make this collection instead?',
      };
    }
    const match = matchDeliveryPostcode(postcode, prefixes);
    if (!match.ok) {
      return {
        ok: false,
        error: 'out_of_delivery_area',
        postcode: match.normalized || postcode,
        spokenHint: 'We do not stretch that far for delivery yet ù collection instead, or a different postcode?',
      };
    }
  }

  let catalog: Awaited<ReturnType<typeof listMenuItemsForOrg>> = [];
  try {
    catalog = await listMenuItemsForOrg(orgId);
  } catch {
    catalog = [];
  }

  const rawLines: OrderLineInput[] = rawItems.map((row) => {
    const r = row as Record<string, unknown>;
    const dealChoices = Array.isArray(r.dealChoices)
      ? (r.dealChoices as Array<Record<string, unknown>>).map((unit) => {
          const mapped: Record<string, string> = {};
          for (const [k, v] of Object.entries(unit ?? {})) {
            if (v != null && String(v).trim()) mapped[String(k).toLowerCase()] = String(v).trim();
          }
          return mapped;
        })
      : undefined;
    return {
      name: String(r.name ?? '').trim(),
      qty: Number(r.qty ?? 1) || 1,
      price: r.price != null ? Number(r.price) : undefined,
      dealChoices,
      dealName: r.dealName != null ? String(r.dealName) : undefined,
      role: r.role != null ? String(r.role) : undefined,
      dealIndex: r.dealIndex != null ? Number(r.dealIndex) : undefined,
    };
  });

  // Hard catalog gates (Wave 3): unknown / unavailable (filtered from list) rejected; catalog price wins.
  for (const line of rawLines) {
    if (!line.name) {
      return {
        ok: false,
        error: 'item_name_required',
        spokenHint: 'I need the dish name for each line.',
      };
    }
    const match = catalog.find((c) => c.name.toLowerCase() === line.name.toLowerCase());
    if (!match) {
      return {
        ok: false,
        error: 'unknown_item',
        spokenHint: `I do not have ${line.name} on the menu ù pick something we offer.`,
      };
    }
    line.price = match.price;
  }

  const expanded = expandMealDealOrderItems(rawLines, catalog);
  if (!expanded.ok) {
    return {
      ok: false,
      error: expanded.error,
      spokenHint: expanded.spokenHint,
    };
  }

  const customerAllergies = firstString(input.customerAllergies) ?? '';
  const allergyConfirmed = input.allergyConfirmed === true;
  if (!allergyConfirmed) {
    return {
      ok: false,
      error: 'allergy_check_required',
      spokenHint: 'Before I place that ù any allergies or intolerances we should know about?',
    };
  }

  const allergenWarnings: string[] = [];
  for (const line of expanded.items) {
    const match = catalog.find((c) => c.name.toLowerCase() === String(line.name).toLowerCase());
    if (!match) continue;
    const safety = allergenSafetyHint(match);
    if (safety) allergenWarnings.push(safety);
    if (customerAllergies) {
      const conflicts = customerAllergenConflict(customerAllergies, match.allergensContains ?? []);
      if (conflicts.length) {
        allergenWarnings.push(
          `${match.name} contains ${conflicts.join(', ')} which matches the caller allergies ù suggest alternatives or kitchen check.`,
        );
      }
    }
  }
  if (allergenWarnings.length) {
    return {
      ok: false,
      error: 'allergen_review_required',
      allergenWarnings,
      spokenHint: allergenWarnings[0],
    };
  }

  let pricedTotal = 0;
  for (const line of rawLines) {
    if (!line.name) continue;
    const qty = Math.max(1, Number(line.qty ?? 1) || 1);
    const match = catalog.find((c) => c.name.toLowerCase() === line.name.toLowerCase());
    if (match?.deal) {
      pricedTotal += match.price * qty;
    } else {
      const unit = Number(line.price ?? match?.price ?? 0);
      pricedTotal += (Number.isFinite(unit) ? unit : 0) * qty;
    }
  }
  pricedTotal = Math.round(pricedTotal * 100) / 100;

  const items = expanded.items.map((row) => {
    const price = Number(row.price ?? 0);
    const filled =
      (!Number.isFinite(price) || price < 0) && row.name
        ? catalog.find((c) => c.name.toLowerCase() === row.name.toLowerCase())?.price
        : price;
    return {
      name: row.name,
      qty: Math.max(1, Number(row.qty ?? 1) || 1),
      price: Number.isFinite(Number(filled)) ? Number(filled) : 0,
      ...(row.dealName ? { dealName: row.dealName } : {}),
      ...(row.dealIndex != null ? { dealIndex: row.dealIndex } : {}),
      ...(row.role ? { role: row.role } : {}),
    };
  });

  // Catalog/deal pricing wins ó never trust client/AI total for money.
  const totalBeforeSpecial = pricedTotal;

  const phone = firstString(input.customerPhone, input.callerPhone) ?? '';
  let customerId = firstString(input.customerId);
  if (!customerId && phone) {
    const found = lookupContactByPhone(phone);
    if (found.found && found.customerId) customerId = found.customerId;
  }

  const store = getDataStore();
  const customerRow = customerId
    ? store.customers.find((c) => String(c.id) === customerId)
    : undefined;
  const crmSpecialName = customerRow?.specialName != null ? String(customerRow.specialName).trim() : '';
  const crmSpecialNote = customerRow?.specialDealNote != null ? String(customerRow.specialDealNote).trim() : '';
  const appliedSpecialName = firstString(input.specialName) || undefined;
  let total = totalBeforeSpecial;
  let specialAppliedNote = '';
  if (appliedSpecialName && crmSpecialNote) {
    const pctMatch = crmSpecialNote.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) {
      const pct = Math.min(100, Math.max(0, Number(pctMatch[1])));
      if (Number.isFinite(pct) && pct > 0) {
        total = Math.round(totalBeforeSpecial * (1 - pct / 100) * 100) / 100;
        specialAppliedNote = `${appliedSpecialName}: ${pct}% off (${formatSpokenGbp(totalBeforeSpecial)} ? ${formatSpokenGbp(total)})`;
      }
    }
    if (!specialAppliedNote) {
      specialAppliedNote = `${appliedSpecialName}: ${crmSpecialNote}`;
    }
  } else if (appliedSpecialName && crmSpecialName) {
    specialAppliedNote = `Special: ${appliedSpecialName}${crmSpecialNote ? ` ù ${crmSpecialNote}` : ''}`;
  }

  const { formatUkPostcodeDisplay, normalizeUkPostcode } = await import('./delivery-areas');
  const normalizedPostcode = postcode ? formatUkPostcodeDisplay(postcode) : '';
  const compactPc = postcode ? normalizeUkPostcode(postcode) : '';
  let deliveryAddress = streetAddress || undefined;
  if (orderType === 'delivery' && normalizedPostcode) {
    if (deliveryAddress) {
      const upper = deliveryAddress.toUpperCase().replace(/\s+/g, '');
      if (!upper.includes(compactPc)) {
        deliveryAddress = `${deliveryAddress.replace(/,\s*$/, '')}, ${normalizedPostcode}`;
      }
    } else {
      deliveryAddress = normalizedPostcode;
    }
  }

  const baseNotes = firstString(input.notes) ?? '';
  const notes = [baseNotes, specialAppliedNote].filter(Boolean).join(' | ');

  const payRaw = (firstString(input.paymentStatus) ?? 'unpaid').toLowerCase();
  let paymentStatus = 'unpaid';
  let paymentMethod: string | undefined;
  if (payRaw === 'cash' || payRaw === 'card') {
    paymentStatus = 'unpaid';
    paymentMethod = payRaw;
  } else if (payRaw === 'paid') {
    paymentStatus = 'paid';
  }

  const channel = firstString(input.channel) ?? 'phone';
  const source = firstString(input.source) ?? channel;
  const callId = firstString(input.sourceCallId);

  let record = await saveOrderRecord(
    {
      customerId: customerId || undefined,
      customerName: firstString(input.customerName) ?? 'Guest',
      customerPhone: phone,
      channel,
      orderType,
      status: 'new',
      paymentStatus,
      paymentMethod,
      items,
      total,
      deliveryAddress,
      deliveryPostcode: normalizedPostcode || undefined,
      specialName: appliedSpecialName,
      notes,
      customerAllergies,
      allergyConfirmed,
      sourceCallId: callId,
      callIds: input.callIds ?? (callId ? [callId] : []),
      source,
      syncState: 'local',
      placedAt: new Date().toISOString(),
      etaMinutes: orderType === 'delivery' ? 40 : 20,
    },
    orgId,
  );

  const config = await getConnectorConfig(orgId);
  const posMode = resolvePosPushMode(config);
  let posPush: { attempted: boolean; ok?: boolean; error?: string } | undefined;

  if (posMode === 'on_place' && isPosOutboundEnabled(config)) {
    const forwarded = await forwardOrderIfPosEnabled(orgId, record as Record<string, unknown>, config);
    record = (forwarded.order as typeof record) ?? record;
    posPush = {
      attempted: true,
      ok: forwarded.push?.ok === true,
      error: forwarded.push?.ok ? undefined : forwarded.push?.error,
    };
  } else if (posMode === 'off') {
    posPush = { attempted: false };
  }

  const rec = record as Record<string, unknown>;
  const syncState = String(rec.syncState ?? 'local');
  const spokenTotal = formatSpokenGbp(Number(rec.total));
  const specialSpeak = specialAppliedNote ? ` Special applied: ${appliedSpecialName}.` : '';
  const orderNumber =
    typeof rec.orderNumber === 'string' || typeof rec.orderNumber === 'number'
      ? rec.orderNumber
      : undefined;
  const resolvedDeliveryAddress =
    typeof rec.deliveryAddress === 'string'
      ? rec.deliveryAddress
      : deliveryAddress;
  const spokenHint = buildSpokenHint({
    orderNumber,
    spokenTotal,
    orderType,
    deliveryAddress: resolvedDeliveryAddress,
    specialSpeak,
    syncState,
    posMode,
    posOk: posPush?.ok,
  });

  return {
    ok: true,
    orderId: String(rec.id),
    orderNumber,
    total: Number(rec.total),
    spokenTotal,
    specialName: appliedSpecialName ?? null,
    deliveryAddress: resolvedDeliveryAddress ?? null,
    deliveryPostcode: normalizedPostcode || null,
    customerId: (typeof rec.customerId === 'string' ? rec.customerId : null) ?? customerId ?? null,
    syncState,
    spokenHint,
    order: rec,
    posPush,
  };
}
