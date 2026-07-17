/**
 * Sync2Dine food menu ↔ Supabase public.products (service role).
 * The FE Menu tab and demo seed write rows as { org_id, id, data jsonb }.
 * The phone/kiosk agent reads the same rows through getMenu so editing
 * /menu changes what Lizzie offers on the next call.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
  description?: string;
  image?: string;
}

const FOOD_CATEGORIES = new Set(['starters', 'mains', 'sides', 'drinks', 'desserts', 'specials', 'other']);

function rowToMenuItem(id: string, data: Record<string, unknown>): MenuItem | null {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return null;
  // Bathroom/trade catalog rows carry a tradeId — never read them as food.
  if (data.tradeId) return null;
  if (data.available === false) return null;
  const price = Number(data.price ?? data.sellPrice ?? data.basePrice ?? NaN);
  if (!Number.isFinite(price) || price < 0) return null;
  const rawCategory = typeof data.category === 'string' ? data.category.trim().toLowerCase() : '';
  const category = FOOD_CATEGORIES.has(rawCategory) ? rawCategory : 'other';
  return {
    id,
    name,
    category,
    price,
    description: typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined,
    image: typeof data.image === 'string' && data.image.trim() ? data.image.trim() : undefined,
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
