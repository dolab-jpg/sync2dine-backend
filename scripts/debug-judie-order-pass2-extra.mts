import { mock } from 'node:test';
const menu = [
  {
    id: 'deal-1',
    name: 'Mile a Meal',
    category: 'deals',
    price: 12,
    allergensContains: [],
    allergensMayContain: [],
    allergenDeclared: true,
    deal: {
      roles: [
        { role: 'main', qtyPerDeal: 1, choices: ['Chicken Tikka'] },
        { role: 'side', qtyPerDeal: 1, choices: ['Garlic Naan'] },
        { role: 'drink', qtyPerDeal: 1, choices: ['Coke'] },
      ],
    },
  },
  { id: '1', name: 'Chicken Tikka', category: 'mains', price: 9.5, allergensContains: [], allergensMayContain: [], allergenDeclared: true },
  { id: '2', name: 'Garlic Naan', category: 'sides', price: 3, allergensContains: ['gluten'], allergensMayContain: [], allergenDeclared: true },
  { id: '3', name: 'Coke', category: 'drinks', price: 1.8, allergensContains: [], allergensMayContain: [], allergenDeclared: true },
  // Undeclared allergen item — should block place
  { id: '4', name: 'Mystery Curry', category: 'mains', price: 8, allergensContains: [], allergensMayContain: [], allergenDeclared: false },
];
const real = await import('../server/menu-catalog.ts');
mock.module('../server/menu-catalog.ts', {
  namedExports: { ...real, listMenuItemsForOrg: async () => menu },
});
const { updateAgentSettings, saveCustomerRecord, getDataStore } = await import('../server/data-store.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');
const { buildVapiAssistantForParty } = await import('../server/vapi-assistant.ts');

updateAgentSettings({ deliveryPostcodePrefixes: ['B11'] });
const c = saveCustomerRecord({ name: 'Deal Guy', phone: '+447500000044', email: 'd@x.com', address: '1 High Street, B11 1AA' });
const body = { messages: [], callContext: { from: '+447500000044' }, customerContext: { customerId: String(c.id), name: 'Deal Guy', phone: '+447500000044' } };

const findings = [];
const check = (id, ok, detail) => { findings.push({ id, ok, detail }); console.log(`${ok?'PASS':'FAIL'} ${id}: ${detail}`); };

const incomplete = await executePhoneTool('placeFoodOrder', {
  customerName: 'Deal Guy', customerPhone: '+447500000044', orderType: 'collection',
  items: [{ name: 'Mile a Meal', qty: 1 }],
  allergyConfirmed: true, customerAllergies: 'none',
}, body);
check('deal_incomplete', incomplete.ok === false, String(incomplete.error || incomplete.spokenHint));

const complete = await executePhoneTool('placeFoodOrder', {
  customerName: 'Deal Guy', customerPhone: '+447500000044', orderType: 'collection',
  items: [{ name: 'Mile a Meal', qty: 1, dealChoices: [{ main: 'Chicken Tikka', side: 'Garlic Naan', drink: 'Coke' }] }],
  allergyConfirmed: true, customerAllergies: 'none',
}, body);
const order = (getDataStore().orders||[]).find(o => String(o.orderNumber) === String(complete.orderNumber));
check('deal_complete', complete.ok === true, String(complete.spokenHint));
check('deal_expanded', Array.isArray(order?.items) && order.items.length >= 3, JSON.stringify(order?.items?.map(i=>i.name)));

const undeclared = await executePhoneTool('placeFoodOrder', {
  customerName: 'Deal Guy', customerPhone: '+447500000044', orderType: 'collection',
  items: [{ name: 'Mystery Curry', qty: 1 }],
  allergyConfirmed: true, customerAllergies: 'none',
}, body);
check('undeclared_blocks', undeclared.error === 'allergen_review_required', String(undeclared.error));

// Vapi first message Judie for diner
process.env.VAPI_WEBHOOK_BASE_URL = process.env.VAPI_WEBHOOK_BASE_URL || 'https://example.com';
const vapi = await buildVapiAssistantForParty({ partyPhone: '+447500000044', direction: 'inbound', contactName: 'Deal Guy' });
check('vapi_name', String(vapi.assistant.name||vapi.assistantName||'').includes('Judie') || JSON.stringify(vapi).includes('Judie'), JSON.stringify({ name: vapi.assistant?.name, first: vapi.assistant?.firstMessage }).slice(0,200));
check('vapi_first', String(vapi.assistant?.firstMessage||'').includes('Judie'), String(vapi.assistant?.firstMessage));
check('vapi_tools_place', JSON.stringify(vapi.assistant).includes('placeFoodOrder'), 'has placeFoodOrder tool');
check('vapi_tools_payment_enum', JSON.stringify(vapi.assistant).includes('"cash"') && JSON.stringify(vapi.assistant).includes('"card"') && !JSON.stringify(vapi.assistant).includes('"unpaid"'), 'payment enum cash/card only');

const failed = findings.filter(f => !f.ok);
console.log('SUMMARY', JSON.stringify({ total: findings.length, failed: failed.length, failedIds: failed.map(f=>f.id) }));
if (failed.length) process.exit(1);
console.log('EXTRA OK');
