/**
 * After Judie placeFoodOrder: push to connected POS / commerce partner when
 * the organisation's posPush policy is automatic (on_place).
 * Never auto-forwards for manual_only / disabled orgs.
 */
import { resolvePosPushMode, type ConnectorConfig, type PosPushMode } from './types';
import { getConnectorConfig } from './config-store';
import { forwardOrderIfPosEnabled, isPosOutboundEnabled } from './pos-outbound';
import { forwardOrderToCommerceHub } from './commerce-outbound';
import { updateOrderRecord } from '../data-store';
import { logConnectorEvent } from './event-log';
import { saveConnectorConfig } from './config-store';

const COMMERCE_PROVIDERS = new Set(['mock', 'deliverect', 'otter', 'custom']);

export function isCommerceOutboundEnabled(config: ConnectorConfig | null | undefined): boolean {
  if (!config?.enabled) return false;
  if (config.direction !== 'outbound' && config.direction !== 'both') return false;
  if (!COMMERCE_PROVIDERS.has(config.provider)) return false;
  return Boolean(config.outboundUrl?.trim() && config.webhookSecret?.trim());
}

export type JudieForwardResult = {
  order: Record<string, unknown>;
  channel: 'none' | 'pos' | 'commerce';
  ok: boolean;
  error?: string;
  externalId?: string;
  mode: PosPushMode;
};

/**
 * Prefer Square/Epos POS push; otherwise commerce hub (Deliverect/Otter/custom webhook).
 * Only runs when resolvePosPushMode === 'automatic'.
 */
export async function forwardJudieOrderToProviders(
  orgId: string,
  order: Record<string, unknown>,
  configHint?: ConnectorConfig | null,
): Promise<JudieForwardResult> {
  const config = configHint === undefined ? await getConnectorConfig(orgId) : configHint;
  const mode = resolvePosPushMode(config);
  if (mode !== 'automatic') {
    return { order, channel: 'none', ok: true, mode };
  }
  if (!config?.enabled) {
    return { order, channel: 'none', ok: true, mode };
  }

  if (isPosOutboundEnabled(config)) {
    const { order: next, push } = await forwardOrderIfPosEnabled(orgId, order, config);
    return {
      order: next,
      channel: 'pos',
      ok: push?.ok !== false,
      error: push?.ok === false ? push.error : undefined,
      externalId: push?.externalId ?? (next.externalId != null ? String(next.externalId) : undefined),
      mode,
    };
  }

  if (isCommerceOutboundEnabled(config)) {
    const orderId = String(order.id ?? '');
    let current = order;
    if (orderId) {
      const pending = await updateOrderRecord(orderId, { syncState: 'pending_out' }, orgId);
      if (pending) current = pending;
    }
    const push = await forwardOrderToCommerceHub(orgId, current, {
      outboundUrl: config.outboundUrl,
      secret: config.webhookSecret,
      accountId: config.deliverectAccountId,
      locationId: config.deliverectLocationId,
    });
    const now = new Date().toISOString();
    if (push.ok) {
      const synced = orderId
        ? await updateOrderRecord(orderId, {
            syncState: 'synced',
            providerMeta: {
              ...((current.providerMeta && typeof current.providerMeta === 'object')
                ? current.providerMeta as Record<string, unknown>
                : {}),
              commerceProvider: config.provider,
              commerceForwardedAt: now,
            },
          }, orgId)
        : null;
      await saveConnectorConfig(orgId, { lastOutboundAt: now, lastError: '' });
      await logConnectorEvent({
        orgId,
        provider: config.provider,
        direction: 'outbound',
        eventType: 'order.created',
        status: 'ok',
        payload: { orderId, channel: 'commerce' },
      });
      return { order: synced ?? current, channel: 'commerce', ok: true, mode };
    }
    const err = push.error || 'commerce_forward_failed';
    const failed = orderId
      ? await updateOrderRecord(orderId, {
          syncState: 'error',
          providerMeta: {
            ...((current.providerMeta && typeof current.providerMeta === 'object')
              ? current.providerMeta as Record<string, unknown>
              : {}),
            lastPushError: err,
            commerceProvider: config.provider,
          },
        }, orgId)
      : null;
    await saveConnectorConfig(orgId, { lastOutboundAt: now, lastError: err });
    await logConnectorEvent({
      orgId,
      provider: config.provider,
      direction: 'outbound',
      eventType: 'order.created',
      status: 'error',
      payload: { orderId, channel: 'commerce' },
      error: err,
    });
    return { order: failed ?? current, channel: 'commerce', ok: false, error: err, mode };
  }

  return { order, channel: 'none', ok: true, mode };
}
