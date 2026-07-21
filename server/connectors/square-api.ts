/**
 * Thin Square REST helpers (Orders + Catalog + OAuth + Locations).
 */

export type SquareEnv = 'sandbox' | 'production';

export function squareEnvironment(): SquareEnv {
  const raw = (process.env.SQUARE_ENVIRONMENT ?? process.env.SQUARE_ENV ?? 'sandbox').trim().toLowerCase();
  return raw === 'production' ? 'production' : 'sandbox';
}

export function squareApiBase(): string {
  return squareEnvironment() === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

export function squareAppCredentials(): { applicationId: string; applicationSecret: string } {
  return {
    applicationId: process.env.SQUARE_APPLICATION_ID?.trim() || '',
    applicationSecret: process.env.SQUARE_APPLICATION_SECRET?.trim() || '',
  };
}

export async function squareFetch<T = Record<string, unknown>>(
  path: string,
  opts: {
    accessToken: string;
    method?: string;
    body?: unknown;
  },
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const url = path.startsWith('http') ? path : `${squareApiBase()}${path}`;
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23',
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text().catch(() => '');
    let data: T | undefined;
    try {
      data = text ? JSON.parse(text) as T : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const errObj = data as { errors?: Array<{ detail?: string; code?: string }> } | undefined;
      const detail = errObj?.errors?.[0]?.detail
        || errObj?.errors?.[0]?.code
        || text.slice(0, 300)
        || res.statusText;
      return { ok: false, status: res.status, data, error: detail };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

export function buildSquareOAuthAuthorizeUrl(opts: {
  redirectUri: string;
  state: string;
}): string | null {
  const { applicationId } = squareAppCredentials();
  if (!applicationId) return null;
  const base = squareEnvironment() === 'production'
    ? 'https://connect.squareup.com/oauth2/authorize'
    : 'https://connect.squareupsandbox.com/oauth2/authorize';
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: [
      'ORDERS_WRITE',
      'ORDERS_READ',
      'ITEMS_READ',
      'MERCHANT_PROFILE_READ',
      'PAYMENTS_WRITE',
      'PAYMENTS_READ',
    ].join(' '),
    session: 'false',
    state: opts.state,
    redirect_uri: opts.redirectUri,
  });
  return `${base}?${params.toString()}`;
}

export async function exchangeSquareOAuthCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<{
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  merchantId?: string;
  error?: string;
}> {
  const { applicationId, applicationSecret } = squareAppCredentials();
  if (!applicationId || !applicationSecret) {
    return { ok: false, error: 'square_app_credentials_missing' };
  }
  const res = await fetch(`${squareApiBase()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      code: opts.code,
      grant_type: 'authorization_code',
      redirect_uri: opts.redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const errors = data.errors as Array<{ detail?: string }> | undefined;
    return { ok: false, error: errors?.[0]?.detail || `oauth_token_http_${res.status}` };
  }
  const expiresAt = data.expires_at != null
    ? String(data.expires_at)
    : data.expires_in != null
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : undefined;
  return {
    ok: true,
    accessToken: String(data.access_token ?? ''),
    refreshToken: data.refresh_token != null ? String(data.refresh_token) : undefined,
    expiresAt,
    merchantId: data.merchant_id != null ? String(data.merchant_id) : undefined,
  };
}

export async function refreshSquareAccessToken(refreshToken: string): Promise<{
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  error?: string;
}> {
  const { applicationId, applicationSecret } = squareAppCredentials();
  if (!applicationId || !applicationSecret) {
    return { ok: false, error: 'square_app_credentials_missing' };
  }
  const res = await fetch(`${squareApiBase()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const errors = data.errors as Array<{ detail?: string }> | undefined;
    return { ok: false, error: errors?.[0]?.detail || `oauth_refresh_http_${res.status}` };
  }
  return {
    ok: true,
    accessToken: String(data.access_token ?? ''),
    refreshToken: data.refresh_token != null ? String(data.refresh_token) : refreshToken,
    expiresAt: data.expires_at != null ? String(data.expires_at) : undefined,
  };
}

export type SquareLocation = {
  id: string;
  name: string;
  addressLine1?: string;
  locality?: string;
  postalCode?: string;
  country?: string;
  status?: string;
};

export async function listSquareLocations(accessToken: string): Promise<{
  ok: boolean;
  locations?: SquareLocation[];
  error?: string;
}> {
  const res = await squareFetch<{ locations?: Array<Record<string, unknown>> }>('/v2/locations', {
    accessToken,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const locations = (res.data?.locations ?? []).map((loc) => {
    const addr = (loc.address && typeof loc.address === 'object')
      ? loc.address as Record<string, unknown>
      : {};
    return {
      id: String(loc.id ?? ''),
      name: String(loc.name ?? loc.id ?? ''),
      addressLine1: addr.address_line_1 != null ? String(addr.address_line_1) : undefined,
      locality: addr.locality != null ? String(addr.locality) : undefined,
      postalCode: addr.postal_code != null ? String(addr.postal_code) : undefined,
      country: addr.country != null ? String(addr.country) : undefined,
      status: loc.status != null ? String(loc.status) : undefined,
    };
  }).filter((l) => l.id);
  return { ok: true, locations };
}

export type SquareCatalogVariation = {
  variationId: string;
  itemId: string;
  name: string;
  itemName: string;
  label: string;
};

export async function listSquareCatalogVariations(accessToken: string): Promise<{
  ok: boolean;
  variations?: SquareCatalogVariation[];
  error?: string;
}> {
  const variations: SquareCatalogVariation[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ types: 'ITEM' });
    if (cursor) qs.set('cursor', cursor);
    const res = await squareFetch<{
      objects?: Array<Record<string, unknown>>;
      cursor?: string;
    }>(`/v2/catalog/list?${qs.toString()}`, { accessToken });
    if (!res.ok) return { ok: false, error: res.error };
    for (const obj of res.data?.objects ?? []) {
      const itemData = (obj.item_data && typeof obj.item_data === 'object')
        ? obj.item_data as Record<string, unknown>
        : null;
      if (!itemData) continue;
      const itemName = String(itemData.name ?? '').trim() || 'Item';
      const itemId = String(obj.id ?? '');
      const vars = Array.isArray(itemData.variations) ? itemData.variations as Array<Record<string, unknown>> : [];
      for (const v of vars) {
        const vd = (v.item_variation_data && typeof v.item_variation_data === 'object')
          ? v.item_variation_data as Record<string, unknown>
          : {};
        const variationId = String(v.id ?? '');
        if (!variationId) continue;
        const varName = String(vd.name ?? 'Regular').trim();
        variations.push({
          variationId,
          itemId,
          name: varName,
          itemName,
          label: varName && varName !== 'Regular' ? `${itemName} — ${varName}` : itemName,
        });
      }
    }
    cursor = res.data?.cursor ? String(res.data.cursor) : undefined;
  } while (cursor);
  return { ok: true, variations };
}
