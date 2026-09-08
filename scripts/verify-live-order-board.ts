import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv(path: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = loadEnv(resolve('.env'));
const login = await (
  await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maya@demo.sync2dine.io', password: 'Sync2DineDemo1!' }),
  })
).json();

const orders = await (
  await fetch('https://app.sync2dine.io/api/orders', {
    headers: {
      Authorization: `Bearer ${login.access_token}`,
      'X-Org-Id': 'c2887ddb-0cba-4df1-9086-e7399c92d159',
    },
  })
).json();

const o = (orders.orders || []).find(
  (x: { orderNumber?: unknown; customerName?: string; customer?: string }) =>
    String(x.orderNumber) === '1015'
    || String(x.customerName || x.customer || '').includes('Meal Deal Smoke'),
);
if (!o) {
  console.error('FAIL order not found');
  process.exit(1);
}

const items = (o.items || []) as Array<Record<string, unknown>>;
const dealTagged = items.filter((i) => i.dealName);
const labels = items.map((row) => {
  const name = String(row.name ?? row.title ?? 'Item');
  const qty = Number(row.qty ?? 1) || 1;
  const role = row.role != null ? String(row.role) : '';
  const dealName = row.dealName != null ? String(row.dealName) : '';
  const dealIndex = row.dealIndex != null ? Number(row.dealIndex) : undefined;
  const roleHint = role ? ` (${role})` : '';
  const dealHint = dealName && dealIndex ? ` · ${dealName} #${dealIndex}` : dealName ? ` · ${dealName}` : '';
  return (qty > 1 ? `${qty}× ${name}` : name) + roleHint + dealHint;
});

console.log(
  JSON.stringify(
    {
      orderNumber: o.orderNumber,
      type: o.orderType || o.type,
      total: o.total,
      postcode: o.deliveryPostcode || o.postcode,
      lines: items.length,
      dealTagged: dealTagged.length,
      boardLabels: labels,
      amberBorderReady: dealTagged.length === items.length && items.length >= 6,
    },
    null,
    2,
  ),
);
if (items.length < 6 || dealTagged.length < 6) process.exit(1);
console.log('BOARD FIELDS PASS');
