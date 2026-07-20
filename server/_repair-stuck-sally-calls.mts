/**
 * One-shot: backfill stuck Sally outbound rows from Vapi providerCallId.
 * Run on VPS: node --import tsx server/_repair-stuck-sally-calls.mts
 */
import { getCallById, getDataStore, saveCall, syncData, appendCustomerCallActivity } from './data-store.ts';
import { vapiFetch } from './vapi-client.ts';
import { notifySallyCallEnded } from './sally-sales-phone.ts';

const STUCK_IDS = ['out-1784585167101', 'out-1784583627048'];

async function repairOne(localId: string): Promise<void> {
  const call = getCallById(localId);
  if (!call) {
    console.log(localId, 'missing locally');
    return;
  }
  const providerId = String(call.providerCallId || '').trim();
  if (!providerId) {
    console.log(localId, 'no providerCallId — force complete');
    saveCall({
      id: localId,
      status: 'completed',
      endedAt: new Date().toISOString(),
      outcome: 'repair_no_provider',
    });
    return;
  }

  const res = await vapiFetch(`/call/${providerId}`);
  if (!res.ok) {
    console.log(localId, 'vapi fetch failed', res.status, String(res.raw || '').slice(0, 200));
    saveCall({
      id: localId,
      status: 'completed',
      endedAt: new Date().toISOString(),
      outcome: 'repair_vapi_fetch_failed',
    });
    return;
  }

  const data = (res.data || {}) as Record<string, unknown>;
  const artifact = (data.artifact || {}) as Record<string, unknown>;
  const recordingUrl = String(
    artifact.recordingUrl
    || data.recordingUrl
    || (Array.isArray(artifact.recordingUrl) ? artifact.recordingUrl[0] : '')
    || '',
  ).trim() || undefined;
  const summary = String(
    data.summary
    || (data.analysis as Record<string, unknown> | undefined)?.summary
    || '',
  ).trim();
  const endedReason = String(data.endedReason || data.status || 'ended');
  const transcriptBlob = String(data.transcript || artifact.transcript || '').trim();
  const messages = Array.isArray(artifact.messages) ? artifact.messages as Array<Record<string, unknown>> : [];

  const turns: Array<{ role: string; content: string; at?: string }> = [];
  for (const m of messages) {
    const rawRole = String(m.role || '').toLowerCase();
    if (rawRole === 'system') continue;
    const text = String(m.message || m.content || '').trim();
    if (!text) continue;
    turns.push({
      role: rawRole === 'assistant' ? 'assistant' : 'user',
      content: text,
      at: new Date().toISOString(),
    });
  }
  if (!turns.length && transcriptBlob) {
    for (const line of transcriptBlob.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      let role = 'user';
      let text = trimmed;
      if (lower.startsWith('ai:') || lower.startsWith('assistant:')) {
        role = 'assistant';
        text = trimmed.replace(/^(ai|assistant):\s*/i, '');
      } else if (lower.startsWith('user:') || lower.startsWith('customer:')) {
        role = 'user';
        text = trimmed.replace(/^(user|customer):\s*/i, '');
      }
      if (text) turns.push({ role, content: text, at: new Date().toISOString() });
    }
  }

  const meta = { ...((call.metadata as Record<string, unknown>) || {}) };
  if (!meta.partyPhone && call.to) meta.partyPhone = String(call.to);
  meta.vapiEndedReason = endedReason;
  meta.repairedFromVapi = true;

  saveCall({
    id: localId,
    status: 'completed',
    endedAt: new Date().toISOString(),
    outcome: endedReason,
    recordingUrl: recordingUrl || (call.recordingUrl as string | undefined),
    transcript: turns.length ? turns : (call.transcript as unknown[] | undefined),
    metadata: meta,
  });

  const customerId = call.customerId != null
    ? String(call.customerId)
    : (meta.customerId != null ? String(meta.customerId) : null);
  const partyPhone = String(meta.partyPhone || call.to || '');

  if (customerId) {
    appendCustomerCallActivity({
      customerId,
      callId: localId,
      summary: (summary || `Sally call repaired from Vapi (${endedReason})`).slice(0, 400),
      detail: `Repaired stuck ringing row. transcriptTurns=${turns.length} recording=${recordingUrl ? 'yes' : 'no'}`,
      outcome: endedReason,
      aim: String(meta.aim || 'sales_outreach'),
      type: 'call',
      createdBy: 'sally',
      recordingUrl,
      updateCallQueue: true,
    });
  }

  notifySallyCallEnded({
    callId: localId,
    customerId,
    partyPhone,
    summary: summary || `Call ${localId} repaired — ${endedReason}`,
    disposition: endedReason,
  });

  console.log(localId, 'repaired', {
    turns: turns.length,
    recordingUrl: Boolean(recordingUrl),
    customerId,
    endedReason,
  });
}

async function main() {
  for (const id of STUCK_IDS) {
    await repairOne(id);
  }
  syncData(getDataStore());
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
