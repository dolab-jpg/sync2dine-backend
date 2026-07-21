/**
 * Audit slice: guest CRM card + captureMessage + placeFoodOrder provider no-op.
 * Run: npx tsx --experimental-test-module-mocks scripts/debug-judie-audit-flow.mts
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
];
const real = await import('../server/menu-catalog.ts');
mock.module('../server/menu-catalog.ts', {
  namedExports: { ...real, listMenuItemsForOrg: async () => menu },
});

const {
  ensureGuestCustomerForCall,
  getDataStore,
  resolveContactByPhone,
  saveCustomerRecord,
} = await import('../server/data-store.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');

const findings: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string) => {
  findings.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};

const phone = '+447500000011';
const guest = ensureGuestCustomerForCall(phone, 'call-audit-1');
check('guest_created', Boolean(guest.customerId) && guest.isNew !== undefined, JSON.stringify(guest));

const resolved = resolveContactByPhone(phone);
check('guest_resolves', resolved.customerId === guest.customerId, String(resolved.customerId));

const body = {
  messages: [],
  callContext: { from: phone, callId: 'call-audit-1' },
  customerContext: { customerId: guest.customerId, name: 'Guest', phone },
};

const msg = (await executePhoneTool(
  'captureMessage',
  {
    department: 'kitchen',
    message: 'Please call back about allergy',
    callerName: 'Sam',
    urgency: 'high',
  },
  body as never,
)) as Record<string, unknown>;
check('message_captured', msg.captured === true && msg.customerId === guest.customerId, JSON.stringify(msg));

const cust = getDataStore().customers.find((c) => String(c.id) === String(guest.customerId));
const activities = Array.isArray(cust?.activities) ? (cust!.activities as Array<Record<string, unknown>>) : [];
check(
  'message_on_card',
  activities.some((a) => String(a.summary ?? '').includes('Message for kitchen')),
  JSON.stringify(activities.map((a) => a.summary).slice(0, 3)),
);

const complaint = (await executePhoneTool(
  'classifyCallIntent',
  { intent: 'complaint', reason: 'Cold food last time', confidence: 0.9 },
  { ...body, callId: 'call-audit-1' } as never,
)) as Record<string, unknown>;
check('complaint_intent', complaint.intent === 'complaint', JSON.stringify(complaint));
const activities2 = Array.isArray(
  getDataStore().customers.find((c) => String(c.id) === String(guest.customerId))?.activities,
)
  ? (getDataStore().customers.find((c) => String(c.id) === String(guest.customerId))!
      .activities as Array<Record<string, unknown>>)
  : [];
check(
  'complaint_on_card',
  activities2.some((a) => String(a.summary ?? '').includes('complaint')),
  JSON.stringify(activities2.map((a) => a.summary).slice(0, 5)),
);

const order = (await executePhoneTool(
  'placeFoodOrder',
  {
    customerName: 'Sam',
    customerPhone: phone,
    orderType: 'collection',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    allergyConfirmed: true,
    customerAllergies: 'none',
  },
  body as never,
)) as Record<string, unknown>;
check('order_ok', order.ok === true, String(order.spokenHint));
check('order_has_customer', order.customerId === guest.customerId, String(order.customerId));
check('provider_noop', order.providerChannel === 'none', String(order.providerChannel));
check('sync_local', order.syncState === 'local' || order.syncState == null, String(order.syncState));

// Fresh phone with no prior guest — placeFoodOrder must create card
const phone2 = '+447500000012';
const order2 = (await executePhoneTool(
  'placeFoodOrder',
  {
    customerName: 'Alex',
    customerPhone: phone2,
    orderType: 'collection',
    items: [{ name: 'Chicken Tikka', qty: 1 }],
    allergyConfirmed: true,
    customerAllergies: 'none',
  },
  {
    messages: [],
    callContext: { from: phone2 },
  } as never,
)) as Record<string, unknown>;
check('order_creates_guest', Boolean(order2.customerId), String(order2.customerId));
const resolved2 = resolveContactByPhone(phone2);
check('new_guest_persisted', Boolean(resolved2.customerId), String(resolved2.customerId));

void saveCustomerRecord; // keep import used if tree-shaken oddly

const failed = findings.filter((f) => !f.ok);
console.log('\nSUMMARY', JSON.stringify({ total: findings.length, failed: failed.length, failedIds: failed.map((f) => f.id) }));
if (failed.length) process.exit(1);
console.log('JUDIE AUDIT FLOW OK');
