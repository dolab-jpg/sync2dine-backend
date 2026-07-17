import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload, verifySignature } from './connectors/hmac';
import { mapInboundStatus, mapOutboundStatus } from './connectors/status-map';
import { parseGenericInboundOrder, inboundOrderToSavePayload } from './connectors/inbound-orders';

describe('connector HMAC', () => {
  it('signs and verifies payloads', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = signPayload('test-secret', body);
    assert.ok(verifySignature('test-secret', body, sig));
    assert.equal(verifySignature('wrong', body, sig), false);
  });
});

describe('status mapping', () => {
  it('maps kitchen statuses for partners', () => {
    assert.equal(mapOutboundStatus('coming'), 'Preparing');
    assert.equal(mapOutboundStatus('ready'), 'Pickup ready');
    assert.equal(mapInboundStatus('pickup_ready'), 'ready');
  });
});

describe('inbound order parsing', () => {
  it('parses rich mock order payload', () => {
    const parsed = parseGenericInboundOrder({
      externalId: 'mock-123',
      customerName: 'Alex',
      customerPhone: '+447700900111',
      orderType: 'delivery',
      items: [{ name: 'Chicken biryani', qty: 2, price: 9.5 }],
      customerAllergies: 'peanuts',
      allergyConfirmed: true,
      postcode: 'SW1A 1AA',
    });
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    const save = inboundOrderToSavePayload(parsed, 'mock');
    assert.equal(save.externalId, 'mock-123');
    assert.equal(save.customerAllergies, 'peanuts');
    assert.equal(save.allergyConfirmed, true);
  });

  it('rejects missing externalId', () => {
    const parsed = parseGenericInboundOrder({ items: [{ name: 'Chips' }] });
    assert.ok('error' in parsed);
  });
});
