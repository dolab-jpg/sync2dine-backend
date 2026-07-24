/**
 * Venue-aware dial windows (Europe/London).
 * Facts only — outbound scheduler uses nextSlot; Sally gets compact angle facts.
 */

export type VenueType = 'takeaway' | 'pub' | 'restaurant' | 'cafe' | 'bar' | 'multi_site' | 'unknown';

export type DialWindowSuggestion = {
  venueType: VenueType;
  windows: Array<{ startHour: number; endHour: number; label: string }>;
  nextSlotISO: string | null;
  reason: string;
  bypassGlobalQuiet: boolean;
  pitchAngle: 'judie_phone' | 'atmosphere_room' | 'no_kitchen_revenue' | 'complete_both' | 'unknown';
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeVenueType(raw: unknown): VenueType {
  const s = String(raw || '').toLowerCase().trim();
  if (/takeaway|take-away|fish.?chip|kebab|pizza.?delivery|delivery.?only/.test(s)) return 'takeaway';
  if (/multi.?site|franchise|group|chain/.test(s)) return 'multi_site';
  if (/\bpub\b|public house|gastropub/.test(s)) return 'pub';
  if (/\bbar\b|cocktail|wine bar/.test(s)) return 'bar';
  if (/caf[eé]|coffee|bakery/.test(s)) return 'cafe';
  if (/restaurant|diner|bistro|brasserie|eatery/.test(s)) return 'restaurant';
  return 'unknown';
}

/** Parse crude "Mon–Sun 12–23" / "12:00-23:00" into open/close hours (local). */
export function parseOpeningHoursHint(hours: unknown): { openHour: number; closeHour: number } | null {
  const s = String(hours || '');
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?/i);
  if (!m) return null;
  const openHour = Math.max(0, Math.min(23, Number(m[1])));
  let closeHour = Math.max(0, Math.min(23, Number(m[3])));
  if (closeHour === 0 && openHour > 0) closeHour = 24;
  if (closeHour <= openHour) closeHour += 12;
  return { openHour, closeHour: Math.min(closeHour, 27) };
}

function windowsForVenue(
  venueType: VenueType,
  hours: { openHour: number; closeHour: number } | null,
): DialWindowSuggestion['windows'] {
  const open = hours?.openHour ?? 9;
  const close = hours?.closeHour ?? 22;

  switch (venueType) {
    case 'takeaway':
      return [
        {
          startHour: Math.max(open, 20),
          endHour: Math.max(close, 22),
          label: 'late while open (takeaway)',
        },
        {
          startHour: Math.max(open, 15),
          endHour: Math.min(close, 17),
          label: 'mid-afternoon lull',
        },
      ];
    case 'pub':
    case 'bar':
      return [
        {
          startHour: Math.max(open, 14),
          endHour: Math.min(Math.max(open + 2, 16), Math.max(close - 1, open + 1)),
          label: 'afternoon before evening rush',
        },
        {
          startHour: Math.max(open, close - 3),
          endHour: Math.max(close - 1, open + 1),
          label: 'before closing',
        },
      ];
    case 'cafe':
      return [
        {
          startHour: Math.max(open + 1, 10),
          endHour: Math.min(12, close),
          label: 'after breakfast rush',
        },
        {
          startHour: 14,
          endHour: Math.min(16, close),
          label: 'mid-afternoon',
        },
      ];
    case 'restaurant':
    case 'multi_site':
      return [
        {
          startHour: Math.max(open, 10),
          endHour: Math.min(11, close),
          label: 'between services (morning)',
        },
        {
          startHour: 15,
          endHour: Math.min(17, close),
          label: 'between lunch and dinner',
        },
      ];
    default:
      return [
        { startHour: 10, endHour: 12, label: 'default morning' },
        { startHour: 14, endHour: 16, label: 'default afternoon' },
      ];
  }
}

function londonYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function londonHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: 'numeric',
      hour12: false,
    }).format(d),
  );
}

function nextSlotInWindows(
  windows: DialWindowSuggestion['windows'],
  from = new Date(),
): string | null {
  for (let day = 0; day < 7; day++) {
    const probe = new Date(from.getTime() + day * DAY_MS);
    const ymd = londonYmd(probe);
    for (const w of windows) {
      if (w.endHour <= w.startHour) continue;
      const hour = Math.floor(w.startHour);
      const midUtc = Date.parse(`${ymd}T12:00:00.000Z`);
      if (!Number.isFinite(midUtc)) continue;
      const midAsLondonHour = londonHour(new Date(midUtc));
      const slotMs = midUtc + (hour - midAsLondonHour) * 3600_000 + 15 * 60_000;
      if (slotMs > from.getTime() + 5 * 60_000) {
        return new Date(slotMs).toISOString();
      }
    }
  }
  return null;
}

export function suggestPitchAngle(opts: {
  venueType: VenueType;
  hasKitchen?: boolean | null;
}): DialWindowSuggestion['pitchAngle'] {
  if (opts.hasKitchen === false) return 'no_kitchen_revenue';
  if (opts.venueType === 'pub' || opts.venueType === 'bar') return 'atmosphere_room';
  if (opts.venueType === 'takeaway') return 'judie_phone';
  if (opts.venueType === 'multi_site') return 'complete_both';
  return 'unknown';
}

export function suggestDialWindows(input: {
  venueType?: unknown;
  openingHours?: unknown;
  hasKitchen?: boolean | null;
  from?: Date;
}): DialWindowSuggestion {
  const venueType = normalizeVenueType(input.venueType);
  const hours = parseOpeningHoursHint(input.openingHours);
  const windows = windowsForVenue(venueType, hours);
  const nextSlotISO = nextSlotInWindows(windows, input.from || new Date());
  const bypassGlobalQuiet =
    venueType === 'takeaway' || (hours != null && (hours.closeHour > 20 || hours.closeHour < 6));
  const pitchAngle = suggestPitchAngle({ venueType, hasKitchen: input.hasKitchen });
  const reason = [
    `venue=${venueType}`,
    hours ? `hours=${hours.openHour}-${hours.closeHour}` : 'hours=unknown',
    `angle=${pitchAngle}`,
    bypassGlobalQuiet ? 'may_bypass_global_quiet' : 'respect_global_quiet',
  ].join('; ');

  return {
    venueType,
    windows,
    nextSlotISO,
    reason,
    bypassGlobalQuiet,
    pitchAngle,
  };
}

export function formatDialTimingPromptBlock(s: DialWindowSuggestion): string {
  const win = s.windows.map((w) => `${w.label} ${w.startHour}:00-${w.endHour}:00`).join('; ');
  return [
    'DIAL / VENUE FACTS (do not recite; adapt pitch):',
    `venueType=${s.venueType}; pitchAngle=${s.pitchAngle}; windows=${win}`,
    s.pitchAngle === 'no_kitchen_revenue'
      ? 'No kitchen on file — do not pretend they take food orders today. Soft opportunity: collection/takeaway revenue if they enable it; Judie captures those phone orders; Atmosphere if they have room/bar trade.'
      : s.pitchAngle === 'judie_phone'
        ? 'Lean Judie (missed calls / orders) unless they name room/audio pain.'
        : s.pitchAngle === 'atmosphere_room'
          ? 'Lean Atmosphere (room/audio) unless they name missed-call pain; Judie for bookings soft.'
          : s.pitchAngle === 'complete_both'
            ? 'Multi-site / both pains — aim senior meeting; Complete as guest outcomes.'
            : '',
  ]
    .filter(Boolean)
    .join('\n');
}
