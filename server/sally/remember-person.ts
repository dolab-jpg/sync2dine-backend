/**
 * Per-venue people memory — contacts on a restaurant account, not extra CRM venues.
 */
import {
  getDataStore,
  lookupContactByPhone,
  normalizePhoneExport,
  saveContactRecord,
  saveCustomerRecord,
} from '../data-store';

export type VenuePersonHowKnown = 'spoke' | 'referred';

export type VenuePerson = {
  name: string;
  role?: string;
  phone?: string;
  howKnown: VenuePersonHowKnown;
  note?: string;
  lastHeard?: string;
};

export type RememberPersonInput = {
  customerId: string;
  name: string;
  role?: string;
  phone?: string;
  howKnown?: VenuePersonHowKnown;
  note?: string;
  setPrimary?: boolean;
};

export type RememberPersonResult = {
  ok: boolean;
  contact: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  error?: string;
};

function normName(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function phonesMatch(a: unknown, b: unknown): boolean {
  const na = a != null ? normalizePhoneExport(String(a)) : '';
  const nb = b != null ? normalizePhoneExport(String(b)) : '';
  if (!na || !nb || na.length < 10 || nb.length < 10) return false;
  return na === nb;
}

function mergeHowKnown(
  prev: unknown,
  next: VenuePersonHowKnown,
): VenuePersonHowKnown {
  if (prev === 'spoke' || next === 'spoke') return 'spoke';
  if (next === 'referred' || prev === 'referred') return 'referred';
  return next;
}

function customerById(customerId: string): Record<string, unknown> | null {
  if (!customerId) return null;
  const store = getDataStore();
  return (
    (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId)
    || null
  );
}

/**
 * True when the referred person belongs on the current restaurant
 * (same customerId / same restaurant name) rather than a new venue lead.
 */
export function resolveSameVenueCustomer(input: {
  referredByCustomerId?: string;
  referredByVenue?: string;
  name?: string;
  phone?: string;
}): Record<string, unknown> | null {
  const store = getDataStore();
  const byId = input.referredByCustomerId
    ? customerById(String(input.referredByCustomerId))
    : null;

  if (input.phone) {
    const lookup = lookupContactByPhone(String(input.phone));
    if (lookup.found && lookup.customerId) {
      const byPhone = customerById(String(lookup.customerId));
      if (byPhone && byId && String(byPhone.id) !== String(byId.id)) return null;
      if (byPhone && byId) return byId;
      if (byPhone) return byPhone;
    }
  }

  if (!byId) return null;

  const currentName = normName(byId.name);
  const venue = normName(input.referredByVenue);
  if (venue && currentName && venue !== currentName) return null;

  const named = normName(input.name);
  if (named && currentName && named !== currentName) {
    const other = (store.customers as Array<Record<string, unknown>>).find(
      (c) => String(c.id) !== String(byId.id) && normName(c.name) === named,
    );
    if (other) return null;
  }

  return byId;
}

export function listVenuePeople(
  customerId: string,
  customer?: Record<string, unknown> | null,
): VenuePerson[] {
  const store = getDataStore();
  const cust = customer || customerById(customerId);
  const people: VenuePerson[] = [];
  const seen = new Set<string>();

  for (const c of store.contacts) {
    if (String(c.customerId) !== customerId) continue;
    const name = String(c.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const howKnown: VenuePersonHowKnown = c.howKnown === 'referred' ? 'referred' : 'spoke';
    people.push({
      name,
      role: c.role != null && String(c.role).trim() ? String(c.role) : undefined,
      phone: c.phone != null && String(c.phone).trim() ? String(c.phone) : undefined,
      howKnown,
      note: c.note != null ? String(c.note) : c.notes != null ? String(c.notes) : undefined,
      lastHeard: c.lastHeard != null ? String(c.lastHeard) : undefined,
    });
  }

  const fallback = String(cust?.contactName || '').trim();
  if (fallback && !seen.has(fallback.toLowerCase())) {
    people.unshift({
      name: fallback,
      role: cust?.contactRole != null && String(cust.contactRole).trim()
        ? String(cust.contactRole)
        : undefined,
      phone: cust?.phone != null && String(cust.phone).trim() ? String(cust.phone) : undefined,
      howKnown: 'spoke',
    });
  }

  return people;
}

export function formatPeopleMemoryLines(
  customerId: string,
  customer?: Record<string, unknown> | null,
): string[] {
  const people = listVenuePeople(customerId, customer);
  if (!people.length) return [];
  const lines = ['PEOPLE ON THIS ACCOUNT:'];
  for (const p of people) {
    const role = p.role ? ` (${p.role})` : '';
    const phone = p.phone ? ` ${p.phone}` : '';
    lines.push(`- ${p.name}${role}${phone} — ${p.howKnown}`);
  }
  return lines;
}

export function rememberPerson(input: RememberPersonInput): RememberPersonResult {
  const customerId = String(input.customerId || '').trim();
  const name = String(input.name || '').trim();
  if (!customerId || !name) {
    return { ok: false, contact: null, customer: null, error: 'name_and_customer_required' };
  }

  const customer = customerById(customerId);
  if (!customer) {
    return { ok: false, contact: null, customer: null, error: 'customer_not_found' };
  }

  const store = getDataStore();
  const existing = store.contacts.find((c) => {
    if (String(c.customerId) !== customerId) return false;
    if (phonesMatch(c.phone, input.phone)) return true;
    if (normName(c.name) === normName(name)) return true;
    return false;
  }) as Record<string, unknown> | undefined;

  const howKnown = mergeHowKnown(existing?.howKnown, input.howKnown || 'spoke');
  const becomingPrimary = Boolean(input.setPrimary) || !String(customer.contactName || '').trim();
  const isPrimary = becomingPrimary || existing?.isPrimary === true;

  if (becomingPrimary) {
    for (const c of store.contacts) {
      if (String(c.customerId) === customerId) c.isPrimary = false;
    }
  }

  const now = new Date().toISOString();
  const contact = saveContactRecord({
    ...(existing || {}),
    id: existing?.id,
    customerId,
    name,
    role: input.role != null && String(input.role).trim()
      ? String(input.role).trim()
      : existing?.role,
    phone: input.phone != null && String(input.phone).trim()
      ? String(input.phone).trim()
      : existing?.phone,
    howKnown,
    note: input.note != null ? String(input.note).slice(0, 400) : existing?.note,
    notes: input.note != null ? String(input.note).slice(0, 400) : existing?.notes,
    isPrimary,
    lastHeard: now,
  });

  let savedCustomer = customer;
  if (isPrimary) {
    savedCustomer = saveCustomerRecord({
      ...customer,
      id: customerId,
      contactName: name,
      ...(input.role ? { contactRole: String(input.role).trim() } : {}),
    });
  }

  return { ok: true, contact, customer: savedCustomer };
}
