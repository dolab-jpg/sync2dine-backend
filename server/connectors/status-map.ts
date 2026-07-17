/** Map Sync2Dine kitchen statuses ↔ partner statuses (integration-ready, not certified). */
const DEFAULT_OUTBOUND_MAP: Record<string, string> = {
  new: 'Accepted',
  coming: 'Preparing',
  cooking: 'Preparing',
  preparing: 'Preparing',
  ready: 'Pickup ready',
  delivery: 'In Delivery',
  completed: 'Delivered',
  cancelled: 'Cancelled',
};

const DEFAULT_INBOUND_MAP: Record<string, string> = {
  accepted: 'new',
  new_order: 'new',
  preparing: 'coming',
  cooking: 'coming',
  prepared: 'ready',
  pickup_ready: 'ready',
  ready: 'ready',
  in_delivery: 'delivery',
  delivered: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

export function mapInboundStatus(providerStatus: string, customMap?: Record<string, string>): string {
  const key = providerStatus.trim().toLowerCase().replace(/\s+/g, '_');
  if (customMap?.[key]) return customMap[key];
  if (customMap?.[providerStatus]) return customMap[providerStatus];
  return DEFAULT_INBOUND_MAP[key] ?? 'new';
}

export function mapOutboundStatus(sync2dineStatus: string, customMap?: Record<string, string>): string {
  const key = sync2dineStatus.trim().toLowerCase();
  if (customMap?.[key]) return customMap[key];
  return DEFAULT_OUTBOUND_MAP[key] ?? sync2dineStatus;
}

export function defaultStatusMap(): Record<string, string> {
  return { ...DEFAULT_OUTBOUND_MAP };
}
