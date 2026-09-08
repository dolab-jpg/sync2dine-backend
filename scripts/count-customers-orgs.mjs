import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { count: custCount, error: cErr } = await s.from('customers').select('*', { count: 'exact', head: true });
if (cErr) throw cErr;
const { data: orgs, error: oErr } = await s.from('customers').select('org_id').limit(5000);
if (oErr) throw oErr;
const by = {};
for (const r of orgs || []) by[r.org_id] = (by[r.org_id] || 0) + 1;
const { count: qCount, error: qErr } = await s.from('outbound_queue').select('*', { count: 'exact', head: true });
if (qErr) throw qErr;
const { data: statuses } = await s.from('outbound_queue').select('data').limit(2000);
const jobStatus = {};
for (const row of statuses || []) {
  const st = String((row.data && row.data.status) || 'unknown');
  jobStatus[st] = (jobStatus[st] || 0) + 1;
}
console.log(JSON.stringify({ custCount, byOrg: by, outboundQueueCount: qCount, jobStatus }, null, 2));
