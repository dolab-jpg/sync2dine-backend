import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { decryptSecret, encryptSecret } from './crypto';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const ORGS_FILE = join(DATA_DIR, 'organizations.json');

export type OrgStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
export type OrgPlan = 'starter' | 'pro' | 'enterprise';

export const PLAN_CONFIG: Record<
  OrgPlan,
  { label: string; monthlyPriceGbp: number; monthlyTokenCap: number }
> = {
  starter: { label: 'Starter', monthlyPriceGbp: 99, monthlyTokenCap: 500_000 },
  pro: { label: 'Pro', monthlyPriceGbp: 199, monthlyTokenCap: 2_000_000 },
  enterprise: { label: 'Enterprise', monthlyPriceGbp: 499, monthlyTokenCap: 10_000_000 },
};

export interface Organization {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  address?: string;
  status: OrgStatus;
  plan: OrgPlan;
  openaiApiKeyEncrypted: string;
  monthlyTokenCap: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
  currentPeriodEnd?: string;
  trialEndsAt?: string;
  whatsappPhoneNumberId?: string;
  phoneDid?: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

let memoryOrgs: Organization[] = [];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk(): Organization[] {
  try {
    if (existsSync(ORGS_FILE)) {
      const parsed = JSON.parse(readFileSync(ORGS_FILE, 'utf-8'));
      return Array.isArray(parsed) ? parsed as Organization[] : [];
    }
  } catch {
    // ignore
  }
  return [];
}

function persist() {
  ensureDir();
  try {
    writeFileSync(ORGS_FILE, JSON.stringify(memoryOrgs, null, 2));
  } catch {
    // ignore write errors in dev
  }
}

export function listOrganizations(): Organization[] {
  if (memoryOrgs.length === 0) memoryOrgs = loadFromDisk();
  return [...memoryOrgs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function getOrganizationById(id: string): Organization | undefined {
  return listOrganizations().find(o => o.id === id);
}

export function getOrganizationByStripeCustomerId(customerId: string): Organization | undefined {
  return listOrganizations().find(o => o.stripeCustomerId === customerId);
}

export function getOrganizationByStripeSubscriptionId(subId: string): Organization | undefined {
  return listOrganizations().find(o => o.stripeSubscriptionId === subId);
}

export function getOrganizationByWhatsAppPhoneNumberId(phoneNumberId: string): Organization | undefined {
  return listOrganizations().find(o => o.whatsappPhoneNumberId === phoneNumberId);
}

export function getOrganizationByPhoneDid(did: string): Organization | undefined {
  const digits = did.replace(/\D/g, '');
  return listOrganizations().find(o => o.phoneDid?.replace(/\D/g, '') === digits);
}

export function maskOrganization(org: Organization, tokensUsedThisMonth = 0) {
  return {
    ...org,
    openaiApiKeyEncrypted: org.openaiApiKeyEncrypted ? '••••••' : '',
    tokensUsedThisMonth,
  };
}

export function getOrgOpenAIApiKey(orgId: string): string | undefined {
  const org = getOrganizationById(orgId);
  if (!org?.openaiApiKeyEncrypted) return undefined;
  const key = decryptSecret(org.openaiApiKeyEncrypted).trim();
  return key || undefined;
}

export interface CreateOrganizationInput {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  address?: string;
  plan?: OrgPlan;
  status?: OrgStatus;
  openaiApiKey?: string;
  monthlyTokenCap?: number;
  notes?: string;
  trialDays?: number;
}

export function createOrganization(input: CreateOrganizationInput): Organization {
  const plan = input.plan ?? 'starter';
  const cfg = PLAN_CONFIG[plan];
  const now = new Date().toISOString();
  const trialEnds = input.status === 'trial' || !input.status
    ? new Date(Date.now() + (input.trialDays ?? 14) * 86400000).toISOString()
    : undefined;

  const org: Organization = {
    id: `org_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim(),
    contactName: input.contactName.trim(),
    contactEmail: input.contactEmail.trim(),
    contactPhone: input.contactPhone.trim(),
    address: input.address?.trim(),
    status: input.status ?? 'trial',
    plan,
    openaiApiKeyEncrypted: input.openaiApiKey?.trim()
      ? encryptSecret(input.openaiApiKey.trim())
      : '',
    monthlyTokenCap: input.monthlyTokenCap ?? cfg.monthlyTokenCap,
    trialEndsAt: trialEnds,
    createdAt: now,
    updatedAt: now,
    notes: input.notes?.trim(),
  };

  memoryOrgs = [org, ...listOrganizations()];
  persist();
  return org;
}

export function updateOrganization(
  id: string,
  patch: Partial<Omit<Organization, 'id' | 'createdAt'>> & { openaiApiKey?: string },
): Organization | undefined {
  const orgs = listOrganizations();
  const idx = orgs.findIndex(o => o.id === id);
  if (idx < 0) return undefined;

  const { openaiApiKey, ...rest } = patch;
  const updated: Organization = {
    ...orgs[idx],
    ...rest,
    updatedAt: new Date().toISOString(),
  };
  if (openaiApiKey !== undefined) {
    updated.openaiApiKeyEncrypted = openaiApiKey.trim()
      ? encryptSecret(openaiApiKey.trim())
      : '';
  }

  orgs[idx] = updated;
  memoryOrgs = orgs;
  persist();
  return updated;
}

export function deleteOrganization(id: string): boolean {
  const before = listOrganizations().length;
  memoryOrgs = listOrganizations().filter(o => o.id !== id);
  if (memoryOrgs.length === before) return false;
  persist();
  return true;
}
