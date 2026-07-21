/**
 * Runtime: Judie upsell options via the same executePhoneTool path Vapi webhooks use.
 * Run: npx tsx --experimental-test-module-mocks scripts/debug-judie-upsell-webhook.mts
 */
import { mock } from 'node:test';

const menu = [
  {
    id: 'food-margherita-pizza',
    name: 'Margherita Pizza',
    category: 'mains',
    price: 9.5,
    allergensContains: ['gluten', 'milk'],
    allergensMayContain: [],
    allergenDeclared: true,
    options: [
      {
        role: 'crust',
        choices: [
          { name: 'Classic Crust', priceDelta: 0 },
          { name: 'Stuffed Crust', priceDelta: 2.5 },
        ],
      },
      {
        role: 'dip',
        choices: [
          { name: 'No dip', priceDelta: 0 },
          { name: 'Garlic Dip', priceDelta: 1 },
        ],
      },
    ],
  },
  {
    id: 'food-chicken-box',
    name: 'Chicken Box Meal',
    category: 'mains',
    price: 9,
    allergensContains: ['gluten'],
    allergensMayContain: [],
    allergenDeclared: true,
    options: [
      {
        role: 'side',
        required: true,
        choices: [
          { name: 'Coleslaw', priceDelta: 0 },
          { name: 'Baked Beans', priceDelta: 0 },
        ],
      },
    ],
  },
  {
    id: 'food-coleslaw',
    name: 'Coleslaw',
    category: 'sides',
    price: 2,
    allergensContains: [],
    allergensMayContain: [],
    allergenDeclared: true,
  },
];

const real = await import('../server/menu-catalog.ts');
mock.module('../server/menu-catalog.ts', {
  namedExports: {
    ...real,
    listMenuItemsForOrg: async () => menu,
  },
});

const { updateAgentSettings, saveCustomerRecord, getDataStore } = await import('../server/data-store.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');
const { buildPhoneBrainPrompt } = await import('../server/phone-brain.ts');

updateAgentSettings({ deliveryPostcodePrefixes: ['B11'], sayToday: 'Try stuffed crust tonight' });
const customer = saveCustomerRecord({
  name: 'Upsell Tester',
  phone: '+447500000022',
  email: 'upsell@example.com',
  address: '5 High Street, B11 1AA',
});
const body = {
  messages: [],
  callContext: { from: '+447500000022' },
  customerContext: {
    customerId: String(customer.id),
    name: 'Upsell Tester',
    phone: '+447500000022',
  },
};

const findings: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string) => {
  findings.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

const prompt = buildPhoneBrainPrompt({
  orgId: 'org',
  partyPhone: '+447500000022',
  direction: 'inbound',
});
check('playbook_upsell', prompt.instructions.includes('HARD RULE — UPSELL'), 'upsell hard rule present');
check('playbook_options', prompt.instructions.includes('optionChoices'), 'optionChoices in playbook');

const menuRes = (await executePhoneTool('getMenu', {}, body as never)) as Record<string, unknown>;
const menuItems = Array.isArray(menuRes.menu) ? (menuRes.menu as Array<Record<string, unknown>>) : [];
const pizza = menuItems.find((m) => m.name === 'Margherita Pizza');
check('getMenu_options', Array.isArray(pizza?.options) && (pizza?.options as unknown[]).length >= 1, JSON.stringify(pizza?.options)?.slice(0, 120) ?? 'missing');

const missingSide = (await executePhoneTool(
  'placeFoodOrder',
  {
    customerName: 'Upsell Tester',
    customerPhone: '+447500000022',
    orderType: 'collection',
    items: [{ name: 'Chicken Box Meal', qty: 1 }],
    allergyConfirmed: true,
    customerAllergies: 'none',
  },
  body as never,
)) as Record<string, unknown>;
check('required_side', missingSide.error === 'option_required', String(missingSide.error));

const pizzaOrder = (await executePhoneTool(
  'placeFoodOrder',
  {
    customerName: 'Upsell Tester',
    customerPhone: '+447500000022',
    orderType: 'collection',
    items: [
      {
        name: 'Margherita Pizza',
        qty: 1,
        optionChoices: { crust: 'Stuffed Crust', dip: 'Garlic Dip' },
      },
    ],
    allergyConfirmed: true,
    customerAllergies: 'none',
  },
  body as never,
)) as Record<string, unknown>;
check('pizza_ok', pizzaOrder.ok === true, String(pizzaOrder.spokenHint));
check('pizza_total', Number(pizzaOrder.total) === 13, `total=${pizzaOrder.total} (expect 9.5+2.5+1)`);

const stored = (getDataStore().orders ?? []).find(
  (o) => String(o.orderNumber) === String(pizzaOrder.orderNumber),
);
const lines = Array.isArray(stored?.items) ? (stored!.items as Array<Record<string, unknown>>) : [];
check(
  'kitchen_lines',
  lines.some((l) => String(l.name) === 'Stuffed Crust' && String(l.role) === 'crust') &&
    lines.some((l) => String(l.name) === 'Garlic Dip'),
  JSON.stringify(lines.map((l) => ({ name: l.name, role: l.role, price: l.price }))),
);

const boxOrder = (await executePhoneTool(
  'placeFoodOrder',
  {
    customerName: 'Upsell Tester',
    customerPhone: '+447500000022',
    orderType: 'delivery',
    items: [
      {
        name: 'Chicken Box Meal',
        qty: 1,
        optionChoices: { side: 'Baked Beans' },
      },
    ],
    deliveryAddress: '5 High Street',
    postcode: 'B11 1AA',
    paymentStatus: 'card',
    allergyConfirmed: true,
    customerAllergies: 'none',
  },
  body as never,
)) as Record<string, unknown>;
check('box_ok', boxOrder.ok === true && boxOrder.paymentMethod === 'card', String(boxOrder.spokenHint));
const boxStored = (getDataStore().orders ?? []).find(
  (o) => String(o.orderNumber) === String(boxOrder.orderNumber),
);
const boxLines = Array.isArray(boxStored?.items) ? (boxStored!.items as Array<Record<string, unknown>>) : [];
check(
  'box_beans',
  boxLines.some((l) => String(l.name) === 'Baked Beans' && String(l.role) === 'side'),
  JSON.stringify(boxLines.map((l) => ({ name: l.name, role: l.role }))),
);

const failed = findings.filter((f) => !f.ok);
console.log('\nSUMMARY', JSON.stringify({ total: findings.length, failed: failed.length, failedIds: failed.map((f) => f.id) }));
if (failed.length) process.exit(1);
console.log('UPSELL WEBHOOK DEBUG OK');
