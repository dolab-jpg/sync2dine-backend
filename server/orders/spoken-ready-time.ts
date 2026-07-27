const HOUR_WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
};

/**
 * London ready-by clock as a Cockney-friendly phrase.
 * Rounds UP to the next quarter hour: "quarter past three", "half past three",
 * "quarter to four", "three o'clock" — never "3:13" / "three point one three".
 */
export function readyByClockSpoken(etaMinutes: number, nowMs = Date.now()): string {
  const ready = new Date(nowMs + Math.max(0, etaMinutes) * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(ready);
  let hour24 = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  let minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);

  if (minute > 0) {
    const nextQuarter = Math.ceil(minute / 15) * 15;
    if (nextQuarter >= 60) {
      minute = 0;
      hour24 = (hour24 + 1) % 24;
    } else {
      minute = nextQuarter;
    }
  }

  const hour12 = hour24 % 12 || 12;
  const nextHour12 = (hour12 % 12) + 1;
  const h = HOUR_WORDS[hour12] || String(hour12);
  const nh = HOUR_WORDS[nextHour12] || String(nextHour12);

  if (minute === 0) return `${h} o'clock`;
  if (minute === 15) return `quarter past ${h}`;
  if (minute === 30) return `half past ${h}`;
  if (minute === 45) return `quarter to ${nh}`;
  return `around ${h}`;
}
