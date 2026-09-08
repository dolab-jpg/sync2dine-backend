/** Create the private candidate-cvs storage bucket if it is missing (run once per environment). */
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const client = createClient(url, key, { auth: { persistSession: false } });

  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw new Error(`listBuckets failed: ${listError.message}`);
  if ((buckets || []).some((b) => b.id === 'candidate-cvs')) {
    console.log('candidate-cvs bucket already exists');
    return;
  }
  const { error } = await client.storage.createBucket('candidate-cvs', {
    public: false,
    fileSizeLimit: 26214400,
  });
  if (error) throw new Error(`createBucket failed: ${error.message}`);
  console.log('created candidate-cvs bucket (private, 25MB limit)');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
