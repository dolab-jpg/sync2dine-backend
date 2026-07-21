import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandMenuOptions,
  optionSurchargeForLine,
  parseMenuOptions,
  type MenuItem,
  type OrderLineInput,
} from './menu-catalog';

const pizza: MenuItem = {
  id: '1',
  name: 'Margherita Pizza',
  category: 'mains',
  price: 9.5,
  allergensContains: [],
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
};

const box: MenuItem = {
  id: '2',
  name: 'Chicken Box Meal',
  category: 'mains',
  price: 9,
  allergensContains: [],
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
};

describe('parseMenuOptions', () => {
  it('parses priced choices', () => {
    const groups = parseMenuOptions([
      {
        role: 'crust',
        choices: [
          { name: 'Stuffed Crust', priceDelta: 2.5 },
          { name: 'Classic', priceDelta: 0 },
        ],
      },
    ]);
    assert.equal(groups?.length, 1);
    assert.equal(groups?.[0].choices[0].priceDelta, 2.5);
  });
});

describe('expandMenuOptions', () => {
  it('adds stuffed crust and dip kitchen lines with surcharge', () => {
    const raw: OrderLineInput[] = [
      {
        name: 'Margherita Pizza',
        qty: 1,
        optionChoices: { crust: 'Stuffed Crust', dip: 'Garlic Dip' },
      },
    ];
    const result = expandMenuOptions(raw, [pizza]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.surcharge, 3.5);
    assert.equal(result.items.length, 3);
    assert.ok(result.items.some((i) => i.name === 'Stuffed Crust' && i.role === 'crust' && i.price === 2.5));
    assert.ok(result.items.some((i) => i.name === 'Garlic Dip' && i.role === 'dip'));
  });

  it('requires package side for chicken box', () => {
    const result = expandMenuOptions([{ name: 'Chicken Box Meal', qty: 1 }], [box]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'option_required');
  });

  it('accepts coleslaw package side', () => {
    const result = expandMenuOptions(
      [{ name: 'Chicken Box Meal', qty: 1, optionChoices: { side: 'Coleslaw' } }],
      [box],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.items.some((i) => i.name === 'Coleslaw' && i.role === 'side'));
  });
});

describe('optionSurchargeForLine', () => {
  it('prices stuffed crust upgrade', () => {
    const surcharge = optionSurchargeForLine(
      { name: 'Margherita Pizza', qty: 2, optionChoices: { crust: 'Stuffed Crust' } },
      [pizza],
    );
    assert.equal(surcharge, 5);
  });
});
