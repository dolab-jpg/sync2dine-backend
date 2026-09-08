/**
 * Local process + production Supabase: getMenu catalog, deal expand totals,
 * delivery gate, placeFoodOrder — after home-org fix.
 *
 * Run: npx tsx scripts/local-prod-meal-deal-smoke.ts
 */
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

const fileEnv = loadEnv(resolve('.env'));
for (const [k, v] of Object.entries(fileEnv)) {
  if (!process.env[k]) process.env[k] = v;
}
process.env.HOME_ORG_ID = process.env.HOME_ORG_ID || 'c2887ddb-0cba-4df1-9086-e7399c92d159';

const { getHomeOrgId } = await import('../server/home-org');
const { listMenuItemsForOrg, expandMealDealOrderItems } = await import('../server/menu-catalog');
const { matchDeliveryPostcode, normalizeDeliveryPrefixes } = await import('../server/delivery-areas');
const { executePhoneTool } = await import('../server/phone-tools');
const { setRequestOrgId, getDataStore, updateAgentSettings } = await import('../server/data-store');

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

const orgId = getHomeOrgId();
console.log('home org', orgId);
setRequestOrgId(orgId);

const menu = await listMenuItemsForOrg(orgId);
console.log('menu items', menu.length);
const deal = menu.find((m) => m.deal?.roles?.length);
if (!deal) fail('no deal on catalog');
console.log('deal', deal.name, deal.price, deal.deal!.roles.map((r) => r.role).join('+'));

const unit1: Record<string, string> = {};
const unit2: Record<string, string> = {};
for (const role of deal.deal!.roles) {
  unit1[role.role] = role.choices[0];
  unit2[role.role] = role.choices[Math.min(1, role.choices.length - 1)];
}
const expanded = expandMealDealOrderItems(
  [{ name: deal.name, qty: 2, dealChoices: [unit1, unit2] }],
  menu,
);
if (!expanded.ok) fail(JSON.stringify(expanded));
const expectedLines = 2 * deal.deal!.roles.length;
if (expanded.items.length !== expectedLines) fail(`lines ${expanded.items.length} != ${expectedLines}`);
console.log('ok expand', expanded.items.map((i) => `${i.dealIndex}:${i.role}:${i.name}`).join(' | '));

const expectedTotal = Math.round(deal.price * 2 * 100) / 100;

// Ensure delivery prefixes for gate test (in-memory / disk for this process)
updateAgentSettings({
  deliveryPostcodePrefixes: ['B1', 'B11', 'B15'],
  deliveryNotes: 'Smoke-test delivery area',
});
const prefixes = normalizeDeliveryPrefixes(getDataStore().agentSettings?.deliveryPostcodePrefixes);
console.log('prefixes', prefixes);

const inOk = matchDeliveryPostcode('B11 2TT', prefixes);
const outOk = matchDeliveryPostcode('M1 1AE', prefixes);
if (!inOk.ok || inOk.matchedPrefix !== 'B11') fail(`B11 match ${JSON.stringify(inOk)}`);
if (outOk.ok) fail('M1 should be out');
console.log('ok delivery match B11 / reject M1');

const orch = { orgId, callId: `local-smoke-${Date.now()}`, partyPhone: '+447700900999' };

const checkIn = await executePhoneTool('checkDeliveryArea', { postcode: 'B1 1AA' }, orch);
if (!(checkIn as { ok?: boolean }).ok) fail(`check in ${JSON.stringify(checkIn)}`);
const checkOut = await executePhoneTool('checkDeliveryArea', { postcode: 'M1 1AE' }, orch);
if ((checkOut as { ok?: boolean }).ok) fail(`check out should fail ${JSON.stringify(checkOut)}`);
console.log('ok checkDeliveryArea tool');

const badPlace = await executePhoneTool(
  'placeFoodOrder',
  {
    orderType: 'delivery',
    postcode: 'M1 1AE',
    deliveryAddress: '1 Far',
    allergyConfirmed: true,
    customerAllergies: 'none',
    customerName: 'Local Smoke',
    items: [{ name: deal.name, qty: 2, dealChoices: [unit1, unit2] }],
  },
  orch,
);
if ((badPlace as { ok?: boolean }).ok || (badPlace as { error?: string }).error !== 'out_of_delivery_area') {
  fail(`expected out_of_delivery_area got ${JSON.stringify(badPlace).slice(0, 300)}`);
}
console.log('ok place blocked out of area');

const placed = await executePhoneTool(
  'placeFoodOrder',
  {
    orderType: 'delivery',
    postcode: 'B11 2AA',
    deliveryAddress: '12 Smoke Street',
    allergyConfirmed: true,
    customerAllergies: 'none',
    customerName: 'Local Smoke Deal',
    customerPhone: '+447700900999',
    items: [{ name: deal.name, qty: 2, dealChoices: [unit1, unit2] }],
  },
  orch,
) as {
  ok?: boolean;
  total?: number;
  orderNumber?: string | number;
  spokenTotal?: string;
  orderId?: string;
  error?: string;
  spokenHint?: string;
};
if (!placed.ok) fail(`place failed ${placed.error} ${placed.spokenHint}`);
if (Number(placed.total) !== expectedTotal) fail(`total ${placed.total} != ${expectedTotal}`);
console.log('ok placed', placed.orderNumber, 'total', placed.total, placed.spokenTotal);

const getMenu = await executePhoneTool('getMenu', {}, orch) as { menu?: Array<{ name: string; deal?: unknown }> };
const menuDeal = (getMenu.menu || []).find((m) => m.name === deal.name);
if (!menuDeal?.deal) fail('getMenu missing deal metadata');
console.log('ok getMenu deal roles present');

console.log('ALL LOCAL-PROD PASS');
