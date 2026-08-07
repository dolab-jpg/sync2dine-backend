/**
 * Contact eligibility for Sally outbound — DNC, consent, opt-out.
 * Enforced in backend enqueue paths (not prompt-only).
 */

export type ConsentSource =
  | 'csv_upload'
  | 'sales_csv_dial'
  | 'gatekeeper_referral'
  | 'inbound_callback'
  | 'manual'
  | 'research'
  | 'unknown';

export type ContactEligibility = {
  eligible: boolean;
  reason: string;
  doNotCall: boolean;
  consentToCall: boolean | null;
  consentSource?: ConsentSource | string;
};

function truthyFlag(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'dnc' || s === 'do_not_call';
}

function falsyExplicit(raw: unknown): boolean {
  if (raw === false || raw === 0) return true;
  const s = String(raw ?? '').trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'n';
}

export function isDoNotCallCustomer(customer: Record<string, unknown> | null | undefined): boolean {
  if (!customer) return false;
  if (truthyFlag(customer.doNotCall) || truthyFlag(customer.dnc)) return true;
  if (String(customer.callQueueStatus || '').toLowerCase() === 'do_not_call') return true;
  if (String(customer.lastCallDisposition || '').toLowerCase() === 'do_not_call') return true;
  const status = String(customer.status || '').toLowerCase();
  if (status === 'do_not_call' || status === 'dnc' || status === 'opted_out') return true;
  return false;
}

/**
 * Consent semantics:
 * - doNotCall always blocks
 * - consentToCall === false blocks
 * - missing consent is allowed for staff-uploaded / referral queues (soft opt-in),
 *   but reason notes consent=unknown so audits stay honest
 */
export function assessContactEligibility(
  customer: Record<string, unknown> | null | undefined,
  opts?: { requireExplicitConsent?: boolean },
): ContactEligibility {
  const consentSource = customer?.consentSource != null
    ? String(customer.consentSource)
    : customer?.source != null
      ? String(customer.source)
      : undefined;

  if (isDoNotCallCustomer(customer)) {
    return {
      eligible: false,
      reason: 'do_not_call',
      doNotCall: true,
      consentToCall: false,
      consentSource,
    };
  }

  const consentRaw = customer?.consentToCall;
  let consentToCall: boolean | null = null;
  if (truthyFlag(consentRaw)) consentToCall = true;
  else if (falsyExplicit(consentRaw)) consentToCall = false;

  if (consentToCall === false) {
    return {
      eligible: false,
      reason: 'consent_declined',
      doNotCall: false,
      consentToCall: false,
      consentSource,
    };
  }

  if (opts?.requireExplicitConsent && consentToCall !== true) {
    return {
      eligible: false,
      reason: 'consent_missing',
      doNotCall: false,
      consentToCall: null,
      consentSource,
    };
  }

  return {
    eligible: true,
    reason: consentToCall === true ? 'eligible_consented' : 'eligible_consent_unknown',
    doNotCall: false,
    consentToCall,
    consentSource,
  };
}

export function formatReferralBrief(input: {
  referredByName?: string;
  referredByPhone?: string;
  referredByVenue?: string;
  summary?: string;
  interestHint?: string;
}): string {
  const who = String(input.referredByName || 'someone on the main line').trim();
  const venue = String(input.referredByVenue || '').trim();
  const from = venue ? `${who} at ${venue}` : who;
  const phone = String(input.referredByPhone || '').trim();
  const summary = String(input.summary || '').trim().slice(0, 400);
  const interest = String(input.interestHint || '').trim().slice(0, 200);
  const bits = [
    `REFERRAL: We spoke to ${from}${phone ? ` (${phone})` : ''} on the main line; they gave us your details.`,
    summary ? `What they said: ${summary}` : 'They suggested you might be the right person to speak to.',
    interest
      ? `They indicated possible interest in: ${interest}. Do not invent stronger interest.`
      : 'Do not invent interest — confirm whether they are the decision-maker and diagnose gently.',
    'Open with who referred you, then Sync2Dine value (Judie / Atmosphere / Complete) briefly.',
  ];
  return bits.join(' ');
}
