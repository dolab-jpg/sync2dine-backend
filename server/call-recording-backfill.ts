/**
 * On call finalization, attach recordingUrl to matching orders and reservations.
 */
import { getDataStore, syncData, updateOrderRecord } from './data-store';
import {
  backfillOrderRecordingInSupabase,
  isSupabaseOrdersConfigured,
} from './supabase-orders';
import {
  backfillReservationRecording,
  isReservationsConfigured,
} from './reservations-store';

export async function backfillCallRecordingOnFinalize(
  callId: string,
  recordingUrl: string | undefined | null,
  orgIdHint?: string | null,
): Promise<{ orders: number; reservations: number }> {
  const url = String(recordingUrl ?? '').trim();
  if (!callId?.trim() || !url) return { orders: 0, reservations: 0 };

  let ordersUpdated = 0;
  let reservationsUpdated = 0;

  if (isSupabaseOrdersConfigured()) {
    const result = await backfillOrderRecordingInSupabase(callId, url, orgIdHint);
    ordersUpdated = result.updated;
  }

  const store = getDataStore();
  if (Array.isArray(store.orders)) {
    for (const order of store.orders) {
      const sourceCall = String(order.sourceCallId ?? order.source_call_id ?? '');
      const callIds = Array.isArray(order.callIds) ? order.callIds.map(String) : [];
      const matches = sourceCall === callId || callIds.includes(callId);
      if (!matches) continue;
      const nextCallIds = [...new Set([...callIds, callId])];
      const patch = {
        recordingUrl: url,
        callIds: nextCallIds,
        sourceCallId: sourceCall || callId,
      };
      await updateOrderRecord(String(order.id), patch, orgIdHint ?? (order.orgId as string | undefined));
      ordersUpdated += 1;
    }
  }

  if (isReservationsConfigured()) {
    reservationsUpdated = await backfillReservationRecording(callId, url, orgIdHint);
  }

  syncData(getDataStore());
  return { orders: ordersUpdated, reservations: reservationsUpdated };
}
