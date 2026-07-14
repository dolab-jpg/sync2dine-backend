import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

async function main() {
  const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data: org } = await s.from('organizations').select('id').eq('name', 'Bathroom Pro Demo').single();
  const { data: john } = await s.from('profiles').select('id').eq('email', 'john@bathroompro.com').single();
  if (!org || !john) throw new Error('missing org or john');
  const token = randomBytes(12).toString('hex');
  const { data: inv, error } = await s
    .from('org_invites')
    .insert({
      token,
      org_id: org.id,
      email: 'newhire@bathroompro.com',
      role: 'staff',
      invited_by: john.id,
    })
    .select()
    .single();
  if (error) throw error;
  console.log('INVITE_TOKEN', inv.token);
  console.log('ACCEPT_URL', `${process.env.APP_BASE_URL || 'http://localhost:5174'}/invite/${inv.token}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
