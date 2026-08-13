/**
 * Plain-English SMS bodies for Sync2Dine ops alerts (~160 chars, no error codes).
 */

export type OpsSmsKind =
  | 'api_down'
  | 'api_recovered'
  | 'api_restarted'
  | 'phone_line_down'
  | 'phone_line_up'
  | 'call_failed'
  | 'orders_backup'
  | 'ops_alert'
  | 'test';

export type OpsSmsExtras = {
  persona?: 'Judie' | 'Sally' | string;
  did?: string;
  title?: string;
  message?: string;
};

const FORBIDDEN_PATTERNS = [
  /\bUNREGISTERED\b/gi,
  /\bREJECTED\b/gi,
  /\bassistant-request\b/gi,
  /\bwebhook_fail\b/gi,
  /\b502\b/g,
  /\bpjsip\b/gi,
  /\bS2D\s*PHONE\s*:/gi,
  /\bsip:[^\s]+/gi,
  /\bSIP\/[\d.]+\b/gi,
];

const MAX_SMS_LEN = 160;

/** Pretty-print UK DID (+44203... / 0203...) for SMS. */
export function formatUkDidForSms(did: string): string {
  const raw = String(did || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('44')) digits = `0${digits.slice(2)}`;
  else if (!digits.startsWith('0') && digits.length >= 10) digits = `0${digits}`;

  if (/^020\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (/^07\d{9}$/.test(digits)) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return raw;
}

function stripForbidden(text: string): string {
  let out = text;
  for (const re of FORBIDDEN_PATTERNS) {
    out = out.replace(re, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max = MAX_SMS_LEN): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1).trimEnd();
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) return `${cut.slice(0, lastSpace)}...`;
  return `${cut}...`;
}

function personaLabel(persona?: string): string {
  const p = String(persona || '').trim();
  if (!p) return 'Phone line';
  if (/^judie$/i.test(p)) return 'Judie';
  if (/^sally$/i.test(p)) return 'Sally';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function formatOpsSms(kind: OpsSmsKind, extras?: OpsSmsExtras): string {
  const persona = personaLabel(extras?.persona);
  const did = formatUkDidForSms(extras?.did || '');
  const onLine = did ? `${persona} on ${did}` : persona;

  switch (kind) {
    case 'api_down':
      return 'Sync2Dine is down. The app and phone lines may not answer. We are restarting now.';
    case 'api_recovered':
      return 'Sync2Dine is back up. App and phones should work again.';
    case 'api_restarted':
      return 'Sync2Dine had a blip. We restarted it and it is working again.';
    case 'phone_line_down':
      return did
        ? `${onLine} is offline. Callers to that number may not get through.`
        : `${persona} is offline. Callers may not get through.`;
    case 'phone_line_up':
      return did ? `${onLine} is back online.` : `${persona} is back online.`;
    case 'call_failed':
      return 'A diner call just failed to start. Callers may hear an error or dead air.';
    case 'orders_backup':
      return 'Orders are saving to backup, not the cloud. Kitchen still works - check this soon.';
    case 'test':
      return 'This is a Sync2Dine test alert. If you got this, SMS is working.';
    case 'ops_alert': {
      const title = stripForbidden(String(extras?.title || '').trim());
      const message = stripForbidden(String(extras?.message || '').trim());
      const combined = [title, message].filter(Boolean).join('. ');
      if (!combined) return 'Sync2Dine needs attention. Please check the app when you can.';
      return truncate(combined);
    }
    default: {
      const _exhaustive: never = kind;
      return truncate(String(_exhaustive));
    }
  }
}

/** Map ops-notify event + payload to SMS kind. */
export function resolveOpsSmsKind(input: {
  event: 'api_down' | 'api_recovered' | 'ops_alert' | 'test';
  title: string;
  message: string;
  code?: string;
}): OpsSmsKind {
  if (input.event === 'test') return 'test';
  if (input.event === 'api_down') return 'api_down';
  if (input.event === 'api_recovered') {
    const t = `${input.title} ${input.message}`.toLowerCase();
    if (/auto[- ]?restart|restarted/.test(t)) return 'api_restarted';
    return 'api_recovered';
  }
  if (input.code === 'orders_disk_fallback') return 'orders_backup';
  if (
    input.code === 'phone_call_fail'
    || input.code === 'phone_webhook_fail'
    || input.code === 'phone_stuck_call'
  ) {
    return 'call_failed';
  }
  const blob = `${input.title} ${input.message} ${input.code || ''}`.toLowerCase();
  if (
    /\b(call|phone|diner|judie|sally|line|vapi|inbound)\b/.test(blob)
    && /\b(fail|error|down|reject|dead|offline|unreachable)\b/.test(blob)
  ) {
    return 'call_failed';
  }
  return 'ops_alert';
}

/** Tokens that must never appear in ops SMS bodies. */
export const OPS_SMS_FORBIDDEN_TOKENS = [
  'UNREGISTERED',
  'REJECTED',
  'assistant-request',
  'webhook_fail',
  '502',
  'pjsip',
] as const;
