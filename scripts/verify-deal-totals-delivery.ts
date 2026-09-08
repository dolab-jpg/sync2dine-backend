/**
 * Verify: invalid deal choices, package totals (deal price × qty), delivery postcode gate.
 * Run: npx tsx scripts/verify-deal-totals-delivery.ts
 */
import { expandMealDealOrderItems, type MenuItem } from '../server/menu-catalog';
import { matchDeliveryPostcode } from '../server/delivery-areas';

const catalog: MenuItem[] = [
  { id: '1', name: 'Chicken biryani', category: 'mains', price: 9.5, allergensContains: [], allergensMayContain: [] },
  { id: '2', name: 'Butter chicken', category: 'mains', price: 11, allergensContains: [], allergensMayContain: [] },
  { id: '4', name: 'Pilau rice', category: 'sides', price: 2.8, allergensContains: [], allergensMayContain: [] },
  { id: '5', name: 'Chips', category: 'sides', price: 2.5, allergensContains: [], allergensMayContain: [] },
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
        { role: 'main', qtyPerDeal: 1, choices: ['Chicken biryani', 'Butter chicken'] },
        { role: 'side', qtyPerDeal: 1, choices: ['Pilau rice', 'Chips'] },
        { role: 'drink', qtyPerDeal: 1, choices: ['Coke', 'Mango lassi'] },
      ],
    },
  },
];

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

const invalid = expandMealDealOrderItems(
  [{ name: 'Mile a Meal', qty: 1, dealChoices: [{ main: 'Pizza', side: 'Pilau rice', drink: 'Coke' }] }],
  catalog,
);
if (invalid.ok || invalid.error !== 'deal_choice_invalid') fail(`expected deal_choice_invalid, got ${JSON.stringify(invalid)}`);
console.log('ok invalid choice:', invalid.error);

const missingRole = expandMealDealOrderItems(
  [{ name: 'Mile a Meal', qty: 1, dealChoices: [{ main: 'Chicken biryani', side: 'Pilau rice' }] }],
  catalog,
);
if (missingRole.ok || missingRole.error !== 'deal_choice_missing') fail(`expected deal_choice_missing, got ${JSON.stringify(missingRole)}`);
console.log('ok missing role:', missingRole.error);

const two = expandMealDealOrderItems(
  [
    {
      name: 'Mile a Meal',
      qty: 2,
      dealChoices: [
        { main: 'Chicken biryani', side: 'Pilau rice', drink: 'Coke' },
        { main: 'Butter chicken', side: 'Chips', drink: 'Mango lassi' },
      ],
    },
  ],
  catalog,
);
if (!two.ok) fail(JSON.stringify(two));
if (two.items.length !== 6) fail(`expected 6 lines, got ${two.items.length}`);

/** Same pricing rule as placeFoodOrder: deal price × qty, not sum of component prices. */
function pricedTotal(rawLines: { name: string; qty: number }[], cat: MenuItem[]): number {
  let total = 0;
  for (const line of rawLines) {
    const qty = Math.max(1, line.qty || 1);
    const match = cat.find((c) => c.name.toLowerCase() === line.name.toLowerCase());
    if (match?.deal) total += match.price * qty;
    else total += (match?.price ?? 0) * qty;
  }
  return Math.round(total * 100) / 100;
}

const packageTotal = pricedTotal([{ name: 'Mile a Meal', qty: 2 }], catalog);
const componentSum = two.items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
if (packageTotal !== 25) fail(`expected package total 25, got ${packageTotal}`);
if (componentSum === packageTotal) {
  console.log('note: component sum equals package (coincidence); components sum =', componentSum);
} else {
  console.log('ok package total', packageTotal, '≠ component sum', componentSum, '(bill package price)');
}

const withExtra = pricedTotal(
  [
    { name: 'Mile a Meal', qty: 2 },
    { name: 'Coke', qty: 1 },
  ],
  catalog,
);
if (withExtra !== 26.8) fail(`expected 26.8 with extra coke, got ${withExtra}`);
console.log('ok basket 2× deal + coke =', withExtra);

const prefixes = ['B1', 'B11', 'B15'];
const inB1 = matchDeliveryPostcode('B1 1AA', prefixes);
if (!inB1.ok || inB1.matchedPrefix !== 'B1') fail(`B1 1AA should match B1: ${JSON.stringify(inB1)}`);
const inB11 = matchDeliveryPostcode('B11 2TT', prefixes);
if (!inB11.ok || inB11.matchedPrefix !== 'B11') fail(`B11 should not collapse to B1: ${JSON.stringify(inB11)}`);
const out = matchDeliveryPostcode('M1 1AE', prefixes);
if (out.ok) fail('M1 should be out of area');
const empty = matchDeliveryPostcode('B1 1AA', []);
if (empty.ok) fail('empty prefixes must not deliver');
console.log('ok delivery in/out + B1 vs B11');
console.log('ALL PASS');
