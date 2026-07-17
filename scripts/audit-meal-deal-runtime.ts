/**
 * Runtime audit of Sync2Dine meal-deal / multi-item work.
 * Writes NDJSON to TradePro workspace debug-b00656.log
 */
import fs from 'fs';
import { listMenuItemsForOrg, expandMealDealOrderItems } from '../server/menu-catalog.ts';
import { listOrdersFromSupabase } from '../server/supabase-orders.ts';

const orgId = process.env.S2D_ORG_ID?.trim() || 'c2887ddb-0cba-4df1-9086-e7399c92d159';
const logPath =
  process.env.DEBUG_LOG_PATH?.trim() ||
  'c:/Users/dolab/Downloads/Bathroom Sales Estimation Platform/debug-b00656.log';

function log(hypothesisId: string, location: string, message: string, data: Record<string, unknown>) {
  const line = JSON.stringify({
    sessionId: 'b00656',
    runId: 's2d-audit',
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  });
  fs.appendFileSync(logPath, `${line}\n`);
  console.log(`[${hypothesisId}] ${message}`, JSON.stringify(data).slice(0, 240));
}

async function main() {
  const menu = await listMenuItemsForOrg(orgId);
  const mile = menu.find((m) => m.name.toLowerCase().includes('mile'));
  log('H1', 'menu-catalog:list', 'menu mile deal presence', {
    menuCount: menu.length,
    hasMile: Boolean(mile),
    dealRoles: mile?.deal?.roles?.map((r) => r.role) ?? null,
    milePrice: mile?.price ?? null,
  });

  const listed = await listOrdersFromSupabase(orgId);
  const orders = listed.orders ?? [];
  log('H2a', 'supabase-orders:list', 'listOrdersFromSupabase result', {
    ok: listed.ok,
    error: listed.error ?? null,
    count: orders.length,
  });
  const delivery = orders.filter((o) => String(o.orderType || o.type) === 'delivery');
  const huge = orders.filter(
    (o) =>
      String(o.notes || '').includes('Huge party') ||
      String(o.customerName || '').includes('Huge Party'),
  );
  const dealOrd = orders.filter(
    (o) =>
      String(o.notes || '').includes('Mile a Meal') ||
      String(o.specialName || '') === 'Mile a Meal',
  );
  const itemCounts = [...huge, ...dealOrd].map((o) => ({
    id: String(o.id).slice(0, 8),
    customer: o.customerName,
    n: Array.isArray(o.items) ? o.items.length : 0,
    type: o.orderType || o.type,
    status: o.status,
  }));
  log('H2', 'supabase-orders:list', 'seeded multi-item orders', {
    totalOrders: orders.length,
    deliveryCount: delivery.length,
    hugeOrDeal: itemCounts,
  });

  if (mile?.deal) {
    const exp = expandMealDealOrderItems(
      [
        {
          name: 'Mile a Meal',
          qty: 3,
          dealChoices: [
            { main: 'Chicken biryani', side: 'Pilau rice', drink: 'Coke' },
            { main: 'Butter chicken', side: 'Chips', drink: 'Mango lassi' },
            { main: 'Lamb curry', side: 'Garlic naan', drink: 'Coke' },
          ],
        },
      ],
      menu,
    );
    log('H3', 'expand:live-catalog', 'expand against live catalog', {
      ok: exp.ok,
      lines: exp.ok ? exp.items.length : null,
      error: exp.ok ? null : (exp as { error?: string }).error ?? null,
    });
  } else {
    log('H3', 'expand:live-catalog', 'skip expand — no mile deal on catalog', { hasMile: false });
  }

  let js = '';
  let hasDense = false;
  let hasDealMains = false;
  let htmlLen = 0;
  try {
    const html = await fetch('https://app.sync2dine.io/').then((r) => r.text());
    htmlLen = html.length;
    const jsMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
    if (jsMatch) {
      js = jsMatch[1];
      const body = await fetch(`https://app.sync2dine.io${js}`).then((r) => r.text());
      hasDense = body.includes('space-y-0.5') || body.includes('max-h-56');
      hasDealMains = body.includes('dealMains') || body.includes('Meal deal choices');
    }
  } catch (e) {
    log('H4', 'live-spa', 'live spa fetch failed', { error: String(e) });
  }
  log('H4', 'live-spa', 'live frontend bundle markers', {
    js,
    hasDenseUiHint: hasDense,
    hasDealMainsUi: hasDealMains,
    htmlLen,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
