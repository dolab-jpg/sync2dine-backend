import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();
    if (v && !process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../Bathroom Sales Estimation Platform/.env.local'));

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anon || !service) {
  console.error('Missing SUPABASE_URL / ANON / SERVICE_ROLE');
  process.exit(1);
}

const password = process.env.SEED_PASSWORD || 'TradeProSeed1!';

async function main() {
  const client = createClient(url!, anon!, { auth: { persistSession: false } });
  const admin = createClient(url!, service!, { auth: { persistSession: false } });

  for (const ident of [
    { label: 'email', email: 'john@bathroompro.com' },
    { label: 'manager', email: 'sarah@bathroompro.com' },
  ]) {
    const { data, error } = await client.auth.signInWithPassword({
      email: ident.email,
      password,
    });
    if (error || !data.user) {
      console.error('FAIL', ident.label, error?.message);
      process.exit(1);
    }
    const { data: profile } = await admin
      .from('profiles')
      .select('username, role, org_id, email')
      .eq('id', data.user.id)
      .single();
    console.log('OK', ident.label, profile);
    await client.auth.signOut();
  }

  const { data: resolved } = await admin
    .from('profiles')
    .select('email')
    .eq('username', 'mike.davis')
    .maybeSingle();
  console.log('RESOLVE username mike.davis ->', resolved?.email);
  console.log('SMOKE_PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
