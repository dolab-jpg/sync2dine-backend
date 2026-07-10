/**
 * Import legacy JSON data from the frontend repo into Supabase.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-supabase.ts
 *   npx tsx scripts/migrate-to-supabase.ts --source "../Bathroom Sales Estimation Platform/server/data"
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSupabaseAdmin, DEFAULT_ORG_UUID } from '../server/supabase-admin.js';
import { syncDataToSupabase } from '../server/supabase-data.js';
import type { SyncedData } from '../server/data-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(): { source: string } {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  const source = sourceIdx >= 0
    ? args[sourceIdx + 1]
    : process.env.LEGACY_DATA_PATH ?? join(ROOT, '..', 'Bathroom Sales Estimation Platform', 'server', 'data');
  return { source };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function createAuthUser(email: string, password: string, meta: Record<string, string>) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: meta,
  });
  if (error && !error.message.includes('already')) {
    console.warn(`Auth user ${email}: ${error.message}`);
    return null;
  }
  return data.user;
}

async function main() {
  const { source } = parseArgs();
  console.log(`Importing from: ${source}`);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const supabase = getSupabaseAdmin();

  // Ensure demo org exists
  await supabase.from('organizations').upsert({
    id: DEFAULT_ORG_UUID,
    legacy_id: 'default',
    name: 'TradePro Demo',
    contact_name: 'Demo Admin',
    contact_email: 'admin@tradepro.com',
    status: 'active',
    plan: 'pro',
    monthly_token_cap: 2_000_000,
  }, { onConflict: 'id' });

  // Import organizations
  const orgs = readJson<Array<Record<string, unknown>>>(join(source, 'organizations.json'));
  if (orgs?.length) {
    for (const org of orgs) {
      await supabase.from('organizations').upsert({
        legacy_id: String(org.id),
        name: String(org.name ?? 'Unknown'),
        contact_name: String(org.contactName ?? ''),
        contact_email: String(org.contactEmail ?? ''),
        contact_phone: String(org.contactPhone ?? ''),
        status: String(org.status ?? 'trial'),
        plan: String(org.plan ?? 'starter'),
        openai_api_key_encrypted: String(org.openaiApiKeyEncrypted ?? ''),
        monthly_token_cap: Number(org.monthlyTokenCap ?? 500000),
        stripe_customer_id: org.stripeCustomerId ? String(org.stripeCustomerId) : null,
        stripe_subscription_id: org.stripeSubscriptionId ? String(org.stripeSubscriptionId) : null,
      }, { onConflict: 'legacy_id' });
    }
    console.log(`Imported ${orgs.length} organizations`);
  }

  // Import users → Supabase Auth + profiles
  const users = readJson<Array<Record<string, unknown>>>(join(source, 'users.json'));
  if (users?.length) {
    for (const user of users) {
      const email = String(user.email);
      const password = process.env.PLATFORM_OWNER_PASSWORD ?? 'platform123';
      const authUser = await createAuthUser(email, password, {
        name: String(user.name ?? ''),
        role: String(user.role ?? 'staff'),
      });
      if (authUser) {
        await supabase.from('profiles').upsert({
          id: authUser.id,
          legacy_id: String(user.id),
          email,
          name: String(user.name ?? ''),
          role: String(user.role ?? 'staff'),
          org_id: user.orgId ? DEFAULT_ORG_UUID : null,
        });
      }
    }
    console.log(`Imported ${users.length} users`);
  } else {
    // Seed platform owner
    const ownerEmail = process.env.PLATFORM_OWNER_EMAIL ?? 'owner@tradepro.com';
    const ownerPassword = process.env.PLATFORM_OWNER_PASSWORD ?? 'platform123';
    const authUser = await createAuthUser(ownerEmail, ownerPassword, {
      name: 'Platform Owner',
      role: 'platform_owner',
    });
    if (authUser) {
      await supabase.from('profiles').upsert({
        id: authUser.id,
        legacy_id: 'user_platform_owner',
        email: ownerEmail,
        name: 'Platform Owner',
        role: 'platform_owner',
        org_id: null,
      });
      console.log(`Created platform owner: ${ownerEmail}`);
    }
  }

  // Import synced data blobs
  const syncedFiles = ['synced-data.json', ...readdirSync(source).filter(f => f.startsWith('synced-data-') && f.endsWith('.json'))];
  for (const file of syncedFiles) {
    const data = readJson<Partial<SyncedData>>(join(source, file));
    if (!data) continue;
    const orgLegacyId = file === 'synced-data.json' ? 'default' : file.replace('synced-data-', '').replace('.json', '');
    let orgUuid = DEFAULT_ORG_UUID;
    if (orgLegacyId !== 'default') {
      const { data: org } = await supabase.from('organizations').select('id').eq('legacy_id', orgLegacyId).maybeSingle();
      orgUuid = org?.id ?? DEFAULT_ORG_UUID;
    }
    await syncDataToSupabase(data as SyncedData, orgUuid);
    console.log(`Imported synced data from ${file} → org ${orgUuid}`);
  }

  console.log('Migration complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
