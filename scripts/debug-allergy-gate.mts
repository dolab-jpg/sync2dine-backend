import { mock } from 'node:test';
const menu = [{
  id: '1', name: 'Chicken Tikka', category: 'mains', price: 9.5,
  allergensContains: [], allergensMayContain: [], allergenDeclared: true,
}];
const real = await import('../server/menu-catalog.ts');
mock.module('../server/menu-catalog.ts', {
  namedExports: { ...real, listMenuItemsForOrg: async () => menu },
});
const { updateAgentSettings, saveCustomerRecord } = await import('../server/data-store.ts');
const { executePhoneTool } = await import('../server/phone-tools.ts');
updateAgentSettings({ deliveryPostcodePrefixes: ['B11'] });
const c = saveCustomerRecord({ name: 'A', phone: '+447500000033', email: 'a@x.com', address: '1 High Street, B11 1AA' });
const body = {
  messages: [],
  callContext: { from: '+447500000033' },
  customerContext: { customerId: String(c.id), name: 'A', phone: '+447500000033' },
};
const r1 = await executePhoneTool('placeFoodOrder', {
  customerName: 'A', customerPhone: '+447500000033', orderType: 'collection',
  items: [{ name: 'Chicken Tikka', qty: 1 }],
}, body as never);
const r2 = await executePhoneTool('placeFoodOrder', {
  customerName: 'A', customerPhone: '+447500000033', orderType: 'collection',
  items: [{ name: 'Chicken Tikka', qty: 1 }], allergyConfirmed: true,
}, body as never);
const r3 = await executePhoneTool('placeFoodOrder', {
  customerName: 'A', customerPhone: '+447500000033', orderType: 'collection',
  items: [{ name: 'Chicken Tikka', qty: 1 }], allergyConfirmed: true, customerAllergies: 'none',
}, body as never);
const ok =
  (r1 as any).error === 'allergy_check_required' &&
  (r2 as any).error === 'allergy_check_required' &&
  (r3 as any).ok === true &&
  String((r1 as any).spokenHint).includes('allergies');
console.log(JSON.stringify({
  noConfirm: (r1 as any).error,
  confirmNoText: (r2 as any).error,
  ok: (r3 as any).ok,
  hint: (r1 as any).spokenHint,
  pass: ok,
}, null, 2));
if (!ok) process.exit(1);
console.log('ALLERGY GATE OK');
