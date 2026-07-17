import type { InboundConnectorOrder } from './types';
import { mapInboundStatus } from './status-map';

/** Normalize generic / mock inbound order payload. */
export function parseGenericInboundOrder(body: Record<string, unknown>): InboundConnectorOrder | { error: string } {
  const externalId = String(body.externalId ?? body.external_id ?? body.id ?? '').trim();
  if (!externalId) return { error: 'externalId required' };
  const itemsRaw = Array.isArray(body.items) ? body.items : [];
  const items = itemsRaw.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      name: String(r.name ?? r.productName ?? '').trim(),
      qty: Math.max(1, Number(r.qty ?? r.quantity ?? 1) || 1),
      price: r.price != null ? Number(r.price) : undefined,
      notes: r.notes != null ? String(r.notes) : undefined,
    };
  }).filter((i) => i.name);
  if (!items.length) return { error: 'items required' };
  const customerObj = body.customer && typeof body.customer === 'object'
    ? body.customer as Record<string, unknown>
    : {};
  return {
    externalId,
    customerName: body.customerName != null ? String(body.customerName) : String(customerObj.name ?? 'Guest'),
    customerPhone: body.customerPhone != null ? String(body.customerPhone) : String(customerObj.phone ?? ''),
    orderType: String(body.orderType ?? body.order_type ?? body.fulfillmentType ?? 'collection'),
    channel: body.channel != null ? String(body.channel) : undefined,
    channelLabel: body.channelLabel != null ? String(body.channelLabel) : String(body.sourceLabel ?? ''),
    items,
    total: body.total != null ? Number(body.total) : undefined,
    deliveryAddress: body.deliveryAddress != null ? String(body.deliveryAddress) : String(body.address ?? ''),
    postcode: body.postcode != null ? String(body.postcode) : String(body.deliveryPostcode ?? ''),
    customerAllergies: body.customerAllergies != null ? String(body.customerAllergies) : undefined,
    allergyConfirmed: body.allergyConfirmed === true,
    paymentStatus: body.paymentStatus != null ? String(body.paymentStatus) : undefined,
    paymentMethod: body.paymentMethod != null ? String(body.paymentMethod) : undefined,
    dueAt: body.dueAt != null ? String(body.dueAt) : undefined,
    notes: body.notes != null ? String(body.notes) : undefined,
    providerMeta: body.providerMeta && typeof body.providerMeta === 'object'
      ? body.providerMeta as Record<string, unknown>
      : body,
  };
}

/** Deliverect-shaped POS inbound webhook (skeleton — integration-ready, not certified). */
export function parseDeliverectInboundOrder(body: Record<string, unknown>): InboundConnectorOrder | { error: string } {
  const order = (body.order && typeof body.order === 'object')
    ? body.order as Record<string, unknown>
    : body;
  const externalId = String(order._id ?? order.id ?? order.channelOrderId ?? '').trim();
  if (!externalId) return { error: 'Deliverect order id required' };
  const itemsRaw = Array.isArray(order.items) ? order.items : [];
  const items = itemsRaw.map((row) => {
    const r = row as Record<string, unknown>;
    const name = String(r.name ?? r.plu ?? r.productName ?? '').trim();
    return {
      name,
      qty: Math.max(1, Number(r.quantity ?? r.qty ?? 1) || 1),
      price: r.price != null ? Number(r.price) / 100 : undefined,
      notes: r.remark != null ? String(r.remark) : undefined,
    };
  }).filter((i) => i.name);
  if (!items.length) return { error: 'items required' };
  const customer = (order.customer && typeof order.customer === 'object')
    ? order.customer as Record<string, unknown>
    : {};
  const orderType = String(order.orderType ?? order.deliveryMethod ?? 'collection').toLowerCase();
  const payment = (order.payment && typeof order.payment === 'object')
    ? order.payment as Record<string, unknown>
    : {};
  const deliveryAddressObj = (order.deliveryAddress && typeof order.deliveryAddress === 'object')
    ? order.deliveryAddress as Record<string, unknown>
    : {};
  return {
    externalId,
    customerName: String(customer.name ?? order.customerName ?? 'Guest'),
    customerPhone: String(customer.phoneNumber ?? customer.phone ?? ''),
    orderType: orderType.includes('delivery') ? 'delivery' : orderType.includes('eat') ? 'table' : 'collection',
    channel: 'deliverect',
    channelLabel: String(order.channel ?? order.channelName ?? 'Deliverect'),
    items,
    total: payment.amount != null ? Number(payment.amount) / 100 : Number(order.total ?? 0),
    deliveryAddress: String(deliveryAddressObj.street ?? order.deliveryAddress ?? ''),
    postcode: String(deliveryAddressObj.postalCode ?? order.postalCode ?? ''),
    customerAllergies: order.allergyInfo != null ? String(order.allergyInfo) : undefined,
    paymentStatus: payment.status != null ? String(payment.status) : 'unpaid',
    dueAt: order.pickupTime != null ? String(order.pickupTime) : undefined,
    notes: order.note != null ? String(order.note) : undefined,
    providerMeta: { deliverect: order },
  };
}

export function inboundOrderToSavePayload(
  parsed: InboundConnectorOrder,
  provider: string,
  statusMap?: Record<string, string>,
): Record<string, unknown> {
  const orderType = String(parsed.orderType ?? 'collection').toLowerCase();
  const pay = String(parsed.paymentStatus ?? 'unpaid').toLowerCase();
  let paymentStatus = 'unpaid';
  let paymentMethod: string | undefined;
  if (pay === 'paid') paymentStatus = 'paid';
  if (parsed.paymentMethod === 'cash' || parsed.paymentMethod === 'card') {
    paymentMethod = parsed.paymentMethod;
  }
  const items = parsed.items.map((i) => ({
    name: i.name,
    qty: i.qty ?? 1,
    price: i.price ?? 0,
    ...(i.notes ? { notes: i.notes } : {}),
  }));
  const total = parsed.total ?? items.reduce((s, i) => s + (i.qty ?? 1) * (i.price ?? 0), 0);
  return {
    externalId: parsed.externalId,
    source: provider,
    sourceStatus: 'new',
    syncState: 'synced',
    status: mapInboundStatus('new', statusMap),
    channel: parsed.channelLabel || parsed.channel || provider,
    orderType,
    customerName: parsed.customerName ?? 'Guest',
    customerPhone: parsed.customerPhone ?? '',
    items,
    total,
    deliveryAddress: parsed.deliveryAddress || undefined,
    deliveryPostcode: parsed.postcode || undefined,
    customerAllergies: parsed.customerAllergies ?? '',
    allergyConfirmed: parsed.allergyConfirmed === true,
    notes: parsed.notes ?? '',
    paymentStatus,
    paymentMethod,
    placedAt: new Date().toISOString(),
    dueAt: parsed.dueAt,
    providerMeta: parsed.providerMeta ?? {},
  };
}
