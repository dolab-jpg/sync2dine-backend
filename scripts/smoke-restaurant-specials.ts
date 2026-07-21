/**
 * Smoke: delivery prefixes + customer specials for phone brain/tools.
 * Run: npx tsx --experimental-test-module-mocks scripts/smoke-restaurant-specials.ts
 */
import { mock } from 'node:test';

const menu = [
  {
    id: 'food-chicken-biryani',
    name: 'Chicken biryani',
    category: 'mains',
    price: 10,
    allergensContains: ['milk'],
    allergensMayContain: ['nuts'],
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

const {
  updateAgentSettings,
  saveCustomerRecord,
  getDataStore,
  getAgentSettings,
  resolveContactByPhone,
} = await import('../server/data-store.ts');
const { buildAccountBrainContext } = await import('../server/phone-brain.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');

async function main() {
  updateAgentSettings({
    deliveryPostcodePrefixes: ['B1', 'B11', 'CV1'],
    deliveryNotes: '£2.50 delivery, £15 minimum',
  });
  const settings = getAgentSettings();

  const customer = saveCustomerRecord({
    name: 'Smoke Special Customer',
    phone: '+447500000042',
    email: 'smoke-special@example.com',
    address: '1 Test Street, B11 1AA',
    status: 'won',
    specialName: 'Family Friday',
    specialDealNote: '10% off the whole order',
    notes: 'smoke test',
  });

  const resolved = resolveContactByPhone('+447500000042');
  const ctx = buildAccountBrainContext('+447500000042', resolved);

  const area = await executePhoneTool(
    'checkDeliveryArea',
    { postcode: 'B11 4AA' },
    { messages: [], callContext: { from: '+447500000042' } } as never,
  );

  const order = await executePhoneTool(
    'placeFoodOrder',
    {
      customerName: 'Smoke Special Customer',
      customerPhone: '+447500000042',
      customerId: customer.id,
      orderType: 'collection',
      specialName: 'Family Friday',
      items: [{ name: 'Chicken biryani', qty: 1 }],
      total: 10,
      allergyConfirmed: true,
      customerAllergies: 'none',
    },
    {
      messages: [],
      callContext: { from: '+447500000042' },
      customerContext: {
        customerId: String(customer.id),
        name: 'Smoke Special Customer',
        phone: '+447500000042',
      },
    } as never,
  );

  const contextHasSpecial = /CUSTOMER SPECIAL/i.test(ctx);
  const contextHasSavedAddress = /SAVED DELIVERY ADDRESS/i.test(ctx) && ctx.includes('1 Test Street');
  const summary = {
    settingsPrefixes: settings.deliveryPostcodePrefixes,
    resolve: resolved.customerId,
    resolveName: resolved.customerName,
    contextHasSpecial,
    contextHasSavedAddress,
    areaInArea: (area as { inArea?: boolean }).inArea,
    orderOk: (order as { ok?: boolean }).ok,
    orderTotal: (order as { total?: number }).total,
    orderSpecial: (order as { specialName?: string }).specialName,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('store customers', getDataStore().customers.length);

  const ok =
    Boolean(resolved.customerId) &&
    contextHasSpecial &&
    contextHasSavedAddress &&
    (area as { inArea?: boolean }).inArea === true &&
    (order as { ok?: boolean }).ok === true &&
    (order as { total?: number }).total === 9 &&
    (order as { specialName?: string }).specialName === 'Family Friday';
  if (!ok) {
    console.error('SMOKE FAILED', summary, order);
    process.exit(1);
  }
  console.log('SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
