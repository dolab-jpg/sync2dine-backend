/**
 * Restaurant staff / Cynthia tools: menu CRUD + order pay/status.
 */
import { listMenuItemsForOrg, upsertMenuItemForOrg, deleteMenuItemForOrg } from './menu-catalog';
import { listOrderRecords, updateOrderRecord } from './data-store';
import type { OrchestratorRequest } from './orchestrator-types';

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export const RESTAURANT_TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'getMenu',
      description: 'List the restaurant food menu (name, category, price, description).',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'upsertMenuItem',
      description:
        'Add or update a menu dish. Include name, price, category (starters|mains|sides|drinks|desserts|specials|other), and description so the phone agent can read it out.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Existing product id to update' },
          name: { type: 'string' },
          category: { type: 'string' },
          price: { type: 'number' },
          description: { type: 'string' },
          available: { type: 'boolean' },
        },
        required: ['name', 'price'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'deleteMenuItem',
      description: 'Delete a menu dish by id. Confirm with the user before calling.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'listOrders',
      description: 'List recent kitchen orders (status, payment, totals, type).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          unpaidOnly: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'markOrderPaid',
      description: 'Mark an order paid with cash or card.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          method: { type: 'string', enum: ['cash', 'card'] },
        },
        required: ['orderId', 'method'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'updateOrderStatus',
      description: 'Update kitchen order status: coming, ready, delivery, completed, cancelled.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['new', 'coming', 'ready', 'delivery', 'completed', 'cancelled'],
          },
        },
        required: ['orderId', 'status'],
      },
    },
  },
];

export const RESTAURANT_TOOL_NAMES = new Set([
  'getMenu',
  'upsertMenuItem',
  'deleteMenuItem',
  'listOrders',
  'markOrderPaid',
  'updateOrderStatus',
]);

export async function executeRestaurantTool(
  name: string,
  input: Record<string, unknown>,
  body: OrchestratorRequest,
): Promise<Record<string, unknown>> {
  const orgId = firstString(body.orgId, (body as { staffContext?: { orgId?: string } }).staffContext?.orgId);

  if (name === 'getMenu') {
    const items = await listMenuItemsForOrg(orgId, firstString(input.category));
    return { ok: true, count: items.length, items };
  }

  if (name === 'upsertMenuItem') {
    const result = await upsertMenuItemForOrg(orgId, {
      id: firstString(input.id),
      name: firstString(input.name) ?? '',
      category: firstString(input.category),
      price: Number(input.price),
      description: firstString(input.description),
      available: input.available !== false,
      deal: input.deal === null
        ? null
        : input.deal && typeof input.deal === 'object'
          ? (input.deal as { roles: Array<{ role: string; qtyPerDeal?: number; choices: string[] }> })
          : undefined,
    });
    return result;
  }

  if (name === 'deleteMenuItem') {
    const id = firstString(input.id);
    if (!id) return { ok: false, error: 'id required' };
    return deleteMenuItemForOrg(orgId, id);
  }

  if (name === 'listOrders') {
    const orders = await listOrderRecords(orgId);
    const unpaidOnly = Boolean(input.unpaidOnly);
    let list = orders as Array<Record<string, unknown>>;
    if (unpaidOnly) {
      list = list.filter((o) => {
        const s = String(o.paymentStatus ?? o.payment ?? 'unpaid').toLowerCase();
        return s === 'unpaid';
      });
    }
    const limit = Math.min(50, Math.max(1, Number(input.limit ?? 20) || 20));
    return {
      ok: true,
      orders: list.slice(0, limit).map((o) => ({
        id: o.id,
        number: o.orderNumber ?? o.number,
        customer: o.customerName ?? o.customer,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        total: o.total,
        orderType: o.orderType ?? o.type,
      })),
    };
  }

  if (name === 'markOrderPaid') {
    const orderId = firstString(input.orderId, input.id);
    const method = (firstString(input.method, input.paymentMethod) ?? 'cash').toLowerCase();
    if (!orderId) return { ok: false, error: 'orderId required' };
    if (method !== 'cash' && method !== 'card') return { ok: false, error: 'method must be cash or card' };
    const updated = await updateOrderRecord(
      orderId,
      { paymentStatus: 'paid', paymentMethod: method },
      orgId,
    );
    return updated ? { ok: true, order: updated } : { ok: false, error: 'order not found' };
  }

  if (name === 'updateOrderStatus') {
    const orderId = firstString(input.orderId, input.id);
    const status = firstString(input.status);
    if (!orderId || !status) return { ok: false, error: 'orderId and status required' };
    const updated = await updateOrderRecord(orderId, { status }, orgId);
    return updated ? { ok: true, order: updated } : { ok: false, error: 'order not found' };
  }

  return { ok: false, error: `Unknown restaurant tool: ${name}` };
}
