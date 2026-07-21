import {
  listPhoneLines,
  updatePhoneLineStatus,
  type PhoneLine,
} from '../data-store';
import { decryptPhoneLineSipPassword } from '../phone-lines';

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

export async function registerLine(line: PhoneLine, bridgeUrl?: string): Promise<{ ok: boolean; message: string }> {
  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) {
    return { ok: false, message: 'SOHO66_SIP_BRIDGE_URL is not configured' };
  }

  updatePhoneLineStatus(line.id, { status: 'registering', lastError: undefined });

  try {
    const response = await bridgeFetch(bridge, '/lines/register', {
      method: 'POST',
      body: JSON.stringify({
        lineId: line.id,
        sipUsername: line.sipUsername,
        sipPassword: decryptPhoneLineSipPassword(line.sipPassword),
        sipDomain: line.sipDomain,
        did: line.did,
        webhookBaseUrl: getWebhookBaseUrl(),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const message = errText || `Bridge registration failed (${response.status})`;
      updatePhoneLineStatus(line.id, { status: 'error', lastError: message });
      return { ok: false, message };
    }

    updatePhoneLineStatus(line.id, {
      status: 'registered',
      registeredAt: new Date().toISOString(),
      lastError: undefined,
    });
    return { ok: true, message: `Line "${line.label}" registered` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bridge unreachable';
    updatePhoneLineStatus(line.id, { status: 'error', lastError: message });
    return { ok: false, message };
  }
}

export async function unregisterLine(lineId: string, bridgeUrl?: string): Promise<void> {
  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) {
    updatePhoneLineStatus(lineId, { status: 'disconnected', lastError: undefined });
    return;
  }

  try {
    await bridgeFetch(bridge, `/lines/${encodeURIComponent(lineId)}`, { method: 'DELETE' });
  } catch {
    // best-effort unregister
  }
  updatePhoneLineStatus(lineId, { status: 'disconnected', lastError: undefined, registeredAt: undefined });
}

export async function registerAllEnabledLines(bridgeUrl?: string): Promise<{
  registered: number;
  failed: number;
  results: Array<{ lineId: string; label: string; ok: boolean; message: string }>;
}> {
  // Only Cynthia AI lines (purpose: aria compat) register with the bridge — staff softphones use browser JsSIP.
  const lines = listPhoneLines().filter(l => l.enabled && (l.purpose ?? 'staff') === 'aria');
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
  const sipPassword = decryptPhoneLineSipPassword(line.sipPassword);
  if (!line.sipUsername || !sipPassword || !line.sipDomain) {
    return { ok: false, message: 'SIP username, password, and domain are required' };
  }
  if (!line.did?.trim()) {
    return { ok: false, message: 'DID (phone number) is required' };
  }

  const bridge = (bridgeUrl ?? getSipBridgeUrl())?.replace(/\/$/, '');
  if (!bridge) {
    return {
      ok: true,
      message: `Credentials saved for ${line.sipUsername}@${line.sipDomain}. Set SOHO66_SIP_BRIDGE_URL to register live.`,
    };
  }

  try {
    const response = await bridgeFetch(bridge, '/health');
    if (!response.ok) {
      return { ok: false, message: `SIP bridge health check failed (${response.status})` };
    }
    return {
      ok: true,
      message: `Bridge reachable. Line "${line.label}" ready to register (${line.sipUsername}@${line.sipDomain}).`,
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
