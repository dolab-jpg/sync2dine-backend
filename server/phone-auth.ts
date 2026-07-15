/**
 * Staff/builder phone PIN hashing and per-call auth unlock.
 */
import { createHash, randomBytes, timingSafeEqual, scryptSync } from 'crypto';
import { getCallById, getCallByProviderId, normalizePhoneExport, saveCall } from './data-store';
import { listTeamMembers, type TeamMember } from './conversation-store';
import { resolveInboundChannel, type ChannelRoute } from './channel-router';

/** Resolve TradePro call id even when webhooks pass the Vapi provider UUID. */
export function resolvePhoneAuthCallId(callId: string): string {
  const raw = String(callId || '').trim();
  if (!raw) return raw;
  const byId = getCallById(raw);
  if (byId) {
    const meta = (byId.metadata as Record<string, unknown> | undefined) || {};
    if (meta.mergedInto) return String(meta.mergedInto);
    const tradepro = String(meta.tradeproCallId || '').trim();
    if (tradepro && tradepro !== raw && getCallById(tradepro)) return tradepro;
    return String(byId.id);
  }
  const byProvider = getCallByProviderId(raw);
  if (byProvider) return String(byProvider.id);
  return raw;
}

const PIN_LEN = 4;
const MAX_PIN_ATTEMPTS = 3; // soft nudge only — never hard-locks the call

export function normalizePhonePin(raw: string): string {
  return String(raw || '').replace(/\D/g, '');
}

/** Spoken → digit string (e.g. "four eight two nine" or "4829"). */
const SPOKEN_DIGIT: Record<string, string> = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

export function extractPinDigits(raw: string): string {
  const direct = normalizePhonePin(raw);
  if (direct.length === PIN_LEN) return direct;
  // Prefer segment before # if present
  const beforeHash = String(raw || '').split('#')[0];
  const fromHash = normalizePhonePin(beforeHash);
  if (fromHash.length === PIN_LEN) return fromHash;

  const tokens = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let built = '';
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) built += tok;
    else if (SPOKEN_DIGIT[tok]) built += SPOKEN_DIGIT[tok];
  }
  if (built.length === PIN_LEN) return built;
  // If too long, take last 4 digits (caller often says filler then PIN)
  if (built.length > PIN_LEN) return built.slice(-PIN_LEN);
  return built || (direct.length > PIN_LEN ? direct.slice(-PIN_LEN) : direct);
}

export function isValidPhonePin(raw: string): boolean {
  return extractPinDigits(raw).length === PIN_LEN;
}

export function hashPhonePin(pin: string): string {
  const normalized = extractPinDigits(pin);
  if (!isValidPhonePin(normalized)) {
    throw new Error(`Phone PIN must be exactly ${PIN_LEN} digits`);
  }
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(normalized, salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPhonePinHash(pin: string, hash: string | undefined | null): boolean {
  if (!hash) return false;
  const normalized = extractPinDigits(pin);
  if (!normalized) return false;
  const parts = String(hash).split('$');
  if (parts[0] === 'scrypt' && parts.length === 3) {
    const [, salt, expected] = parts;
    const derived = scryptSync(normalized, salt, 32).toString('hex');
    try {
      return timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }
  // Legacy / smoke: plain sha256 hex (no salt) — avoid for new PINs
  if (parts[0] === 'sha256' && parts.length === 2) {
    const digest = createHash('sha256').update(normalized).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(parts[1], 'hex'));
    } catch {
      return false;
    }
  }
  return false;
}

export type PhoneCallerKind = 'customer' | 'staff' | 'foreman';

export interface PhoneCallerIdentity {
  kind: PhoneCallerKind;
  route: ChannelRoute;
  role: string;
  name: string;
  phone: string;
  /** Canonical profiles.id when bound; null means identity_not_bound for privileged tools. */
  userId: string | null;
  member?: TeamMember;
  pinConfigured: boolean;
  needsPin: boolean;
}

export function resolvePhoneCallerIdentity(partyPhone: string, orgId?: string): PhoneCallerIdentity {
  const route = resolveInboundChannel(partyPhone, orgId);
  const phone = normalizePhoneExport(partyPhone);
  if (route.mode === 'staff') {
    const member = listTeamMembers(orgId).find(
      (m) => normalizePhoneExport(m.phone) === phone,
    );
    const pinConfigured = Boolean(member?.phonePinHash);
    const userId = String(member?.userId || route.userId || '').trim() || null;
    return {
      kind: 'staff',
      route,
      role: route.role || member?.role || 'staff',
      name: route.name || member?.name || 'Staff',
      phone,
      userId,
      member,
      pinConfigured,
      needsPin: true,
    };
  }
  if (route.mode === 'foreman') {
    const member = listTeamMembers(orgId).find(
      (m) => normalizePhoneExport(m.phone) === phone && m.role === 'builder',
    );
    const pinConfigured = Boolean(member?.phonePinHash);
    const userId = String(member?.userId || route.userId || '').trim() || null;
    return {
      kind: 'foreman',
      route,
      role: 'builder',
      name: route.name || member?.name || 'Builder',
      phone,
      userId,
      member,
      pinConfigured,
      needsPin: true,
    };
  }
  return {
    kind: 'customer',
    route,
    role: 'customer',
    name: route.name || 'Guest',
    phone,
    userId: null,
    pinConfigured: false,
    needsPin: false,
  };
}

function callMeta(callId: string): Record<string, unknown> {
  const id = resolvePhoneAuthCallId(callId);
  const call = getCallById(id);
  return { ...((call?.metadata as Record<string, unknown> | undefined) || {}) };
}

export function isPhoneAuthVerified(callId: string): boolean {
  const meta = callMeta(callId);
  return meta.phoneAuth === 'verified' || meta.phoneAuthVerified === true;
}

export function getPhonePinAttempts(callId: string): number {
  return Number(callMeta(callId).phonePinAttempts || 0);
}

/** Preserve verified unlock when later webhooks re-merge stale pending metadata. */
export function mergePhoneAuthMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = { ...(existing || {}), ...(incoming || {}) };
  const wasVerified =
    existing?.phoneAuth === 'verified'
    || existing?.phoneAuthVerified === true;
  if (wasVerified) {
    base.phoneAuth = 'verified';
    base.phoneAuthVerified = true;
    if (existing?.phoneAuthRole != null) base.phoneAuthRole = existing.phoneAuthRole;
    if (existing?.phoneAuthKind != null) base.phoneAuthKind = existing.phoneAuthKind;
    if (existing?.phoneAuthName != null) base.phoneAuthName = existing.phoneAuthName;
  }
  return base;
}

export function markPhoneAuthVerified(callId: string, identity: PhoneCallerIdentity): void {
  const id = resolvePhoneAuthCallId(callId);
  const meta = callMeta(id);
  const patch = {
    phoneAuth: 'verified' as const,
    phoneAuthVerified: true,
    phoneAuthRole: identity.role,
    phoneAuthKind: identity.kind,
    phoneAuthName: identity.name,
  };
  saveCall({
    id,
    metadata: { ...meta, ...patch },
    contactName: identity.name,
  });
  // Keep provider-UUID twin in sync so mismatched tool callIds still pass the gate
  const call = getCallById(id);
  const providerId = String(call?.providerCallId || meta.vapiCallId || '').trim();
  if (providerId && providerId !== id) {
    const twin = getCallById(providerId);
    if (twin) {
      saveCall({
        id: providerId,
        metadata: mergePhoneAuthMetadata(
          (twin.metadata as Record<string, unknown> | undefined) || {},
          patch,
        ),
      });
    }
  }
}

export function recordPhonePinFailure(callId: string): { attempts: number; locked: boolean } {
  const id = resolvePhoneAuthCallId(callId);
  const meta = callMeta(id);
  const attempts = Number(meta.phonePinAttempts || 0) + 1;
  // Soft continue: never hard-lock the call — privileged tools stay gated until verify succeeds
  saveCall({
    id,
    metadata: {
      ...meta,
      phonePinAttempts: attempts,
      phoneAuth: 'pending',
      phoneAuthVerified: false,
    },
  });
  return { attempts, locked: false };
}

export function verifyStaffPhonePinForCall(
  callId: string,
  partyPhone: string,
  pin: string,
  orgId?: string,
): Record<string, unknown> {
  const identity = resolvePhoneCallerIdentity(partyPhone, orgId);
  if (identity.kind === 'customer') {
    return { verified: false, error: 'Not a registered staff or builder number' };
  }
  if (isPhoneAuthVerified(callId)) {
    return { verified: true, alreadyVerified: true, role: identity.role, name: identity.name };
  }
  if (!identity.pinConfigured || !identity.member?.phonePinHash) {
    return {
      verified: false,
      error: 'No phone PIN configured for this number — set one in Settings → Team',
    };
  }
  const digits = extractPinDigits(pin);
  if (!isValidPhonePin(digits)) {
    return {
      verified: false,
      error: `PIN must be exactly ${PIN_LEN} digits`,
      continueCall: true,
      hint: 'Keep chatting naturally and gently ask them to say the four digits again when ready.',
    };
  }
  const ok = verifyPhonePinHash(digits, identity.member.phonePinHash);
  if (!ok) {
    const { attempts } = recordPhonePinFailure(callId);
    return {
      verified: false,
      attempts,
      locked: false,
      continueCall: true,
      error: 'Incorrect PIN',
      hint: attempts >= MAX_PIN_ATTEMPTS
        ? 'Still wrong — carry on the conversation naturally; gently retry the PIN later via verifyStaffPhonePin. Do not hang up or refuse to talk.'
        : 'Wrong code — acknowledge briefly, keep the call going, and try verifyStaffPhonePin again when they say four new digits.',
    };
  }
  markPhoneAuthVerified(callId, identity);
  return {
    verified: true,
    role: identity.role,
    name: identity.name,
    kind: identity.kind,
  };
}

/** True when text looks like a spoken PIN attempt (not normal speech). */
export function looksLikePhonePinEntry(text: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  // Mostly digits (+ optional #)
  if (/^\s*[\d\s*#]{3,12}\s*$/.test(trimmed) && extractPinDigits(trimmed).length === PIN_LEN) {
    return true;
  }
  // Spoken: "one two three four" / "my code is 4 8 2 9"
  const digits = extractPinDigits(trimmed);
  if (digits.length !== PIN_LEN) return false;
  const wordCount = trimmed.toLowerCase().split(/\s+/).filter(Boolean).length;
  return wordCount <= 10 && (
    /\b(pin|code|security)\b/i.test(trimmed)
    || wordCount <= digits.length + 2
  );
}

/** Tools allowed before PIN unlock on a staff/foreman call. */
export const PRE_AUTH_PHONE_TOOLS = new Set([
  'verifyStaffPhonePin',
  'transferToHuman',
  'captureMessage',
  'endCall',
  'setCallLanguage',
]);

/** Slim staff pack once unlocked (includes CRM search + company snapshot for managers/admins). */
export const STAFF_PHONE_TOOL_NAMES = [
  'verifyStaffPhonePin',
  'lookupCustomerByPhone',
  'getAccountBriefing',
  'lookupQuote',
  'lookupProjectStatus',
  'getPortalLink',
  'logCallActivity',
  'searchCustomers',
  'searchProjects',
  'searchQuotes',
  'getBusinessSnapshot',
  'getTeamPerformance',
  'bookCallback',
  'scheduleAppointment',
  'captureLead',
  'captureMessage',
  'classifyCallIntent',
  'transferToHuman',
  'escalateToStaff',
  'sendToStaffCynthia',
  'deliverCallFollowUp',
  'placeOutboundCall',
  'enqueueOutboundCall',
  'endCall',
  'setCallLanguage',
] as const;

export const BUILDER_PHONE_TOOL_NAMES = [
  'verifyStaffPhonePin',
  'lookupCustomerByPhone',
  'getAccountBriefing',
  'lookupProjectStatus',
  'searchProjects',
  'logCallActivity',
  'captureMessage',
  'transferToHuman',
  'sendToStaffCynthia',
  'endCall',
  'setCallLanguage',
] as const;

/** Tools that require a bound profiles.id after PIN (no privileged CRM without UUID). */
const BOUND_IDENTITY_TOOLS = new Set([
  'lookupCustomerByPhone',
  'getAccountBriefing',
  'lookupQuote',
  'lookupProjectStatus',
  'getPortalLink',
  'logCallActivity',
  'searchCustomers',
  'searchProjects',
  'searchQuotes',
  'getBusinessSnapshot',
  'getTeamPerformance',
  'sendToStaffCynthia',
  'deliverCallFollowUp',
  'placeOutboundCall',
  'enqueueOutboundCall',
  'bookCallback',
  'scheduleAppointment',
  'escalateToStaff',
]);

export function isIdentityBound(identity: PhoneCallerIdentity): boolean {
  return Boolean(identity.userId || identity.member?.userId);
}

export function isToolAllowedForPhoneSession(
  toolName: string,
  callId: string,
  identity: PhoneCallerIdentity,
): boolean {
  if (identity.kind === 'customer') return true;
  if (PRE_AUTH_PHONE_TOOLS.has(toolName)) return true;
  if (!isPhoneAuthVerified(callId)) return false;
  if (BOUND_IDENTITY_TOOLS.has(toolName) && !isIdentityBound(identity)) return false;
  const allowed = identity.kind === 'foreman' ? BUILDER_PHONE_TOOL_NAMES : STAFF_PHONE_TOOL_NAMES;
  return (allowed as readonly string[]).includes(toolName);
}

export { MAX_PIN_ATTEMPTS, PIN_LEN };
