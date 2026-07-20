/**
 * Clear spoken forms for UK phone numbers and postcodes (TTS-safe).
 * Use for demo numbers / postcode confirmations — banter elsewhere, clarity for IDs.
 */

const DIGIT_WORDS: Record<string, string> = {
  '0': 'oh',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
};

const LETTER_NATO: Record<string, string> = {
  A: 'A for Alpha',
  B: 'B for Bravo',
  C: 'C for Charlie',
  D: 'D for Delta',
  E: 'E for Echo',
  F: 'F for Foxtrot',
  G: 'G for Golf',
  H: 'H for Hotel',
  I: 'I for India',
  J: 'J for Juliet',
  K: 'K for Kilo',
  L: 'L for Lima',
  M: 'M for Mike',
  N: 'N for November',
  O: 'O for Oscar',
  P: 'P for Papa',
  Q: 'Q for Quebec',
  R: 'R for Romeo',
  S: 'S for Sierra',
  T: 'T for Tango',
  U: 'U for Uniform',
  V: 'V for Victor',
  W: 'W for Whisky',
  X: 'X for X-ray',
  Y: 'Y for Yankee',
  Z: 'Z for Zulu',
};

function digitsOnly(input: string): string {
  return String(input || '').replace(/\D/g, '');
}

/** Normalise UK numbers to national digits starting with 0 when possible. */
export function toUkNationalDigits(input: string): string {
  let d = digitsOnly(input);
  if (d.startsWith('44') && d.length >= 11) d = `0${d.slice(2)}`;
  return d;
}

/**
 * Speak a UK phone in clear digit groups.
 * e.g. 02080505029 ? "oh two oh, eight oh five oh, five oh two nine"
 */
export function speakUkPhone(input: string): string {
  const d = toUkNationalDigits(input);
  if (!d) return String(input || '').trim();
  const words = [...d].map((c) => DIGIT_WORDS[c] || c);
  // Group: landline 020 + 4 + 4; mobile 07xxx in 5+3+3 or 5+6
  if (d.startsWith('020') && d.length === 11) {
    return [
      words.slice(0, 3).join(' '),
      words.slice(3, 7).join(' '),
      words.slice(7).join(' '),
    ].join(', ');
  }
  if (d.startsWith('07') && d.length === 11) {
    return [
      words.slice(0, 5).join(' '),
      words.slice(5, 8).join(' '),
      words.slice(8).join(' '),
    ].join(', ');
  }
  // Generic chunks of 3–4
  const parts: string[] = [];
  for (let i = 0; i < words.length; i += 4) {
    parts.push(words.slice(i, i + 4).join(' '));
  }
  return parts.join(', ');
}

/**
 * Speak a UK postcode letter-by-letter for letters, digit words for numbers.
 * e.g. GU12 5QW ? "G for Golf, U for Uniform, one, two, five, Q for Quebec, W for Whisky"
 */
export function speakUkPostcode(input: string): string {
  const raw = String(input || '').toUpperCase().replace(/\s+/g, '');
  if (!raw) return String(input || '').trim();
  const parts: string[] = [];
  for (const ch of raw) {
    if (/[A-Z]/.test(ch)) parts.push(LETTER_NATO[ch] || ch);
    else if (/\d/.test(ch)) parts.push(DIGIT_WORDS[ch] || ch);
  }
  return parts.join(', ');
}

/** True if E.164 / UK national looks like a mobile (07… / +447…). */
export function isUkMobile(input: string): boolean {
  const d = toUkNationalDigits(input);
  return d.startsWith('07') && d.length === 11;
}
