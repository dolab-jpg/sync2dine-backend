/**
 * Runtime debug for Judie placeFoodOrder hardening.
 * Run: npx tsx --experimental-test-module-mocks scripts/debug-judie-order.mts
 */
import { mock } from 'node:test';

const menu = [
  {
    id: '1',
    name: 'Chicken Tikka',
    category: 'mains',
    price: 9.5,
    allergensContains: [],
    allergensMayContain: [],
    allergenDeclared: true,
  },
  {
    id: '2',
    name: 'Garlic Naan',
    category: 'sides',
    price: 3,
    allergensContains: ['gluten'],
    allergensMayContain: [],
    allergenDeclared: true,
  },
];

const realCatalog = await import('../server/menu-catalog.ts');
mock.module('../server/menu-catalog.ts', {
  namedExports: {
    ...realCatalog,
    listMenuItemsForOrg: async () => menu,
  },
});

const { updateAgentSettings, saveCustomerRecord, getDataStore, resolveContactByPhone } =
  await import('../server/data-store.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');
const { buildAccountBrainContext, buildPhoneBrainPrompt } = await import('../server/phone-brain.ts');

updateAgentSettings({
  deliveryPostcodePrefixes: ['B11', 'B1'],
  deliveryNotes: 'Min 15',
  sayToday: 'Free naan on orders over 20',
});

const customer = saveCustomerRecord({
  name: 'Debug Caller',
  phone: '+447500000099',
  email: 'debug@example.com',
  address: '14 High Street, B11 1AA',
  status: 'won',
  specialName: 'VIP',
  specialDealNote: '10% off',
});

const ctx = buildAccountBrainContext('+447500000099', resolveContactByPhone('+447500000099'));
const prompt = buildPhoneBrainPrompt({
  orgId: 'org',
  partyPhone: '+447500000099',
  direction: 'inbound',
});

const findings: Array<{ id: string; ok: boolean; detail: string }> = [];

function check(id: string, ok: boolean, detail: string) {
  findings.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

check('ctx_saved', /SAVED DELIVERY ADDRESS/.test(ctx), 'account memory has saved address block');
check('ctx_literal_bug', !ctx.includes('{address}'), 'must interpolate real address, not {address}');
check('ctx_real_addr', ctx.includes('14 High Street'), 'saved address text present');
check('prompt_judie', prompt.instructions.includes('You are Judie'), 'diner persona is Judie');
check('prompt_tonight', prompt.instructions.includes("TONIGHT'S OFFER"), 'Say today as tonight offer');
check('prompt_cash_card', prompt.instructions.includes('cash or card'), 'asks cash/card preference');
check('prompt_no_links', prompt.instructions.includes('payment links'), 'bans payment links');

const body = {
  messages: [],
  callContext: { from: '+447500000099' },
  customerContext: {
    customerId: String(customer.id),
    name: 'Debug Caller',
    phone: '+447500000099',
  },
};

async function run(label: string, input: Record<string, unknown>) {
  const r = (await executePhoneTool('placeFoodOrder', input, body as never)) as Record<string, unknown>;
  console.log(
    'CASE',
    label,
    JSON.stringify({
      ok: r.ok,
      error: r.error,
      paymentMethod: r.paymentMethod,
      total: r.total,
      deliveryAddress: r.deliveryAddress,
      spokenHint: String(r.spokenHint ?? '').slice(0, 140),
    }),
  );
  return r;
}

const failNoPay = await run('fail_no_pay', {
  customerName: 'Debug Caller',
  customerPhone: '+447500000099',
  orderType: 'delivery',
  items: [{ name: 'Chicken Tikka', qty: 1 }],
  deliveryAddress: '14 High Street',
  postcode: 'B11 1AA',
  allergyConfirmed: true,
  customerAllergies: 'none',
});
check('fail_no_pay', failNoPay.error === 'payment_preference_required', String(failNoPay.error));

const failBadAddr = await run('fail_bad_addr', {
  customerName: 'Debug Caller',
  customerPhone: '+447500000099',
  orderType: 'delivery',
  items: [{ name: 'Chicken Tikka', qty: 1 }],
  deliveryAddress: 'near station',
  postcode: 'B11 1AA',
  paymentStatus: 'cash',
  allergyConfirmed: true,
  customerAllergies: 'none',
});
check('fail_bad_addr', failBadAddr.error === 'street_address_required', String(failBadAddr.error));

const failUnknown = await run('fail_unknown', {
  customerName: 'Debug Caller',
  customerPhone: '+447500000099',
  orderType: 'collection',
  items: [{ name: 'Unicorn Stew', qty: 1 }],
  allergyConfirmed: true,
  customerAllergies: 'none',
});
check('fail_unknown', failUnknown.error === 'unknown_menu_item', String(failUnknown.error));

const okDelivery = await run('ok_delivery_cash', {
  customerName: 'Debug Caller',
  customerPhone: '+447500000099',
  orderType: 'delivery',
  items: [
    { name: 'Chicken Tikka', qty: 1 },
    { name: 'Garlic Naan', qty: 1 },
  ],
  deliveryAddress: '14 High Street',
  postcode: 'B11 1AA',
  paymentStatus: 'cash',
  parkingAccessNotes: 'bay outside',
  allergyConfirmed: true,
  customerAllergies: 'none',
});
check('ok_delivery', okDelivery.ok === true && okDelivery.paymentMethod === 'cash', String(okDelivery.spokenHint));
check(
  'ok_delivery_addr',
  String(okDelivery.deliveryAddress ?? '').includes('14 High Street') &&
    String(okDelivery.deliveryAddress ?? '').includes('B11'),
  String(okDelivery.deliveryAddress),
);

const okSaved = await run('ok_saved', {
  customerName: 'Debug Caller',
  customerPhone: '+447500000099',
  orderType: 'delivery',
  items: [{ name: 'Chicken Tikka', qty: 1 }],
  useSavedAddress: true,
  paymentStatus: 'card',
  allergyConfirmed: true,
  customerAllergies: 'none',
});
check('ok_saved', okSaved.ok === true && okSaved.paymentMethod === 'card', String(okSaved.spokenHint));

const cust = getDataStore().customers.find((c) => String(c.id) === String(customer.id));
check('special_kept', String(cust?.specialName ?? '') === 'VIP', String(cust?.specialName));
check('addr_saved_back', String(cust?.address ?? '').includes('High Street'), String(cust?.address));

const failed = findings.filter((f) => !f.ok);
console.log('\nSUMMARY', JSON.stringify({ total: findings.length, failed: failed.length, failedIds: failed.map((f) => f.id) }));
if (failed.length) process.exit(1);
console.log('DEBUG OK');
