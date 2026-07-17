import type { ConnectorWebhookEvent } from './types';
import { signPayload } from './hmac';
import { exportMenuForOrg } from '../menu-catalog';

/**
 * Deliverect Commerce API outbound skeleton (Direction B).
 * Posts a basket/checkout-shaped payload to a configured mock/partner URL.
 * Integration-ready terminology only — not live certification.
 */
export async function forwardOrderToCommerceHub(
  orgId: string,
  order: Record<string, unknown>,
  opts: {
    outboundUrl: string;
    secret: string;
    accountId?: string;
    locationId?: string;
  },
): Promise<{ ok: boolean; error?: string; status?: number }> {
  if (!opts.outboundUrl?.trim()) return { ok: false, error: 'outbound_url_missing' };
  const menu = await exportMenuForOrg(orgId);
  const items = Array.isArray(order.items) ? order.items as Array<Record<string, unknown>> : [];
  const payload = {
    channelOrderId: String(order.id ?? ''),
    channelOrderDisplayId: String(order.orderNumber ?? order.id ?? ''),
    orderType: order.orderType ?? 'collection',
    customer: {
      name: order.customerName ?? 'Guest',
      phoneNumber: order.customerPhone ?? '',
      allergyInfo: order.customerAllergies ?? '',
    },
    items: items.map((row) => ({
      plu: String(row.name ?? ''),
      name: String(row.name ?? ''),
      quantity: Number(row.qty ?? 1),
      price: Math.round(Number(row.price ?? 0) * 100),
    })),
    payment: {
      amount: Math.round(Number(order.total ?? 0) * 100),
      status: order.paymentStatus === 'paid' ? 'paid' : 'unpaid',
      method: order.paymentMethod ?? 'cash',
    },
    allergyConfirmed: order.allergyConfirmed === true,
    menuVersion: menu.version,
    account: opts.accountId ?? '',
    location: opts.locationId ?? '',
    providerMeta: { sync2dine: true, direction: 'outbound_commerce' },
  };
  const event: ConnectorWebhookEvent = {
    event: 'order.created',
    orgId,
    timestamp: new Date().toISOString(),
    data: payload,
  };
  const body = JSON.stringify(event);
  const signature = signPayload(opts.secret, body);
  try {
    const res = await fetch(opts.outboundUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-S2D-Signature': signature,
        'X-S2D-Adapter': 'commerce-outbound-skeleton',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 300) || res.statusText };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}
