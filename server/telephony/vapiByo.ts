/**
 * Vapi BYO (bring-your-own) phone-number helpers.
 *
 * Every AI DID (Sally + each customer Judie) must have a Vapi BYO number on the
 * shared Sync2Dine SIP credential whose server.url points at the Sync2Dine
 * webhook. A missing BYO is exactly why an inbound call could "test fine" yet
 * drop to voicemail: Vapi had no identity for that number, so it never invoked
 * the assistant. Go live and Test both call in here so that class of failure is
 * caught up front instead of on a live customer call.
 *
 * This is a runtime TS port of scripts/vapi-ensure-byo.mjs (kept for CLI use).
 */

const API_BASE = process.env.VAPI_API_BASE || 'https://api.vapi.ai';

function key(): string | null {
  return process.env.VAPI_PRIVATE_KEY || process.env.VAPI_API_KEY || null;
}

function credentialId(): string | null {
  return process.env.VAPI_SIP_CREDENTIAL_ID || process.env.VAPI_SIP_CREDENTIAL || null;
}

function webhookUrl(): string {
  const base = (process.env.WEBHOOK_BASE_URL || process.env.APP_BASE_URL || 'https://app.sync2dine.io').replace(/\/$/, '');
  return `${base}/webhooks/vapi`;
}

/** Whether the API even has the credentials needed to talk to Vapi. */
export function isVapiByoConfigured(): boolean {
  return Boolean(key() && credentialId());
}

interface VapiNumber {
  id: string;
  number?: string;
  credentialId?: string;
  server?: { url?: string };
  serverUrl?: string;
}

async function vapiFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key()}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function listNumbers(): Promise<VapiNumber[]> {
  const res = await vapiFetch('/phone-number');
  if (!res.ok) throw new Error(`GET /phone-number ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as VapiNumber[]) : [];
}

function serverOf(n: VapiNumber): string {
  return (n.server && n.server.url) || n.serverUrl || '';
}

export interface ByoResult {
  did: string;
  ok: boolean;
  id?: string;
  action: 'exists' | 'patched' | 'created' | 'missing' | 'skipped' | 'error';
  message: string;
}

export interface ByoEnsureSummary {
  configured: boolean;
  ok: boolean;
  results: ByoResult[];
}

/**
 * Make sure every DID has a BYO number on the right credential + webhook.
 * Idempotent. If Vapi isn't configured, returns configured:false (callers
 * decide whether that is fatal for their context).
 */
export async function ensureVapiByoForDids(didsE164: string[]): Promise<ByoEnsureSummary> {
  const dids = Array.from(new Set(didsE164.map((d) => String(d || '').trim()).filter(Boolean)));
  if (!isVapiByoConfigured()) {
    return { configured: false, ok: false, results: dids.map((did) => ({ did, ok: false, action: 'skipped', message: 'VAPI_PRIVATE_KEY / VAPI_SIP_CREDENTIAL_ID not set' })) };
  }
  const cred = credentialId() as string;
  const url = webhookUrl();
  let existing: VapiNumber[];
  try {
    existing = await listNumbers();
  } catch (err) {
    return { configured: true, ok: false, results: dids.map((did) => ({ did, ok: false, action: 'error', message: err instanceof Error ? err.message : String(err) })) };
  }

  const results: ByoResult[] = [];
  for (const did of dids) {
    const match = existing.find((n) => (n.number || '') === did);
    try {
      if (match) {
        if (serverOf(match) !== url) {
          const res = await vapiFetch(`/phone-number/${match.id}`, { method: 'PATCH', body: JSON.stringify({ server: { url } }) });
          results.push(res.ok
            ? { did, ok: true, id: match.id, action: 'patched', message: `serverUrl updated -> ${url}` }
            : { did, ok: false, id: match.id, action: 'error', message: `PATCH ${res.status}` });
        } else {
          results.push({ did, ok: true, id: match.id, action: 'exists', message: `already on cred ${cred}` });
        }
        continue;
      }
      const res = await vapiFetch('/phone-number', {
        method: 'POST',
        body: JSON.stringify({ provider: 'byo-phone-number', number: did, credentialId: cred, numberE164CheckEnabled: false, server: { url } }),
      });
      if (res.ok) {
        const created = (await res.json()) as VapiNumber;
        results.push({ did, ok: true, id: created.id, action: 'created', message: `created on cred ${cred}` });
      } else {
        results.push({ did, ok: false, action: 'error', message: `POST ${res.status}: ${await res.text().catch(() => '')}` });
      }
    } catch (err) {
      results.push({ did, ok: false, action: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { configured: true, ok: results.every((r) => r.ok), results };
}

/** Read-only check for a single DID (used by Test). */
export async function checkVapiByoForDid(didE164: string): Promise<{ configured: boolean; ok: boolean; message: string }> {
  const did = String(didE164 || '').trim();
  if (!isVapiByoConfigured()) {
    return { configured: false, ok: false, message: 'VAPI_PRIVATE_KEY / VAPI_SIP_CREDENTIAL_ID not set — cannot verify Vapi BYO' };
  }
  try {
    const numbers = await listNumbers();
    const match = numbers.find((n) => (n.number || '') === did);
    if (!match) return { configured: true, ok: false, message: `No Vapi BYO number for ${did} — inbound calls will drop to voicemail` };
    const url = webhookUrl();
    if (serverOf(match) !== url) return { configured: true, ok: false, message: `Vapi BYO ${did} points at "${serverOf(match)}", not ${url}` };
    return { configured: true, ok: true, message: `Vapi BYO ${did} ready (id=${match.id})` };
  } catch (err) {
    return { configured: true, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
