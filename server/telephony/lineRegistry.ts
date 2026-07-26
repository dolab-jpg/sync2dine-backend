import {
  listPhoneLines,
  updatePhoneLineStatus,
  withOrgContext,
  type PhoneLine,
} from '../data-store';
import { withDecryptedSipPassword, didToE164 } from '../phone-lines';
import { checkVapiByoForDid } from './vapiByo';

export function getSipBridgeUrl(): string | null {
  const url = (process.env.SOHO66_SIP_BRIDGE_URL ?? '').replace(/\/$/, '');
  return url || null;
}

export function getWebhookBaseUrl(): string {
  return (process.env.WEBHOOK_BASE_URL ?? process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
}

async function bridgeFetch(
  bridgeUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = bridgeUrl.replace(/\/$/, '');
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

/** Status writes must hit the correct org's store when called from platform multi-org paths. */
function setLineStatus(
  lineId: string,
  patch: Parameters<typeof updatePhoneLineStatus>[1],
  orgId?: string,
): void {
  if (orgId) {
    withOrgContext(orgId, () => {
      updatePhoneLineStatus(lineId, patch);
    });
    return;
  }
  updatePhoneLineStatus(lineId, patch);
}

export async function registerLine(
  line: PhoneLine,
  bridgeUrl?: string,
  orgId?: string,
): Promise<{ ok: boolean; message: string }> {
  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) {
    return { ok: false, message: 'SOHO66_SIP_BRIDGE_URL is not configured' };
  }

  setLineStatus(line.id, { status: 'registering', lastError: undefined }, orgId);

  const decrypted = withDecryptedSipPassword(line);

  try {
    const response = await bridgeFetch(bridge, '/lines/register', {
      method: 'POST',
      body: JSON.stringify({
        lineId: line.id,
        sipUsername: decrypted.sipUsername,
        sipPassword: decrypted.sipPassword,
        sipDomain: decrypted.sipDomain,
        did: decrypted.did,
        webhookBaseUrl: getWebhookBaseUrl(),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const message = errText || `Bridge registration failed (${response.status})`;
      setLineStatus(line.id, { status: 'error', lastError: message }, orgId);
      return { ok: false, message };
    }

    setLineStatus(line.id, {
      status: 'registered',
      registeredAt: new Date().toISOString(),
      lastError: undefined,
    }, orgId);
    return { ok: true, message: `Line "${line.label}" registered` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bridge unreachable';
    setLineStatus(line.id, { status: 'error', lastError: message }, orgId);
    return { ok: false, message };
  }
}

export async function unregisterLine(lineId: string, bridgeUrl?: string, orgId?: string): Promise<void> {
  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) {
    setLineStatus(lineId, { status: 'disconnected', lastError: undefined }, orgId);
    return;
  }

  try {
    await bridgeFetch(bridge, `/lines/${encodeURIComponent(lineId)}`, { method: 'DELETE' });
  } catch {
    // best-effort unregister
  }
  setLineStatus(lineId, { status: 'disconnected', lastError: undefined, registeredAt: undefined }, orgId);
}

export async function registerAllEnabledLines(bridgeUrl?: string): Promise<{
  registered: number;
  failed: number;
  results: Array<{ lineId: string; label: string; ok: boolean; message: string }>;
}> {
  // Judie (aria) and Sally lines register with the bridge — staff softphones use browser JsSIP.
  const lines = listPhoneLines().filter(
    (l) => l.enabled && ((l.purpose ?? 'staff') === 'aria' || l.purpose === 'sally'),
  );
  const results: Array<{ lineId: string; label: string; ok: boolean; message: string }> = [];
  let registered = 0;
  let failed = 0;

  for (const line of lines) {
    const result = await registerLine(line, bridgeUrl);
    results.push({ lineId: line.id, label: line.label, ok: result.ok, message: result.message });
    if (result.ok) registered += 1;
    else failed += 1;
  }

  return { registered, failed, results };
}

export async function testLineConnection(line: PhoneLine, bridgeUrl?: string): Promise<{ ok: boolean; message: string }> {
  const decrypted = withDecryptedSipPassword(line);
  if (!decrypted.sipUsername || !decrypted.sipPassword || !decrypted.sipDomain) {
    return { ok: false, message: 'SIP username, password, and domain are required' };
  }
  if (!decrypted.did?.trim()) {
    return { ok: false, message: 'DID (phone number) is required' };
  }

  // The inbound identity: a missing Vapi BYO for this DID is exactly why a call
  // "tests fine" and still drops to voicemail. Verify it as part of Test.
  const byo = await checkVapiByoForDid(didToE164(decrypted.did));

  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) {
    return {
      ok: false,
      message:
        `Credentials look complete for ${decrypted.sipUsername}@${decrypted.sipDomain}, but SOHO66_SIP_BRIDGE_URL is not set on the API. ` +
        'Test cannot verify in-app REGISTER; live Judie inbound uses the VPS Asterisk Soho66 bridge (use Go live). ' +
        `Vapi BYO: ${byo.message}.`,
    };
  }

  try {
    const response = await bridgeFetch(bridge, '/health');
    if (!response.ok) {
      return { ok: false, message: `SIP bridge health check failed (${response.status})` };
    }
    // Never claim ready when the inbound BYO is missing (when Vapi is configured).
    const ready = byo.ok || !byo.configured;
    return {
      ok: ready,
      message: ready
        ? `Bridge reachable and line "${decrypted.label}" ready (${decrypted.sipUsername}@${decrypted.sipDomain}). Vapi BYO: ${byo.message}.`
        : `Bridge reachable, but inbound will fail: ${byo.message}. Run Go live to provision the Vapi BYO.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Bridge unreachable' };
  }
}

export async function syncLineStatusesFromBridge(bridgeUrl?: string): Promise<void> {
  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) return;

  try {
    const response = await bridgeFetch(bridge, '/lines');
    if (!response.ok) return;
    const data = await response.json() as { lines?: Array<{ lineId: string; status: string }> };
    if (!Array.isArray(data.lines)) return;
    for (const remote of data.lines) {
      const status = remote.status === 'registered' ? 'registered' : remote.status === 'error' ? 'error' : 'disconnected';
      updatePhoneLineStatus(remote.lineId, { status });
    }
  } catch {
    // optional sync
  }
}
