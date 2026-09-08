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
const org = '4fc49703-d1b0-4ac7-892d-9c32d31e9661';
const { data, error } = await s.from('customers').select('id, data').eq('org_id', org).limit(5000);
if (error) throw error;
const counts = {};
const withDisposition = [];
for (const row of data || []) {
  const d = row.data || {};
  const st = String(d.callQueueStatus || 'not_called').toLowerCase();
  counts[st] = (counts[st] || 0) + 1;
  if (d.lastCallDisposition || d.callDisposition || (Array.isArray(d.callActivity) && d.callActivity.length)) {
    withDisposition.push({
      name: d.name,
      phone: d.phone,
      callQueueStatus: st,
      lastCallDisposition: d.lastCallDisposition || d.callDisposition || null,
      activityLen: Array.isArray(d.callActivity) ? d.callActivity.length : 0,
      lastActivity: Array.isArray(d.callActivity) && d.callActivity.length ? d.callActivity[d.callActivity.length - 1] : null,
    });
  }
}
withDisposition.sort((a, b) => b.activityLen - a.activityLen);
console.log(JSON.stringify({
  customerRows: (data || []).length,
  callQueueStatusCounts: counts,
  withDispositionCount: withDisposition.length,
  sample: withDisposition.slice(0, 12),
}, null, 2));
