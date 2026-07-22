import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePosPushMode } from './order-service';
import type { ConnectorConfig } from './connectors/types';

const base = {
  orgId: 'o1',
  provider: 'square',
  enabled: true,
  direction: 'both',
  outboundUrl: '',
  webhookSecret: '',
  statusMap: {},
} as ConnectorConfig;

describe('resolvePosPushMode', () => {
  it('defaults to manual_only', () => {
    assert.equal(resolvePosPushMode(null), 'manual_only');
    assert.equal(resolvePosPushMode(undefined), 'manual_only');
  });

  it('normalizes automatic/disabled and legacy on_place/off', () => {
    assert.equal(resolvePosPushMode({ ...base, posPush: 'automatic' }), 'automatic');
    assert.equal(resolvePosPushMode({ ...base, posPush: 'on_place' }), 'automatic');
    assert.equal(resolvePosPushMode({ ...base, posPush: 'disabled' }), 'disabled');
    assert.equal(resolvePosPushMode({ ...base, posPush: 'off' }), 'disabled');
    assert.equal(resolvePosPushMode({ ...base, posPush: 'manual_only' }), 'manual_only');
  });
});
