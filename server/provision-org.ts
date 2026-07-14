import { getSupabaseAdmin } from './supabase-admin.js';

const DEFAULT_RECRUITMENT_JOBS = [
  {
    id: 'J001',
    data: {
      title: 'Senior Sales Representative',
      department: 'sales',
      location: 'London, UK',
      status: 'open',
      description: 'Luxury bathroom sales.',
      salaryRange: '£35k-£45k',
      employmentType: 'full-time',
      requiredSkills: ['Sales'],
      qualifications: [],
      positions: 2,
    },
  },
  {
    id: 'J002',
    data: {
      title: 'Microcement Installation Specialist',
      department: 'construction',
      location: 'Manchester, UK',
      status: 'open',
      description: 'Microcement specialist.',
      salaryRange: '£32k-£42k',
      employmentType: 'full-time',
      requiredSkills: ['Microcement'],
      qualifications: [],
      positions: 3,
    },
  },
  {
    id: 'J003',
    data: {
      title: 'Office Administrator',
      department: 'office',
      location: 'Birmingham, UK',
      status: 'open',
      description: 'Office admin.',
      salaryRange: '£24k-£28k',
      employmentType: 'full-time',
      requiredSkills: ['Admin'],
      qualifications: [],
      positions: 1,
    },
  },
];

export type ProvisionOrgInput = {
  name: string;
  contactName?: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  plan?: string;
  monthlyTokenCap?: number;
  notes?: string;
  adminPassword: string;
  openaiApiKeyEncrypted?: string;
};

export type ProvisionOrgResult = {
  organization: Record<string, unknown>;
  mainUserEmail: string;
  mainUserCreated: true;
};

export function canProvisionViaSupabase(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

export async function provisionOrganizationInSupabase(
  input: ProvisionOrgInput,
): Promise<ProvisionOrgResult> {
  const supabase = getSupabaseAdmin();
  const name = input.name.trim();
  const contactEmail = input.contactEmail.trim().toLowerCase();
  const contactName = (input.contactName ?? name).trim() || name;
  const adminPassword = input.adminPassword.trim();

  if (!name || !contactEmail) {
    throw new Error('Company name and contact email are required');
  }
  if (!adminPassword || adminPassword.length < 8) {
    throw new Error('Main user password is required (min 8 characters)');
  }

  const plan = input.plan || 'starter';
  const tokenCaps: Record<string, number> = {
    starter: 500_000,
    pro: 2_000_000,
    enterprise: 10_000_000,
  };
  const monthlyTokenCap = input.monthlyTokenCap || tokenCaps[plan] || 500_000;

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert({
      name,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: input.contactPhone ?? '',
      address: input.address ?? null,
      plan: plan as 'starter' | 'pro' | 'enterprise',
      status: 'trial',
      monthly_token_cap: monthlyTokenCap,
      notes: input.notes ?? null,
      openai_api_key_encrypted: input.openaiApiKeyEncrypted ?? '',
      trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
    })
    .select()
    .single();

  if (orgError || !org) {
    throw new Error(orgError?.message ?? 'Failed to create organization');
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: contactEmail,
    password: adminPassword,
    email_confirm: true,
    user_metadata: {
      name: contactName,
      role: 'super_admin',
      org_id: org.id,
    },
  });

  if (authError || !authData.user) {
    await supabase.from('organizations').delete().eq('id', org.id);
    throw new Error(authError?.message ?? 'Failed to create main user');
  }

  const { error: profileError } = await supabase.from('profiles').upsert({
    id: authData.user.id,
    email: contactEmail,
    name: contactName,
    role: 'super_admin',
    org_id: org.id,
    updated_at: new Date().toISOString(),
  });

  if (profileError) {
    await supabase.auth.admin.deleteUser(authData.user.id);
    await supabase.from('organizations').delete().eq('id', org.id);
    throw new Error(profileError.message);
  }

  await supabase.from('agent_settings').upsert({
    org_id: org.id,
    is_active: true,
    data: { updatedAt: new Date().toISOString() },
  }, { onConflict: 'org_id' });

  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('recruitment_jobs').upsert(
    DEFAULT_RECRUITMENT_JOBS.map((job) => ({
      id: job.id,
      org_id: org.id,
      data: { ...job.data, createdAt: today },
    })),
    { onConflict: 'org_id,id' },
  );

  return {
    organization: org as unknown as Record<string, unknown>,
    mainUserEmail: contactEmail,
    mainUserCreated: true,
  };
}

export function mapSupabaseOrgToApi(row: Record<string, unknown>) {
  const plan = String(row.plan ?? 'starter');
  const planPrice: Record<string, number> = { starter: 99, pro: 199, enterprise: 499 };
  const planLabel: Record<string, string> = {
    starter: 'Starter',
    pro: 'Pro',
    enterprise: 'Enterprise',
  };
  return {
    id: String(row.id),
    name: String(row.name),
    contactName: String(row.contact_name ?? ''),
    contactEmail: String(row.contact_email ?? ''),
    contactPhone: String(row.contact_phone ?? ''),
    address: row.address ? String(row.address) : undefined,
    status: row.status,
    plan: row.plan,
    openaiApiKeyEncrypted: row.openai_api_key_encrypted
      ? `${String(row.openai_api_key_encrypted).slice(0, 8)}…`
      : '',
    monthlyTokenCap: Number(row.monthly_token_cap ?? 500000),
    tokensUsedThisMonth: 0,
    monthlyPriceGbp: planPrice[plan] ?? 99,
    planLabel: planLabel[plan] ?? plan,
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : undefined,
    stripeSubscriptionId: row.stripe_subscription_id
      ? String(row.stripe_subscription_id)
      : undefined,
    subscriptionStatus: row.subscription_status ? String(row.subscription_status) : undefined,
    currentPeriodEnd: row.current_period_end ? String(row.current_period_end) : undefined,
    trialEndsAt: row.trial_ends_at ? String(row.trial_ends_at) : undefined,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    notes: row.notes ? String(row.notes) : undefined,
  };
}
