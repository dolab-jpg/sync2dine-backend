/**
 * Pure guards for Judie phone food orders — keep placeFoodOrder strict and testable.
 */
import {
  extractUkPostcode,
  formatUkPostcodeDisplay,
  isPlausibleUkStreetAddress,
  isValidUkPostcode,
  normalizeUkPostcode,
} from './delivery-areas';
import { findCatalogByName, findClosestCatalogNames, type MenuItem } from '../menu-catalog';

export type GuardFail = {
  ok: false;
  error: string;
  spokenHint: string;
  suggestions?: string[];
  item?: string;
};

export type SavedDeliveryAddress = {
  address: string;
  postcode: string;
  source: 'customer' | 'order';
};

export function resolveSavedDeliveryAddressFromRecords(input: {
  customerAddress?: string | null;
  orders?: Array<Record<string, unknown>>;
}): SavedDeliveryAddress | null {
  const customerAddress = String(input.customerAddress ?? '').trim();
  if (customerAddress && isPlausibleUkStreetAddress(customerAddress)) {
    const postcode =
      extractUkPostcode(customerAddress) ||
      (isValidUkPostcode(customerAddress) ? formatUkPostcodeDisplay(customerAddress) : '');
    return {
      address: customerAddress,
      postcode,
      source: 'customer',
    };
  }

  const orders = Array.isArray(input.orders) ? input.orders : [];
  const deliveryOrders = orders
    .filter((o) => String(o.orderType ?? '') === 'delivery')
    .filter((o) => String(o.deliveryAddress ?? '').trim())
    .sort((a, b) => {
      const at = Date.parse(String(a.placedAt ?? a.createdAt ?? a.updatedAt ?? 0));
      const bt = Date.parse(String(b.placedAt ?? b.createdAt ?? b.updatedAt ?? 0));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });

  for (const order of deliveryOrders) {
    const address = String(order.deliveryAddress ?? '').trim();
    if (!isPlausibleUkStreetAddress(address)) continue;
    const postcode =
      (order.deliveryPostcode != null ? formatUkPostcodeDisplay(String(order.deliveryPostcode)) : '') ||
      extractUkPostcode(address);
    return { address, postcode, source: 'order' };
  }
  return null;
}

export function validateDeliveryAddressForOrder(input: {
  streetAddress?: string | null;
  postcode?: string | null;
  useSavedAddress?: boolean;
  saved?: SavedDeliveryAddress | null;
}):
  | { ok: true; streetAddress: string; postcode: string; usedSaved: boolean }
  | GuardFail {
  const useSaved = input.useSavedAddress === true;
  if (useSaved) {
    if (!input.saved?.address || !isPlausibleUkStreetAddress(input.saved.address)) {
      return {
        ok: false,
        error: 'saved_address_unavailable',
        spokenHint:
          'I do not have a saved delivery address on file — can I take the house number, street, and postcode?',
      };
    }
    const postcode =
      (input.postcode && isValidUkPostcode(input.postcode)
        ? formatUkPostcodeDisplay(input.postcode)
        : '') ||
      input.saved.postcode ||
      extractUkPostcode(input.saved.address);
    if (!postcode || !isValidUkPostcode(postcode)) {
      return {
        ok: false,
        error: 'postcode_required',
        spokenHint: 'I just need the postcode so I can check we deliver there.',
      };
    }
    return {
      ok: true,
      streetAddress: input.saved.address,
      postcode: formatUkPostcodeDisplay(postcode),
      usedSaved: true,
    };
  }

  const streetAddress = String(input.streetAddress ?? '').trim();
  const postcodeRaw = String(input.postcode ?? '').trim() || extractUkPostcode(streetAddress);
  if (!streetAddress && !postcodeRaw) {
    return {
      ok: false,
      error: 'delivery_address_required',
      spokenHint: 'For delivery I need the house number, street, and postcode first.',
    };
  }
  if (!postcodeRaw || !isValidUkPostcode(postcodeRaw)) {
    return {
      ok: false,
      error: 'postcode_required',
      spokenHint: 'I just need a full postcode so I can check we deliver there.',
    };
  }
  if (!isPlausibleUkStreetAddress(streetAddress)) {
    return {
      ok: false,
      error: 'street_address_required',
      spokenHint:
        'I need the house number and street as well as the postcode — or say if you want the address we have saved.',
    };
  }
  return {
    ok: true,
    streetAddress,
    postcode: formatUkPostcodeDisplay(postcodeRaw),
    usedSaved: false,
  };
}

export function validateDeliveryPaymentPreference(
  paymentStatus: string | null | undefined,
): { ok: true; paymentMethod: 'cash' | 'card' } | GuardFail {
  const payRaw = String(paymentStatus ?? '').trim().toLowerCase();
  if (payRaw === 'cash' || payRaw === 'card') {
    return { ok: true, paymentMethod: payRaw };
  }
  return {
    ok: false,
    error: 'payment_preference_required',
    spokenHint: 'Will that be cash or card when the driver arrives?',
  };
}

export function validateCatalogOrderItems(
  itemNames: string[],
  catalog: MenuItem[],
): { ok: true } | GuardFail {
  if (!catalog.length) {
    return {
      ok: false,
      error: 'menu_unavailable',
      spokenHint:
        'The menu is not set up in the app yet — I can take a message or a callback, but I cannot place an order until dishes are added.',
    };
  }
  for (const rawName of itemNames) {
    const name = String(rawName ?? '').trim();
    if (!name) continue;
    if (findCatalogByName(catalog, name)) continue;
    const suggestions = findClosestCatalogNames(catalog, name, 3);
    const hint = suggestions.length
      ? `I do not have ${name} on the menu — closest I have is ${suggestions.join(', ')}. Want one of those, or shall I read the menu?`
      : `I do not have ${name} on the menu — shall I read what we do have?`;
    return {
      ok: false,
      error: 'unknown_menu_item',
      item: name,
      suggestions,
      spokenHint: hint,
    };
  }
  return { ok: true };
}

export function mergeDeliveryAddressLine(streetAddress: string, postcode: string): string {
  const normalizedPostcode = formatUkPostcodeDisplay(postcode);
  const compactPc = normalizeUkPostcode(postcode);
  const base = streetAddress.replace(/,\s*$/, '').trim();
  const upper = base.toUpperCase().replace(/\s+/g, '');
  if (compactPc && upper.includes(compactPc)) return base;
  return `${base}, ${normalizedPostcode}`;
}
