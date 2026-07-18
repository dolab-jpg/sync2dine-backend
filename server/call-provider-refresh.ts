/**
 * Pull missing call artifacts (phone, transcript, recording) from Vapi GET /call/{id}.
 */
import {
  appendCallTurn,
  computeCallDurationSec,
  computeCallSentiment,
  getCallById,
  getDataStore,
  saveCall,
} from './data-store';
import { toE164Uk, vapiFetch } from './vapi-client';
import {
  extractRecordingUrls,
  lineDidForDirection,
} from './call-recording-artifacts';
import { ingestCallRecording } from './call-recording-store';
import { backfillCallRecordingOnFinalize } from './call-recording-backfill';
import { getDemoKitchenOrgId } from './home-org';
import { mapEndedReasonToDisposition } from './lead-call-disposition';

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function partyPhoneFromVapiCall(call: Record<string, unknown> | undefined): string {
  if (!call) return '';
  const customer = asRecord(call.customer);
  const customerNumber = String(customer?.number || '').trim();
  if (customerNumber) return toE164Uk(customerNumber);
  const direction = String(call.type || call.direction || '');
  const from = String(call.from || '').trim();
  const to = String(call.to || '').trim();
  if (direction.toLowerCase().includes('outbound')) return toE164Uk(customerNumber || to || from);
  return toE164Uk(from || customerNumber || to);
}

function vapiCallIdFor(call: Record<string, unknown>): string {
  const meta = asRecord(call.metadata) || {};
  return String(
    call.providerCallId
    || meta.vapiCallId
    || (String(call.provider || '') === 'vapi' ? call.id : '')
    || '',
  ).trim();
}

function applyTranscriptFromVapi(callId: string, json: Record<string, unknown>, _partyPhone: string): number {
  const existing = getCallById(callId);
  const existingTurns = Array.isArray(existing?.transcript) ? existing!.transcript.length : 0;
  if (existingTurns >= 2) return 0;

  const artifact = asRecord(json.artifact);
  const messages = Array.isArray(artifact?.messages)
    ? (artifact!.messages as Array<Record<string, unknown>>)
    : Array.isArray(json.messages)
      ? (json.messages as Array<Record<string, unknown>>)
      : [];

  let added = 0;
  for (const m of messages) {
    const rawRole = String(m.role || '').toLowerCase();
    if (rawRole === 'system') continue;
    const role: 'caller' | 'agent' = rawRole === 'assistant' ? 'agent' : 'caller';
    const text = String(m.message || m.content || '').trim();
    if (!text) continue;
    appendCallTurn(callId, {
      role,
      content: text,
      timestamp: new Date().toISOString(),
    });
    added += 1;
  }

  if (added === 0) {
    const blob = String(json.transcript || artifact?.transcript || '').trim();
    if (blob) {
      for (const line of blob.split(/\n+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        appendCallTurn(callId, {
          role: 'caller',
          content: trimmed,
          timestamp: new Date().toISOString(),
        });
        added += 1;
      }
    }
  }

  void _partyPhone;
  return added;
}

export type RefreshFromProviderResult = {
  ok: boolean;
  callId: string;
  found: boolean;
  providerStatus?: number;
  partyPhone?: string;
  recordingUrl?: string;
  recordingStoragePath?: string;
  transcriptAdded?: number;
  error?: string;
};

/** Fetch Vapi call by id and merge phone / transcript / recording into our row. */
export async function refreshCallFromProvider(callId: string): Promise<RefreshFromProviderResult> {
  const local = getCallById(callId);
  if (!local) return { ok: false, callId, found: false, error: 'Call not found' };

  const vapiId = vapiCallIdFor(local);
  if (!vapiId) {
    return {
      ok: false,
      callId,
      found: true,
      error: 'No Vapi call id on this row — cannot refresh from provider',
    };
  }

  let json: Record<string, unknown>;
  let status: number;
  try {
    const res = await vapiFetch(`/call/${encodeURIComponent(vapiId)}`);
    status = res.status;
    json = res.json;
    if (!res.ok) {
      return {
        ok: false,
        callId,
        found: true,
        providerStatus: status,
        error: `Vapi GET /call failed (${status})`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      callId,
      found: true,
      error: err instanceof Error ? err.message : 'Vapi fetch failed',
    };
  }

  const meta = asRecord(local.metadata) || {};
  const directionRaw = String(json.type || local.direction || '').toLowerCase();
  const direction = directionRaw.includes('outbound') ? 'outbound' : 'inbound';
  const partyPhone = partyPhoneFromVapiCall(json) || toE164Uk(String(meta.partyPhone || ''));
  const lineDid = lineDidForDirection(direction, json, String(process.env.SOHO66_FROM_NUMBER || ''));
  const urls = extractRecordingUrls(json);
  const endedReason = String(json.endedReason || json.ended_reason || '');
  const summary = String(
    json.summary
    || asRecord(json.analysis)?.summary
    || '',
  ).trim();
  const cost = json.cost ?? asRecord(json.costBreakdown)?.total;

  const from = direction === 'outbound'
    ? (lineDid || String(local.from || ''))
    : (partyPhone || String(local.from || ''));
  const to = direction === 'outbound'
    ? (partyPhone || String(local.to || ''))
    : (lineDid || String(local.to || ''));

  const disposition = mapEndedReasonToDisposition(endedReason, {
    transferred: Boolean(local.transferredTo),
    toolOutcome: String(local.outcome || ''),
  });

  const providerDuration = Number(json.duration || json.durationSeconds || NaN);
  const durationSec = Number.isFinite(providerDuration) && providerDuration > 0
    ? Math.round(providerDuration)
    : (local.durationSec ?? computeCallDurationSec(local));

  saveCall({
    id: callId,
    providerCallId: vapiId,
    provider: 'vapi',
    direction,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(urls.recordingUrl ? { recordingUrl: urls.recordingUrl } : {}),
    ...(urls.stereoRecordingUrl ? { stereoRecordingUrl: urls.stereoRecordingUrl } : {}),
    ...(endedReason && String(local.outcome || '') === 'stale_timeout'
      ? { outcome: disposition || endedReason || 'completed' }
      : {}),
    durationSec,
    sentiment: computeCallSentiment({ ...local, durationSec }),
    status: String(json.status || '').toLowerCase().includes('end')
      || String(json.status || '').toLowerCase() === 'ended'
      || local.endedAt
      ? 'completed'
      : (local.status as string) || 'completed',
    ...(local.endedAt ? {} : { endedAt: new Date().toISOString() }),
    metadata: {
      ...meta,
      vapiCallId: vapiId,
      partyPhone: partyPhone || meta.partyPhone,
      lineDid: lineDid || meta.lineDid,
      ...(summary ? { vapiSummary: summary } : {}),
      ...(endedReason ? { vapiEndedReason: endedReason } : {}),
      ...(cost != null ? { vapiCost: cost } : {}),
      refreshedFromProviderAt: new Date().toISOString(),
    },
  });

  const transcriptAdded = applyTranscriptFromVapi(callId, json, partyPhone);

  const ingest = await ingestCallRecording({
    callId,
    orgId: getDemoKitchenOrgId(),
    urls,
    messageOrCall: json,
  });

  const finalUrl = ingest.recordingUrl || urls.recordingUrl || urls.stereoRecordingUrl;
  if (finalUrl) {
    void backfillCallRecordingOnFinalize(callId, finalUrl, getDemoKitchenOrgId());
  }

  return {
    ok: true,
    callId,
    found: true,
    providerStatus: status,
    partyPhone: partyPhone || undefined,
    recordingUrl: finalUrl,
    recordingStoragePath: ingest.recordingStoragePath || ingest.stereoStoragePath,
    transcriptAdded,
  };
}

/** Best-effort refresh for recently stale / artifact-missing calls. */
export async function refreshCallsMissingArtifacts(limit = 5): Promise<number> {
  const calls = (getDataStore().calls as Array<Record<string, unknown>>).slice(0, 80);
  const candidates = calls.filter((c) => {
    const meta = asRecord(c.metadata) || {};
    const hasVapi = Boolean(vapiCallIdFor(c));
    if (!hasVapi) return false;
    const missingPhone = !String(meta.partyPhone || c.from || '').trim();
    const missingRec = !String(c.recordingUrl || c.recordingStoragePath || '').trim();
    const missingTx = !Array.isArray(c.transcript) || c.transcript.length < 1;
    const stale = String(c.outcome || '') === 'stale_timeout';
    return stale || missingPhone || missingRec || missingTx;
  }).slice(0, limit);

  let ok = 0;
  for (const c of candidates) {
    const result = await refreshCallFromProvider(String(c.id));
    if (result.ok) ok += 1;
  }
  return ok;
}
