/**
 * Promote a Sync2Dine CRM won sale into a Platform Client (organizations tenant).
 * Shared by Sally provision, CRM upsert hooks, SaaS contract sign, and quote paid.
 */
import { getHomeOrgId, isOrgUuid } from './home-org';
import {
  getDataStore,
  getRequestOrgId,
  saveCustomerRecord,
  withOrgContextAsync,
} from './data-store';
import { generateTempPassword, linkCrmToSallyOrg } from './sally/offer';
import { resolveCrmOrgId, mirrorCustomerToSupabase } from './supabase-crm';
import { isSaasPackageId } from './saas-packages';

export type EnsurePlatformClientInput = {
  customer?: Record<string, unknown>;
  customerId?: string;
  businessName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  plan?: string;
  adminPassword?: string;
  notes?: string;
  /** Selling org context � must be home org unless force=true */
  sellingOrgId?: string;
  /** Sally / explicit provision � skip home-org gate */
  force?: boolean;
};

export type EnsurePlatformClientResult = {
  ok: true;
  organizationId: string;
  organizationName: string;
  contactEmail: string;
  temporaryPassword?: string;
  plan: string;
  created: boolean;
  localOnly?: boolean;
  skipped?: false;
  organization: Record<string, unknown>;
} | {
  ok: true;
  skipped: true;
  reason: string;
} | {
  ok: false;
  error: string;
};

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function mapPackageToPlan(planOrPackage: string): string {
  const p = planOrPackage.trim().toLowerCase();
  if (!p) return 'starter';
  if (['starter', 'pro', 'enterprise', 'sync2dine_platform', 'sync2dine_kiosk'].includes(p)) {
    return p;
  }
  if (p.includes('enterprise')) return 'enterprise';
  if (p.includes('pro')) return 'pro';
  if (p.includes('atmosphere') && !p.includes('combined') && !p.includes('judie')) {
    return 'sync2dine_kiosk';
  }
  if (p.includes('combined') || p.includes('platform')) return 'sync2dine_platform';
  // judie_payg_inbound and other Judie packages → legacy starter for compatibility only
  return 'starter';
}

/** When input.plan is a SaaS package id, return it for organizations.saas_package_id. */
function resolveSaasPackageId(planOrPackage: string): string | undefined {
  const raw = planOrPackage.trim();
  if (!raw) return undefined;
  return isSaasPackageId(raw) ? raw : undefined;
}

function isHomeSellingOrg(sellingOrgId?: string): boolean {
  const home = getHomeOrgId();
  const raw = (sellingOrgId || getRequestOrgId() || '').trim();
  if (!raw) return true;
  if (raw === home) return true;
  if (raw === 'sync2dine' || raw === 'bdiddies') return true;
  return false;
}

async function findOrgById(orgId: string): Promise<Record<string, unknown> | null> {
  const { getOrganizationById } = await import('./organizations');
  const local = getOrganizationById(orgId);
  if (local) {
    return local as unknown as Record<string, unknown>;
  }
  try {
    const { canProvisionViaSupabase } = await import('./provision-org');
    if (!canProvisionViaSupabase()) return null;
    const { getSupabaseAdmin } = await import('./supabase-admin');
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.from('organizations').select('*').eq('id', orgId).maybeSingle();
    return data ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveCustomer(
  input: EnsurePlatformClientInput,
): Record<string, unknown> | null {
  if (input.customer && typeof input.customer === 'object') {
    return input.customer;
  }
  const id = firstString(input.customerId);
  if (!id) return null;
  const store = getDataStore();
  const found = (store.customers as Array<Record<string, unknown>>).find(
    (c) => String(c.id) === id,
  );
  return found ?? null;
}

async function linkCustomerToOrg(
  customer: Record<string, unknown> | null,
  orgId: string,
  contactEmail: string,
  contactPhone?: string,
  sellingOrgId?: string,
): Promise<void> {
  linkCrmToSallyOrg(orgId, contactEmail, contactPhone);
  if (customer?.id) {
    const updated = {
      ...customer,
      saasOrgId: orgId,
      organizationId: orgId,
      status: customer.status === 'won' ? customer.status : (customer.status ?? 'won'),
    };
    const home = getHomeOrgId();
    const orgHint = resolveCrmOrgId(sellingOrgId) || home;
    await withOrgContextAsync(orgHint, async () => {
      saveCustomerRecord(updated);
    });
    await mirrorCustomerToSupabase(updated, orgHint);
  }
}

/**
 * Idempotent: if CRM already has saasOrgId and org exists, return it.
 * Otherwise provision a trial org and link the CRM row.
 */
export async function ensurePlatformClientFromCrmCustomer(
  input: EnsurePlatformClientInput,
): Promise<EnsurePlatformClientResult> {
  if (!input.force && !isHomeSellingOrg(input.sellingOrgId)) {
    return { ok: true, skipped: true, reason: 'not_home_org' };
  }

  const customer = resolveCustomer(input);
  const existingOrgId = firstString(
    customer?.saasOrgId,
    customer?.organizationId,
    input.customer?.saasOrgId,
    input.customer?.organizationId,
  );

  if (existingOrgId && isOrgUuid(existingOrgId)) {
    const existing = await findOrgById(existingOrgId);
    if (existing) {
      const {
        mapSupabaseOrgToApi,
      } = await import('./provision-org');
      const api = existing.id && existing.contact_email
        ? mapSupabaseOrgToApi(existing)
        : {
            id: String(existing.id),
            name: String(existing.name ?? ''),
            contactEmail: String(existing.contactEmail ?? existing.contact_email ?? ''),
            plan: String(existing.plan ?? 'starter'),
          };
      return {
        ok: true,
        organizationId: String(api.id),
        organizationName: String(api.name),
        contactEmail: String(api.contactEmail),
        plan: String(api.plan ?? 'starter'),
        created: false,
        organization: api as Record<string, unknown>,
      };
    }
  }

  const contactEmail = firstString(
    input.contactEmail,
    customer?.email,
    customer?.contactEmail,
  ).toLowerCase();
  if (!contactEmail || !contactEmail.includes('@')) {
    return { ok: false, error: 'email_required' };
  }

  const businessName = firstString(
    input.businessName,
    customer?.company,
    customer?.companyName,
    customer?.businessName,
    customer?.name,
    'New Restaurant',
  );
  const contactName = firstString(
    input.contactName,
    customer?.contactName,
    customer?.name,
    businessName,
  );
  const contactPhone = firstString(
    input.contactPhone,
    customer?.phone,
    customer?.contactPhone,
  );
  const address = firstString(input.address, customer?.address);
  const planRaw = firstString(input.plan, customer?.plan, customer?.packageId);
  const plan = mapPackageToPlan(planRaw);
  const saasPackageId = resolveSaasPackageId(planRaw);
  const adminPassword = firstString(input.adminPassword) || generateTempPassword();
  const notes = firstString(input.notes)
    || `Provisioned from CRM sale${customer?.id ? ` (customer ${customer.id})` : ''}.`;

  try {
    const {
      canProvisionViaSupabase,
      provisionOrganizationInSupabase,
      mapSupabaseOrgToApi,
    } = await import('./provision-org');

    if (canProvisionViaSupabase()) {
      // Reuse existing tenant with same contact email if present
      try {
        const { getSupabaseAdmin } = await import('./supabase-admin');
        const supabase = getSupabaseAdmin();
        const { data: byEmail } = await supabase
          .from('organizations')
          .select('*')
          .ilike('contact_email', contactEmail)
          .limit(1)
          .maybeSingle();
        if (byEmail?.id) {
          if (saasPackageId && !byEmail.saas_package_id) {
            try {
              await supabase
                .from('organizations')
                .update({ saas_package_id: saasPackageId })
                .eq('id', byEmail.id);
              (byEmail as Record<string, unknown>).saas_package_id = saasPackageId;
            } catch {
              /* non-fatal */
            }
          }
          const org = mapSupabaseOrgToApi(byEmail as Record<string, unknown>);
          await linkCustomerToOrg(
            customer,
            org.id,
            contactEmail,
            contactPhone,
            input.sellingOrgId,
          );
          try {
            const { updateOrganization, getOrganizationById } = await import('./organizations');
            if (getOrganizationById(org.id) && saasPackageId) {
              updateOrganization(org.id, { saasPackageId });
            }
          } catch {
            /* non-fatal */
          }
          return {
            ok: true,
            organizationId: org.id,
            organizationName: org.name,
            contactEmail,
            plan: String(org.plan ?? plan),
            created: false,
            organization: org as unknown as Record<string, unknown>,
          };
        }
      } catch {
        // continue to provision
      }

      const provisioned = await provisionOrganizationInSupabase({
        name: businessName,
        contactName,
        contactEmail,
        contactPhone,
        address: address || undefined,
        plan,
        saasPackageId,
        adminPassword,
        notes,
      });
      const org = mapSupabaseOrgToApi(provisioned.organization);

      try {
        const { createOrganization } = await import('./organizations');
        createOrganization({
          id: org.id,
          name: businessName,
          contactName,
          contactEmail,
          contactPhone,
          address: address || undefined,
          plan: plan as 'starter' | 'pro' | 'enterprise' | 'sync2dine_platform' | 'sync2dine_kiosk',
          status: 'trial',
          notes,
          saasPackageId,
        });
      } catch {
        // disk mirror non-fatal
      }

      await linkCustomerToOrg(
        customer,
        org.id,
        contactEmail,
        contactPhone,
        input.sellingOrgId,
      );

      return {
        ok: true,
        organizationId: org.id,
        organizationName: org.name,
        contactEmail,
        temporaryPassword: adminPassword,
        plan: String(org.plan ?? plan),
        created: true,
        organization: org as unknown as Record<string, unknown>,
      };
    }

    const { createOrganization } = await import('./organizations');
    const local = createOrganization({
      name: businessName,
      contactName,
      contactEmail,
      contactPhone,
      address: address || undefined,
      plan: plan as 'starter' | 'pro' | 'enterprise',
      notes,
      saasPackageId,
    });
    await linkCustomerToOrg(
      customer,
      local.id,
      contactEmail,
      contactPhone,
      input.sellingOrgId,
    );
    return {
      ok: true,
      organizationId: local.id,
      organizationName: local.name,
      contactEmail,
      temporaryPassword: adminPassword,
      plan: local.plan,
      created: true,
      localOnly: true,
      organization: local as unknown as Record<string, unknown>,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'provision_failed',
    };
  }
}

/** Fire-and-forget for sale-close hooks � never throws. */
export function ensurePlatformClientFromCrmCustomerAsync(
  input: EnsurePlatformClientInput,
): void {
  void ensurePlatformClientFromCrmCustomer(input).then((result) => {
    if (!result.ok) {
      console.warn('[provision-from-crm] failed:', result.error);
      return;
    }
    if (result.skipped) return;
    if (result.created) {
      console.info(
        `[provision-from-crm] created org ${result.organizationId} for ${result.contactEmail}`,
      );
    }
  }).catch((err) => {
    console.warn(
      '[provision-from-crm] unexpected error:',
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Backfill: home-org won CRM customers without saasOrgId ? provision.
 */
export async function syncWonCrmCustomersToPlatformClients(): Promise<{
  created: number;
  skipped: number;
  errors: Array<{ customerId: string; error: string }>;
}> {
  const home = getHomeOrgId();
  const customers: Array<Record<string, unknown>> = [];

  await withOrgContextAsync(home, async () => {
    const store = getDataStore(home);
    for (const c of store.customers as Array<Record<string, unknown>>) {
      customers.push(c);
    }
  });

  try {
    const { getSupabaseAdmin } = await import('./supabase-admin');
    const { canProvisionViaSupabase } = await import('./provision-org');
    if (canProvisionViaSupabase()) {
      const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from('customers')
        .select('id, data')
        .eq('org_id', home)
        .limit(2000);
      if (data?.length) {
        const byId = new Map(customers.map((c) => [String(c.id), c]));
        for (const row of data) {
          const payload = (row.data && typeof row.data === 'object')
            ? (row.data as Record<string, unknown>)
            : {};
          const merged = { ...payload, id: String(row.id) };
          byId.set(String(row.id), merged);
        }
        customers.length = 0;
        customers.push(...byId.values());
      }
    }
  } catch {
    // disk-only fallback
  }

  let created = 0;
  let skipped = 0;
  const errors: Array<{ customerId: string; error: string }> = [];

  for (const customer of customers) {
    const status = String(customer.status ?? '').toLowerCase();
    if (status !== 'won') {
      skipped += 1;
      continue;
    }
    const linked = firstString(customer.saasOrgId, customer.organizationId);
    if (linked && isOrgUuid(linked)) {
      skipped += 1;
      continue;
    }
    const email = firstString(customer.email, customer.contactEmail);
    if (!email || !email.includes('@')) {
      skipped += 1;
      continue;
    }

    const result = await ensurePlatformClientFromCrmCustomer({
      customer,
      sellingOrgId: home,
      force: true,
      notes: `Backfill from CRM won sale (customer ${customer.id}).`,
    });
    if (!result.ok) {
      errors.push({ customerId: String(customer.id), error: result.error });
      continue;
    }
    if (result.skipped) {
      skipped += 1;
      continue;
    }
    if (result.created) created += 1;
    else skipped += 1;
  }

  return { created, skipped, errors };
}
