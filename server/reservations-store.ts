/**
 * Dining tables + reservations ↔ Supabase (service role) with disk fallback.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { getDataStore, getRequestOrgId, syncData } from './data-store';
import { resolveOrdersOrgId } from './supabase-orders';

let admin: SupabaseClient | null | undefined;

const DEFAULT_SLOT_MINUTES = 90;

export type ReservationStatus =
  | 'enquiry'
  | 'held'
  | 'confirmed'
  | 'seated'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface DiningTable {
  id: string;
  orgId: string;
  label: string;
  seats: number;
  zone?: string;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Reservation {
  id: string;
  orgId: string;
  tableId?: string;
  partySize: number;
  customerName: string;
  customerPhone: string;
  customerId?: string;
  startsAt: string;
  endsAt?: string;
  status: ReservationStatus;
  channel: string;
  callId?: string;
  recordingUrl?: string;
  callIds: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

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

export function isReservationsConfigured(): boolean {
  return Boolean(getAdmin());
}

function resolveOrg(orgId?: string | null): string | null {
  return resolveOrdersOrgId(orgId ?? getRequestOrgId());
}

function parseIso(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

function addMinutes(d: Date, mins: number): Date {
  return new Date(d.getTime() + mins * 60_000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

type TableRow = {
  id: string;
  org_id: string;
  label: string;
  seats: number;
  zone: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ReservationRow = {
  id: string;
  org_id: string;
  table_id: string | null;
  party_size: number;
  customer_name: string;
  customer_phone: string;
  customer_id: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
  channel: string;
  call_id: string | null;
  recording_url: string | null;
  call_ids: unknown;
  notes: string;
  created_at: string;
  updated_at: string;
};

function rowToTable(row: TableRow): DiningTable {
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    seats: Number(row.seats),
    zone: row.zone ?? undefined,
    active: row.active !== false,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    orgId: row.org_id,
    tableId: row.table_id ?? undefined,
    partySize: Number(row.party_size),
    customerName: row.customer_name ?? '',
    customerPhone: row.customer_phone ?? '',
    customerId: row.customer_id ?? undefined,
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? undefined,
    status: (row.status ?? 'confirmed') as ReservationStatus,
    channel: row.channel ?? 'phone',
    callId: row.call_id ?? undefined,
    recordingUrl: row.recording_url ?? undefined,
    callIds: Array.isArray(row.call_ids) ? row.call_ids.map(String) : [],
    notes: row.notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function diskTables(): DiningTable[] {
  const store = getDataStore();
  const raw = store.diningTables;
  return Array.isArray(raw) ? raw as unknown as DiningTable[] : [];
}

function diskReservations(): Reservation[] {
  const store = getDataStore();
  const raw = store.reservations;
  return Array.isArray(raw) ? raw as unknown as Reservation[] : [];
}

function saveDiskTables(tables: DiningTable[]): void {
  const store = getDataStore();
  store.diningTables = tables as unknown as Array<Record<string, unknown>>;
  syncData(store);
}

function saveDiskReservations(rows: Reservation[]): void {
  const store = getDataStore();
  store.reservations = rows as unknown as Array<Record<string, unknown>>;
  syncData(store);
}

export async function listDiningTables(orgIdHint?: string | null): Promise<DiningTable[]> {
  const orgId = resolveOrg(orgIdHint);
  if (!orgId) return [];
  const client = getAdmin();
  if (client) {
    const { data, error } = await client
      .from('dining_tables')
      .select('*')
      .eq('org_id', orgId)
      .order('sort_order', { ascending: true });
    if (!error && data) {
      const tables = (data as TableRow[]).map(rowToTable);
      const store = getDataStore();
      store.diningTables = tables as unknown as Array<Record<string, unknown>>;
      syncData(store);
      return tables;
    }
  }
  return diskTables().filter((t) => t.orgId === orgId);
}

export async function upsertDiningTable(
  input: Partial<DiningTable> & { label: string; seats: number },
  orgIdHint?: string | null,
): Promise<{ ok: boolean; table?: DiningTable; error?: string }> {
  const orgId = resolveOrg(orgIdHint ?? input.orgId);
  if (!orgId) return { ok: false, error: 'no org id' };
  const id = input.id?.trim() || randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    org_id: orgId,
    label: String(input.label).trim(),
    seats: Math.max(1, Number(input.seats) || 1),
    zone: input.zone != null ? String(input.zone).trim() : null,
    active: input.active !== false,
    sort_order: Number(input.sortOrder ?? 0),
    updated_at: now,
    created_at: input.createdAt ?? now,
  };
  const client = getAdmin();
  if (client) {
    const { data, error } = await client.from('dining_tables').upsert(row).select('*').maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (data) return { ok: true, table: rowToTable(data as TableRow) };
  }
  const tables = diskTables().filter((t) => !(t.orgId === orgId && t.id === id));
  const table = rowToTable(row as TableRow);
  tables.push(table);
  saveDiskTables(tables);
  return { ok: true, table };
}

export async function listReservations(
  orgIdHint?: string | null,
  filter?: { day?: string; phone?: string; status?: string },
): Promise<Reservation[]> {
  const orgId = resolveOrg(orgIdHint);
  if (!orgId) return [];
  const client = getAdmin();
  if (client) {
    let q = client.from('reservations').select('*').eq('org_id', orgId).order('starts_at', { ascending: true });
    if (filter?.phone) q = q.ilike('customer_phone', `%${filter.phone.replace(/\D/g, '').slice(-10)}%`);
    if (filter?.status) q = q.eq('status', filter.status);
    const { data, error } = await q;
    if (!error && data) {
      let rows = (data as ReservationRow[]).map(rowToReservation);
      if (filter?.day) {
        const day = filter.day.slice(0, 10);
        rows = rows.filter((r) => r.startsAt.slice(0, 10) === day);
      }
      const store = getDataStore();
      store.reservations = rows as unknown as Array<Record<string, unknown>>;
      syncData(store);
      return rows;
    }
  }
  let rows = diskReservations().filter((r) => r.orgId === orgId);
  if (filter?.day) {
    const day = filter.day.slice(0, 10);
    rows = rows.filter((r) => r.startsAt.slice(0, 10) === day);
  }
  if (filter?.phone) {
    const needle = filter.phone.replace(/\D/g, '').slice(-10);
    rows = rows.filter((r) => r.customerPhone.replace(/\D/g, '').includes(needle));
  }
  if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
  return rows;
}

function activeReservationStatuses(): Set<string> {
  return new Set(['enquiry', 'held', 'confirmed', 'seated']);
}

export async function checkTableAvailability(
  input: { startsAt: string; partySize: number; durationMinutes?: number },
  orgIdHint?: string | null,
): Promise<{
  ok: boolean;
  availableTables: Array<{ id: string; label: string; seats: number; zone?: string }>;
  nextSlots?: string[];
  error?: string;
}> {
  const orgId = resolveOrg(orgIdHint);
  if (!orgId) return { ok: false, availableTables: [], error: 'no org id' };
  const starts = parseIso(input.startsAt);
  if (!starts) return { ok: false, availableTables: [], error: 'invalid startsAt' };
  const partySize = Math.max(1, Number(input.partySize) || 1);
  const duration = Math.max(30, Number(input.durationMinutes ?? DEFAULT_SLOT_MINUTES) || DEFAULT_SLOT_MINUTES);
  const ends = addMinutes(starts, duration);

  const tables = (await listDiningTables(orgId)).filter((t) => t.active && t.seats >= partySize);
  const reservations = (await listReservations(orgId)).filter((r) => activeReservationStatuses().has(r.status));

  const bookedTableIds = new Set<string>();
  for (const r of reservations) {
    const rStart = parseIso(r.startsAt);
    const rEnd = parseIso(r.endsAt ?? '') ?? addMinutes(rStart ?? starts, duration);
    if (!rStart || !overlaps(starts, ends, rStart, rEnd)) continue;
    if (r.tableId) bookedTableIds.add(r.tableId);
  }

  const availableTables = tables
    .filter((t) => !bookedTableIds.has(t.id))
    .map((t) => ({ id: t.id, label: t.label, seats: t.seats, zone: t.zone }));

  const nextSlots: string[] = [];
  if (!availableTables.length) {
    for (let offset = 1; offset <= 4; offset += 1) {
      const slotStart = addMinutes(starts, offset * 30);
      const slotEnd = addMinutes(slotStart, duration);
      const free = tables.some((t) => {
        if (bookedTableIds.has(t.id)) return false;
        const clash = reservations.some((r) => {
          if (r.tableId && r.tableId !== t.id) return false;
          const rStart = parseIso(r.startsAt);
          const rEnd = parseIso(r.endsAt ?? '') ?? addMinutes(rStart ?? slotStart, duration);
          return rStart ? overlaps(slotStart, slotEnd, rStart, rEnd) : false;
        });
        return !clash;
      });
      if (free) nextSlots.push(slotStart.toISOString());
    }
  }

  return { ok: true, availableTables, nextSlots: nextSlots.length ? nextSlots : undefined };
}

export async function createReservation(
  input: {
    partySize: number;
    startsAt: string;
    customerName?: string;
    customerPhone?: string;
    customerId?: string;
    tableId?: string;
    endsAt?: string;
    status?: ReservationStatus;
    channel?: string;
    callId?: string;
    notes?: string;
    durationMinutes?: number;
  },
  orgIdHint?: string | null,
): Promise<{ ok: boolean; reservation?: Reservation; error?: string }> {
  const orgId = resolveOrg(orgIdHint);
  if (!orgId) return { ok: false, error: 'no org id' };
  const starts = parseIso(input.startsAt);
  if (!starts) return { ok: false, error: 'invalid startsAt' };
  const partySize = Math.max(1, Number(input.partySize) || 1);
  const duration = Math.max(30, Number(input.durationMinutes ?? DEFAULT_SLOT_MINUTES) || DEFAULT_SLOT_MINUTES);
  const endsAt = input.endsAt ?? addMinutes(starts, duration).toISOString();

  const avail = await checkTableAvailability(
    { startsAt: input.startsAt, partySize, durationMinutes: duration },
    orgId,
  );
  if (!avail.ok) return { ok: false, error: avail.error };
  let tableId = input.tableId;
  if (tableId && !avail.availableTables.some((t) => t.id === tableId)) {
    return { ok: false, error: 'table_not_available' };
  }
  if (!tableId && avail.availableTables.length) {
    tableId = avail.availableTables.sort((a, b) => a.seats - b.seats)[0]?.id;
  }
  if (!tableId && !avail.nextSlots?.length) {
    return { ok: false, error: 'no_availability' };
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const callId = input.callId?.trim() || undefined;
  const row = {
    id,
    org_id: orgId,
    table_id: tableId ?? null,
    party_size: partySize,
    customer_name: String(input.customerName ?? 'Guest').trim(),
    customer_phone: String(input.customerPhone ?? '').trim(),
    customer_id: input.customerId?.trim() || null,
    starts_at: starts.toISOString(),
    ends_at: endsAt,
    status: input.status ?? (tableId ? 'confirmed' : 'enquiry'),
    channel: input.channel ?? 'phone',
    call_id: callId ?? null,
    recording_url: null,
    call_ids: callId ? [callId] : [],
    notes: String(input.notes ?? '').trim(),
    created_at: now,
    updated_at: now,
  };

  const client = getAdmin();
  if (client) {
    const { data, error } = await client.from('reservations').insert(row).select('*').maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (data) return { ok: true, reservation: rowToReservation(data as ReservationRow) };
  }

  const reservation = rowToReservation(row as ReservationRow);
  const rows = diskReservations();
  rows.push(reservation);
  saveDiskReservations(rows);
  return { ok: true, reservation };
}

export async function updateReservation(
  id: string,
  patch: Partial<Reservation>,
  orgIdHint?: string | null,
): Promise<{ ok: boolean; reservation?: Reservation; error?: string }> {
  const orgId = resolveOrg(orgIdHint ?? patch.orgId);
  if (!orgId) return { ok: false, error: 'no org id' };
  const client = getAdmin();
  const rowPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.tableId !== undefined) rowPatch.table_id = patch.tableId || null;
  if (patch.partySize !== undefined) rowPatch.party_size = Math.max(1, Number(patch.partySize) || 1);
  if (patch.customerName !== undefined) rowPatch.customer_name = String(patch.customerName);
  if (patch.customerPhone !== undefined) rowPatch.customer_phone = String(patch.customerPhone);
  if (patch.startsAt !== undefined) rowPatch.starts_at = patch.startsAt;
  if (patch.endsAt !== undefined) rowPatch.ends_at = patch.endsAt ?? null;
  if (patch.status !== undefined) rowPatch.status = patch.status;
  if (patch.notes !== undefined) rowPatch.notes = String(patch.notes ?? '');
  if (patch.callId !== undefined) rowPatch.call_id = patch.callId || null;
  if (patch.recordingUrl !== undefined) rowPatch.recording_url = patch.recordingUrl || null;
  if (patch.callIds !== undefined) rowPatch.call_ids = patch.callIds;

  if (client) {
    const { data, error } = await client
      .from('reservations')
      .update(rowPatch)
      .eq('id', id)
      .eq('org_id', orgId)
      .select('*')
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: 'not found' };
    return { ok: true, reservation: rowToReservation(data as ReservationRow) };
  }

  const rows = diskReservations();
  const idx = rows.findIndex((r) => r.id === id && r.orgId === orgId);
  if (idx < 0) return { ok: false, error: 'not found' };
  rows[idx] = { ...rows[idx], ...patch, updatedAt: new Date().toISOString() };
  saveDiskReservations(rows);
  return { ok: true, reservation: rows[idx] };
}

export async function cancelReservation(
  id: string,
  reason?: string,
  orgIdHint?: string | null,
): Promise<{ ok: boolean; reservation?: Reservation; error?: string }> {
  const notesSuffix = reason?.trim() ? ` | Cancelled: ${reason.trim()}` : '';
  const existing = (await listReservations(orgIdHint)).find((r) => r.id === id);
  const notes = [existing?.notes, notesSuffix].filter(Boolean).join('');
  return updateReservation(id, { status: 'cancelled', notes }, orgIdHint);
}

export async function backfillReservationRecording(
  callId: string,
  recordingUrl: string,
  orgIdHint?: string | null,
): Promise<number> {
  const orgId = resolveOrg(orgIdHint);
  if (!orgId || !callId) return 0;
  let updated = 0;
  const client = getAdmin();
  if (client) {
    const { data } = await client
      .from('reservations')
      .select('*')
      .eq('org_id', orgId)
      .or(`call_id.eq.${callId},call_ids.cs.["${callId}"]`);
    for (const row of (data as ReservationRow[] | null) ?? []) {
      const callIds = Array.isArray(row.call_ids) ? row.call_ids.map(String) : [];
      const nextIds = [...new Set([...callIds, callId])];
      await client.from('reservations').update({
        recording_url: recordingUrl,
        call_ids: nextIds,
        call_id: row.call_id || callId,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      updated += 1;
    }
  }
  const rows = diskReservations();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.orgId !== orgId) continue;
    const matches = r.callId === callId || r.callIds.includes(callId);
    if (!matches) continue;
    rows[i] = {
      ...r,
      recordingUrl,
      callIds: [...new Set([...r.callIds, callId])],
      callId: r.callId || callId,
      updatedAt: new Date().toISOString(),
    };
    updated += 1;
  }
  if (updated) saveDiskReservations(rows);
  return updated;
}
