import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { decryptSecret, encryptSecret } from './crypto';
import { BDIDDIES_HOME_ORG_ID, BDIDDIES_HOME_ORG_LEGACY_ID, BDIDDIES_COMPANY, getHomeOrgId } from './home-org';
import { setCompanySettings } from './conversation-store';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const ORGS_FILE = join(DATA_DIR, 'organizations.json');

export type OrgStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
export type OrgPlan = 'starter' | 'pro' | 'enterprise' | 'sync2dine_platform' | 'sync2dine_kiosk';

export const PLAN_CONFIG: Record<
  OrgPlan,
  { label: string; monthlyPriceGbp: number; monthlyTokenCap: number }
> = {
  starter: { label: 'Starter', monthlyPriceGbp: 99, monthlyTokenCap: 500_000 },
  pro: { label: 'Pro', monthlyPriceGbp: 199, monthlyTokenCap: 2_000_000 },
  enterprise: { label: 'Enterprise', monthlyPriceGbp: 499, monthlyTokenCap: 10_000_000 },
  sync2dine_platform: { label: 'Sync2Dine Platform', monthlyPriceGbp: 399, monthlyTokenCap: 3_000_000 },
  sync2dine_kiosk: { label: 'Sync2Dine Kiosk Screen', monthlyPriceGbp: 249, monthlyTokenCap: 750_000 },
};

export type AIBrainProvider = 'openai' | 'deepseek';

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
  /** Active text-brain provider. Vision/Whisper/Realtime always use OpenAI. */
  aiProvider?: AIBrainProvider;
  deepseekApiKeyEncrypted?: string;
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
  if (memoryOrgs.length === 0) {
    memoryOrgs = loadFromDisk();
    ensureBdiddiesHomeOrg();
  }
  return [...memoryOrgs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Seed Sync2Dine as the platform home org if missing. Migrates legacy slug → uuid. */
export function ensureBdiddiesHomeOrg(): Organization {
  if (memoryOrgs.length === 0) memoryOrgs = loadFromDisk();
  const homeId = getHomeOrgId();

  const legacy = memoryOrgs.find((o) => o.id === BDIDDIES_HOME_ORG_LEGACY_ID);
  if (legacy && homeId !== BDIDDIES_HOME_ORG_LEGACY_ID) {
    memoryOrgs = memoryOrgs.map((o) =>
      o.id === BDIDDIES_HOME_ORG_LEGACY_ID ? { ...o, id: homeId, name: BDIDDIES_COMPANY.companyName } : o,
    );
    persist();
  }

  const existing = memoryOrgs.find((o) => o.id === homeId || o.id === BDIDDIES_HOME_ORG_ID);
  if (existing) {
    try {
      setCompanySettings(existing.id, {
        companyName: BDIDDIES_COMPANY.companyName,
        website: BDIDDIES_COMPANY.website,
      });
    } catch {
      // data store may not be ready in some import orders
    }
    return existing;
  }
  const now = new Date().toISOString();
  const org: Organization = {
    id: homeId,
    name: BDIDDIES_COMPANY.companyName,
    contactName: 'Platform Owner',
    contactEmail: BDIDDIES_COMPANY.email,
    contactPhone: BDIDDIES_COMPANY.phone,
    status: 'active',
    plan: 'enterprise',
    openaiApiKeyEncrypted: '',
    monthlyTokenCap: PLAN_CONFIG.enterprise.monthlyTokenCap,
    createdAt: now,
    updatedAt: now,
    notes: 'Platform home org (Sync2Dine). Staff invited by platform_owner land here.',
  };
  memoryOrgs = [org, ...memoryOrgs];
  persist();
  try {
    setCompanySettings(homeId, {
      companyName: BDIDDIES_COMPANY.companyName,
      website: BDIDDIES_COMPANY.website,
    });
  } catch {
    // ignore
  }
  return org;
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

/** In-memory plaintext cache (also hydrates from Supabase for cloud org UUIDs). */
const orgOpenAIKeyCache = new Map<string, string>();
const orgOpenAIKeyLoadAttempts = new Set<string>();
const orgDeepSeekKeyCache = new Map<string, string>();
const orgAIProviderCache = new Map<string, AIBrainProvider>();

export function getOrgOpenAIApiKey(orgId: string): string | undefined {
  const cached = orgOpenAIKeyCache.get(orgId);
  if (cached) return cached;

  const org = getOrganizationById(orgId);
  if (!org?.openaiApiKeyEncrypted) return undefined;
  const key = decryptSecret(org.openaiApiKeyEncrypted).trim();
  if (key) orgOpenAIKeyCache.set(orgId, key);
  return key || undefined;
}

export function getOrgDeepSeekApiKey(orgId: string): string | undefined {
  const cached = orgDeepSeekKeyCache.get(orgId);
  if (cached) return cached;
  const org = getOrganizationById(orgId);
  if (!org?.deepseekApiKeyEncrypted) return undefined;
  const key = decryptSecret(org.deepseekApiKeyEncrypted).trim();
  if (key) orgDeepSeekKeyCache.set(orgId, key);
  return key || undefined;
}

export function getOrgAIBrain(orgId: string): {
  provider: AIBrainProvider;
  openaiConfigured: boolean;
  deepseekConfigured: boolean;
} {
  const cachedProvider = orgAIProviderCache.get(orgId);
  const org = getOrganizationById(orgId);
  const provider = cachedProvider
    || (org?.aiProvider === 'deepseek' ? 'deepseek' : 'openai');
  return {
    provider,
    openaiConfigured: Boolean(getOrgOpenAIApiKey(orgId)),
    deepseekConfigured: Boolean(getOrgDeepSeekApiKey(orgId)),
  };
}

export async function ensureOrgAIBrainLoaded(orgId: string): Promise<void> {
  await ensureOrgOpenAIKeyLoaded(orgId);
}

export function maskOpenAIApiKeyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

export function getOrgOpenAIKeyStatus(orgId: string): {
  configured: boolean;
  maskedHint?: string;
  provider?: AIBrainProvider;
  deepseekConfigured?: boolean;
  deepseekMaskedHint?: string;
} {
  const key = getOrgOpenAIApiKey(orgId);
  const deepseek = getOrgDeepSeekApiKey(orgId);
  const brain = getOrgAIBrain(orgId);
  return {
    configured: Boolean(key),
    maskedHint: key ? maskOpenAIApiKeyHint(key) : undefined,
    provider: brain.provider,
    deepseekConfigured: Boolean(deepseek),
    deepseekMaskedHint: deepseek ? maskOpenAIApiKeyHint(deepseek) : undefined,
  };
}

/** Ensure a local org row exists for cloud UUIDs before writing the key. */
function ensureLocalOrgStub(orgId: string): Organization {
  const existing = getOrganizationById(orgId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const stub: Organization = {
    id: orgId,
    name: 'Organization',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    status: 'active',
    plan: 'starter',
    openaiApiKeyEncrypted: '',
    monthlyTokenCap: PLAN_CONFIG.starter.monthlyTokenCap,
    createdAt: now,
    updatedAt: now,
  };
  memoryOrgs = [stub, ...listOrganizations()];
  persist();
  return stub;
}

export function setOrgOpenAIApiKey(orgId: string, apiKey: string): Organization {
  ensureLocalOrgStub(orgId);
  const updated = updateOrganization(orgId, { openaiApiKey: apiKey });
  if (!updated) throw new Error('Failed to update organization OpenAI key');
  const trimmed = apiKey.trim();
  if (trimmed) orgOpenAIKeyCache.set(orgId, trimmed);
  else orgOpenAIKeyCache.delete(orgId);
  orgOpenAIKeyLoadAttempts.delete(orgId);
  return updated;
}

/** Save company AI brain settings (OpenAI key + optional DeepSeek + active provider). */
export function setOrgAIBrainConfig(
  orgId: string,
  config: {
    openaiApiKey?: string;
    deepseekApiKey?: string;
    provider?: AIBrainProvider;
  },
): Organization {
  ensureLocalOrgStub(orgId);
  const patch: Partial<Omit<Organization, 'id' | 'createdAt'>> & {
    openaiApiKey?: string;
    deepseekApiKey?: string;
  } = {};
  if (config.openaiApiKey !== undefined) patch.openaiApiKey = config.openaiApiKey;
  if (config.deepseekApiKey !== undefined) patch.deepseekApiKey = config.deepseekApiKey;
  if (config.provider === 'openai' || config.provider === 'deepseek') {
    patch.aiProvider = config.provider;
    orgAIProviderCache.set(orgId, config.provider);
  }
  const updated = updateOrganization(orgId, patch);
  if (!updated) throw new Error('Failed to update organization AI brain');
  if (config.openaiApiKey !== undefined) {
    const trimmed = config.openaiApiKey.trim();
    if (trimmed) orgOpenAIKeyCache.set(orgId, trimmed);
    else orgOpenAIKeyCache.delete(orgId);
    orgOpenAIKeyLoadAttempts.delete(orgId);
  }
  if (config.deepseekApiKey !== undefined) {
    const trimmed = config.deepseekApiKey.trim();
    if (trimmed) orgDeepSeekKeyCache.set(orgId, trimmed);
    else orgDeepSeekKeyCache.delete(orgId);
  }
  return updated;
}

async function getSupabaseServiceClient(): Promise<{
  from: (table: string) => {
    select: (cols: string) => { eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: { openai_api_key_encrypted?: string } | null }> } };
    update: (row: Record<string, unknown>) => { eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> };
  };
} | null> {
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as Awaited<ReturnType<typeof getSupabaseServiceClient>>;
  } catch {
    return null;
  }
}

/** Persist encrypted org key to Supabase when service role is available. */
export async function syncOrgOpenAIKeyToSupabase(orgId: string, encrypted: string): Promise<{ synced: boolean; warning?: string }> {
  const supabase = await getSupabaseServiceClient();
  if (!supabase) {
    return {
      synced: false,
      warning:
        'Key saved on this server, but cloud sync is unavailable (missing SUPABASE_SERVICE_ROLE_KEY). Builder/customer AI may fail if API runs in another process.',
    };
  }

  const now = new Date().toISOString();
  const local = getOrganizationById(orgId);
  const { data: existing, error: readError } = await supabase
    .from('organizations')
    .select('id')
    .eq('id', orgId)
    .maybeSingle();

  if (readError) {
    console.warn('[org-openai-key] Supabase read failed:', readError.message);
    return {
      synced: false,
      warning: `Key saved locally, but cloud sync failed (${readError.message}).`,
    };
  }

  let error: { message: string } | null = null;
  if (existing?.id) {
    const result = await supabase
      .from('organizations')
      .update({ openai_api_key_encrypted: encrypted, updated_at: now })
      .eq('id', orgId);
    error = result.error;
  } else {
    // Org UUID from auth profiles may not exist yet in cloud — upsert a stub with the key.
    const result = await supabase.from('organizations').upsert(
      {
        id: orgId,
        name: local?.name || 'Organization',
        contact_name: local?.contactName || '',
        contact_email: local?.contactEmail || '',
        contact_phone: local?.contactPhone || '',
        status: local?.status || 'active',
        plan: local?.plan || 'starter',
        openai_api_key_encrypted: encrypted,
        monthly_token_cap: local?.monthlyTokenCap ?? 500_000,
        updated_at: now,
      },
      { onConflict: 'id' },
    );
    error = result.error;
  }

  if (error) {
    console.warn('[org-openai-key] Supabase sync failed:', error.message);
    return {
      synced: false,
      warning: `Key saved locally, but cloud sync failed (${error.message}). Builder/customer AI may fail until the key is available to the API server.`,
    };
  }
  return { synced: true };
}

/** Load org key from Supabase into local store/cache when missing locally. */
export async function ensureOrgOpenAIKeyLoaded(orgId: string): Promise<void> {
  if (!orgId) return;
  if (getOrgOpenAIApiKey(orgId)) return;
  if (orgOpenAIKeyLoadAttempts.has(orgId)) return;
  orgOpenAIKeyLoadAttempts.add(orgId);

  const supabase = await getSupabaseServiceClient();
  if (!supabase) {
    // Allow retry later if service role env becomes available.
    orgOpenAIKeyLoadAttempts.delete(orgId);
    return;
  }

  try {
    const { data } = await supabase
      .from('organizations')
      .select('openai_api_key_encrypted')
      .eq('id', orgId)
      .maybeSingle();
    const encrypted = data?.openai_api_key_encrypted?.trim();
    if (!encrypted) {
      // Key may be saved moments later — allow a future retry.
      orgOpenAIKeyLoadAttempts.delete(orgId);
      return;
    }
    ensureLocalOrgStub(orgId);
    const orgs = listOrganizations();
    const idx = orgs.findIndex(o => o.id === orgId);
    if (idx >= 0) {
      orgs[idx] = { ...orgs[idx], openaiApiKeyEncrypted: encrypted, updatedAt: new Date().toISOString() };
      memoryOrgs = orgs;
      persist();
    }
    const key = decryptSecret(encrypted).trim();
    if (key) orgOpenAIKeyCache.set(orgId, key);
    else orgOpenAIKeyLoadAttempts.delete(orgId);
  } catch (err) {
    orgOpenAIKeyLoadAttempts.delete(orgId);
    console.warn('[org-openai-key] Failed to load key from Supabase:', err);
  }
}

export interface CreateOrganizationInput {
  id?: string;
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

  if (input.id?.trim()) {
    const existing = getOrganizationById(input.id.trim());
    if (existing) return existing;
  }

  const org: Organization = {
    id: input.id?.trim() || `org_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
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
  try {
    setCompanySettings(org.id, {
      companyName: org.name,
      website: '',
    });
  } catch {
    // ignore
  }
  return org;
}

export function updateOrganization(
  id: string,
  patch: Partial<Omit<Organization, 'id' | 'createdAt'>> & {
    openaiApiKey?: string;
    deepseekApiKey?: string;
  },
): Organization | undefined {
  const orgs = listOrganizations();
  const idx = orgs.findIndex(o => o.id === id);
  if (idx < 0) return undefined;

  const { openaiApiKey, deepseekApiKey, ...rest } = patch;
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
  if (deepseekApiKey !== undefined) {
    updated.deepseekApiKeyEncrypted = deepseekApiKey.trim()
      ? encryptSecret(deepseekApiKey.trim())
      : '';
  }
  if (updated.aiProvider === 'deepseek' || updated.aiProvider === 'openai') {
    orgAIProviderCache.set(id, updated.aiProvider);
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
