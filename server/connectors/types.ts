export type ConnectorProvider = 'mock' | 'deliverect' | 'otter' | 'custom' | 'square' | 'epos_now';
export type ConnectorDirection = 'inbound' | 'outbound' | 'both';
export type OrderSource = 'phone' | 'kiosk' | 'whatsapp' | 'sync2dine' | 'deliverect' | 'otter' | 'custom' | 'square';
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
  /** Square location selected in Settings */
  squareLocationId?: string;
  squareMerchantId?: string;
  /** Server-only OAuth / PAT — never return raw to FE */
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: string;
  defaultPickupName?: string;
  defaultPickupPhone?: string;
  fulfillmentAddressLine1?: string;
  fulfillmentAddressCity?: string;
  fulfillmentAddressPostcode?: string;
  fulfillmentAddressCountry?: string;
  lastTestPushAt?: string;
  lastTestPushOk?: boolean;
  lastMenuSyncAt?: string;
  menuVersion?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
  updatedAt?: string;
  /**
   * When to push to Square/POS after place:
   * - manual_only (default): staff retry / push API only
   * - on_place: forwardOrderIfPosEnabled after OrderService.place
   * - off: never auto-push
   */
  posPush?: 'manual_only' | 'on_place' | 'off';
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
