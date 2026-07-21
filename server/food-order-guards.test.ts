import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUkPostcode,
  isPlausibleUkStreetAddress,
  isValidUkPostcode,
} from './delivery-areas';
import {
  mergeDeliveryAddressLine,
  resolveSavedDeliveryAddressFromRecords,
  validateCatalogOrderItems,
  validateDeliveryAddressForOrder,
  validateDeliveryPaymentPreference,
} from './food-order-guards';
import { findClosestCatalogNames, type MenuItem } from './menu-catalog';

const sampleMenu: MenuItem[] = [
  {
    id: '1',
    name: 'Chicken Tikka',
    category: 'mains',
    price: 9.5,
    allergensContains: [],
    allergensMayContain: [],
  },
  {
    id: '2',
    name: 'Garlic Naan',
    category: 'sides',
    price: 3,
    allergensContains: [],
    allergensMayContain: [],
  },
  {
    id: '3',
    name: 'Mango Lassi',
    category: 'drinks',
    price: 2.5,
    allergensContains: [],
    allergensMayContain: [],
  },
];

describe('UK address helpers', () => {
  it('accepts full UK postcodes', () => {
    assert.equal(isValidUkPostcode('SW1A 1AA'), true);
    assert.equal(isValidUkPostcode('b11 1aa'), true);
    assert.equal(isValidUkPostcode('B1'), false);
    assert.equal(isValidUkPostcode('near the station'), false);
  });

  it('requires house number and street for delivery lines', () => {
    assert.equal(isPlausibleUkStreetAddress('14 High Street'), true);
    assert.equal(isPlausibleUkStreetAddress('Flat 2, 14 Acacia Avenue'), true);
    assert.equal(isPlausibleUkStreetAddress('SW1A 1AA'), false);
    assert.equal(isPlausibleUkStreetAddress('near the station'), false);
    assert.equal(isPlausibleUkStreetAddress('High Street'), false);
  });

  it('extracts postcode from a full address line', () => {
    assert.equal(extractUkPostcode('14 High Street, SW1A 1AA'), 'SW1A 1AA');
  });
});

describe('delivery address gate', () => {
  it('requires street + full postcode for new delivery addresses', () => {
    const fail = validateDeliveryAddressForOrder({
      streetAddress: 'SW1A 1AA',
      postcode: 'SW1A 1AA',
    });
    assert.equal(fail.ok, false);
    if (!fail.ok) assert.equal(fail.error, 'street_address_required');

    const ok = validateDeliveryAddressForOrder({
      streetAddress: '14 High Street',
      postcode: 'SW1A 1AA',
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.streetAddress, '14 High Street');
      assert.equal(ok.postcode, 'SW1A 1AA');
    }
  });

  it('allows confirming a saved address', () => {
    const ok = validateDeliveryAddressForOrder({
      useSavedAddress: true,
      saved: {
        address: '14 High Street, SW1A 1AA',
        postcode: 'SW1A 1AA',
        source: 'customer',
      },
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.usedSaved, true);
      assert.match(ok.streetAddress, /14 High Street/);
    }
  });

  it('resolves saved address from prior delivery orders', () => {
    const saved = resolveSavedDeliveryAddressFromRecords({
      customerAddress: '',
      orders: [
        {
          orderType: 'delivery',
          deliveryAddress: '9 Oak Road, B11 1AA',
          deliveryPostcode: 'B11 1AA',
          placedAt: '2026-07-01T12:00:00.000Z',
        },
      ],
    });
    assert.ok(saved);
    assert.equal(saved?.source, 'order');
    assert.match(saved?.address ?? '', /Oak Road/);
  });
});

describe('payment preference', () => {
  it('requires cash or card for delivery preference', () => {
    const miss = validateDeliveryPaymentPreference('unpaid');
    assert.equal(miss.ok, false);
    if (!miss.ok) assert.equal(miss.error, 'payment_preference_required');

    const cash = validateDeliveryPaymentPreference('cash');
    assert.equal(cash.ok, true);
    if (cash.ok) assert.equal(cash.paymentMethod, 'cash');

    const card = validateDeliveryPaymentPreference('card');
    assert.equal(card.ok, true);
    if (card.ok) assert.equal(card.paymentMethod, 'card');
  });
});

describe('catalog hard reject', () => {
  it('rejects empty catalog', () => {
    const result = validateCatalogOrderItems(['Chicken Tikka'], []);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'menu_unavailable');
  });

  it('rejects unknown items with closest suggestions', () => {
    const result = validateCatalogOrderItems(['Chicken Tika'], sampleMenu);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'unknown_menu_item');
      assert.ok((result.suggestions ?? []).some((s) => /Chicken Tikka/i.test(s)));
    }
  });

  it('accepts exact catalog names', () => {
    const result = validateCatalogOrderItems(['Chicken Tikka', 'Garlic Naan'], sampleMenu);
    assert.equal(result.ok, true);
  });

  it('finds closest catalog names', () => {
    const closest = findClosestCatalogNames(sampleMenu, 'garlic bread', 2);
    assert.ok(closest.includes('Garlic Naan'));
  });
});

describe('address merge', () => {
  it('appends postcode when missing from street line', () => {
    assert.equal(
      mergeDeliveryAddressLine('14 High Street', 'SW1A 1AA'),
      '14 High Street, SW1A 1AA',
    );
  });
});
