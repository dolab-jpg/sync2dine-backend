/**
 * Sync2Dine food orders ↔ Supabase public.orders (service role).
 * Primary store for kitchen / phone / API; disk JSON is write-through cache.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { getHomeOrgId, isOrgUuid, sanitizeOrgId } from './home-org';

let admin: SupabaseClient | null | undefined;

function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    admin = null;
    return null;
  }
  admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return admin;
}

export function isSupabaseOrdersConfigured(): boolean {
  return Boolean(getAdmin());
}

export function resolveOrdersOrgId(orgId?: string | null): string | null {
  const sanitized = sanitizeOrgId(orgId);
  if (sanitized) return sanitized;
  const home = getHomeOrgId();
  return isOrgUuid(home) ? home : null;
}

export function isOrderUuid(id: string | null | undefined): boolean {
  return Boolean(id && isOrgUuid(id));
}

export function newOrderId(): string {
  return randomUUID();
}

type OrderRow = {
  id: string;
  org_id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  channel: string;
  order_type: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  order_number: number;
  items: unknown;
  total: number | string;
  delivery_address: string | null;
  notes: string;
  review_score: number | null;
  review_text: string | null;
  review_called_at: string | null;
  last_winback_call_at: string | null;
  external_id?: string | null;
  source?: string | null;
  source_status?: string | null;
  sync_state?: string | null;
  placed_at?: string | null;
  due_at?: string | null;
  provider_meta?: unknown;
  customer_allergies?: string | null;
  allergy_confirmed?: boolean | null;
  source_call_id?: string | null;
  recording_url?: string | null;
  call_ids?: unknown;
  created_at: string;
  updated_at: string;
};

/** Persist specials/postcode in notes — orders table has no dedicated columns. */
const S2D_META_RE = /\s*\[\[s2d:([^\]]+)\]\]\s*$/;

function encodeOrderMeta(notes: string, order: Record<string, unknown>): string {
  const base = String(notes ?? '').replace(S2D_META_RE, '').trim();
  const parts: string[] = [];
  if (order.specialName != null && String(order.specialName).trim()) {
    parts.push(`special=${encodeURIComponent(String(order.specialName).trim())}`);
  }
  if (order.deliveryPostcode != null && String(order.deliveryPostcode).trim()) {
    parts.push(`pc=${encodeURIComponent(String(order.deliveryPostcode).trim())}`);
  }
  if (order.etaMinutes != null && Number.isFinite(Number(order.etaMinutes))) {
    parts.push(`eta=${encodeURIComponent(String(Number(order.etaMinutes)))}`);
  }
  if (!parts.length) return base;
  return base ? `${base} [[s2d:${parts.join('|')}]]` : `[[s2d:${parts.join('|')}]]`;
}

function decodeOrderMeta(notes: string): {
  notes: string;
  specialName?: string;
  deliveryPostcode?: string;
  etaMinutes?: number;
} {
  const raw = String(notes ?? '');
  const m = raw.match(S2D_META_RE);
  if (!m) return { notes: raw };
  const cleaned = raw.replace(S2D_META_RE, '').trim();
  let specialName: string | undefined;
  let deliveryPostcode: string | undefined;
  let etaMinutes: number | undefined;
  for (const part of m[1].split('|')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = decodeURIComponent(part.slice(eq + 1));
    if (key === 'special' && val) specialName = val;
    if (key === 'pc' && val) deliveryPostcode = val;
    if (key === 'eta' && val) {
      const n = Number(val);
      if (Number.isFinite(n)) etaMinutes = n;
    }
  }
  return { notes: cleaned, specialName, deliveryPostcode, etaMinutes };
}

function extractPostcodeFromAddress(address: string | null | undefined): string | undefined {
  if (!address) return undefined;
  const m = String(address).match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, ' ').trim() : undefined;
}

/** Map Supabase row → camelCase API / disk shape. */
export function rowToOrder(row: OrderRow): Record<string, unknown> {
  const decoded = decodeOrderMeta(row.notes ?? '');
  const deliveryPostcode = decoded.deliveryPostcode || extractPostcodeFromAddress(row.delivery_address);
  const callIds = Array.isArray(row.call_ids) ? row.call_ids.map(String) : [];
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id ?? undefined,
    customerName: row.customer_name ?? '',
    customerPhone: row.customer_phone ?? '',
    channel: row.channel ?? 'phone',
    orderType: row.order_type ?? 'collection',
    status: row.status ?? 'new',
    paymentStatus: row.payment_status ?? 'unpaid',
    paymentMethod: row.payment_method ?? undefined,
    orderNumber: Number(row.order_number),
    items: Array.isArray(row.items) ? row.items : [],
    total: Number(row.total ?? 0),
    deliveryAddress: row.delivery_address ?? undefined,
    deliveryPostcode,
    specialName: decoded.specialName,
    notes: decoded.notes,
    etaMinutes: decoded.etaMinutes,
    externalId: row.external_id ?? undefined,
    source: row.source ?? 'sync2dine',
    sourceStatus: row.source_status ?? undefined,
    syncState: row.sync_state ?? 'local',
    placedAt: row.placed_at ?? row.created_at,
    dueAt: row.due_at ?? undefined,
    providerMeta: (row.provider_meta && typeof row.provider_meta === 'object')
      ? row.provider_meta as Record<string, unknown>
      : {},
    customerAllergies: row.customer_allergies ?? '',
    allergyConfirmed: row.allergy_confirmed === true,
    sourceCallId: row.source_call_id ?? undefined,
    recordingUrl: row.recording_url ?? undefined,
    callIds,
    reviewScore: row.review_score ?? undefined,
    reviewText: row.review_text ?? undefined,
    reviewCalledAt: row.review_called_at ?? undefined,
    lastWinbackCallAt: row.last_winback_call_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map camelCase order → Supabase insert/upsert row. */
export function orderToRow(order: Record<string, unknown>, orgId: string): Record<string, unknown> {
  const id = isOrderUuid(String(order.id ?? '')) ? String(order.id) : newOrderId();
  const notesEncoded = encodeOrderMeta(String(order.notes ?? ''), order);
  const callIds = Array.isArray(order.callIds) ? order.callIds.map(String) : [];
  const sourceCallId = order.sourceCallId != null ? String(order.sourceCallId) : null;
  const mergedCallIds = [...new Set([...callIds, ...(sourceCallId ? [sourceCallId] : [])])];
  return {
    id,
    org_id: orgId,
    customer_id: order.customerId != null && String(order.customerId).trim()
      ? String(order.customerId)
      : null,
    customer_name: String(order.customerName ?? order.customer ?? 'Guest'),
    customer_phone: String(order.customerPhone ?? order.phone ?? ''),
    channel: String(order.channel ?? 'phone'),
    order_type: String(order.orderType ?? order.type ?? 'collection'),
    status: String(order.status ?? 'new'),
    payment_status: String(order.paymentStatus ?? order.payment ?? 'unpaid'),
    payment_method: order.paymentMethod != null ? String(order.paymentMethod) : null,
    order_number: Number(order.orderNumber ?? 0),
    items: Array.isArray(order.items) ? order.items : [],
    total: Number(order.total ?? 0),
    delivery_address: order.deliveryAddress != null
      ? String(order.deliveryAddress)
      : order.address != null
        ? String(order.address)
        : null,
    notes: notesEncoded,
    review_score: order.reviewScore != null ? Number(order.reviewScore) : null,
    review_text: order.reviewText != null ? String(order.reviewText) : null,
    review_called_at: order.reviewCalledAt != null ? String(order.reviewCalledAt) : null,
    last_winback_call_at: order.lastWinbackCallAt != null
      ? String(order.lastWinbackCallAt)
      : null,
    external_id: order.externalId != null ? String(order.externalId) : null,
    source: String(order.source ?? 'sync2dine'),
    source_status: order.sourceStatus != null ? String(order.sourceStatus) : null,
    sync_state: String(order.syncState ?? 'local'),
    placed_at: order.placedAt != null ? String(order.placedAt) : (order.createdAt != null ? String(order.createdAt) : new Date().toISOString()),
    due_at: order.dueAt != null ? String(order.dueAt) : null,
    provider_meta: order.providerMeta && typeof order.providerMeta === 'object'
      ? order.providerMeta
      : {},
    customer_allergies: order.customerAllergies != null ? String(order.customerAllergies) : '',
    allergy_confirmed: order.allergyConfirmed === true,
    source_call_id: sourceCallId,
    recording_url: order.recordingUrl != null ? String(order.recordingUrl) : null,
    call_ids: mergedCallIds,
    created_at: String(order.createdAt ?? new Date().toISOString()),
    updated_at: String(order.updatedAt ?? new Date().toISOString()),
  };
}

/** Ensure org row exists so orders FK does not fail on empty cloud projects. */
export async function ensureOrdersOrg(orgId: string): Promise<{ ok: boolean; error?: string }> {
  const client = getAdmin();
  if (!client) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  if (!isOrgUuid(orgId)) return { ok: false, error: 'org id must be a uuid' };

  const { data, error: readErr } = await client
    .from('organizations')
    .select('id')
    .eq('id', orgId)
    .maybeSingle();
  if (readErr) {
    console.warn('[supabase-orders] org read failed:', readErr.message);
    return { ok: false, error: readErr.message };
  }
  if (data?.id) return { ok: true };

  const now = new Date().toISOString();
  const { error } = await client.from('organizations').upsert(
    {
      id: orgId,
      name: 'Sync2Dine',
      contact_name: '',
      contact_email: '',
      contact_phone: '',
      status: 'active',
      plan: 'starter',
      openai_api_key_encrypted: '',
      monthly_token_cap: 500_000,
      updated_at: now,
    },
    { onConflict: 'id' },
  );
  if (error) {
    console.warn('[supabase-orders] org stub upsert failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function listOrdersFromSupabase(
  orgIdHint?: string | null,
): Promise<{ ok: boolean; orders: Array<Record<string, unknown>>; error?: string }> {
  const client = getAdmin();
  if (!client) return { ok: false, orders: [], error: 'not configured' };
  const orgId = resolveOrdersOrgId(orgIdHint);
  if (!orgId) return { ok: false, orders: [], error: 'no org id' };

  const { data, error } = await client
    .from('orders')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('[supabase-orders] list failed:', error.message);
    return { ok: false, orders: [], error: error.message };
  }
  return {
    ok: true,
    orders: (data as OrderRow[] | null)?.map(rowToOrder) ?? [],
  };
}

export async function nextOrderNumber(orgIdHint?: string | null): Promise<number> {
  const client = getAdmin();
  const orgId = resolveOrdersOrgId(orgIdHint);
  if (!client || !orgId) return 101;

  const { data, error } = await client
    .from('orders')
    .select('order_number')
    .eq('org_id', orgId)
    .order('order_number', { ascending: false })
    .limit(1);

  if (error) {
    console.warn('[supabase-orders] nextOrderNumber failed:', error.message);
    return 101;
  }
  const max = Number((data as Array<{ order_number: number }> | null)?.[0]?.order_number ?? 100);
  return Number.isFinite(max) ? max + 1 : 101;
}

export async function upsertOrderToSupabase(
  order: Record<string, unknown>,
  orgIdHint?: string | null,
): Promise<{ ok: boolean; order?: Record<string, unknown>; error?: string }> {
  const client = getAdmin();
  if (!client) return { ok: false, error: 'not configured' };
  const orgId = resolveOrdersOrgId(orgIdHint ?? (order.orgId as string | undefined));
  if (!orgId) return { ok: false, error: 'no org id' };

  const ensured = await ensureOrdersOrg(orgId);
  if (!ensured.ok) return { ok: false, error: ensured.error };

  let orderNumber = Number(order.orderNumber ?? 0);
  if (!Number.isFinite(orderNumber) || orderNumber <= 0) {
    orderNumber = await nextOrderNumber(orgId);
  }

  const row = orderToRow({ ...order, orderNumber, orgId }, orgId);
  const { data, error } = await client
    .from('orders')
    .upsert(row, { onConflict: 'id' })
    .select('*')
    .maybeSingle();

  if (error) {
    console.warn('[supabase-orders] upsert failed:', error.message);
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    order: data ? rowToOrder(data as OrderRow) : rowToOrder(row as OrderRow),
  };
}

export async function updateOrderInSupabase(
  id: string,
  patch: Record<string, unknown>,
  orgIdHint?: string | null,
): Promise<{ ok: boolean; order?: Record<string, unknown>; error?: string }> {
  const client = getAdmin();
  if (!client) return { ok: false, error: 'not configured' };
  const orgId = resolveOrdersOrgId(orgIdHint);
  if (!orgId) return { ok: false, error: 'no org id' };
  if (!isOrderUuid(id)) return { ok: false, error: 'invalid order id' };

  const rowPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.customerId !== undefined) {
    rowPatch.customer_id = patch.customerId != null && String(patch.customerId).trim()
      ? String(patch.customerId)
      : null;
  }
  if (patch.customerName !== undefined) rowPatch.customer_name = String(patch.customerName);
  if (patch.customerPhone !== undefined) rowPatch.customer_phone = String(patch.customerPhone);
  if (patch.channel !== undefined) rowPatch.channel = String(patch.channel);
  if (patch.orderType !== undefined) rowPatch.order_type = String(patch.orderType);
  if (patch.status !== undefined) rowPatch.status = String(patch.status);
  if (patch.paymentStatus !== undefined) {
    const s = String(patch.paymentStatus).toLowerCase();
    if (s === 'cash' || s === 'card') {
      rowPatch.payment_status = 'paid';
      rowPatch.payment_method = s;
    } else {
      rowPatch.payment_status = s === 'paid' ? 'paid' : 'unpaid';
    }
  }
  if (patch.paymentMethod !== undefined) {
    rowPatch.payment_method = patch.paymentMethod != null ? String(patch.paymentMethod) : null;
  }
  // Persist eta / special / postcode into notes meta when patched
  if (patch.etaMinutes !== undefined || patch.specialName !== undefined || patch.deliveryPostcode !== undefined || patch.notes !== undefined) {
    const existing = await client.from('orders').select('notes').eq('id', id).eq('org_id', orgId).maybeSingle();
    const currentNotes = String((existing.data as { notes?: string } | null)?.notes ?? '');
    const decoded = decodeOrderMeta(currentNotes);
    const merged = {
      specialName: patch.specialName !== undefined ? patch.specialName : decoded.specialName,
      deliveryPostcode: patch.deliveryPostcode !== undefined ? patch.deliveryPostcode : decoded.deliveryPostcode,
      etaMinutes: patch.etaMinutes !== undefined ? patch.etaMinutes : decoded.etaMinutes,
    };
    const baseNotes = patch.notes !== undefined ? String(patch.notes) : decoded.notes;
    rowPatch.notes = encodeOrderMeta(baseNotes, merged);
  } else if (patch.notes !== undefined) {
    rowPatch.notes = String(patch.notes);
  }
  if (patch.orderNumber !== undefined) rowPatch.order_number = Number(patch.orderNumber);
  if (patch.items !== undefined) rowPatch.items = Array.isArray(patch.items) ? patch.items : [];
  if (patch.total !== undefined) rowPatch.total = Number(patch.total);
  if (patch.deliveryAddress !== undefined) {
    rowPatch.delivery_address = patch.deliveryAddress != null ? String(patch.deliveryAddress) : null;
  }
  if (patch.reviewScore !== undefined) {
    rowPatch.review_score = patch.reviewScore != null ? Number(patch.reviewScore) : null;
  }
  if (patch.reviewText !== undefined) {
    rowPatch.review_text = patch.reviewText != null ? String(patch.reviewText) : null;
  }
  if (patch.reviewCalledAt !== undefined) {
    rowPatch.review_called_at = patch.reviewCalledAt != null ? String(patch.reviewCalledAt) : null;
  }
  if (patch.lastWinbackCallAt !== undefined) {
    rowPatch.last_winback_call_at = patch.lastWinbackCallAt != null
      ? String(patch.lastWinbackCallAt)
      : null;
  }
  if (patch.externalId !== undefined) rowPatch.external_id = patch.externalId != null ? String(patch.externalId) : null;
  if (patch.source !== undefined) rowPatch.source = String(patch.source);
  if (patch.sourceStatus !== undefined) rowPatch.source_status = patch.sourceStatus != null ? String(patch.sourceStatus) : null;
  if (patch.syncState !== undefined) rowPatch.sync_state = String(patch.syncState);
  if (patch.placedAt !== undefined) rowPatch.placed_at = patch.placedAt != null ? String(patch.placedAt) : null;
  if (patch.dueAt !== undefined) rowPatch.due_at = patch.dueAt != null ? String(patch.dueAt) : null;
  if (patch.providerMeta !== undefined) {
    rowPatch.provider_meta = patch.providerMeta && typeof patch.providerMeta === 'object' ? patch.providerMeta : {};
  }
  if (patch.customerAllergies !== undefined) {
    rowPatch.customer_allergies = patch.customerAllergies != null ? String(patch.customerAllergies) : '';
  }
  if (patch.allergyConfirmed !== undefined) rowPatch.allergy_confirmed = patch.allergyConfirmed === true;
  if (patch.sourceCallId !== undefined) rowPatch.source_call_id = patch.sourceCallId != null ? String(patch.sourceCallId) : null;
  if (patch.recordingUrl !== undefined) rowPatch.recording_url = patch.recordingUrl != null ? String(patch.recordingUrl) : null;
  if (patch.callIds !== undefined) {
    rowPatch.call_ids = Array.isArray(patch.callIds) ? patch.callIds.map(String) : [];
  }

  const { data, error } = await client
    .from('orders')
    .update(rowPatch)
    .eq('id', id)
    .eq('org_id', orgId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.warn('[supabase-orders] update failed:', error.message);
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: false, error: 'not found' };
  return { ok: true, order: rowToOrder(data as OrderRow) };
}

export async function findOrderByExternalId(
  provider: string,
  externalId: string,
  orgIdHint?: string | null,
): Promise<Record<string, unknown> | null> {
  const client = getAdmin();
  const orgId = resolveOrdersOrgId(orgIdHint);
  if (!client || !orgId || !externalId?.trim()) return null;
  const { data } = await client
    .from('orders')
    .select('*')
    .eq('org_id', orgId)
    .eq('source', provider)
    .eq('external_id', externalId.trim())
    .maybeSingle();
  return data ? rowToOrder(data as OrderRow) : null;
}

export async function backfillOrderRecordingInSupabase(
  callId: string,
  recordingUrl: string,
  orgIdHint?: string | null,
): Promise<{ updated: number }> {
  const client = getAdmin();
  const orgId = resolveOrdersOrgId(orgIdHint);
  if (!client || !orgId || !callId?.trim()) return { updated: 0 };

  const { data } = await client
    .from('orders')
    .select('*')
    .eq('org_id', orgId)
    .or(`source_call_id.eq.${callId},call_ids.cs.["${callId}"]`);

  let updated = 0;
  for (const row of (data as OrderRow[] | null) ?? []) {
    const existingIds = Array.isArray(row.call_ids) ? row.call_ids.map(String) : [];
    const nextIds = [...new Set([...existingIds, callId])];
    const { error } = await client.from('orders').update({
      recording_url: recordingUrl,
      call_ids: nextIds,
      source_call_id: row.source_call_id || callId,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (!error) updated += 1;
  }
  return { updated };
}
