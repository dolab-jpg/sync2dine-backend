/**
 * Idempotent seed of real Supabase Auth users + org.
 * Preserves existing openai_api_key_encrypted and integrations — never deletes keys.
 *
 * Usage (from sync2dine-backend):
 *   npx tsx --env-file=.env scripts/seed-real-accounts.ts
 * Optional: SEED_PASSWORD=yourpassword (default: Sync2DineDemo1!)
 */
import { createClient } from '@supabase/supabase-js';

const SEED_PASSWORD = process.env.SEED_PASSWORD?.trim() || 'Sync2DineDemo1!';
const ORG_NAME = 'Sync2Dine Demo Kitchen';

type Role =
  | 'platform_owner'
  | 'super_admin'
  | 'manager'
  | 'staff'
  | 'builder'
  | 'recruitment'
  | 'customer';

const USERS: Array<{
  username: string;
  email: string;
  name: string;
  role: Role;
  attachOrg: boolean;
}> = [
  { username: 'owner', email: 'owner@sync2dine.io', name: 'Platform Owner', role: 'platform_owner', attachOrg: false },
  { username: 'maya.nguyen', email: 'maya@demo.sync2dine.io', name: 'Maya Nguyen', role: 'super_admin', attachOrg: true },
  { username: 'leo.martinez', email: 'leo@demo.sync2dine.io', name: 'Leo Martinez', role: 'manager', attachOrg: true },
  { username: 'priya.patel', email: 'priya@demo.sync2dine.io', name: 'Priya Patel', role: 'staff', attachOrg: true },
  { username: 'kai.brooks', email: 'kai@demo.sync2dine.io', name: 'Kai Brooks', role: 'builder', attachOrg: true },
  { username: 'nina.ross', email: 'nina@demo.sync2dine.io', name: 'Nina Ross', role: 'recruitment', attachOrg: true },
  { username: 'guest.chen', email: 'guest@demo.sync2dine.io', name: 'Guest Chen', role: 'customer', attachOrg: true },
];

function admin() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function ensureOrg(supabase: ReturnType<typeof admin>): Promise<{ id: string; reused: boolean }> {
  const { data: existing } = await supabase
    .from('organizations')
    .select('id, name, openai_api_key_encrypted')
    .or(`name.eq.${ORG_NAME},contact_email.eq.maya@demo.sync2dine.io`)
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    console.log(`[seed] Reusing org ${existing.id} (${existing.name}) — keys preserved`);
    return { id: existing.id, reused: true };
  }

  // Prefer any org that already has an OpenAI key so we never orphan integrations
  const { data: withKey } = await supabase
    .from('organizations')
    .select('id, name, openai_api_key_encrypted')
    .neq('openai_api_key_encrypted', '')
    .limit(1)
    .maybeSingle();

  if (withKey?.id) {
    console.log(`[seed] Reusing org with existing API key ${withKey.id} (${withKey.name})`);
    return { id: withKey.id, reused: true };
  }

  const { data: org, error } = await supabase
    .from('organizations')
    .insert({
      name: ORG_NAME,
      contact_name: 'Maya Nguyen',
      contact_email: 'maya@demo.sync2dine.io',
      contact_phone: '',
      plan: 'pro',
      status: 'active',
      monthly_token_cap: 2_000_000,
      openai_api_key_encrypted: '',
      trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    })
    .select('id')
    .single();

  if (error || !org) throw new Error(error?.message ?? 'Failed to create org');
  console.log(`[seed] Created org ${org.id}`);
  return { id: org.id, reused: false };
}

async function ensureUser(
  supabase: ReturnType<typeof admin>,
  user: (typeof USERS)[number],
  orgId: string | null,
): Promise<'created' | 'updated' | 'skipped'> {
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id, org_id, username, role')
    .eq('email', user.email)
    .maybeSingle();

  if (existingProfile?.id) {
    const { error } = await supabase
      .from('profiles')
      .update({
        name: user.name,
        username: user.username,
        role: user.role,
        org_id: user.attachOrg ? orgId : existingProfile.org_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingProfile.id);
    if (error) throw new Error(`Update profile ${user.email}: ${error.message}`);
    // Reset password so seed credentials always work
    await supabase.auth.admin.updateUserById(existingProfile.id, {
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: {
        name: user.name,
        username: user.username,
        role: user.role,
        org_id: user.attachOrg ? orgId ?? '' : '',
      },
    });
    console.log(`[seed] Updated ${user.email} (${user.role})`);
    return 'updated';
  }

  const { data: list } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const authUser = list?.users?.find((u) => u.email?.toLowerCase() === user.email);
  if (authUser) {
    await supabase.auth.admin.updateUserById(authUser.id, {
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: {
        name: user.name,
        username: user.username,
        role: user.role,
        org_id: user.attachOrg ? orgId ?? '' : '',
      },
    });
    await supabase.from('profiles').upsert({
      id: authUser.id,
      email: user.email,
      name: user.name,
      username: user.username,
      role: user.role,
      org_id: user.attachOrg ? orgId : null,
      updated_at: new Date().toISOString(),
    });
    console.log(`[seed] Linked auth user ${user.email}`);
    return 'updated';
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: user.email,
    password: SEED_PASSWORD,
    email_confirm: true,
    user_metadata: {
      name: user.name,
      username: user.username,
      role: user.role,
      org_id: user.attachOrg ? orgId ?? '' : '',
    },
  });
  if (error || !data.user) throw new Error(`Create ${user.email}: ${error?.message}`);
  await supabase.from('profiles').upsert({
    id: data.user.id,
    email: user.email,
    name: user.name,
    username: user.username,
    role: user.role,
    org_id: user.attachOrg ? orgId : null,
    updated_at: new Date().toISOString(),
  });
  console.log(`[seed] Created ${user.email} (${user.role})`);
  return 'created';
}

async function main() {
  const supabase = admin();
  const { id: orgId } = await ensureOrg(supabase);

  for (const user of USERS) {
    await ensureUser(supabase, user, user.attachOrg ? orgId : null);
  }

  console.log('\n=== Seed credentials (dev) ===');
  console.log(`Password for all users: ${SEED_PASSWORD}`);
  for (const u of USERS) {
    console.log(`  ${u.role.padEnd(16)} username=${u.username.padEnd(18)} email=${u.email}`);
  }
  console.log(`Org id: ${orgId}`);
  console.log('API keys / integrations on the org were not deleted.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
