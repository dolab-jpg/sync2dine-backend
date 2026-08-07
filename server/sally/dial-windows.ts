/**
 * Venue-aware dial windows (Europe/London by default).
 * Supports crude range hints and structured per-day opening hours / closed days.
 * Facts only — outbound scheduler uses nextSlot; Sally gets compact angle facts.
 */

export type VenueType = 'takeaway' | 'pub' | 'restaurant' | 'cafe' | 'bar' | 'multi_site' | 'unknown';

export type Weekday =
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat'
  | 'sun';

export type DayOpeningInterval = {
  openHour: number;
  closeHour: number;
  /** Optional minute offsets 0–59 */
  openMinute?: number;
  closeMinute?: number;
};

/** Structured weekly hours. Absent day = closed. Empty intervals = closed that day. */
export type WeeklyOpeningHours = Partial<Record<Weekday, DayOpeningInterval[]>>;

export type DialWindowSuggestion = {
  venueType: VenueType;
  windows: Array<{ startHour: number; endHour: number; label: string }>;
  nextSlotISO: string | null;
  reason: string;
  bypassGlobalQuiet: boolean;
  pitchAngle: 'judie_phone' | 'atmosphere_room' | 'no_kitchen_revenue' | 'complete_both' | 'unknown';
  timezone: string;
  closedDays?: Weekday[];
};

export type VenueDialProfile = {
  venueType?: unknown;
  openingHours?: unknown;
  weeklyHours?: WeeklyOpeningHours | unknown;
  closedDays?: unknown;
  preferredContactTimes?: unknown;
  hasKitchen?: boolean | null;
  timezone?: unknown;
  from?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_TZ = 'Europe/London';

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

export function normalizeTimezone(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return DEFAULT_TZ;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: s });
    return s;
  } catch {
    return DEFAULT_TZ;
  }
}

export function normalizeWeekday(raw: unknown): Weekday | null {
  const s = String(raw || '').toLowerCase().trim().slice(0, 3);
  if (s === 'mon' || s === 'tue' || s === 'wed' || s === 'thu' || s === 'fri' || s === 'sat' || s === 'sun') {
    return s;
  }
  const full: Record<string, Weekday> = {
    monday: 'mon',
    tuesday: 'tue',
    wednesday: 'wed',
    thursday: 'thu',
    friday: 'fri',
    saturday: 'sat',
    sunday: 'sun',
  };
  return full[String(raw || '').toLowerCase().trim()] || null;
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

/** Detect closed-day tokens in free text e.g. "Closed Mon" / "Mon closed". */
export function parseClosedDaysHint(hours: unknown): Weekday[] {
  const s = String(hours || '');
  const closed: Weekday[] = [];
  const re =
    /(?:closed\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+closed)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const day = normalizeWeekday(m[1] || m[2]);
    if (day && !closed.includes(day)) closed.push(day);
  }
  return closed;
}

export function parseClosedDaysList(raw: unknown): Weekday[] {
  if (Array.isArray(raw)) {
    return raw.map(normalizeWeekday).filter((d): d is Weekday => Boolean(d));
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(/[,;/|]+/)
      .map((p) => normalizeWeekday(p.trim()))
      .filter((d): d is Weekday => Boolean(d));
  }
  return parseClosedDaysHint(raw);
}

export function normalizeWeeklyHours(raw: unknown): WeeklyOpeningHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: WeeklyOpeningHours = {};
  let any = false;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const day = normalizeWeekday(key);
    if (!day) continue;
    if (val == null || val === false || val === 'closed') {
      out[day] = [];
      any = true;
      continue;
    }
    const intervals: DayOpeningInterval[] = [];
    const list = Array.isArray(val) ? val : [val];
    for (const item of list) {
      if (typeof item === 'string') {
        const hint = parseOpeningHoursHint(item);
        if (hint) intervals.push({ openHour: hint.openHour, closeHour: hint.closeHour });
        continue;
      }
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const openHour = Number(o.openHour ?? o.open ?? o.startHour);
        let closeHour = Number(o.closeHour ?? o.close ?? o.endHour);
        if (!Number.isFinite(openHour) || !Number.isFinite(closeHour)) continue;
        if (closeHour === 0 && openHour > 0) closeHour = 24;
        if (closeHour <= openHour) closeHour += 12;
        intervals.push({
          openHour: Math.max(0, Math.min(23, openHour)),
          closeHour: Math.min(closeHour, 27),
          openMinute: Number.isFinite(Number(o.openMinute)) ? Number(o.openMinute) : undefined,
          closeMinute: Number.isFinite(Number(o.closeMinute)) ? Number(o.closeMinute) : undefined,
        });
      }
    }
    out[day] = intervals;
    any = true;
  }
  return any ? out : null;
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

/** Preferred contact windows like "14:00-16:00" or "afternoon". */
export function parsePreferredContactWindows(
  raw: unknown,
): Array<{ startHour: number; endHour: number; label: string }> {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out: Array<{ startHour: number; endHour: number; label: string }> = [];
  const rangeRe = /(\d{1,2})(?::(\d{2}))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(s))) {
    const startHour = Math.max(0, Math.min(23, Number(m[1])));
    let endHour = Math.max(0, Math.min(24, Number(m[3])));
    if (endHour <= startHour) endHour = Math.min(24, startHour + 2);
    out.push({ startHour, endHour, label: 'preferred contact' });
  }
  if (out.length) return out;
  if (/morning/i.test(s)) out.push({ startHour: 10, endHour: 12, label: 'preferred morning' });
  if (/afternoon/i.test(s)) out.push({ startHour: 14, endHour: 16, label: 'preferred afternoon' });
  if (/evening/i.test(s)) out.push({ startHour: 18, endHour: 20, label: 'preferred evening' });
  return out;
}

function partsInTz(d: Date, timeZone: string): { ymd: string; weekday: Weekday; hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const wdRaw = get('weekday').toLowerCase().slice(0, 3);
  const weekday = (normalizeWeekday(wdRaw) || 'mon') as Weekday;
  const y = get('year');
  const mo = get('month');
  const da = get('day');
  let hour = Number(get('hour'));
  // en-GB can emit 24 for midnight in some engines
  if (hour === 24) hour = 0;
  const minute = Number(get('minute'));
  return { ymd: `${y}-${mo}-${da}`, weekday, hour, minute };
}

function zonedLocalToUtcMs(
  ymd: string,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  // Approximate: start from UTC noon on that civil date, adjust by observed offset.
  const midUtc = Date.parse(`${ymd}T12:00:00.000Z`);
  if (!Number.isFinite(midUtc)) return NaN;
  const midParts = partsInTz(new Date(midUtc), timeZone);
  const midAsLocalMinutes = midParts.hour * 60 + midParts.minute;
  const targetLocalMinutes = hour * 60 + minute;
  return midUtc + (targetLocalMinutes - midAsLocalMinutes) * 60_000;
}

function dayIntervals(
  weekday: Weekday,
  weekly: WeeklyOpeningHours | null,
  closedDays: Weekday[],
  fallbackHours: { openHour: number; closeHour: number } | null,
): DayOpeningInterval[] | null {
  if (closedDays.includes(weekday)) return null;
  if (weekly) {
    if (!(weekday in weekly)) return null;
    const intervals = weekly[weekday] || [];
    return intervals.length ? intervals : null;
  }
  const open = fallbackHours?.openHour ?? 9;
  const close = fallbackHours?.closeHour ?? 22;
  return [{ openHour: open, closeHour: close }];
}

function clampWindowToOpen(
  window: { startHour: number; endHour: number; label: string },
  intervals: DayOpeningInterval[],
): Array<{ startHour: number; endHour: number; label: string }> {
  const out: Array<{ startHour: number; endHour: number; label: string }> = [];
  for (const iv of intervals) {
    const start = Math.max(window.startHour, iv.openHour);
    const end = Math.min(window.endHour, iv.closeHour);
    if (end > start) out.push({ startHour: start, endHour: end, label: window.label });
  }
  return out;
}

function nextSlotInWindows(
  windows: DialWindowSuggestion['windows'],
  opts: {
    from: Date;
    timeZone: string;
    weekly: WeeklyOpeningHours | null;
    closedDays: Weekday[];
    fallbackHours: { openHour: number; closeHour: number } | null;
  },
): string | null {
  const { from, timeZone, weekly, closedDays, fallbackHours } = opts;
  for (let day = 0; day < 14; day++) {
    const probe = new Date(from.getTime() + day * DAY_MS);
    const { ymd, weekday } = partsInTz(probe, timeZone);
    const intervals = dayIntervals(weekday, weekly, closedDays, fallbackHours);
    if (!intervals) continue;
    for (const w of windows) {
      const clamped = clampWindowToOpen(w, intervals);
      for (const slot of clamped) {
        if (slot.endHour <= slot.startHour) continue;
        const hour = Math.floor(slot.startHour);
        const minute = Math.round((slot.startHour % 1) * 60) || 15;
        const slotMs = zonedLocalToUtcMs(ymd, hour, minute, timeZone);
        if (!Number.isFinite(slotMs)) continue;
        if (slotMs > from.getTime() + 5 * 60_000) {
          // Also ensure the slot hour is still inside the window end in that zone
          const check = partsInTz(new Date(slotMs), timeZone);
          if (check.hour + check.minute / 60 < slot.endHour) {
            return new Date(slotMs).toISOString();
          }
        }
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

/**
 * Central next-eligible dial slot for a venue profile.
 * Preferred contact times override venue-type windows when present.
 */
export function suggestDialWindows(input: VenueDialProfile): DialWindowSuggestion {
  const venueType = normalizeVenueType(input.venueType);
  const timeZone = normalizeTimezone(input.timezone);
  const hours = parseOpeningHoursHint(input.openingHours);
  const weekly = normalizeWeeklyHours(input.weeklyHours);
  const closedDays = [
    ...parseClosedDaysList(input.closedDays),
    ...parseClosedDaysHint(input.openingHours),
  ].filter((d, i, arr) => arr.indexOf(d) === i);
  const preferred = parsePreferredContactWindows(input.preferredContactTimes);
  const venueWindows = windowsForVenue(venueType, hours);
  const windows = preferred.length ? preferred : venueWindows;
  const nextSlotISO = nextSlotInWindows(windows, {
    from: input.from || new Date(),
    timeZone,
    weekly,
    closedDays,
    fallbackHours: hours,
  });
  const bypassGlobalQuiet =
    venueType === 'takeaway' || (hours != null && (hours.closeHour > 20 || hours.closeHour < 6));
  const pitchAngle = suggestPitchAngle({ venueType, hasKitchen: input.hasKitchen });
  const reason = [
    `venue=${venueType}`,
    hours ? `hours=${hours.openHour}-${hours.closeHour}` : weekly ? 'hours=weekly' : 'hours=unknown',
    closedDays.length ? `closed=${closedDays.join('+')}` : null,
    preferred.length ? 'preferred_contact' : null,
    `tz=${timeZone}`,
    `angle=${pitchAngle}`,
    bypassGlobalQuiet ? 'may_bypass_global_quiet' : 'respect_global_quiet',
  ]
    .filter(Boolean)
    .join('; ');

  return {
    venueType,
    windows,
    nextSlotISO,
    reason,
    bypassGlobalQuiet,
    pitchAngle,
    timezone: timeZone,
    closedDays: closedDays.length ? closedDays : undefined,
  };
}

/** Next eligible call time — alias used by schedulers. */
export function nextEligibleCallAt(input: VenueDialProfile): string | null {
  return suggestDialWindows(input).nextSlotISO;
}

export function formatDialTimingPromptBlock(s: DialWindowSuggestion): string {
  const win = s.windows.map((w) => `${w.label} ${w.startHour}:00-${w.endHour}:00`).join('; ');
  return [
    'DIAL / VENUE FACTS (do not recite; adapt pitch):',
    `venueType=${s.venueType}; pitchAngle=${s.pitchAngle}; tz=${s.timezone}; windows=${win}`,
    s.closedDays?.length ? `closedDays=${s.closedDays.join(',')}` : '',
    s.nextSlotISO ? `nextEligibleSlot=${s.nextSlotISO}` : '',
    s.pitchAngle === 'no_kitchen_revenue'
      ? 'No kitchen on file — do not pretend they take food orders today. Soft opportunity: collection/takeaway revenue if they enable it; Judie captures those phone orders; Atmosphere if they have room/bar trade.'
      : s.pitchAngle === 'judie_phone'
        ? 'Lean Judie (missed calls / orders) unless they name room/audio pain.'
        : s.pitchAngle === 'atmosphere_room'
          ? 'Lean Atmosphere (exclusive soundtrack, seating vs kitchen mood, announcements, multi-week training, proven sales-lift track record) unless they name missed-call pain; Judie for bookings soft. Diagnose footfall vs spend vs service vs staff training first.'
          : s.pitchAngle === 'complete_both'
            ? 'Multi-site / both pains — aim senior meeting; Complete as guest outcomes.'
            : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** London local minutes-since-midnight for quiet-hour checks. */
export function londonMinutesNow(now = new Date(), timeZone = DEFAULT_TZ): number {
  const { hour, minute } = partsInTz(now, timeZone);
  return hour * 60 + minute;
}
