/**
 * British spoken money for phone TTS (ElevenLabs mishandles £ and digit runs).
 * Keep numeric totals for CRM; use spokenTotal / spokenHint for speech.
 */

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function underThousand(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
  }
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return rest ? `${ONES[h]} hundred and ${underThousand(rest)}` : `${ONES[h]} hundred`;
}

function integerToBritishWords(n: number): string {
  if (n === 0) return 'zero';
  if (n < 0) return `minus ${integerToBritishWords(-n)}`;
  if (n >= 1_000_000_000) return String(n);

  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const remainder = n % 1000;

  if (millions) {
    parts.push(`${underThousand(millions)} million`);
  }
  if (thousands) {
    parts.push(`${underThousand(thousands)} thousand`);
  }
  if (remainder) {
    if (parts.length && remainder < 100) {
      parts.push(`and ${underThousand(remainder)}`);
    } else {
      parts.push(underThousand(remainder));
    }
  }
  return parts.join(' ');
}

/** e.g. 5200 → "five thousand two hundred pounds" */
export function formatSpokenGbp(amount: number | string | null | undefined): string {
  const raw = typeof amount === 'number' ? amount : Number(String(amount ?? '').replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(raw)) return 'an unknown amount';

  const negative = raw < 0;
  const abs = Math.abs(raw);
  const pounds = Math.floor(abs + 1e-9);
  const pence = Math.round((abs - pounds) * 100);

  let spoken = pounds === 0 && pence > 0
    ? ''
    : `${integerToBritishWords(pounds)} ${pounds === 1 ? 'pound' : 'pounds'}`;

  if (pence > 0) {
    const penceWords = integerToBritishWords(pence);
    spoken = spoken
      ? `${spoken} and ${penceWords} ${pence === 1 ? 'penny' : 'pence'}`
      : `${penceWords} ${pence === 1 ? 'penny' : 'pence'}`;
  }

  if (!spoken) spoken = 'zero pounds';
  return negative ? `minus ${spoken}` : spoken;
}

export function withSpokenMoney<T extends Record<string, unknown>>(
  row: T,
  totalKey = 'total',
): T & { spokenTotal: string } {
  const total = Number(row[totalKey] ?? 0);
  return {
    ...row,
    spokenTotal: formatSpokenGbp(total),
  };
}
