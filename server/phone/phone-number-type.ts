/**
 * UK-oriented mobile vs landline classification for outbound billing.
 */
export type PhoneNumberType = 'mobile' | 'landline' | 'unknown';

export function normalizeUkDigits(input: string): string {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('44')) return digits;
  if (digits.startsWith('0')) return `44${digits.slice(1)}`;
  return digits;
}

/** UK mobiles: 07… / +447… ; most other geographic = landline. */
export function classifyUkPhoneNumber(input: string): PhoneNumberType {
  const digits = normalizeUkDigits(input);
  if (digits.length < 10) return 'unknown';
  // UK mobile: 447 followed by 7 (national 07)
  if (digits.startsWith('447') && digits.length >= 12) return 'mobile';
  // National format already normalized above; also catch bare 07
  const national = digits.startsWith('44') ? `0${digits.slice(2)}` : digits;
  if (national.startsWith('07') && national.length >= 11) return 'mobile';
  // UK geographic / non-geo landline-ish
  if (national.startsWith('01') || national.startsWith('02') || national.startsWith('03')) {
    return 'landline';
  }
  if (digits.startsWith('441') || digits.startsWith('442') || digits.startsWith('443')) {
    return 'landline';
  }
  return 'unknown';
}
