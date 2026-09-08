#!/usr/bin/env node
/**
 * Non-invasive live smoke matrix for Sync2Dine.
 * Does not add auth headers, forge webhooks, or mutate access control.
 *
 * Usage: node scripts/smoke-live-matrix.mjs [baseUrl]
 * Default: https://app.sync2dine.io
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = (process.argv[2] || 'https://app.sync2dine.io').replace(/\/$/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}: ${detail}`);
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`, { method: 'GET' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, text, json };
}

async function postRaw(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// 1. Health
{
  const { status, json, text } = await getJson('/health');
  const ok = status === 200 && json && json.status === 'ok';
  record('health', ok, `HTTP ${status} ${text.slice(0, 120)}`);
}

// 2. Ops alerts (deploy script expects 200)
{
  const { status, text } = await getJson('/api/ops/alerts');
  const ok = status === 200;
  record('ops_alerts', ok, `HTTP ${status} ${text.slice(0, 120)}`);
}

// 3. Vapi health (public readiness probe)
{
  const { status, text } = await getJson('/api/vapi/health');
  const ok = status === 200 || status === 503;
  record(
    'vapi_health',
    ok,
    `HTTP ${status} (200=ready, 503=config gap � still mounted) ${text.slice(0, 160)}`,
  );
}

// 4. Vapi webhook rejects unsigned POST (do not forge valid signatures)
{
  const { status, text } = await postRaw('/api/vapi/webhook', { message: { type: 'status-update' } });
  const ok = status === 401;
  record('vapi_webhook_unsigned', ok, `HTTP ${status} expected 401 ${text.slice(0, 160)}`);
}

// 5. Stripe webhook rejects missing signature (no charge)
{
  const { status, text } = await postRaw('/api/stripe/webhook', { type: 'ping' });
  const ok = status === 400;
  record('stripe_webhook_unsigned', ok, `HTTP ${status} expected 400 ${text.slice(0, 160)}`);
}

// 6. Orders unauthenticated ? 401/403 (current intentional behaviour)
{
  const child = spawnSync(
    process.execPath,
    [join(root, 'scripts/smoke-orders-live.mjs'), base],
    { encoding: 'utf8' },
  );
  const ok = child.status === 0;
  record(
    'orders_unauth',
    ok,
    (child.stdout || child.stderr || '').trim().slice(0, 200) || `exit ${child.status}`,
  );
}

// 7. Sally Web pricing (must stay useful for live marketing tests)
{
  const child = spawnSync(
    process.execPath,
    [join(root, 'scripts/probe-sally-web.mjs'), base],
    { encoding: 'utf8' },
  );
  const out = `${child.stdout || ''}${child.stderr || ''}`;
  const pricing = /Judie|Atmosphere|�\d+|GBP|\d+\s*\/\s*wk/i.test(out);
  const ok = child.status === 0 && /STATUS 200/.test(out) && pricing;
  record(
    'sally_web',
    ok,
    ok ? 'HTTP 200 with Sync2Dine pricing facts' : out.slice(0, 400),
  );
}

// 8. Connector HMAC path without signature ? 401 (provider segment is literal; do not forge HMAC)
{
  const { status, text } = await postRaw('/api/connectors/square/orders', { ping: true });
  const ok = status === 401;
  record(
    'connectors_hmac_unsigned',
    ok,
    `HTTP ${status} expected 401 invalid_signature ${text.slice(0, 120)}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log('\n--- summary ---');
console.log(`base=${base}`);
console.log(`pass=${results.length - failed.length} fail=${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('smoke-live-matrix OK');
process.exit(0);
