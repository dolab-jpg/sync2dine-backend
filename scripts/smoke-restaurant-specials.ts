/**
 * Smoke: delivery prefixes + customer specials for phone brain/tools.
 * Run: node --import tsx scripts/smoke-restaurant-specials.ts
 * (from sync2dine-backend)
 */
import { updateAgentSettings, saveCustomerRecord, getDataStore, getAgentSettings, resolveContactByPhone } from '../server/data-store.ts';
import { buildAccountBrainContext } from '../server/phone-brain.ts';
import { executePhoneTool } from '../server/phone-tools.ts';

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
    address: '1 Test Street',
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
      items: [{ name: 'Chicken biryani', qty: 1, price: 10 }],
      total: 10,
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
  const summary = {
    settingsPrefixes: settings.deliveryPostcodePrefixes,
    resolve: resolved.customerId,
    resolveName: resolved.customerName,
    contextHasSpecial,
    areaInArea: area.inArea,
    orderTotal: order.total,
    orderSpecial: order.specialName,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('store customers', getDataStore().customers.length);

  const ok =
    Boolean(resolved.customerId) &&
    contextHasSpecial &&
    area.inArea === true &&
    order.total === 9 &&
    order.specialName === 'Family Friday';
  if (!ok) {
    console.error('SMOKE FAILED', summary);
    process.exit(1);
  }
  console.log('SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
