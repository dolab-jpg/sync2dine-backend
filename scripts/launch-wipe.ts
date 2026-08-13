/**
 * Launch inventory + optional wipe.
 *
 * Dry-run (default):
 *   npx tsx --env-file=.env scripts/launch-wipe.ts
 *
 * Apply:
 *   APPLY=1 npx tsx --env-file=.env scripts/launch-wipe.ts
 *
 * Also empties CRM keys in local/VPS `server/data/synced-data*.json` when that
 * directory exists (Supabase wipe alone used to resurrect leads from disk).
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const HOME_ORG_ID = '4fc49703-d1b0-4ac7-892d-9c32d31e9661';
const DEMO_KITCHEN_ORG_ID = 'c2887ddb-0cba-4df1-9086-e7399c92d159';
const KEEP_ORG_IDS = new Set([HOME_ORG_ID, DEMO_KITCHEN_ORG_ID]);
const KEEP_OWNER_EMAIL = 'owner@sync2dine.io';
const APPLY = process.env.APPLY === '1';

const SMOKE_TABLES = [
  'orders',
  'calls',
  'conversation_logs',
  'code_fix_jobs',
  'customers',
  'contacts',
  'quotes',
  'builders',
] as const;

/** Disk CRM keys that rematerialize into Supabase via preferNonEmpty / sync. */
const DISK_CRM_KEYS = ['customers', 'contacts', 'quotes', 'calls', 'orders', 'builders'] as const;

function resolveDataDir(): string | null {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data');
  if (existsSync(local)) return local;
  return null;
}

function planDiskCrmWipe(dataDir: string): { empty: string[]; remove: string[]; extra: string[] } {
  const empty: string[] = [];
  const remove: string[] = [];
  const extra: string[] = [];
  for (const name of readdirSync(dataDir)) {
    if (/^lead-inbox\.json$/i.test(name)) extra.push(name);
    if (!/^synced-data.*\.json$/i.test(name)) continue;
    const orgMatch = /^synced-data-(.+)\.json$/i.exec(name);
    const orgId = orgMatch?.[1];
    if (orgId && !KEEP_ORG_IDS.has(orgId)) remove.push(name);
    else empty.push(name);
  }
  return { empty, remove, extra };
}

function wipeDiskCrm(dataDir: string, plan: ReturnType<typeof planDiskCrmWipe>): void {
  for (const name of plan.remove) {
    unlinkSync(join(dataDir, name));
    console.log(`  deleted disk ${name}`);
  }
  for (const name of plan.empty) {
    const path = join(dataDir, name);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      console.warn(`  skip unreadable ${name}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const key of DISK_CRM_KEYS) data[key] = [];
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`  emptied CRM keys in ${name}`);
  }
  for (const name of plan.extra) {
    if (/^lead-inbox\.json$/i.test(name)) {
      writeFileSync(join(dataDir, name), '[]\n');
      console.log(`  emptied ${name}`);
    }
  }
}

function admin() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function countEq(
  supabase: ReturnType<typeof admin>,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq(column, value);
  if (error) return -1;
  return count ?? 0;
}

async function main() {
  const supabase = admin();
  console.log(APPLY ? '=== APPLY (destructive) ===' : '=== DRY RUN ===');
  console.log(`Keep orgs: home=${HOME_ORG_ID} kitchen=${DEMO_KITCHEN_ORG_ID}`);
  console.log(`Keep user: ${KEEP_OWNER_EMAIL}\n`);

  const { data: orgs, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name, status, plan, phone_did, contact_email, openai_api_key_encrypted')
    .order('created_at', { ascending: false });
  if (orgErr) throw orgErr;

  console.log('--- organizations ---');
  for (const org of orgs ?? []) {
    const keep = KEEP_ORG_IDS.has(org.id);
    const products = await countEq(supabase, 'products', 'org_id', org.id);
    const phoneLines = await countEq(supabase, 'phone_lines', 'org_id', org.id);
    const orders = await countEq(supabase, 'orders', 'org_id', org.id);
    const customers = await countEq(supabase, 'customers', 'org_id', org.id);
    const logs = await countEq(supabase, 'conversation_logs', 'org_id', org.id);
    const jobs = await countEq(supabase, 'code_fix_jobs', 'org_id', org.id);
    const hasKey = Boolean(org.openai_api_key_encrypted);
    console.log(
      `${keep ? 'KEEP' : 'WIPE'} ${org.id}  ${org.name}  status=${org.status} plan=${org.plan} did=${org.phone_did || '-'} key=${hasKey ? 'yes' : 'no'} products=${products} lines=${phoneLines} orders=${orders} customers=${customers} logs=${logs} jobs=${jobs}`,
    );
  }

  const kitchen = (orgs ?? []).find((o) => o.id === DEMO_KITCHEN_ORG_ID);
  if (!kitchen) {
    console.error('\nSTOP: Demo Kitchen org is missing. Refusing wipe.');
    process.exit(1);
  }
  const kitchenProducts = await countEq(supabase, 'products', 'org_id', DEMO_KITCHEN_ORG_ID);
  const kitchenLines = await countEq(supabase, 'phone_lines', 'org_id', DEMO_KITCHEN_ORG_ID);
  if (kitchenProducts < 20) {
    console.error(`\nSTOP: Demo Kitchen has only ${kitchenProducts} products. Expected the Dishoom menu.`);
    process.exit(1);
  }
  if (!kitchen.phone_did && kitchenLines < 1) {
    console.error('\nSTOP: Demo Kitchen has no phone_did and no phone_lines. Inbound Judie would break.');
    process.exit(1);
  }
  console.log(`\nDemo Kitchen OK: products=${kitchenProducts} phone_did=${kitchen.phone_did || '-'} lines=${kitchenLines}`);

  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, email, username, role, org_id, name')
    .order('email');
  if (profErr) throw profErr;

  console.log('\n--- profiles ---');
  const wipeProfiles: typeof profiles = [];
  for (const p of profiles ?? []) {
    const email = String(p.email ?? '').toLowerCase();
    const keep = email === KEEP_OWNER_EMAIL;
    if (!keep) wipeProfiles.push(p);
    console.log(
      `${keep ? 'KEEP' : 'WIPE'} ${email.padEnd(36)} role=${String(p.role).padEnd(16)} org=${p.org_id ?? '-'} user=${p.username ?? '-'} ${p.name ?? ''}`,
    );
  }

  const { data: authPage } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const wipeAuth = (authPage?.users ?? []).filter((u) => (u.email ?? '').toLowerCase() !== KEEP_OWNER_EMAIL);
  console.log(`\n--- auth.users extra=${wipeAuth.length} (keep ${KEEP_OWNER_EMAIL}) ---`);
  for (const u of wipeAuth) {
    console.log(`WIPE auth ${u.email}`);
  }

  const dataDir = resolveDataDir();
  const diskPlan = dataDir ? planDiskCrmWipe(dataDir) : null;
  console.log('\n--- VPS/local disk CRM ---');
  if (!dataDir) {
    console.log('  no DATA_DIR / server/data  disk wipe skipped (run this on the API host to clear synced-data-*.json)');
  } else {
    console.log(`  dataDir=${dataDir}`);
    for (const name of diskPlan?.empty ?? []) console.log(`  EMPTY CRM keys ${name}`);
    for (const name of diskPlan?.remove ?? []) console.log(`  DELETE extra org file ${name}`);
    for (const name of diskPlan?.extra ?? []) console.log(`  EMPTY ${name}`);
    if (!diskPlan?.empty.length && !diskPlan?.remove.length && !diskPlan?.extra.length) {
      console.log('  no synced-data*.json or lead-inbox.json found');
    }
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with APPLY=1 to delete.');
    return;
  }

  console.log('\nApplying wipe');

  for (const orgId of KEEP_ORG_IDS) {
    for (const table of SMOKE_TABLES) {
      const { error, count } = await supabase.from(table).delete({ count: 'exact' }).eq('org_id', orgId);
      if (error) console.warn(`  ${table} ${orgId}: ${error.message}`);
      else console.log(`  cleared ${table} for ${orgId} (${count ?? '?'})`);
    }
  }

  const { error: jobsAllErr, count: jobsAll } = await supabase
    .from('code_fix_jobs')
    .delete({ count: 'exact' })
    .neq('id', '__never__');
  if (jobsAllErr) console.warn(`  code_fix_jobs all: ${jobsAllErr.message}`);
  else console.log(`  cleared remaining code_fix_jobs (${jobsAll ?? '?'})`);

  const extraOrgs = (orgs ?? []).filter((o) => !KEEP_ORG_IDS.has(o.id));
  for (const org of extraOrgs) {
    const { error } = await supabase.from('organizations').delete().eq('id', org.id);
    if (error) console.warn(`  delete org ${org.name}: ${error.message}`);
    else console.log(`  deleted org ${org.name} ${org.id}`);
  }

  for (const user of wipeAuth) {
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) console.warn(`  delete auth ${user.email}: ${error.message}`);
    else console.log(`  deleted auth ${user.email}`);
  }

  for (const p of wipeProfiles ?? []) {
    const { error } = await supabase.from('profiles').delete().eq('id', p.id);
    if (error && !String(error.message).includes('0 rows')) {
      console.warn(`  delete profile ${p.email}: ${error.message}`);
    }
  }

  if (dataDir && diskPlan) {
    console.log('\nWiping disk CRM…');
    wipeDiskCrm(dataDir, diskPlan);
  }

  console.log('\nApply complete. Keep phone_lines, products, dining_tables, integrations, sally knowledge.');
  console.log('Browser notifications are localStorage (tradepro_notifications) — SPA one-shot s2d.notificationsLaunchCleared.v1 clears them on next load.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
