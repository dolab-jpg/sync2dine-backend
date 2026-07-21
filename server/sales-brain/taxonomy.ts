export const OBJECTION_CODES = [
  'too_expensive',
  'think_about_it',
  'send_info',
  'has_supplier',
  'no_budget',
  'call_later',
  'not_interested',
  'busy',
  'need_approval',
  'want_demo',
  'other',
] as const;

export type ObjectionCode = (typeof OBJECTION_CODES)[number];

export const OUTCOMES = [
  'meeting_booked',
  'callback',
  'lost',
  'no_answer',
  'dnc',
  'other',
] as const;

export type SalesOutcome = (typeof OUTCOMES)[number];

export function normalizeObjection(raw: string): ObjectionCode {
  const s = raw.toLowerCase();
  if (/expensive|price|cost|afford/.test(s)) return 'too_expensive';
  if (/think|consider/.test(s)) return 'think_about_it';
  if (/send|email|brochure|info/.test(s)) return 'send_info';
  if (/already|supplier|receptionist|competitor/.test(s)) return 'has_supplier';
  if (/budget|no money/.test(s)) return 'no_budget';
  if (/later|call back|callback/.test(s)) return 'call_later';
  if (/not interested|no thanks/.test(s)) return 'not_interested';
  if (/busy|rush/.test(s)) return 'busy';
  if (/approval|boss|partner|sign/.test(s)) return 'need_approval';
  if (/demo|try/.test(s)) return 'want_demo';
  return 'other';
}
