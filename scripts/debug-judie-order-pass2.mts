/**
 * Second debug pass — edge cases around Judie ordering.
 * Run: npx tsx --experimental-test-module-mocks scripts/debug-judie-order-pass2.mts
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

let catalogOverride: typeof menu | null = menu;
const realCatalog = await import('../server/menu-catalog.ts');
mock.module('../server/menu-catalog.ts', {
  namedExports: {
    ...realCatalog,
    listMenuItemsForOrg: async () => catalogOverride ?? [],
  },
});

const {
  updateAgentSettings,
  saveCustomerRecord,
  getDataStore,
  resolveContactByPhone,
} = await import('../server/data-store.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');
const { buildAccountBrainContext, buildPhoneBrainPrompt } = await import('../server/phone-brain.ts');
const { buildBritishVoicePrompt } = await import('../server/british-voice.ts');
const { buildVapiAssistantConfig } = await import('../server/vapi-assistant.ts').catch(() => ({
  buildVapiAssistantConfig: null,
}));

updateAgentSettings({
  deliveryPostcodePrefixes: ['B11', 'B1'],
  deliveryNotes: 'Min 15',
  sayToday: 'Tonight: free poppadom',
});

const findings: Array<{ id: string; ok: boolean; detail: string }> = [];
function check(id: string, ok: boolean, detail: string) {
  findings.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

const phone = '+447500000088';
const customer = saveCustomerRecord({
  name: 'Edge Caller',
  phone,
  email: 'edge@example.com',
  address: '9 Oak Road, B11 1AA',
  status: 'won',
});

const noPcCustomer = saveCustomerRecord({
  name: 'No Postcode Caller',
  phone: '+447500000077',
  email: 'nopc@example.com',
  address: '12 Manor Lane',
  status: 'won',
});

const bodyFor = (id: string, from: string, name: string) => ({
  messages: [],
  callContext: { from },
  customerContext: { customerId: id, name, phone: from },
});

async function place(label: string, from: string, customerId: string, name: string, input: Record<string, unknown>) {
  const r = (await executePhoneTool(
    'placeFoodOrder',
    input,
    bodyFor(customerId, from, name) as never,
  )) as Record<string, unknown>;
  console.log(
    'CASE',
    label,
    JSON.stringify({
      ok: r.ok,
      error: r.error,
      paymentMethod: r.paymentMethod,
      deliveryAddress: r.deliveryAddress,
      notes: r.notes,
      spokenHint: String(r.spokenHint ?? '').slice(0, 160),
    }),
  );
  return r;
}

// 1) Out of area
{
  const r = await place('out_of_area', phone, String(customer.id), 'Edge Caller', {
    customerName: 'Edge Caller',
    customerPhone: phone,
    orderType: 'delivery',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    deliveryAddress: '1 High Street',
    postcode: 'SW1A 1AA',
    paymentStatus: 'cash',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('out_of_area', r.error === 'out_of_delivery_area', String(r.error));
}

// 2) Partial postcode only
{
  const r = await place('partial_pc', phone, String(customer.id), 'Edge Caller', {
    customerName: 'Edge Caller',
    customerPhone: phone,
    orderType: 'delivery',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    deliveryAddress: '1 High Street',
    postcode: 'B11',
    paymentStatus: 'cash',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('partial_pc', r.error === 'postcode_required', String(r.error));
}

// 3) Saved address with no postcode on file — should ask for postcode
{
  const ctx = buildAccountBrainContext('+447500000077', resolveContactByPhone('+447500000077'));
  check('nopc_ctx_offers', /SAVED DELIVERY ADDRESS/.test(ctx) && ctx.includes('12 Manor Lane'), 'offers street without inventing postcode');
  const r = await place('saved_no_pc', '+447500000077', String(noPcCustomer.id), 'No Postcode Caller', {
    customerName: 'No Postcode Caller',
    customerPhone: '+447500000077',
    orderType: 'delivery',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    useSavedAddress: true,
    paymentStatus: 'card',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('saved_no_pc', r.error === 'postcode_required', String(r.error));

  const r2 = await place('saved_plus_pc', '+447500000077', String(noPcCustomer.id), 'No Postcode Caller', {
    customerName: 'No Postcode Caller',
    customerPhone: '+447500000077',
    orderType: 'delivery',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    useSavedAddress: true,
    postcode: 'B11 2AA',
    paymentStatus: 'card',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('saved_plus_pc', r2.ok === true && String(r2.deliveryAddress).includes('Manor Lane'), String(r2.deliveryAddress));
}

// 4) Collection without payment preference should still work
{
  const r = await place('collection_ok', phone, String(customer.id), 'Edge Caller', {
    customerName: 'Edge Caller',
    customerPhone: phone,
    orderType: 'collection',
    items: [{ name: 'Garlic Naan', qty: 2 }],
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('collection_ok', r.ok === true && r.paymentMethod == null, `ok=${r.ok} pay=${r.paymentMethod}`);
}

// 5) Case-insensitive item + payment casing + parking note persisted
{
  const r = await place('case_pay_park', phone, String(customer.id), 'Edge Caller', {
    customerName: 'Edge Caller',
    customerPhone: phone,
    orderType: 'delivery',
    items: [{ name: 'chicken tikka', qty: 1 }],
    deliveryAddress: '9 Oak Road',
    postcode: 'b11 1aa',
    paymentStatus: 'CASH',
    parkingAccessNotes: 'blue door, bay 3',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  const order = (getDataStore().orders ?? []).find((o) => String(o.orderNumber) === String(r.orderNumber));
  const notes = String(order?.notes ?? '');
  check('case_item_pay', r.ok === true && r.paymentMethod === 'cash', String(r.spokenHint));
  check('parking_persisted', notes.includes('Parking/access: blue door, bay 3'), notes);
}

// 6) Empty catalog hard reject
{
  catalogOverride = [];
  const r = await place('empty_menu', phone, String(customer.id), 'Edge Caller', {
    customerName: 'Edge Caller',
    customerPhone: phone,
    orderType: 'collection',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('empty_menu', r.error === 'menu_unavailable', String(r.error));
  catalogOverride = menu;
}

// 7) useSavedAddress with no memory
{
  const ghostPhone = '+447500000066';
  const r = await place('no_saved', ghostPhone, 'missing', 'Ghost', {
    customerName: 'Ghost',
    customerPhone: ghostPhone,
    orderType: 'delivery',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    useSavedAddress: true,
    paymentStatus: 'cash',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check('no_saved', r.error === 'saved_address_unavailable', String(r.error));
}

// 8) Persona split — diner Judie, staff/british Lizzie
{
  const diner = buildPhoneBrainPrompt({ orgId: 'org', partyPhone: phone, direction: 'inbound' });
  const britCustomer = buildBritishVoicePrompt('cheeky', 'customer', undefined, 'phone');
  const britStaff = buildBritishVoicePrompt('cheeky', 'staff', undefined, 'phone_staff');
  check('diner_judie', diner.instructions.includes('You are Judie') && !/Your name is Lizzie/.test(diner.instructions), 'diner Judie');
  check('brit_customer_judie', britCustomer.includes('Judie') && !britCustomer.includes('Lizzie'), 'british customer Judie');
  check('brit_staff_lizzie', britStaff.includes('Lizzie') && !britStaff.includes('Judie'), 'british staff Lizzie');
}

// 9) Address embedded postcode only in deliveryAddress field
{
  const r = await place('addr_embedded_pc', phone, String(customer.id), 'Edge Caller', {
    customerName: 'Edge Caller',
    customerPhone: phone,
    orderType: 'delivery',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    deliveryAddress: '22 Elm Close, B11 3AA',
    paymentStatus: 'card',
    allergyConfirmed: true,
    customerAllergies: 'none',
  });
  check(
    'addr_embedded_pc',
    r.ok === true && String(r.deliveryAddress).includes('Elm Close') && String(r.deliveryAddress).includes('B11'),
    String(r.deliveryAddress),
  );
}

// 10) B1 must not match B11-only caller incorrectly — B1 1AA should match B1 chip
{
  const area = (await executePhoneTool(
    'checkDeliveryArea',
    { postcode: 'B1 1AA' },
    bodyFor(String(customer.id), phone, 'Edge Caller') as never,
  )) as Record<string, unknown>;
  check('b1_match', area.inArea === true && area.matchedPrefix === 'B1', JSON.stringify({ inArea: area.inArea, matchedPrefix: area.matchedPrefix }));
  const area2 = (await executePhoneTool(
    'checkDeliveryArea',
    { postcode: 'B12 1AA' },
    bodyFor(String(customer.id), phone, 'Edge Caller') as never,
  )) as Record<string, unknown>;
  check('b12_reject', area2.inArea === false || area2.ok === false, JSON.stringify({ ok: area2.ok, inArea: area2.inArea }));
}

if (typeof buildVapiAssistantConfig === 'function') {
  // optional — may need more env; ignore failures
}

const failed = findings.filter((f) => !f.ok);
console.log('\nSUMMARY', JSON.stringify({ total: findings.length, failed: failed.length, failedIds: failed.map((f) => f.id) }, null, 2));
if (failed.length) {
  console.error('DEBUG PASS2 FAILED');
  process.exit(1);
}
console.log('DEBUG PASS2 OK');
