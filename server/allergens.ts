/**
 * UK FIC Annex II — 14 allergens (stable codes + display labels).
 */
export const UK_ALLERGEN_CODES = [
  'celery',
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'lupin',
  'milk',
  'molluscs',
  'mustard',
  'nuts',
  'peanuts',
  'sesame',
  'soya',
  'sulphites',
] as const;

export type AllergenCode = (typeof UK_ALLERGEN_CODES)[number];

export const DIETARY_CODES = ['vegetarian', 'vegan', 'halal', 'gluten_free'] as const;
export type DietaryCode = (typeof DIETARY_CODES)[number];

export const ALLERGEN_LABELS: Record<AllergenCode, string> = {
  celery: 'Celery',
  gluten: 'Gluten',
  crustaceans: 'Crustaceans',
  eggs: 'Eggs',
  fish: 'Fish',
  lupin: 'Lupin',
  milk: 'Milk',
  molluscs: 'Molluscs',
  mustard: 'Mustard',
  nuts: 'Nuts',
  peanuts: 'Peanuts',
  sesame: 'Sesame',
  soya: 'Soya',
  sulphites: 'Sulphites',
};

const ALLERGEN_ALIASES: Record<string, AllergenCode> = {
  celery: 'celery',
  gluten: 'gluten',
  wheat: 'gluten',
  crustacean: 'crustaceans',
  crustaceans: 'crustaceans',
  shellfish: 'crustaceans',
  egg: 'eggs',
  eggs: 'eggs',
  fish: 'fish',
  lupin: 'lupin',
  milk: 'milk',
  dairy: 'milk',
  mollusc: 'molluscs',
  molluscs: 'molluscs',
  mustard: 'mustard',
  nut: 'nuts',
  nuts: 'nuts',
  tree_nuts: 'nuts',
  treenuts: 'nuts',
  peanut: 'peanuts',
  peanuts: 'peanuts',
  sesame: 'sesame',
  soya: 'soya',
  soy: 'soya',
  soybean: 'soya',
  sulphite: 'sulphites',
  sulphites: 'sulphites',
  sulfite: 'sulphites',
  sulfites: 'sulphites',
};

const DIETARY_ALIASES: Record<string, DietaryCode> = {
  vegetarian: 'vegetarian',
  veggie: 'vegetarian',
  vegan: 'vegan',
  halal: 'halal',
  gluten_free: 'gluten_free',
  glutenfree: 'gluten_free',
  'gluten-free': 'gluten_free',
};

function dedupeCodes<T extends string>(codes: T[]): T[] {
  return [...new Set(codes)];
}

export function normalizeAllergenCode(raw: unknown): AllergenCode | null {
  const key = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!key) return null;
  if ((UK_ALLERGEN_CODES as readonly string[]).includes(key)) return key as AllergenCode;
  return ALLERGEN_ALIASES[key] ?? null;
}

export function normalizeAllergenCodes(raw: unknown): AllergenCode[] {
  if (!Array.isArray(raw)) return [];
  const out: AllergenCode[] = [];
  for (const row of raw) {
    const code = normalizeAllergenCode(row);
    if (code) out.push(code);
  }
  return dedupeCodes(out);
}

export function normalizeDietaryCodes(raw: unknown): DietaryCode[] {
  if (!Array.isArray(raw)) return [];
  const out: DietaryCode[] = [];
  for (const row of raw) {
    const key = String(row ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    const code = DIETARY_ALIASES[key] ?? ((DIETARY_CODES as readonly string[]).includes(key) ? key as DietaryCode : null);
    if (code) out.push(code);
  }
  return dedupeCodes(out);
}

export interface NormalizedAllergenFields {
  allergensContains: AllergenCode[];
  allergensMayContain: AllergenCode[];
  dietary: DietaryCode[];
  allergenNotes?: string;
  allergenDeclared: boolean;
}

/** Normalize allergen fields from product jsonb / API input. */
export function normalizeAllergenFields(data: Record<string, unknown>): NormalizedAllergenFields {
  const contains = normalizeAllergenCodes(
    data.allergensContains ?? data.allergens_contains ?? data.contains,
  );
  const mayContain = normalizeAllergenCodes(
    data.allergensMayContain ?? data.allergens_may_contain ?? data.mayContain ?? data.may_contain,
  );
  const dietary = normalizeDietaryCodes(data.dietary);
  const notesRaw = data.allergenNotes ?? data.allergen_notes;
  const allergenNotes = typeof notesRaw === 'string' && notesRaw.trim() ? notesRaw.trim() : undefined;
  const declaredRaw = data.allergenDeclared ?? data.allergen_declared;
  const allergenDeclared = declaredRaw === true || declaredRaw === 'true' || declaredRaw === 1;
  return {
    allergensContains: contains,
    allergensMayContain: mayContain.filter((c) => !contains.includes(c)),
    dietary,
    allergenNotes,
    allergenDeclared,
  };
}

/** True when staff confirmed allergen facts (even if contains is empty). */
export function isAllergenDeclared(item: { allergenDeclared?: boolean }): boolean {
  return item.allergenDeclared === true;
}

/** Spoken caution when dish allergen data is incomplete. */
export function allergenSafetyHint(item: {
  name: string;
  allergensContains?: AllergenCode[];
  allergenDeclared?: boolean;
}): string | null {
  if (isAllergenDeclared(item)) return null;
  return `${item.name} does not have allergen information confirmed in our system — I cannot guarantee it is safe; the kitchen will need to check.`;
}

/** Match customer allergy text against dish contains codes (simple keyword overlap). */
export function customerAllergenConflict(
  customerAllergies: string,
  contains: AllergenCode[],
): AllergenCode[] {
  if (!customerAllergies.trim() || !contains.length) return [];
  const spoken = customerAllergies.toLowerCase();
  return contains.filter((code) => {
    const label = ALLERGEN_LABELS[code].toLowerCase();
    return spoken.includes(label) || spoken.includes(code.replace('_', ' '));
  });
}
