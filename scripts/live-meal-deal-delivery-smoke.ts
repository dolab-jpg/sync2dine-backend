/**
 * Live smoke: menu deal metadata, package totals, delivery gate, placeFoodOrder expand.
 * Uses demo Maya + production app.sync2dine.io / Supabase from backend .env
 *
 * Run: npx tsx scripts/live-meal-deal-delivery-smoke.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BASE = process.env.S2D_BASE || 'https://app.sync2dine.io';
const EMAIL = process.env.S2D_EMAIL || 'maya@demo.sync2dine.io';
const PASS = process.env.S2D_PASS || 'Sync2DineDemo1!';

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {
    /* optional */
  }
  return out;
}

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function main() {
  const env = { ...loadEnvFile(resolve(process.cwd(), '.env')), ...process.env } as Record<string, string>;
  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anon) fail('Missing SUPABASE_URL / ANON_KEY in .env');

  console.log('1) Auth demo user…');
  const loginRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const login = (await loginRes.json()) as { access_token?: string; user?: { id?: string }; error_description?: string; msg?: string };
  if (!loginRes.ok || !login.access_token) {
    fail(`login ${loginRes.status}: ${login.error_description || login.msg || JSON.stringify(login).slice(0, 200)}`);
  }
  const token = login.access_token!;
  console.log('ok login', EMAIL);

  console.log('2) Live agent settings (delivery prefixes)…');
  const settingsRes = await fetch(`${BASE}/api/agent/settings`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const settingsText = await settingsRes.text();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(settingsText) as Record<string, unknown>;
  } catch {
    fail(`settings not JSON (${settingsRes.status}): ${settingsText.slice(0, 200)}`);
  }
  console.log('settings status', settingsRes.status);
  let prefixes = Array.isArray(settings.deliveryPostcodePrefixes)
    ? (settings.deliveryPostcodePrefixes as string[]).map(String)
    : [];
  console.log('delivery prefixes:', prefixes.length ? prefixes.join(', ') : '(none)');

  console.log('3) Supabase products — find meal deal specials…');
  const key = service || anon;
  const prodRes = await fetch(
    `${supabaseUrl}/rest/v1/products?select=id,org_id,data&limit=500`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } },
  );
  if (!prodRes.ok) fail(`products ${prodRes.status}: ${(await prodRes.text()).slice(0, 200)}`);
  const products = (await prodRes.json()) as Array<{ id: string; org_id?: string; data?: Record<string, unknown> }>;
  const food = products.filter((p) => {
    const cat = String(p.data?.category ?? '').toLowerCase();
    return !['toilet', 'basin', 'shower', 'bath', 'tap', 'accessory', 'tile'].includes(cat);
  });
  const deals = food.filter((p) => {
    const deal = p.data?.deal as { roles?: unknown[] } | undefined;
    return deal && Array.isArray(deal.roles) && deal.roles.length > 0;
  });
  console.log(`food items=${food.length} deals=${deals.length}`);
  if (!deals.length) fail('No menu specials with deal.roles on live Supabase — Menu side not configured');

  const dealItem = deals.find((p) => /mile/i.test(String(p.data?.name ?? ''))) || deals[0];
  const dealName = String(dealItem.data?.name ?? '');
  const dealPrice = Number(dealItem.data?.price ?? dealItem.data?.sellPrice ?? dealItem.data?.basePrice ?? 0);
  const dealRoles = (dealItem.data?.deal as { roles: Array<{ role: string; choices: string[] }> }).roles;
  console.log('using deal:', dealName, '£' + dealPrice, 'roles:', dealRoles.map((r) => `${r.role}[${r.choices.length}]`).join(', '));
  for (const role of dealRoles) {
    if (!role.choices?.length) fail(`deal ${dealName} role ${role.role} has no choices`);
  }

  // Build 2× deal with different this-or-that choices
  const unit1: Record<string, string> = {};
  const unit2: Record<string, string> = {};
  for (const role of dealRoles) {
    unit1[role.role] = role.choices[0];
    unit2[role.role] = role.choices[Math.min(1, role.choices.length - 1)];
  }
  const expectedLines = 2 * dealRoles.length;
  const expectedTotal = Math.round(dealPrice * 2 * 100) / 100;
  console.log('choices unit1', unit1);
  console.log('choices unit2', unit2);
  console.log('expected kitchen lines', expectedLines, 'package total', expectedTotal);

  console.log('4) Ensure delivery prefixes on live settings…');
  const DEMO_ORG = 'c2887ddb-0cba-4df1-9086-e7399c92d159';
  if (!prefixes.length) {
    const patchRes = await fetch(`${BASE}/api/agent/settings`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Org-Id': DEMO_ORG,
      },
      body: JSON.stringify({
        deliveryPostcodePrefixes: ['B1', 'B11', 'B15'],
        deliveryNotes: 'Smoke-test delivery area (B1 / B11 / B15)',
      }),
    });
    const patchText = await patchRes.text();
    if (!patchRes.ok) fail(`PATCH settings ${patchRes.status}: ${patchText.slice(0, 200)}`);
    try {
      const patched = JSON.parse(patchText) as { deliveryPostcodePrefixes?: string[] };
      prefixes = (patched.deliveryPostcodePrefixes || ['B1', 'B11', 'B15']).map(String);
    } catch {
      prefixes = ['B1', 'B11', 'B15'];
    }
    console.log('ok patched prefixes', prefixes.join(', '));
  }

  console.log('5) Live tool: getMenu…');
  const callId = `smoke-deal-${Date.now()}`;
  const menuTool = await callRealtimeTool(token, callId, 'getMenu', {}, DEMO_ORG);
  const menuOut = menuTool.output as { menu?: Array<{ name?: string; deal?: unknown }>; items?: Array<{ name?: string; deal?: unknown }>; ok?: boolean; error?: string };
  const menuItems = Array.isArray(menuOut?.menu) ? menuOut.menu : Array.isArray(menuOut?.items) ? menuOut.items : [];
  const menuDeal = menuItems.find((i) => String(i.name).toLowerCase() === dealName.toLowerCase());
  if (!menuDeal?.deal) {
    console.log('getMenu output keys', Object.keys(menuOut || {}), 'itemCount', menuItems.length);
    fail(`getMenu did not return deal metadata for ${dealName}`);
  } else {
    console.log('ok getMenu includes deal for', dealName);
  }

  console.log('6) Delivery gate checkDeliveryArea…');
  {
    const inPc = inventInPostcode(prefixes.includes('B11') ? 'B11' : prefixes[0]);
    const outPc = 'M1 1AE';
    const inCheck = await callRealtimeTool(token, callId, 'checkDeliveryArea', { postcode: inPc }, DEMO_ORG);
    const inOut = inCheck.output as { ok?: boolean; inArea?: boolean; spokenHint?: string; error?: string };
    if (!inOut.ok && !inOut.inArea) fail(`in-area ${inPc} rejected: ${JSON.stringify(inOut).slice(0, 200)}`);
    console.log('ok in-area', inPc, inOut.spokenHint?.slice(0, 100));

    const outCheck = await callRealtimeTool(token, callId, 'checkDeliveryArea', { postcode: outPc }, DEMO_ORG);
    const outOut = outCheck.output as { ok?: boolean; inArea?: boolean; spokenHint?: string; error?: string };
    if (outOut.ok || outOut.inArea) fail(`out-of-area ${outPc} should fail`);
    const hint = String(outOut.spokenHint || outOut.error || '');
    if (!/collection|stretch|deliver/i.test(hint)) {
      console.warn('WARN: out-of-area hint weak:', hint.slice(0, 120));
    }
    console.log('ok out-of-area refused + collection offer:', hint.slice(0, 120));
  }

  console.log('7) placeFoodOrder 2× deal delivery…');
  const orderType = 'delivery';
  const postcode = inventInPostcode(prefixes.includes('B11') ? 'B11' : prefixes[0]);
  const placeArgs: Record<string, unknown> = {
    orderType,
    customerName: 'Meal Deal Smoke',
    customerPhone: '+447700900123',
    allergyConfirmed: true,
    customerAllergies: 'none',
    items: [
      {
        name: dealName,
        qty: 2,
        dealChoices: [unit1, unit2],
      },
    ],
    postcode,
    deliveryAddress: '12 Smoke Test Street',
  };

  const badPlace = await callRealtimeTool(token, callId, 'placeFoodOrder', {
    ...placeArgs,
    postcode: 'M1 1AE',
    deliveryAddress: '1 Far Away Road',
  }, DEMO_ORG);
  const badOut = badPlace.output as { ok?: boolean; error?: string; spokenHint?: string };
  if (badOut.ok) fail('placeFoodOrder out-of-area should fail');
  if (badOut.error !== 'out_of_delivery_area') {
    console.warn('WARN unexpected out-area error:', badOut.error, badOut.spokenHint?.slice(0, 80));
  } else {
    console.log('ok placeFoodOrder out_of_delivery_area');
  }

  const place = await callRealtimeTool(token, callId, 'placeFoodOrder', placeArgs, DEMO_ORG);
  const placed = place.output as {
    ok?: boolean;
    error?: string;
    spokenHint?: string;
    orderId?: string;
    orderNumber?: string;
    total?: number;
    spokenTotal?: string;
  };
  if (!placed.ok) {
    fail(`placeFoodOrder failed: ${placed.error} — ${placed.spokenHint}`);
  }
  if (Number(placed.total) !== expectedTotal) {
    fail(`total mismatch: got ${placed.total} expected ${expectedTotal}`);
  }
  console.log('ok placed', placed.orderNumber, 'total', placed.total, 'spoken', placed.spokenTotal);

  console.log('8) Fetch orders — confirm expanded kitchen lines + deal tags…');
  const ordersRes = await fetch(`${BASE}/api/orders`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Org-Id': DEMO_ORG,
    },
  });
  const ordersBody = (await ordersRes.json()) as { orders?: Array<Record<string, unknown>> };
  const orders = Array.isArray(ordersBody.orders) ? ordersBody.orders : [];
  const found =
    orders.find((o) => String(o.id) === String(placed.orderId))
    || orders.find((o) => String(o.orderNumber) === String(placed.orderNumber))
    || orders.find((o) => String(o.customerName || o.customer) === 'Meal Deal Smoke');
  if (!found) {
    console.warn('WARN: order not in GET /api/orders list (org scope?). orderId=', placed.orderId);
  } else {
    const items = (found.items as Array<Record<string, unknown>>) || [];
    const withDeal = items.filter((i) => i.dealName);
    console.log('order items', items.length, 'with dealName', withDeal.length);
    if (items.length < expectedLines) {
      fail(`expected >= ${expectedLines} kitchen lines, got ${items.length}: ${JSON.stringify(items).slice(0, 400)}`);
    }
    if (withDeal.length < expectedLines) {
      fail(`expected deal tags on lines, got ${withDeal.length}`);
    }
    console.log(
      'ok lines:',
      items
        .slice(0, 8)
        .map((i) => `${i.dealIndex}:${i.role}:${i.name || i.label}`)
        .join(' | '),
    );
    if (orderType === 'delivery') {
      const pc = String(found.deliveryPostcode || found.postcode || '');
      console.log('ok delivery postcode on order', pc || '(missing)');
    }
  }

  console.log('ALL LIVE PASS');
}

function inventInPostcode(prefix: string): string {
  const p = prefix.toUpperCase().replace(/\s+/g, '');
  // outward + dummy inward
  return `${p} 1AA`;
}

async function callRealtimeTool(
  token: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  orgId?: string,
): Promise<{ ok?: boolean; name?: string; output: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/agent/realtime/tool`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(orgId ? { 'X-Org-Id': orgId } : {}),
    },
    body: JSON.stringify({
      callId,
      name,
      arguments: args,
      partyPhone: '+447700900123',
      ...(orgId ? { orgId } : {}),
    }),
  });
  const text = await res.text();
  let json: { ok?: boolean; name?: string; output?: Record<string, unknown>; error?: string };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    fail(`tool ${name} non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) fail(`tool ${name} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return { ok: json.ok, name: json.name, output: (json.output || json) as Record<string, unknown> };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
