/**
 * UK delivery postcode prefix matching for Sync2Dine phone ordering.
 * Matches the outward code (e.g. B1, B11) so B1 1AA does not falsely match B11.
 */

export function normalizeUkPostcode(raw: string): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Outward code: everything before the inward (last 3 chars) on a full postcode. */
export function ukOutwardCode(raw: string): string {
  const compact = normalizeUkPostcode(raw);
  if (!compact) return '';
  if (compact.length >= 5) return compact.slice(0, -3);
  return compact;
}

export function formatUkPostcodeDisplay(raw: string): string {
  const compact = normalizeUkPostcode(raw);
  if (compact.length < 5) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** Full UK postcode (outward + inward), e.g. SW1A 1AA / B11 1AA. */
export function isValidUkPostcode(text: string): boolean {
  const compact = normalizeUkPostcode(text);
  if (!compact) return false;
  return /^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/.test(compact);
}

/**
 * Plausible UK delivery street line: needs a house number/name plus a street-ish phrase.
 * Rejects bare postcodes and vague landmarks ("near the station").
 */
export function isPlausibleUkStreetAddress(text: string): boolean {
  const raw = String(text || '').trim();
  if (raw.length < 5) return false;
  if (isValidUkPostcode(raw)) return false;

  const withoutPostcode = raw
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, ' ')
    .replace(/[,\s]+/g, ' ')
    .trim();
  if (withoutPostcode.length < 3) return false;

  const hasHouseNumber = /\b\d+[A-Za-z]?\b/.test(withoutPostcode);
  const hasNamedHouse =
    /\b(flat|apartment|apt|unit|suite|house|cottage|farm|manor|villa|lodge|bungalow|mews)\b/i.test(
      withoutPostcode,
    );
  if (!hasHouseNumber && !hasNamedHouse) return false;

  const hasStreetWord =
    /\b(street|st|road|rd|avenue|ave|lane|ln|close|cl|drive|dr|way|court|ct|place|pl|terrace|gardens|crescent|grove|hill|park|row|square|sq|walk|boulevard|blvd|mews)\b/i.test(
      withoutPostcode,
    );
  const wordCount = withoutPostcode.split(/\s+/).filter(Boolean).length;
  return hasStreetWord || (hasHouseNumber && wordCount >= 2);
}

/** Pull a full UK postcode out of free text when present. */
export function extractUkPostcode(text: string): string {
  const m = String(text || '').toUpperCase().match(
    /\b(GIR\s*0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/,
  );
  return m ? formatUkPostcodeDisplay(m[1]) : '';
}

export function normalizeDeliveryPrefixes(prefixes: unknown): string[] {
  if (!Array.isArray(prefixes)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of prefixes) {
    const p = normalizeUkPostcode(String(row ?? ''));
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * True when the caller's postcode is in a configured delivery area.
 * Compares outward code to configured chips (exact match).
 * Partial input like "B11" also matches chip B11.
 */
export function matchDeliveryPostcode(
  postcode: string,
  prefixes: string[],
): { ok: boolean; matchedPrefix?: string; normalized: string } {
  const compact = normalizeUkPostcode(postcode);
  const outward = ukOutwardCode(postcode);
  const list = normalizeDeliveryPrefixes(prefixes);
  const normalized = compact.length >= 5 ? formatUkPostcodeDisplay(compact) : compact;
  if (!compact) return { ok: false, normalized: '' };
  if (!list.length) return { ok: false, normalized };

  for (const prefix of list) {
    if (outward === prefix || compact === prefix) {
      return { ok: true, matchedPrefix: prefix, normalized };
    }
  }
  return { ok: false, normalized };
}
