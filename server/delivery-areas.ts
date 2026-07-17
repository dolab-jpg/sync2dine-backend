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
