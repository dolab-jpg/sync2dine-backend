import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAllergenCodes,
  normalizeAllergenFields,
  customerAllergenConflict,
  allergenSafetyHint,
} from './allergens';

describe('allergens normalization', () => {
  it('whitelists UK 14 codes and dedupes', () => {
    const codes = normalizeAllergenCodes(['milk', 'Milk', 'peanuts', 'invalid']);
    assert.deepEqual(codes, ['milk', 'peanuts']);
  });

  it('maps aliases like soy → soya', () => {
    assert.ok(normalizeAllergenCodes(['soy']).includes('soya'));
    assert.ok(normalizeAllergenCodes(['wheat']).includes('gluten'));
  });

  it('normalizes declared empty contains as checked', () => {
    const fields = normalizeAllergenFields({
      allergensContains: [],
      allergenDeclared: true,
    });
    assert.equal(fields.allergenDeclared, true);
    assert.deepEqual(fields.allergensContains, []);
  });
});

describe('allergen safety hints', () => {
  it('warns on undeclared dishes', () => {
    const hint = allergenSafetyHint({ name: 'Mystery curry', allergensContains: [] });
    assert.ok(hint?.includes('cannot guarantee'));
  });

  it('detects customer allergen conflicts', () => {
    const conflicts = customerAllergenConflict('peanut allergy', ['peanuts', 'milk']);
    assert.deepEqual(conflicts, ['peanuts']);
  });
});
