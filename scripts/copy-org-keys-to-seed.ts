/**
 * Copy openai_api_key_encrypted + integrations FROM an existing org that has them
 * TO the seed org — never deletes source keys.
 */
import { createClient } from '@supabase/supabase-js';

const SEED_ORG = 'Bathroom Pro Demo';

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase env');
  const s = createClient(url, key, { auth: { persistSession: false } });

  const { data: seed } = await s
    .from('organizations')
    .select('id, name, openai_api_key_encrypted')
    .eq('name', SEED_ORG)
    .maybeSingle();
  if (!seed) {
    console.log('No seed org found');
    return;
  }

  const { data: orgs } = await s
    .from('organizations')
    .select('id, name, openai_api_key_encrypted')
    .neq('id', seed.id);

  const source = (orgs ?? []).find(
    (o) => o.openai_api_key_encrypted && String(o.openai_api_key_encrypted).length > 0,
  );

  if (!source) {
    console.log('No source org with OpenAI key found — leaving seed org as-is (env OPENAI_API_KEY still works)');
    return;
  }

  if (!seed.openai_api_key_encrypted) {
    await s
      .from('organizations')
      .update({ openai_api_key_encrypted: source.openai_api_key_encrypted })
      .eq('id', seed.id);
    console.log(`Copied openai key from ${source.name} → ${seed.name} (source untouched)`);
  } else {
    console.log('Seed org already has openai key — skipped');
  }

  const { data: integrations } = await s
    .from('integrations')
    .select('*')
    .eq('org_id', source.id);

  for (const row of integrations ?? []) {
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = row as Record<string, unknown>;
    await s.from('integrations').upsert(
      {
        ...rest,
        org_id: seed.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,integration_id' },
    );
  }
  console.log(`Copied ${(integrations ?? []).length} integration row(s) to seed org (source untouched)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
