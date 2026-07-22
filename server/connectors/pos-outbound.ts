/**
 * Shared POS outbound dispatcher. Square is live; epos_now is a stub for the next plugin.
 */
import { updateOrderRecord } from '../data-store';
import type { ConnectorConfig } from './types';
import { pushOrderToSquare, type PosPushResult } from './square-outbound';
import { logConnectorEvent } from './event-log';
import { saveConnectorConfig } from './config-store';
import { enqueuePosPushRetry } from './pos-push-helpers';

export type PosProvider = 'square' | 'epos_now';

export type { PosPushResult };

export function isPosOutboundEnabled(config: ConnectorConfig | null | undefined): boolean {
  if (!config?.enabled) return false;
  if (config.direction !== 'outbound' && config.direction !== 'both') return false;
  return config.provider === 'square' || config.provider === 'epos_now';
}

export async function pushOrderToPos(
  orgId: string,
  order: Record<string, unknown>,
  config: ConnectorConfig,
): Promise<PosPushResult> {
  if (!isPosOutboundEnabled(config)) {
    return { ok: false, error: 'pos_outbound_not_enabled' };
  }

  if (config.provider === 'square') {
    return pushOrderToSquare(orgId, order, config);
  }

  if (config.provider === 'epos_now') {
    return { ok: false, error: 'epos_now_not_implemented' };
  }

  return { ok: false, error: `unsupported_provider:${config.provider}` };
}

/**
 * After placeFoodOrder (or manual retry): pending_out → push → synced | error (+ queue).
 */
export async function forwardOrderIfPosEnabled(
  orgId: string,
  order: Record<string, unknown>,
  config: ConnectorConfig | null,
): Promise<{ order: Record<string, unknown>; push?: PosPushResult }> {
  // #region agent log
  // #endregion
  if (!isPosOutboundEnabled(config) || !config) {
    return { order };
  }

  const orderId = String(order.id ?? '');
  let current = order;
  if (orderId) {
    const pending = await updateOrderRecord(orderId, { syncState: 'pending_out' }, orgId);
    if (pending) current = pending;
  }

  const push = await pushOrderToPos(orgId, current, config);
  const now = new Date().toISOString();

  if (push.ok && push.externalId) {
    const synced = orderId
      ? await updateOrderRecord(orderId, {
          syncState: 'synced',
          externalId: push.externalId,
          providerMeta: {
            ...((current.providerMeta && typeof current.providerMeta === 'object')
              ? current.providerMeta as Record<string, unknown>
              : {}),
            squareOrderId: push.externalId,
            posProvider: config.provider,
          },
        }, orgId)
      : null;
    await saveConnectorConfig(orgId, { lastOutboundAt: now, lastError: '' });
    await logConnectorEvent({
      orgId,
      provider: config.provider,
      direction: 'outbound',
      eventType: 'order.created',
      externalId: push.externalId,
      status: 'ok',
      payload: { orderId, externalId: push.externalId },
    });
    return { order: synced ?? current, push };
  }

  const err = push.error || 'pos_push_failed';
  const failed = orderId
    ? await updateOrderRecord(orderId, {
        syncState: 'error',
        ...(push.externalId ? { externalId: push.externalId } : {}),
        providerMeta: {
          ...((current.providerMeta && typeof current.providerMeta === 'object')
            ? current.providerMeta as Record<string, unknown>
            : {}),
          lastPushError: err,
          posProvider: config.provider,
        },
      }, orgId)
    : null;
  await saveConnectorConfig(orgId, { lastOutboundAt: now, lastError: err });
  await logConnectorEvent({
    orgId,
    provider: config.provider,
    direction: 'outbound',
    eventType: 'order.created',
    externalId: push.externalId,
    status: 'error',
    payload: { orderId },
    error: err,
  });
  await enqueuePosPushRetry(orgId, config.provider, orderId, err);
  return { order: failed ?? current, push };
}
