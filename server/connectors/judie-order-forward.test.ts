import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const updateOrderRecord = mock.fn(async (_id: string, patch: Record<string, unknown>, _org?: string) => ({
  id: _id,
  ...patch,
}));
const saveConnectorConfig = mock.fn(async () => ({}));
const logConnectorEvent = mock.fn(async () => undefined);
const getConnectorConfig = mock.fn(async () => null as unknown);
const forwardOrderIfPosEnabled = mock.fn(async (_org: string, order: Record<string, unknown>) => ({
  order: { ...order, syncState: 'synced', externalId: 'sq-1' },
  push: { ok: true, externalId: 'sq-1' },
}));
const isPosOutboundEnabled = mock.fn((_cfg: unknown) => false);
const forwardOrderToCommerceHub = mock.fn(async () => ({ ok: true, status: 200 }));

mock.module('../data-store.ts', {
  namedExports: { updateOrderRecord },
});
mock.module('./config-store.ts', {
  namedExports: { getConnectorConfig, saveConnectorConfig },
});
mock.module('./event-log.ts', {
  namedExports: { logConnectorEvent },
});
mock.module('./pos-outbound.ts', {
  namedExports: { forwardOrderIfPosEnabled, isPosOutboundEnabled },
});
mock.module('./commerce-outbound.ts', {
  namedExports: { forwardOrderToCommerceHub },
});

const { forwardJudieOrderToProviders, isCommerceOutboundEnabled } = await import('./judie-order-forward.ts');

describe('isCommerceOutboundEnabled', () => {
  it('requires enabled outbound commerce provider with url+secret', () => {
    assert.equal(
      isCommerceOutboundEnabled({
        orgId: 'o',
        provider: 'custom',
        enabled: true,
        direction: 'both',
        outboundUrl: 'https://partner.example/hook',
        webhookSecret: 'sec',
        statusMap: {},
      }),
      true,
    );
    assert.equal(
      isCommerceOutboundEnabled({
        orgId: 'o',
        provider: 'square',
        enabled: true,
        direction: 'both',
        outboundUrl: 'https://x',
        webhookSecret: 'sec',
        statusMap: {},
      }),
      false,
    );
  });
});

describe('forwardJudieOrderToProviders', () => {
  beforeEach(() => {
    updateOrderRecord.mock.resetCalls();
    forwardOrderIfPosEnabled.mock.resetCalls();
    forwardOrderToCommerceHub.mock.resetCalls();
    isPosOutboundEnabled.mock.resetCalls();
    getConnectorConfig.mock.resetCalls();
  });

  it('no-ops when connectors disabled', async () => {
    getConnectorConfig.mock.mockImplementation(async () => ({
      orgId: 'o',
      provider: 'square',
      enabled: false,
      direction: 'outbound',
      outboundUrl: '',
      webhookSecret: '',
      statusMap: {},
    }));
    isPosOutboundEnabled.mock.mockImplementation(() => false);
    const result = await forwardJudieOrderToProviders('o', { id: 'ord-1', syncState: 'local' });
    assert.equal(result.channel, 'none');
    assert.equal(result.ok, true);
    assert.equal(forwardOrderIfPosEnabled.mock.calls.length, 0);
  });

  it('uses POS path when Square outbound enabled', async () => {
    const cfg = {
      orgId: 'o',
      provider: 'square' as const,
      enabled: true,
      direction: 'both' as const,
      outboundUrl: '',
      webhookSecret: '',
      statusMap: {},
    };
    isPosOutboundEnabled.mock.mockImplementation(() => true);
    const result = await forwardJudieOrderToProviders('o', { id: 'ord-2', syncState: 'local' }, cfg);
    assert.equal(result.channel, 'pos');
    assert.equal(result.ok, true);
    assert.equal(result.externalId, 'sq-1');
    assert.equal(forwardOrderIfPosEnabled.mock.calls.length, 1);
  });

  it('uses commerce hub for custom outbound partners', async () => {
    const cfg = {
      orgId: 'o',
      provider: 'custom' as const,
      enabled: true,
      direction: 'outbound' as const,
      outboundUrl: 'https://partner.example/hook',
      webhookSecret: 'sec',
      statusMap: {},
    };
    isPosOutboundEnabled.mock.mockImplementation(() => false);
    const result = await forwardJudieOrderToProviders('o', { id: 'ord-3', syncState: 'local', total: 10 }, cfg);
    assert.equal(result.channel, 'commerce');
    assert.equal(result.ok, true);
    assert.equal(forwardOrderToCommerceHub.mock.calls.length, 1);
    assert.ok(updateOrderRecord.mock.calls.some((c) => (c.arguments[1] as { syncState?: string }).syncState === 'synced'));
  });
});
