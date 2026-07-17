/**
 * Per-org phone billing config + outbound minute metering helpers.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyUkPhoneNumber, type PhoneNumberType } from './phone-number-type';
import {
  recordProviderUsage,
  getProviderQuantityThisMonth,
  getProviderEventsThisMonth,
  normalizeUsageOrgId,
} from './usage';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const BILLING_FILE = join(DATA_DIR, 'phone-billing.json');

export interface PhoneBillingConfig {
  orgId: string;
  /** Free outbound minutes included each calendar month */
  phoneMinutesIncluded: number;
  /** GBP per minute for UK mobiles (overage) */
  phoneRateMobilePerMin: number;
  /** GBP per minute for landlines (overage) */
  phoneRateLandlinePerMin: number;
  /** Optional Soho66 trunk fields stored for Settings UI */
  soho66SipUsername?: string;
  soho66SipPassword?: string;
  soho66SipDomain?: string;
  soho66FromNumber?: string;
  soho66BridgeUrl?: string;
  updatedAt: string;
}

const DEFAULTS: Omit<PhoneBillingConfig, 'orgId' | 'updatedAt'> = {
  phoneMinutesIncluded: 100,
  phoneRateMobilePerMin: 0.12,
  phoneRateLandlinePerMin: 0.03,
  soho66SipDomain: 'sbc.soho66.co.uk',
};

let memory: Record<string, PhoneBillingConfig> = {};

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (Object.keys(memory).length) return;
  try {
    if (existsSync(BILLING_FILE)) {
      memory = JSON.parse(readFileSync(BILLING_FILE, 'utf-8')) as Record<string, PhoneBillingConfig>;
    }
  } catch {
    memory = {};
  }
}

function persist() {
  ensureDir();
  try {
    writeFileSync(BILLING_FILE, JSON.stringify(memory, null, 2));
  } catch {
    /* ignore */
  }
}

export function getPhoneBillingConfig(orgId: string): PhoneBillingConfig {
  load();
  const oid = normalizeUsageOrgId(orgId);
  const existing = memory[oid] || memory[orgId];
  if (existing) {
    return {
      ...DEFAULTS,
      ...existing,
      orgId: oid,
      soho66SipDomain: existing.soho66SipDomain || DEFAULTS.soho66SipDomain,
    };
  }
  return {
    orgId: oid,
    ...DEFAULTS,
    soho66SipUsername: process.env.SOHO66_SIP_USERNAME?.trim() || undefined,
    soho66FromNumber: process.env.SOHO66_FROM_NUMBER?.trim() || undefined,
    soho66BridgeUrl: process.env.SOHO66_SIP_BRIDGE_URL?.trim() || undefined,
    soho66SipDomain: process.env.SOHO66_SIP_DOMAIN?.trim() || DEFAULTS.soho66SipDomain,
    updatedAt: new Date().toISOString(),
  };
}

export function setPhoneBillingConfig(
  orgId: string,
  patch: Partial<Omit<PhoneBillingConfig, 'orgId' | 'updatedAt'>>,
): PhoneBillingConfig {
  load();
  const oid = normalizeUsageOrgId(orgId);
  const prev = getPhoneBillingConfig(oid);
  const next: PhoneBillingConfig = {
    ...prev,
    ...patch,
    orgId: oid,
    phoneMinutesIncluded: Math.max(0, Number(patch.phoneMinutesIncluded ?? prev.phoneMinutesIncluded)),
    phoneRateMobilePerMin: Math.max(0, Number(patch.phoneRateMobilePerMin ?? prev.phoneRateMobilePerMin)),
    phoneRateLandlinePerMin: Math.max(0, Number(patch.phoneRateLandlinePerMin ?? prev.phoneRateLandlinePerMin)),
    updatedAt: new Date().toISOString(),
  };
  // Don't persist plaintext password wipe if empty string means "leave unchanged"
  if (patch.soho66SipPassword === '' || patch.soho66SipPassword === undefined) {
    next.soho66SipPassword = prev.soho66SipPassword;
  }
  memory[oid] = next;
  persist();
  return maskPhoneBilling(next);
}

export function maskPhoneBilling(cfg: PhoneBillingConfig) {
  return {
    ...cfg,
    soho66SipPassword: cfg.soho66SipPassword ? '••••••' : '',
    hasSoho66Password: Boolean(cfg.soho66SipPassword || process.env.SOHO66_SIP_PASSWORD?.trim()),
  };
}

export function recordOutboundPhoneUsage(input: {
  orgId: string;
  seconds: number;
  toNumber: string;
  fromNumber?: string;
  callId?: string;
}): void {
  const secs = Math.max(0, Math.round(input.seconds));
  const orgId = normalizeUsageOrgId(input.orgId);
  if (secs <= 0 || !orgId) return;
  const numberType: PhoneNumberType = classifyUkPhoneNumber(input.toNumber);
  recordProviderUsage({
    orgId,
    provider: 'phone',
    unit: 'seconds',
    quantity: secs,
    endpoint: 'phone.outbound',
    model: numberType,
    metadata: {
      numberType,
      to: input.toNumber,
      from: input.fromNumber,
      callId: input.callId,
    },
    costUsd: 0, // cost computed at summary time against free allowance
  });
}

export function getPhoneUsageSummary(orgId: string) {
  const oid = normalizeUsageOrgId(orgId);
  const cfg = getPhoneBillingConfig(oid);
  const events = getProviderEventsThisMonth(oid, 'phone');
  let mobileSec = 0;
  let landlineSec = 0;
  let unknownSec = 0;
  for (const e of events) {
    const t = String(e.metadata?.numberType || e.model || 'unknown');
    const q = Number(e.quantity || e.totalTokens || 0);
    if (t === 'mobile') mobileSec += q;
    else if (t === 'landline') landlineSec += q;
    else unknownSec += q;
  }
  const totalSec = mobileSec + landlineSec + unknownSec;
  const totalMin = totalSec / 60;
  const included = cfg.phoneMinutesIncluded;
  const usedMin = totalMin;
  const freeRemaining = Math.max(0, included - usedMin);
  const overageMin = Math.max(0, usedMin - included);
  // Allocate overage proportionally to mobile vs landline
  const mobileMin = mobileSec / 60;
  const landlineMin = landlineSec / 60;
  const typedMin = mobileMin + landlineMin;
  let overageMobile = 0;
  let overageLandline = 0;
  if (overageMin > 0 && typedMin > 0) {
    overageMobile = overageMin * (mobileMin / typedMin);
    overageLandline = overageMin * (landlineMin / typedMin);
  } else if (overageMin > 0) {
    overageLandline = overageMin;
  }
  const estimatedCostGbp =
    overageMobile * cfg.phoneRateMobilePerMin + overageLandline * cfg.phoneRateLandlinePerMin;

  return {
    orgId: oid,
    phoneMinutesIncluded: included,
    phoneRateMobilePerMin: cfg.phoneRateMobilePerMin,
    phoneRateLandlinePerMin: cfg.phoneRateLandlinePerMin,
    outboundSeconds: totalSec,
    outboundMinutes: Math.round(usedMin * 100) / 100,
    mobileMinutes: Math.round(mobileMin * 100) / 100,
    landlineMinutes: Math.round(landlineMin * 100) / 100,
    unknownMinutes: Math.round((unknownSec / 60) * 100) / 100,
    freeMinutesRemaining: Math.round(freeRemaining * 100) / 100,
    overageMobileMinutes: Math.round(overageMobile * 100) / 100,
    overageLandlineMinutes: Math.round(overageLandline * 100) / 100,
    estimatedCostGbp: Math.round(estimatedCostGbp * 100) / 100,
    callCount: events.length,
  };
}

// avoid circular init issues — re-export quantity helper
export function getPhoneSecondsThisMonth(orgId: string): number {
  return getProviderQuantityThisMonth(orgId, 'phone');
}
