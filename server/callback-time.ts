/**
 * Parse “tomorrow 4pm” / ISO into a Europe/London offset datetime string.
 */
export function resolveCallbackIso(preferredTime: string, now = new Date()): string | null {
  const raw = String(preferredTime || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;

  const lower = raw.toLowerCase();
  let hour = 16;
  let minute = 0;
  const m12 = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  const m24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const mBare = lower.match(/\b(\d{1,2})\b/);
  if (m12) {
    hour = parseInt(m12[1], 10);
    minute = m12[2] ? parseInt(m12[2], 10) : 0;
    const ap = m12[3];
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
  } else if (m24) {
    hour = parseInt(m24[1], 10);
    minute = parseInt(m24[2], 10);
  } else if (mBare) {
    hour = parseInt(mBare[1], 10);
    if (hour <= 7) hour += 12; // business: “4” ? 16:00
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  let y = Number(parts.find((p) => p.type === 'year')?.value);
  let mo = Number(parts.find((p) => p.type === 'month')?.value);
  let d = Number(parts.find((p) => p.type === 'day')?.value);
  if (lower.includes('tomorrow') || lower.includes('tmrw')) {
    const probe = new Date(Date.UTC(y, mo - 1, d + 1, 12, 0, 0));
    const p2 = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(probe);
    y = Number(p2.find((p) => p.type === 'year')?.value);
    mo = Number(p2.find((p) => p.type === 'month')?.value);
    d = Number(p2.find((p) => p.type === 'day')?.value);
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const sample = new Date(`${y}-${pad(mo)}-${pad(d)}T12:00:00Z`);
  const londonOffsetMin = (() => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      timeZoneName: 'shortOffset',
    });
    const tz = fmt.formatToParts(sample).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const mm = tz.match(/GMT([+-]\d+)?/);
    if (!mm || !mm[1]) return 0;
    return parseInt(mm[1], 10) * 60;
  })();
  const sign = londonOffsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(londonOffsetMin);
  const off = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(hour)}:${pad(minute)}:00${off || '+01:00'}`;
}
