#!/usr/bin/env node
/**
 * Ensure a Vapi BYO phone number exists for each AI DID so inbound Soho66 calls
 * reach the Sync2Dine webhook (which picks Judie/Sally per DID). Idempotent.
 *
 * Every AI DID must have a BYO number on the shared Sync2Dine SIP credential with
 * server.url -> <webhook>/webhooks/vapi. A missing BYO is why an inbound call
 * "tests fine" but drops to voicemail — Vapi has no identity for that number.
 *
 * Usage (on the VPS, env from the API .env):
 *   node scripts/vapi-ensure-byo.mjs +442071128727 [+44...]
 *
 * Env:
 *   VAPI_PRIVATE_KEY        (required)
 *   VAPI_SIP_CREDENTIAL_ID  (required — the BYO SIP trunk credential id)
 *   WEBHOOK_BASE_URL        (default https://app.sync2dine.io)
 */
const KEY = process.env.VAPI_PRIVATE_KEY || process.env.VAPI_API_KEY;
const CRED = process.env.VAPI_SIP_CREDENTIAL_ID || process.env.VAPI_SIP_CREDENTIAL;
const WEBHOOK = (process.env.WEBHOOK_BASE_URL || process.env.APP_BASE_URL || 'https://app.sync2dine.io').replace(/\/$/, '');
const SERVER_URL = `${WEBHOOK}/webhooks/vapi`;
const API = process.env.VAPI_API_BASE || 'https://api.vapi.ai';

const numbers = process.argv.slice(2).map((n) => n.trim()).filter(Boolean);

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!KEY) fail('VAPI_PRIVATE_KEY missing');
if (!CRED) fail('VAPI_SIP_CREDENTIAL_ID missing');
if (numbers.length === 0) fail('Pass at least one E.164 number, e.g. +442071128727');

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function listNumbers() {
  const res = await fetch(`${API}/phone-number`, { headers });
  if (!res.ok) fail(`GET /phone-number ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function createByo(number) {
  const body = {
    provider: 'byo-phone-number',
    number,
    credentialId: CRED,
    numberE164CheckEnabled: false,
    server: { url: SERVER_URL },
  };
  const res = await fetch(`${API}/phone-number`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text };
  return { ok: true, data: JSON.parse(text) };
}

async function patchServer(id) {
  const res = await fetch(`${API}/phone-number/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ server: { url: SERVER_URL } }),
  });
  return res.ok;
}

async function main() {
  console.log(`Credential: ${CRED}`);
  console.log(`Webhook:    ${SERVER_URL}`);
  const existing = await listNumbers();
  for (const number of numbers) {
    const match = existing.find((n) => (n.number || '') === number);
    if (match) {
      const server = (match.server && match.server.url) || match.serverUrl || '';
      if (server !== SERVER_URL) {
        const ok = await patchServer(match.id);
        console.log(`~ ${number}: exists (id=${match.id}) — server ${ok ? 'updated' : 'update FAILED'} -> ${SERVER_URL}`);
      } else {
        console.log(`= ${number}: already provisioned (id=${match.id}, cred=${match.credentialId || '?'})`);
      }
      continue;
    }
    const result = await createByo(number);
    if (result.ok) {
      console.log(`+ ${number}: created BYO (id=${result.data.id}) on cred ${CRED}`);
    } else {
      console.log(`x ${number}: create FAILED (${result.status}) ${result.text}`);
    }
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
