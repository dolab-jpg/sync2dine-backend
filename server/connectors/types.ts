export type ConnectorProvider = 'mock' | 'deliverect' | 'otter' | 'custom';
export type ConnectorDirection = 'inbound' | 'outbound' | 'both';
export type OrderSource = 'phone' | 'kiosk' | 'whatsapp' | 'sync2dine' | 'deliverect' | 'otter' | 'custom';
export type SyncState = 'local' | 'pending_out' | 'synced' | 'error';

export interface ConnectorConfig {
  orgId: string;
  provider: ConnectorProvider;
  enabled: boolean;
  direction: ConnectorDirection;
  outboundUrl: string;
  webhookSecret: string;
  statusMap: Record<string, string>;
  deliverectAccountId?: string;
  deliverectLocationId?: string;
  lastMenuSyncAt?: string;
  menuVersion?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
  updatedAt?: string;
}

export interface InboundConnectorOrder {
  externalId: string;
  customerName?: string;
  customerPhone?: string;
  orderType?: string;
  channel?: string;
  channelLabel?: string;
  items: Array<{ name: string; qty?: number; price?: number; notes?: string }>;
  total?: number;
  deliveryAddress?: string;
  postcode?: string;
  customerAllergies?: string;
  allergyConfirmed?: boolean;
  paymentStatus?: string;
  paymentMethod?: string;
  dueAt?: string;
  notes?: string;
  providerMeta?: Record<string, unknown>;
}

export interface ConnectorWebhookEvent {
  event: 'order.created' | 'order.updated' | 'menu.updated' | 'item.snoozed' | 'busy_mode.updated';
  orgId: string;
  timestamp: string;
  data: Record<string, unknown>;
}
