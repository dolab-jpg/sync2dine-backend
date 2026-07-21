import { describe, it, expect } from 'vitest';
import { resolvePosPushMode } from './order-service';
import type { ConnectorConfig } from './connectors/types';

describe('resolvePosPushMode', () => {
  it('defaults to manual_only', () => {
    expect(resolvePosPushMode(null)).toBe('manual_only');
    expect(resolvePosPushMode(undefined)).toBe('manual_only');
  });

  it('reads config.posPush', () => {
    const base = {
      orgId: 'o1',
      provider: 'square',
      enabled: true,
      direction: 'both',
      outboundUrl: '',
      webhookSecret: '',
      statusMap: {},
    } as ConnectorConfig;
    expect(resolvePosPushMode({ ...base, posPush: 'on_place' })).toBe('on_place');
    expect(resolvePosPushMode({ ...base, posPush: 'off' })).toBe('off');
    expect(resolvePosPushMode({ ...base, posPush: 'manual_only' })).toBe('manual_only');
  });
});
