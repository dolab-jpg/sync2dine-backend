/**
 * Sync2Dine SaaS subscription contracts — server-backed, signing-gated checkout.
 * Template id: sync2dine-saas-subscription-v1
 */
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  FARE_SCHEDULE_VERSION,
  OUTBOUND_OVERAGE,
  SAAS_PACKAGES,
  type OverageAction,
  type SaasPackageId,
  formatFareSummary,
  getPackage,
  isSaasPackageId,
} from './saas-packages';
import { isLaunchOfferActive, getSallyOfferStored } from './sally-offer-store';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const CONTRACTS_FILE = join(DATA_DIR, 'saas-contracts.json');

export const SAAS_CONTRACT_TEMPLATE_ID = 'sync2dine-saas-subscription-v1';

export type SaasContractStatus = 'draft' | 'sent' | 'signed' | 'void';

export type SaasContract = {
  id: string;
  templateId: typeof SAAS_CONTRACT_TEMPLATE_ID;
  status: SaasContractStatus;
  packageId: SaasPackageId;
  billingInterval: 'weekly' | 'annual';
  useLaunch: boolean;
  weeklyGbp: number;
  standardWeeklyGbp: number;
  annualPrepayGbp: number;
  amountGbp: number;
  additionalSites: number;
  overageAction: OverageAction;
  fareScheduleVersion: string;
  fareSummary: string;
  customerId?: string;
  organizationId?: string;
  restaurantName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  offerEndsAt?: string | null;
  signingToken: string;
  signingUrl?: string;
  sentAt?: string;
  signedAt?: string;
  signatureName?: string;
  consents?: {
    terms: boolean;
    fairUse: boolean;
    privacy: boolean;
    acceptableUse: boolean;
    marketing?: boolean;
    consentedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  notes?: string;
};

let memory: SaasContract[] | null = null;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): SaasContract[] {
  if (memory) return memory;
  try {
    if (existsSync(CONTRACTS_FILE)) {
      const parsed = JSON.parse(readFileSync(CONTRACTS_FILE, 'utf-8'));
      memory = Array.isArray(parsed) ? (parsed as SaasContract[]) : [];
      return memory;
    }
  } catch {
    /* ignore */
  }
  memory = [];
  return memory;
}

function persist() {
  ensureDir();
  try {
    writeFileSync(CONTRACTS_FILE, JSON.stringify(memory || [], null, 2));
  } catch (err) {
    console.warn('[saas-contracts] persist failed:', err instanceof Error ? err.message : err);
  }
}

function newId(): string {
  return `s2dc_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function newToken(): string {
  return randomBytes(24).toString('hex');
}

export type CreateSaasContractInput = {
  packageId: SaasPackageId | string;
  billingInterval?: 'weekly' | 'annual';
  additionalSites?: number;
  overageAction?: OverageAction;
  customerId?: string;
  organizationId?: string;
  restaurantName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  createdBy?: string;
  notes?: string;
  forceStandard?: boolean;
};

export function createSaasContract(input: CreateSaasContractInput): SaasContract {
  if (!isSaasPackageId(input.packageId)) {
    throw new Error(`Unknown package: ${input.packageId}`);
  }
  const pkg = getPackage(input.packageId);
  const stored = getSallyOfferStored();
  const launchActive = !input.forceStandard && isLaunchOfferActive(stored);
  const interval = input.billingInterval === 'annual' ? 'annual' : 'weekly';
  const weeklyGbp = launchActive ? pkg.launchWeeklyGbp : pkg.standardWeeklyGbp;
  const sites = Math.max(0, Math.floor(Number(input.additionalSites) || 0));
  const siteWeekly = sites * 1;
  const amountGbp =
    interval === 'annual'
      ? pkg.annualPrepayGbp + sites * 26
      : weeklyGbp + siteWeekly;

  const now = new Date().toISOString();
  const contract: SaasContract = {
    id: newId(),
    templateId: SAAS_CONTRACT_TEMPLATE_ID,
    status: 'draft',
    packageId: input.packageId,
    billingInterval: interval,
    useLaunch: launchActive && interval === 'weekly',
    weeklyGbp,
    standardWeeklyGbp: pkg.standardWeeklyGbp,
    annualPrepayGbp: pkg.annualPrepayGbp,
    amountGbp: Math.round(amountGbp * 100) / 100,
    additionalSites: sites,
    overageAction: input.overageAction || 'continue_bill',
    fareScheduleVersion: stored.fareScheduleVersion || FARE_SCHEDULE_VERSION,
    fareSummary: formatFareSummary(pkg),
    customerId: input.customerId,
    organizationId: input.organizationId,
    restaurantName: String(input.restaurantName || '').trim(),
    contactName: String(input.contactName || '').trim(),
    contactEmail: String(input.contactEmail || '').trim().toLowerCase(),
    contactPhone: input.contactPhone ? String(input.contactPhone).trim() : undefined,
    address: input.address ? String(input.address).trim() : undefined,
    offerEndsAt: stored.offerEndsAt || null,
    signingToken: newToken(),
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy || 'sally',
    notes: input.notes,
  };

  const baseUrl = process.env.APP_BASE_URL?.trim() || 'https://app.sync2dine.io';
  contract.signingUrl = `${baseUrl}/start?contract=${contract.id}&token=${contract.signingToken}`;

  const all = load();
  all.unshift(contract);
  memory = all;
  persist();
  return contract;
}

export function getSaasContractById(id: string): SaasContract | null {
  return load().find((c) => c.id === id) || null;
}

export function getSaasContractByToken(token: string): SaasContract | null {
  return load().find((c) => c.signingToken === token) || null;
}

export function listSaasContracts(filter?: { customerId?: string; organizationId?: string }): SaasContract[] {
  let rows = load();
  if (filter?.customerId) rows = rows.filter((c) => c.customerId === filter.customerId);
  if (filter?.organizationId) rows = rows.filter((c) => c.organizationId === filter.organizationId);
  return rows;
}

export function markSaasContractSent(id: string): SaasContract | null {
  const all = load();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const now = new Date().toISOString();
  all[idx] = {
    ...all[idx]!,
    status: all[idx]!.status === 'signed' ? 'signed' : 'sent',
    sentAt: now,
    updatedAt: now,
  };
  memory = all;
  persist();
  return all[idx]!;
}

export function signSaasContract(input: {
  id: string;
  token: string;
  signatureName: string;
  consents: SaasContract['consents'];
}): SaasContract {
  const all = load();
  const idx = all.findIndex((c) => c.id === input.id);
  if (idx < 0) throw new Error('Contract not found');
  const c = all[idx]!;
  if (c.signingToken !== input.token) throw new Error('Invalid signing token');
  if (c.status === 'void') throw new Error('Contract voided');
  if (!input.consents?.terms || !input.consents?.fairUse || !input.consents?.privacy || !input.consents?.acceptableUse) {
    throw new Error('Required legal consents missing');
  }
  const now = new Date().toISOString();
  all[idx] = {
    ...c,
    status: 'signed',
    signedAt: now,
    signatureName: String(input.signatureName || '').trim(),
    consents: { ...input.consents, consentedAt: now },
    updatedAt: now,
  };
  memory = all;
  persist();
  return all[idx]!;
}

/** Gate: Checkout requires a signed contract for this org or explicit contract id. */
export function assertContractSignedForCheckout(opts: {
  contractId?: string;
  organizationId?: string;
}): SaasContract {
  if (opts.contractId) {
    const c = getSaasContractById(opts.contractId);
    if (!c) throw new Error('Contract not found');
    if (c.status !== 'signed') throw new Error('Contract must be signed before Checkout');
    return c;
  }
  if (opts.organizationId) {
    const signed = listSaasContracts({ organizationId: opts.organizationId }).find((c) => c.status === 'signed');
    if (!signed) throw new Error('Signed Sync2Dine SaaS contract required before Checkout');
    return signed;
  }
  throw new Error('contractId or organizationId required');
}

export function contractEmailBody(contract: SaasContract): { subject: string; text: string } {
  const pkg = SAAS_PACKAGES[contract.packageId];
  const subject = `Sync2Dine contract — ${contract.restaurantName} (${pkg.name})`;
  const text = [
    `Hi ${contract.contactName},`,
    '',
    `Please review and sign your Sync2Dine subscription for ${contract.restaurantName}.`,
    '',
    `Package: ${pkg.name}`,
    contract.billingInterval === 'annual'
      ? `Annual prepay: £${contract.amountGbp}`
      : `Weekly: £${contract.weeklyGbp}/week` +
        (contract.useLaunch ? ` (launch offer; normally £${contract.standardWeeklyGbp}/week)` : ''),
    contract.additionalSites > 0 ? `Additional sites: ${contract.additionalSites}` : null,
    `Overage action: ${contract.overageAction}`,
    '',
    contract.fareSummary,
    '',
    `Included Judie AI minutes/week: ${pkg.weeklyAiMinutes || 'n/a'}`,
    `Outbound minutes/week: ${pkg.weeklyOutboundMinutes}`,
    pkg.weeklyAiMinutes
      ? `AI overage: £${pkg.aiOverageGbpPerMinute}/min · Outbound overage: £${OUTBOUND_OVERAGE.mobileGbpPerMin}/min mobile / £${OUTBOUND_OVERAGE.landlineGbpPerMin}/min landline`
      : null,
    `Fare schedule: ${contract.fareScheduleVersion}`,
    '',
    `Sign here: ${contract.signingUrl}`,
    '',
    'Policies: /legal/terms · /legal/fair-use-and-fares · /legal/privacy · /legal/acceptable-use · /legal/cancellation-refunds',
    '',
    'Best regards,',
    'Sally — Sync2Dine',
  ]
    .filter((l) => l != null)
    .join('\n');
  return { subject, text };
}

export function contractFingerprint(contract: SaasContract): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: contract.id,
        packageId: contract.packageId,
        amountGbp: contract.amountGbp,
        fareScheduleVersion: contract.fareScheduleVersion,
        overageAction: contract.overageAction,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
