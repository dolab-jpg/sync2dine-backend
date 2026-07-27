/**
 * Vapi BYO (bring-your-own) phone-number helpers.
 *
 * Every AI DID (Sally + each customer Judie) must have a Vapi BYO number on the
 * shared Sync2Dine SIP credential whose server.url points at the Sync2Dine
 * webhook. A missing BYO is exactly why an inbound call could "test fine" yet
 * drop to voicemail: Vapi had no identity for that number, so it never invoked
 * the assistant.
 *
 * Additionally, Asterisk on the VPS must be allowlisted as an inboundEnabled
 * gateway on that SIP credential. Without it, Vapi 401s the Dial and the caller
 * hears Answer then silence/hangup. Go live and Test both call in here so those
 * classes of failure are caught up front.
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

function webhookSecret(): string | null {
  return process.env.VAPI_SERVER_SECRET?.trim() || null;
}

function serverPayload(): { url: string; secret?: string } {
  const url = webhookUrl();
  const secret = webhookSecret();
  return secret ? { url, secret } : { url };
}

function inboundAllowedIp(): string | null {
  return (
    process.env.EXTERNAL_IP
    || process.env.VAPI_INBOUND_ALLOWED_IP
    || process.env.PUBLIC_IP
    || null
  )?.trim() || null;
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

interface VapiGateway {
  ip?: string;
  port?: number;
  inboundEnabled?: boolean;
  outboundEnabled?: boolean;
  outboundProtocol?: string;
  netmask?: number;
}

interface VapiCredential {
  id?: string;
  gateways?: VapiGateway[];
  outboundAuthenticationPlan?: Record<string, unknown>;
  outboundLeadingPlusEnabled?: boolean;
}

async function vapiFetch(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

/** phoneNumberId ? E.164 (real SIP assistant-request often omits phoneNumber.number). */
const phoneNumberIdToDidCache = new Map<string, string>();

function seedKnownPhoneNumberIds(): void {
  // Warm cache so inbound assistant-request never waits on Vapi list/get (Vapi budget ~7.5s).
  const pairs = [
    [process.env.JUDIE_VAPI_PHONE_NUMBER_ID, process.env.JUDIE_DID || process.env.SOHO66_ARIA_DID],
    [process.env.VAPI_JUDIE_PHONE_NUMBER_ID, process.env.JUDIE_DID],
    // Live Judie BYO (app.sync2dine.io demo kitchen line)
    ['3019a4c8-d063-48e9-92c9-f0c51dd58d7b', '+442071128727'],
  ] as Array<[string | undefined, string | undefined]>;
  for (const [id, did] of pairs) {
    const nid = String(id || '').trim();
    const number = String(did || '').trim();
    if (nid && number) phoneNumberIdToDidCache.set(nid, number);
  }
}
seedKnownPhoneNumberIds();

/**
 * Resolve a Vapi BYO phoneNumberId to its E.164 DID.
 * Critical for Judie: inbound webhooks often only send phoneNumberId, and without
 * the DID we fall back to home org (empty menu).
 * Must stay fast ó Vapi assistant-request times out at ~7.5s.
 */
export async function resolveVapiPhoneNumberIdToDid(phoneNumberId: string): Promise<string | null> {
  const id = String(phoneNumberId || '').trim();
  if (!id) return null;
  const cached = phoneNumberIdToDidCache.get(id);
  if (cached) return cached;
  if (!key()) return null;
  try {
    // Short timeout ó never burn the whole assistant-request budget on Vapi GET.
    const res = await vapiFetch(`/phone-number/${id}`, undefined, 2_000);
    if (res.ok) {
      const row = (await res.json()) as VapiNumber;
      const number = String(row.number || '').trim();
      if (number) {
        phoneNumberIdToDidCache.set(id, number);
        return number;
      }
    }
    // Do not list-all on the hot path (can exceed 7.5s). Warm cache in background.
    void listNumbers()
      .then((all) => {
        for (const n of all) {
          const nid = String(n.id || '').trim();
          const number = String(n.number || '').trim();
          if (nid && number) phoneNumberIdToDidCache.set(nid, number);
        }
      })
      .catch(() => undefined);
    return phoneNumberIdToDidCache.get(id) || null;
  } catch {
    return null;
  }
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

export interface InboundIpResult {
  ok: boolean;
  ip: string | null;
  action: 'exists' | 'patched' | 'skipped' | 'error';
  message: string;
}

export interface ByoEnsureSummary {
  configured: boolean;
  ok: boolean;
  results: ByoResult[];
  inboundIp?: InboundIpResult;
}

/**
 * Ensure the VPS public IP is inboundEnabled on the BYO SIP credential so
 * Asterisk?Vapi Dial is accepted (avoids Answer-then-silent-Hangup).
 */
export async function ensureVapiInboundIp(ip?: string | null): Promise<InboundIpResult> {
  const targetIp = (ip || inboundAllowedIp())?.trim() || null;
  if (!isVapiByoConfigured()) {
    return { ok: false, ip: targetIp, action: 'skipped', message: 'Vapi not configured' };
  }
  if (!targetIp) {
    return {
      ok: false,
      ip: null,
      action: 'skipped',
      message: 'EXTERNAL_IP / VAPI_INBOUND_ALLOWED_IP not set ù cannot verify Vapi inbound allowlist',
    };
  }
  const cred = credentialId() as string;
  try {
    const get = await vapiFetch(`/credential/${cred}`);
    if (!get.ok) {
      return { ok: false, ip: targetIp, action: 'error', message: `GET credential ${get.status}` };
    }
    const cur = (await get.json()) as VapiCredential;
    const gateways = Array.isArray(cur.gateways) ? [...cur.gateways] : [];
    if (gateways.some((g) => g.ip === targetIp && g.inboundEnabled === true)) {
      return { ok: true, ip: targetIp, action: 'exists', message: `inbound IP ${targetIp} already allowlisted` };
    }
    gateways.push({ ip: targetIp, inboundEnabled: true, outboundEnabled: false, netmask: 32 });
    if (!gateways.some((g) => g.outboundEnabled)) {
      gateways.push({
        ip: 'sbc.soho66.co.uk',
        port: 8060,
        inboundEnabled: false,
        outboundEnabled: true,
        outboundProtocol: 'udp',
      });
    }
    const body: Record<string, unknown> = {
      gateways,
      outboundLeadingPlusEnabled: cur.outboundLeadingPlusEnabled !== false,
    };
    if (cur.outboundAuthenticationPlan) body.outboundAuthenticationPlan = cur.outboundAuthenticationPlan;
    const patch = await vapiFetch(`/credential/${cred}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (!patch.ok) {
      return { ok: false, ip: targetIp, action: 'error', message: `PATCH credential ${patch.status}: ${await patch.text().catch(() => '')}` };
    }
    return { ok: true, ip: targetIp, action: 'patched', message: `inbound IP ${targetIp} allowlisted on Vapi SIP credential` };
  } catch (err) {
    return { ok: false, ip: targetIp, action: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Make sure every DID has a BYO number on the right credential + webhook, and
 * the VPS IP is allowlisted for inbound SIP to Vapi.
 */
export async function ensureVapiByoForDids(didsE164: string[]): Promise<ByoEnsureSummary> {
  const dids = Array.from(new Set(didsE164.map((d) => String(d || '').trim()).filter(Boolean)));
  if (!isVapiByoConfigured()) {
    return { configured: false, ok: false, results: dids.map((did) => ({ did, ok: false, action: 'skipped', message: 'VAPI_PRIVATE_KEY / VAPI_SIP_CREDENTIAL_ID not set' })) };
  }
  const cred = credentialId() as string;
  const inboundIp = await ensureVapiInboundIp();
  let existing: VapiNumber[];
  try {
    existing = await listNumbers();
  } catch (err) {
    return {
      configured: true,
      ok: false,
      inboundIp,
      results: dids.map((did) => ({ did, ok: false, action: 'error', message: err instanceof Error ? err.message : String(err) })),
    };
  }

  const results: ByoResult[] = [];
  for (const did of dids) {
    const match = existing.find((n) => (n.number || '') === did);
    try {
      if (match) {
        const want = serverPayload();
        const haveSecret = Boolean((match.server && (match.server as { secret?: string }).secret) || (match as { serverUrlSecret?: string }).serverUrlSecret);
        const needPatch = serverOf(match) !== want.url || (Boolean(want.secret) && !haveSecret);
        if (needPatch) {
          const res = await vapiFetch(`/phone-number/${match.id}`, { method: 'PATCH', body: JSON.stringify({ server: want }) });
          results.push(res.ok
            ? { did, ok: true, id: match.id, action: 'patched', message: `server ${want.secret ? 'url+secret' : 'url'} updated -> ${want.url}` }
            : { did, ok: false, id: match.id, action: 'error', message: `PATCH ${res.status}` });
        } else {
          results.push({ did, ok: true, id: match.id, action: 'exists', message: `already on cred ${cred}` });
        }
        continue;
      }
      const res = await vapiFetch('/phone-number', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'byo-phone-number',
          number: did,
          credentialId: cred,
          numberE164CheckEnabled: false,
          server: serverPayload(),
        }),
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
  // inboundIp.skipped (no EXTERNAL_IP) is a warning, not a hard fail ù live may still
  // work if the IP was allowlisted manually. inboundIp.error / !ok when we tried = fail.
  const inboundOk = inboundIp.action === 'skipped' || inboundIp.ok;
  return { configured: true, ok: results.every((r) => r.ok) && inboundOk, results, inboundIp };
}

/** Read-only check for a single DID (used by Test). */
export async function checkVapiByoForDid(didE164: string): Promise<{ configured: boolean; ok: boolean; message: string }> {
  const did = String(didE164 || '').trim();
  if (!isVapiByoConfigured()) {
    return { configured: false, ok: false, message: 'VAPI_PRIVATE_KEY / VAPI_SIP_CREDENTIAL_ID not set ù cannot verify Vapi BYO' };
  }
  try {
    const numbers = await listNumbers();
    const match = numbers.find((n) => (n.number || '') === did);
    if (!match) return { configured: true, ok: false, message: `No Vapi BYO number for ${did} ù inbound calls will drop to voicemail` };
    const url = webhookUrl();
    if (serverOf(match) !== url) return { configured: true, ok: false, message: `Vapi BYO ${did} points at "${serverOf(match)}", not ${url}` };
    const haveSecret = Boolean(
      (match.server && (match.server as { secret?: string }).secret)
      || (match as { serverUrlSecret?: string }).serverUrlSecret,
    );
    if (webhookSecret() && !haveSecret) {
      return {
        configured: true,
        ok: false,
        message: `Vapi BYO ${did} has no webhook secret ù Vapi will speak "invalid secret" instead of Judie`,
      };
    }

    const ip = inboundAllowedIp();
    if (ip) {
      const get = await vapiFetch(`/credential/${credentialId()}`);
      if (get.ok) {
        const cur = (await get.json()) as VapiCredential;
        const allowed = (cur.gateways || []).some((g) => g.ip === ip && g.inboundEnabled === true);
        if (!allowed) {
          return {
            configured: true,
            ok: false,
            message: `Vapi BYO ${did} exists, but VPS IP ${ip} is not inbound-allowlisted ù calls Answer then hang up with no audio`,
          };
        }
      }
    }
    return { configured: true, ok: true, message: `Vapi BYO ${did} ready (id=${match.id})` };
  } catch (err) {
    return { configured: true, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
