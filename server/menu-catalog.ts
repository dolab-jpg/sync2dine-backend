/**
 * Sync2Dine food menu ↔ Supabase public.products (service role).
 * The FE Menu tab and demo seed write rows as { org_id, id, data jsonb }.
 * The phone/kiosk agent reads the same rows through getMenu so editing
 * /menu changes what Judie offers on the next call.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  type AllergenCode,
  type DietaryCode,
  normalizeAllergenFields,
} from './allergens';
import { resolveOrdersOrgId } from './supabase-orders';

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

export interface MealDealRole {
  role: string;
  qtyPerDeal: number;
  choices: string[];
}

export interface MealDeal {
  roles: MealDealRole[];
}

/** Optional / required upgrade group on a dish (stuffed crust, package side, etc.). */
export interface MenuOptionChoice {
  name: string;
  priceDelta: number;
}

export interface MenuOptionGroup {
  role: string;
  required?: boolean;
  choices: MenuOptionChoice[];
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
  description?: string;
  image?: string;
  available?: boolean;
  allergensContains: AllergenCode[];
  allergensMayContain: AllergenCode[];
  dietary?: DietaryCode[];
  allergenNotes?: string;
  allergenDeclared?: boolean;
  /** When set, this special expands into component kitchen lines on placeFoodOrder. */
  deal?: MealDeal;
  /** Paid / free upgrades Judie can offer (crust, dips, package sides). */
  options?: MenuOptionGroup[];
  /** POS catalog ids — e.g. Square item variation id */
  externalIds?: { square?: string; epos_now?: string };
}

/** Connector / partner menu export shape (includes allergens). */
export interface MenuExportItem {
  id: string;
  name: string;
  category: string;
  price: number;
  description?: string;
  available: boolean;
  allergensContains: AllergenCode[];
  allergensMayContain: AllergenCode[];
  dietary?: DietaryCode[];
  allergenNotes?: string;
  allergenDeclared?: boolean;
  deal?: MealDeal;
  options?: MenuOptionGroup[];
  externalIds?: { square?: string; epos_now?: string };
}

export type OrderLineInput = {
  name: string;
  qty?: number;
  price?: number;
  /** Per-unit role → dish name, length === qty for meal deals. */
  dealChoices?: Array<Record<string, string>>;
  /** role → chosen upgrade name for this line (applies to each qty unit). */
  optionChoices?: Record<string, string>;
  dealName?: string;
  dealIndex?: number;
  role?: string;
};

const FOOD_CATEGORIES = new Set(['starters', 'mains', 'sides', 'drinks', 'desserts', 'specials', 'other']);
// BD legacy bathroom catalog categories — never read these as food. We filter by
// category (not tradeId) because the FE product migration historically stamped
// tradeId:'bathroom' onto every synced row, including food.
const BATHROOM_CATEGORIES = new Set(['toilet', 'basin', 'shower', 'bath', 'tap', 'accessory', 'tile']);

function parseDeal(raw: unknown): MealDeal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rolesRaw = (raw as { roles?: unknown }).roles;
  if (!Array.isArray(rolesRaw) || !rolesRaw.length) return undefined;
  const roles: MealDealRole[] = [];
  for (const row of rolesRaw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const role = String(r.role ?? '').trim().toLowerCase();
    if (!role) continue;
    const choices = Array.isArray(r.choices)
      ? r.choices.map((c) => String(c ?? '').trim()).filter(Boolean)
      : [];
    if (!choices.length) continue;
    const qtyPerDeal = Math.max(1, Number(r.qtyPerDeal ?? 1) || 1);
    roles.push({ role, qtyPerDeal, choices });
  }
  return roles.length ? { roles } : undefined;
}

export function parseMenuOptions(raw: unknown): MenuOptionGroup[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const groups: MenuOptionGroup[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const role = String(r.role ?? '').trim().toLowerCase();
    if (!role) continue;
    const choicesRaw = Array.isArray(r.choices) ? r.choices : [];
    const choices: MenuOptionChoice[] = [];
    for (const c of choicesRaw) {
      if (typeof c === 'string') {
        const name = c.trim();
        if (name) choices.push({ name, priceDelta: 0 });
        continue;
      }
      if (!c || typeof c !== 'object') continue;
      const choice = c as Record<string, unknown>;
      const name = String(choice.name ?? '').trim();
      if (!name) continue;
      const priceDelta = Number(choice.priceDelta ?? choice.price ?? 0);
      choices.push({
        name,
        priceDelta: Number.isFinite(priceDelta) ? Math.round(priceDelta * 100) / 100 : 0,
      });
    }
    if (!choices.length) continue;
    groups.push({
      role,
      required: r.required === true,
      choices,
    });
  }
  return groups.length ? groups : undefined;
}

function rowToMenuItem(id: string, data: Record<string, unknown>): MenuItem | null {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return null;
  const catRaw = typeof data.category === 'string' ? data.category.trim().toLowerCase() : '';
  if (BATHROOM_CATEGORIES.has(catRaw)) return null;
  if (data.available === false) return null;
  const price = Number(data.price ?? data.sellPrice ?? data.basePrice ?? NaN);
  if (!Number.isFinite(price) || price < 0) return null;
  const rawCategory = typeof data.category === 'string' ? data.category.trim().toLowerCase() : '';
  const category = FOOD_CATEGORIES.has(rawCategory) ? rawCategory : 'other';
  const deal = parseDeal(data.deal);
  const options = parseMenuOptions(data.options);
  const allergens = normalizeAllergenFields(data);
  const externalIdsRaw = (data.externalIds && typeof data.externalIds === 'object')
    ? data.externalIds as Record<string, unknown>
    : {};
  const squareId = typeof externalIdsRaw.square === 'string' ? externalIdsRaw.square.trim() : '';
  const eposId = typeof externalIdsRaw.epos_now === 'string' ? externalIdsRaw.epos_now.trim() : '';
  const externalIds = (squareId || eposId)
    ? {
        ...(squareId ? { square: squareId } : {}),
        ...(eposId ? { epos_now: eposId } : {}),
      }
    : undefined;
  return {
    id,
    name,
    category,
    price,
    available: data.available !== false,
    description: typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined,
    image: typeof data.image === 'string' && data.image.trim() ? data.image.trim() : undefined,
    allergensContains: allergens.allergensContains,
    allergensMayContain: allergens.allergensMayContain,
    ...(allergens.dietary.length ? { dietary: allergens.dietary } : {}),
    ...(allergens.allergenNotes ? { allergenNotes: allergens.allergenNotes } : {}),
    ...(allergens.allergenDeclared ? { allergenDeclared: true } : {}),
    ...(deal ? { deal } : {}),
    ...(options ? { options } : {}),
    ...(externalIds ? { externalIds } : {}),
  };
}

export function menuItemToExport(item: MenuItem): MenuExportItem {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    price: item.price,
    description: item.description,
    available: item.available !== false,
    allergensContains: item.allergensContains ?? [],
    allergensMayContain: item.allergensMayContain ?? [],
    dietary: item.dietary,
    allergenNotes: item.allergenNotes,
    allergenDeclared: item.allergenDeclared,
    deal: item.deal,
    options: item.options,
    externalIds: item.externalIds,
  };
}

/** Set or clear POS external ids on a menu product row. */
export async function setMenuItemExternalIds(
  orgId: string | null | undefined,
  menuItemId: string,
  externalIds: { square?: string | null; epos_now?: string | null },
): Promise<{ ok: boolean; item?: MenuItem; error?: string }> {
  const client = getAdmin();
  const resolvedOrg = resolveOrdersOrgId(orgId);
  if (!client || !resolvedOrg) return { ok: false, error: 'Supabase not configured' };
  const id = menuItemId.trim();
  if (!id) return { ok: false, error: 'id required' };
  const { data, error } = await client.from('products').select('data').eq('org_id', resolvedOrg).eq('id', id).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'not found' };
  const existing = ((data as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const prev = (existing.externalIds && typeof existing.externalIds === 'object')
    ? { ...(existing.externalIds as Record<string, unknown>) }
    : {};
  if (externalIds.square === null) delete prev.square;
  else if (externalIds.square !== undefined) prev.square = String(externalIds.square).trim();
  if (externalIds.epos_now === null) delete prev.epos_now;
  else if (externalIds.epos_now !== undefined) prev.epos_now = String(externalIds.epos_now).trim();
  const nextData = { ...existing, externalIds: prev };
  if (!Object.keys(prev).length) delete nextData.externalIds;
  const { error: upErr } = await client.from('products').upsert(
    { org_id: resolvedOrg, id, data: nextData },
    { onConflict: 'org_id,id' },
  );
  if (upErr) return { ok: false, error: upErr.message };
  const item = rowToMenuItem(id, nextData);
  return item ? { ok: true, item } : { ok: false, error: 'saved but could not map item' };
}

export async function squareMenuCompleteness(orgId: string | null | undefined): Promise<{
  declared: number;
  total: number;
}> {
  const items = await listMenuItemsForOrg(orgId);
  const total = items.length;
  const declared = items.filter((i) => Boolean(i.externalIds?.square?.trim())).length;
  return { declared, total };
}

export async function exportMenuForOrg(orgId: string | null | undefined): Promise<{
  version: string;
  generatedAt: string;
  items: MenuExportItem[];
}> {
  const items = await listMenuItemsForOrg(orgId);
  const generatedAt = new Date().toISOString();
  const version = `${generatedAt.slice(0, 10)}-${items.length}`;
  return {
    version,
    generatedAt,
    items: items.map(menuItemToExport),
  };
}

/**
 * Live menu for an org from Supabase products. Returns [] when Supabase is
 * not configured, the org cannot be resolved, or the tenant has no food rows.
 */
export async function listMenuItemsForOrg(
  orgId: string | null | undefined,
  category?: string,
): Promise<MenuItem[]> {
  const client = getAdmin();
  const resolvedOrg = resolveOrdersOrgId(orgId);
  if (!client || !resolvedOrg) return [];
  const { data, error } = await client
    .from('products')
    .select('id, data')
    .eq('org_id', resolvedOrg);
  if (error || !data) return [];
  const items: MenuItem[] = [];
  for (const row of data) {
    const item = rowToMenuItem(String(row.id), (row.data ?? {}) as Record<string, unknown>);
    if (item) items.push(item);
  }
  const wanted = category?.trim().toLowerCase();
  const filtered = wanted
    ? items.filter((i) => i.category === wanted || i.name.toLowerCase().includes(wanted))
    : items;
  const order = ['starters', 'mains', 'sides', 'drinks', 'desserts', 'specials', 'other'];
  return filtered.sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name),
  );
}

function newProductId(): string {
  return randomUUID();
}

export async function upsertMenuItemForOrg(
  orgId: string | null | undefined,
  input: {
    id?: string;
    name: string;
    category?: string;
    price: number;
    description?: string;
    available?: boolean;
    image?: string;
    deal?: MealDeal | null;
    options?: MenuOptionGroup[] | null;
    allergensContains?: AllergenCode[];
    allergensMayContain?: AllergenCode[];
    dietary?: DietaryCode[];
    allergenNotes?: string;
    allergenDeclared?: boolean;
  },
): Promise<{ ok: boolean; item?: MenuItem; error?: string }> {
  const client = getAdmin();
  const resolvedOrg = resolveOrdersOrgId(orgId);
  if (!client || !resolvedOrg) return { ok: false, error: 'Supabase not configured' };
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, error: 'name required' };
  const price = Number(input.price);
  if (!Number.isFinite(price) || price < 0) return { ok: false, error: 'valid price required' };
  const catRaw = String(input.category ?? 'other').trim().toLowerCase();
  if (BATHROOM_CATEGORIES.has(catRaw)) return { ok: false, error: 'invalid food category' };
  const category = FOOD_CATEGORIES.has(catRaw) ? catRaw : 'other';
  const id = input.id?.trim() || newProductId();

  let existingData: Record<string, unknown> = {};
  if (input.id?.trim()) {
    const { data } = await client.from('products').select('data').eq('org_id', resolvedOrg).eq('id', id).maybeSingle();
    existingData = ((data as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  }

  const parsedDeal = input.deal === null ? undefined : input.deal !== undefined ? parseDeal(input.deal) : parseDeal(existingData.deal);
  const parsedOptions =
    input.options === null
      ? undefined
      : input.options !== undefined
        ? parseMenuOptions(input.options)
        : parseMenuOptions(existingData.options);

  const data: Record<string, unknown> = {
    ...existingData,
    name,
    category,
    price,
    basePrice: price,
    sellPrice: price,
    description: input.description != null ? String(input.description).trim() : (existingData.description ?? ''),
    available: input.available !== false,
    source: 'restaurant',
    tradeId: null,
    margin: typeof existingData.margin === 'number' ? existingData.margin : 0,
  };
  if (input.image != null) data.image = String(input.image);
  if (input.deal === null) {
    delete data.deal;
  } else if (parsedDeal) {
    data.deal = parsedDeal;
  }
  if (input.options === null) {
    delete data.options;
  } else if (parsedOptions) {
    data.options = parsedOptions;
  }

  const allergenInput: Record<string, unknown> = { ...existingData };
  if (input.allergensContains !== undefined) allergenInput.allergensContains = input.allergensContains;
  if (input.allergensMayContain !== undefined) allergenInput.allergensMayContain = input.allergensMayContain;
  if (input.dietary !== undefined) allergenInput.dietary = input.dietary;
  if (input.allergenNotes !== undefined) allergenInput.allergenNotes = input.allergenNotes;
  if (input.allergenDeclared !== undefined) allergenInput.allergenDeclared = input.allergenDeclared;
  const normalizedAllergens = normalizeAllergenFields(allergenInput);
  data.allergensContains = normalizedAllergens.allergensContains;
  data.allergensMayContain = normalizedAllergens.allergensMayContain;
  data.dietary = normalizedAllergens.dietary;
  if (normalizedAllergens.allergenNotes) data.allergenNotes = normalizedAllergens.allergenNotes;
  else delete data.allergenNotes;
  if (normalizedAllergens.allergenDeclared) data.allergenDeclared = true;
  else delete data.allergenDeclared;

  const { error } = await client.from('products').upsert(
    { org_id: resolvedOrg, id, data },
    { onConflict: 'org_id,id' },
  );
  if (error) return { ok: false, error: error.message };
  const item = rowToMenuItem(id, data);
  return item ? { ok: true, item } : { ok: false, error: 'saved but could not map item' };
}

export async function deleteMenuItemForOrg(
  orgId: string | null | undefined,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = getAdmin();
  const resolvedOrg = resolveOrdersOrgId(orgId);
  if (!client || !resolvedOrg) return { ok: false, error: 'Supabase not configured' };
  if (!id?.trim()) return { ok: false, error: 'id required' };
  const { error } = await client.from('products').delete().eq('org_id', resolvedOrg).eq('id', id.trim());
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export function findCatalogByName(catalog: MenuItem[], name: string): MenuItem | undefined {
  const needle = name.trim().toLowerCase();
  return catalog.find((c) => c.name.toLowerCase() === needle);
}

/** Closest catalog names for hard-reject hints (exact / contains / token overlap). */
export function findClosestCatalogNames(
  catalog: MenuItem[],
  name: string,
  limit = 3,
): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle || !catalog.length) return [];
  const needleTokens = new Set(needle.split(/\s+/).filter(Boolean));
  const scored = catalog
    .map((c) => {
      const n = c.name.toLowerCase();
      let score = 0;
      if (n === needle) score = 100;
      else if (n.includes(needle) || needle.includes(n)) score = 60;
      else {
        const tokens = n.split(/\s+/).filter(Boolean);
        score = tokens.filter((t) => needleTokens.has(t)).length * 15;
        if (tokens.some((t) => t.startsWith(needle.slice(0, 3)) || needle.startsWith(t.slice(0, 3)))) {
          score += 5;
        }
      }
      return { name: c.name, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of scored) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.name);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Expand meal-deal basket lines into flat kitchen lines.
 * Non-deal rows pass through. Incomplete dealChoices returns an error.
 */
export function expandMealDealOrderItems(
  rawItems: OrderLineInput[],
  catalog: MenuItem[],
): { ok: true; items: OrderLineInput[] } | { ok: false; error: string; spokenHint: string } {
  const out: OrderLineInput[] = [];

  for (const row of rawItems) {
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    const qty = Math.max(1, Number(row.qty ?? 1) || 1);
    const catalogItem = findCatalogByName(catalog, name);
    const deal = catalogItem?.deal;

    // Already expanded component lines (have role/dealName) — keep as-is.
    if (row.role || (row.dealName && !deal)) {
      out.push({
        name,
        qty,
        price: row.price != null ? Number(row.price) : catalogItem?.price,
        dealName: row.dealName,
        dealIndex: row.dealIndex,
        role: row.role,
      });
      continue;
    }

    if (!deal) {
      out.push({
        name,
        qty,
        price: row.price != null && Number(row.price) > 0 ? Number(row.price) : catalogItem?.price,
      });
      continue;
    }

    const units = Array.isArray(row.dealChoices) ? row.dealChoices : [];
    if (units.length < qty) {
      const needed = deal.roles.map((r) => r.role).join(', ');
      return {
        ok: false,
        error: 'deal_choices_required',
        spokenHint: `${name} is a meal deal — for each of the ${qty}, I need ${needed}. Tell me the choices for every set.`,
      };
    }

    for (let i = 0; i < qty; i++) {
      const unit = units[i] ?? {};
      for (const roleDef of deal.roles) {
        const roleKey = roleDef.role;
        const chosenRaw = String(
          unit[roleKey]
          ?? unit[roleKey.charAt(0).toUpperCase() + roleKey.slice(1)]
          ?? '',
        ).trim();
        if (!chosenRaw) {
          return {
            ok: false,
            error: 'deal_choice_missing',
            spokenHint: `For ${name} number ${i + 1}, which ${roleKey} would you like? Options: ${roleDef.choices.join(', ')}.`,
          };
        }
        const matchChoice = roleDef.choices.find((c) => c.toLowerCase() === chosenRaw.toLowerCase());
        if (!matchChoice) {
          return {
            ok: false,
            error: 'deal_choice_invalid',
            spokenHint: `For ${name}, ${chosenRaw} is not a ${roleKey} option. Choose from: ${roleDef.choices.join(', ')}.`,
          };
        }
        const component = findCatalogByName(catalog, matchChoice);
        const perDeal = Math.max(1, roleDef.qtyPerDeal || 1);
        out.push({
          name: matchChoice,
          qty: perDeal,
          price: component?.price ?? 0,
          dealName: catalogItem!.name,
          dealIndex: i + 1,
          role: roleKey,
        });
      }
    }
  }

  if (!out.length) {
    return { ok: false, error: 'items_required', spokenHint: 'Tell me what you would like to order first.' };
  }
  return { ok: true, items: out };
}

/**
 * Expand dish upgrades (crust, dips, package sides) into kitchen lines.
 * Meal-deal rows pass through unchanged for expandMealDealOrderItems.
 */
export function expandMenuOptions(
  rawItems: OrderLineInput[],
  catalog: MenuItem[],
):
  | { ok: true; items: OrderLineInput[]; surcharge: number }
  | { ok: false; error: string; spokenHint: string } {
  const out: OrderLineInput[] = [];
  let surcharge = 0;

  for (const row of rawItems) {
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    const qty = Math.max(1, Number(row.qty ?? 1) || 1);
    const catalogItem = findCatalogByName(catalog, name);

    // Already a component / option line, or a meal deal — leave for deal expander.
    if (row.role || row.dealName || catalogItem?.deal) {
      out.push({ ...row, name, qty });
      continue;
    }

    const groups = catalogItem?.options ?? [];
    if (!groups.length) {
      out.push({
        name,
        qty,
        price: row.price != null && Number(row.price) > 0 ? Number(row.price) : catalogItem?.price,
        dealChoices: row.dealChoices,
        optionChoices: row.optionChoices,
      });
      continue;
    }

    const chosen = row.optionChoices && typeof row.optionChoices === 'object'
      ? row.optionChoices
      : {};

    out.push({
      name,
      qty,
      price: row.price != null && Number(row.price) > 0 ? Number(row.price) : catalogItem?.price,
    });

    for (const group of groups) {
      const rawChoice = String(
        chosen[group.role]
          ?? chosen[group.role.charAt(0).toUpperCase() + group.role.slice(1)]
          ?? '',
      ).trim();
      if (!rawChoice) {
        if (group.required) {
          const opts = group.choices.map((c) => c.name).join(', ');
          return {
            ok: false,
            error: 'option_required',
            spokenHint: `For ${name}, which ${group.role} would you like? Options: ${opts}.`,
          };
        }
        continue;
      }
      const match = group.choices.find((c) => c.name.toLowerCase() === rawChoice.toLowerCase());
      if (!match) {
        const opts = group.choices.map((c) => c.name).join(', ');
        return {
          ok: false,
          error: 'option_invalid',
          spokenHint: `For ${name}, ${rawChoice} is not a ${group.role} option. Choose from: ${opts}.`,
        };
      }
      const delta = Number(match.priceDelta ?? 0) || 0;
      surcharge += delta * qty;
      out.push({
        name: match.name,
        qty,
        price: delta,
        role: group.role,
        dealName: name,
      });
    }
  }

  if (!out.length) {
    return { ok: false, error: 'items_required', spokenHint: 'Tell me what you would like to order first.' };
  }
  return { ok: true, items: out, surcharge: Math.round(surcharge * 100) / 100 };
}

/** Extra £ from selected upgrades on a raw basket line. */
export function optionSurchargeForLine(
  line: OrderLineInput,
  catalog: MenuItem[],
): number {
  const catalogItem = findCatalogByName(catalog, String(line.name ?? ''));
  const groups = catalogItem?.options ?? [];
  if (!groups.length || !line.optionChoices) return 0;
  const qty = Math.max(1, Number(line.qty ?? 1) || 1);
  let total = 0;
  for (const group of groups) {
    const rawChoice = String(
      line.optionChoices[group.role]
        ?? line.optionChoices[group.role.charAt(0).toUpperCase() + group.role.slice(1)]
        ?? '',
    ).trim();
    if (!rawChoice) continue;
    const match = group.choices.find((c) => c.name.toLowerCase() === rawChoice.toLowerCase());
    if (match) total += (Number(match.priceDelta ?? 0) || 0) * qty;
  }
  return Math.round(total * 100) / 100;
}
