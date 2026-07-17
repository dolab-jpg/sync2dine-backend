/**
 * Verify meal-deal expansion: 3× Mile a Meal → 9 kitchen lines.
 * Run: npx tsx scripts/verify-meal-deal-expand.ts
 */
import { expandMealDealOrderItems, type MenuItem } from '../server/menu-catalog';

const catalog: MenuItem[] = [
  { id: '1', name: 'Chicken biryani', category: 'mains', price: 9.5, allergensContains: [], allergensMayContain: [] },
  { id: '2', name: 'Butter chicken', category: 'mains', price: 11, allergensContains: [], allergensMayContain: [] },
  { id: '3', name: 'Lamb curry', category: 'mains', price: 10.5, allergensContains: [], allergensMayContain: [] },
  { id: '4', name: 'Pilau rice', category: 'sides', price: 2.8, allergensContains: [], allergensMayContain: [] },
  { id: '5', name: 'Chips', category: 'sides', price: 2.5, allergensContains: [], allergensMayContain: [] },
  { id: '6', name: 'Garlic naan', category: 'sides', price: 2.5, allergensContains: [], allergensMayContain: [] },
  { id: '7', name: 'Coke', category: 'drinks', price: 1.8, allergensContains: [], allergensMayContain: [] },
  { id: '8', name: 'Mango lassi', category: 'drinks', price: 3, allergensContains: [], allergensMayContain: [] },
  {
    id: '9',
    name: 'Mile a Meal',
    category: 'specials',
    price: 12.5,
    allergensContains: [],
    allergensMayContain: [],
    deal: {
      roles: [
        { role: 'main', qtyPerDeal: 1, choices: ['Chicken biryani', 'Butter chicken', 'Lamb curry'] },
        { role: 'side', qtyPerDeal: 1, choices: ['Pilau rice', 'Chips', 'Garlic naan'] },
        { role: 'drink', qtyPerDeal: 1, choices: ['Coke', 'Mango lassi'] },
      ],
    },
  },
];

const incomplete = expandMealDealOrderItems(
  [{ name: 'Mile a Meal', qty: 3 }],
  catalog,
);
if (incomplete.ok) {
  console.error('FAIL: expected deal_choices_required');
  process.exit(1);
}
console.log('ok incomplete:', incomplete.error);

const expanded = expandMealDealOrderItems(
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
  catalog,
);
if (!expanded.ok) {
  console.error('FAIL expand:', expanded);
  process.exit(1);
}
if (expanded.items.length !== 9) {
  console.error('FAIL expected 9 lines, got', expanded.items.length, expanded.items);
  process.exit(1);
}
const withDeal = expanded.items.filter((i) => i.dealName === 'Mile a Meal');
if (withDeal.length !== 9) {
  console.error('FAIL deal tags', withDeal.length);
  process.exit(1);
}
console.log('ok expand 3× Mile a Meal →', expanded.items.length, 'lines');
console.log(expanded.items.map((i) => `${i.dealIndex}:${i.role}:${i.name}`).join(' | '));

const plain = expandMealDealOrderItems(
  [{ name: 'Chicken biryani', qty: 2, price: 9.5 }, { name: 'Coke', qty: 1 }],
  catalog,
);
if (!plain.ok || plain.items.length !== 2) {
  console.error('FAIL plain items', plain);
  process.exit(1);
}
console.log('ok plain basket passthrough');
console.log('ALL PASS');
