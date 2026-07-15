import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOrgOpenAIApiKey, listOrganizations } from '../server/organizations.ts';
import { probeOpenAIConnection } from '../server/openai-connection.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.resolve(root, '..', 'Bathroom Sales Estimation Platform');

function upsertEnv(filePath, updates) {
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const lines = content.length ? content.split(/\r?\n/) : [];
  const pending = { ...updates };
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m && Object.prototype.hasOwnProperty.call(pending, m[1])) {
      out.push(`${m[1]}=${pending[m[1]]}`);
      delete pending[m[1]];
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`);
  while (out.length && out[out.length - 1] === '') out.pop();
  out.push('');
  writeFileSync(filePath, out.join('\n'), 'utf8');
  console.log('updated', filePath);
}

const orgs = listOrganizations();
console.log('orgs', orgs.map((o) => ({ id: o.id, encLen: (o.openaiApiKeyEncrypted || '').length })));

let apiKey = '';
for (const o of orgs) {
  const k = getOrgOpenAIApiKey(o.id);
  console.log({ id: o.id, decrypted: Boolean(k), len: k?.length || 0, prefix: (k || '').slice(0, 7) });
  if (k && k.startsWith('sk-')) apiKey = k;
}

if (!apiKey) {
  console.error('No decryptable sk- OpenAI key found in organizations.json');
  process.exit(1);
}

console.log('Probing OpenAI…');
await probeOpenAIConnection(apiKey);
console.log('OpenAI probe OK');

upsertEnv(path.join(root, '.env'), { OPENAI_API_KEY: apiKey });
upsertEnv(path.join(frontendRoot, '.env.local'), { OPENAI_API_KEY: apiKey });
upsertEnv(path.join(frontendRoot, '.cursor', 'local', 'deploy.env'), { OPENAI_API_KEY: apiKey });

console.log('Done — restart API server to pick up OPENAI_API_KEY');
