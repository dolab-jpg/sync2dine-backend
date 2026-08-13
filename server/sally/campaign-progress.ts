/**
 * Campaign / CSV outbound progress for Cynthia chat.
 * Crunches CRM customers + outbound_queue + calls. No download.
 */
import {
  getAgentSettings,
  getDataStore,
  getOutboundQueueState,
  isOpenCallStatus,
  normalizePhoneExport,
} from '../data-store';
import { getOutboundVoiceHealthStamp } from './outbound-voice-health';

export type CampaignProgressInput = {
  batchId?: string;
  campaign?: string;
};

type ProgressStore = {
  customers: Array<Record<string, unknown>>;
  outboundQueue: Array<Record<string, unknown>>;
  calls: Array<Record<string, unknown>>;
};

const CAMPAIGN_SOURCES = new Set(['sales_csv_dial', 'csv_upload', 'csv_campaign']);

function jobBatch(job: Record<string, unknown>): string {
  const ctx = job.context && typeof job.context === 'object'
    ? job.context as Record<string, unknown>
    : {};
  return String(ctx.batchId || ctx.campaignId || job.campaignId || '').trim();
}

function customerBatch(c: Record<string, unknown>): string {
  return String(c.leadBatchId || c.campaign || '').trim();
}

function pickLatestBatch(store: ProgressStore): string {
  const fromCustomers: Array<{ id: string; at: number }> = [];
  for (const c of store.customers) {
    const id = customerBatch(c);
    if (!id) continue;
    const at = Date.parse(String(c.updatedAt || c.createdAt || '')) || 0;
    fromCustomers.push({ id, at });
  }
  fromCustomers.sort((a, b) => b.at - a.at);
  if (fromCustomers[0]?.id) return fromCustomers[0].id;

  const activeJob = new Set(['queued', 'dialling', 'needs_hours']);
  const fromJobs: Array<{ id: string; at: number }> = [];
  for (const j of store.outboundQueue) {
    const id = jobBatch(j);
    if (!id) continue;
    if (!activeJob.has(String(j.status || '').toLowerCase())) continue;
    const at = Date.parse(String(j.createdAt || j.startedAt || '')) || 0;
    fromJobs.push({ id, at });
  }
  fromJobs.sort((a, b) => b.at - a.at);
  return fromJobs[0]?.id || '';
}

function isCampaignCustomer(c: Record<string, unknown>, batch: string): boolean {
  if (batch) {
    const id = customerBatch(c);
    if (id && id === batch) return true;
  }
  const source = String(c.source || '').toLowerCase();
  if (!batch && CAMPAIGN_SOURCES.has(source)) return true;
  const qs = String(c.callQueueStatus || '').toLowerCase();
  if (!batch && qs && qs !== 'not_called') return CAMPAIGN_SOURCES.has(source) || Boolean(customerBatch(c));
  return false;
}

function snippetFromTranscript(transcript: unknown): string {
  if (!Array.isArray(transcript)) return '';
  const turns = transcript as Array<{ role?: string; content?: string }>;
  const last = turns.slice(-4)
    .map((t) => {
      const role = String(t.role || '').toLowerCase();
      const who = role === 'agent' || role === 'assistant' ? 'Sally' : 'Them';
      const content = String(t.content || '').trim();
      return content ? `${who}: ${content}` : '';
    })
    .filter(Boolean);
  return last.join(' | ').slice(0, 280);
}

function startOfTodayIso(): number {
  const t = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  return Number.isFinite(t) ? t : Date.now() - 86400000;
}

export function buildCampaignProgress(
  input: CampaignProgressInput = {},
  injected?: ProgressStore,
): Record<string, unknown> {
  const live = getDataStore();
  const store: ProgressStore = injected || {
    customers: live.customers as Array<Record<string, unknown>>,
    outboundQueue: (live.outboundQueue ?? []) as Array<Record<string, unknown>>,
    calls: (live.calls ?? []) as Array<Record<string, unknown>>,
  };

  const requested = String(input.batchId || input.campaign || '').trim();
  const batch = requested || pickLatestBatch(store);

  const leads = store.customers.filter((c) => {
    if (batch) return isCampaignCustomer(c, batch);
    return CAMPAIGN_SOURCES.has(String(c.source || '').toLowerCase()) || Boolean(customerBatch(c));
  });

  const queueJobs = store.outboundQueue.filter((j) => {
    if (!batch) return true;
    const id = jobBatch(j);
    return id === batch;
  });

  const leadPhones = new Set(
    leads.map((c) => normalizePhoneExport(String(c.phone || ''))).filter((p) => p.length >= 7),
  );
  const leadIds = new Set(leads.map((c) => String(c.id || '')).filter(Boolean));

  const todayStart = startOfTodayIso();
  const outboundCalls = store.calls.filter((call) => {
    if (String(call.direction || '').toLowerCase() !== 'outbound') return false;
    const started = Date.parse(String(call.startedAt || call.createdAt || ''));
    if (Number.isFinite(started) && started < todayStart && batch) {
      /* still include if tied to this batch's customers */
    }
    const cid = String(call.customerId || '');
    const to = normalizePhoneExport(String(call.to || ''));
    if (leadIds.has(cid) || (to && leadPhones.has(to))) return true;
    if (!batch && Number.isFinite(started) && started >= todayStart) return true;
    return false;
  });

  const heldPhones = new Set(
    queueJobs
      .filter((j) => String(j.status || '').toLowerCase() === 'needs_hours')
      .map((j) => normalizePhoneExport(String(j.to || '')))
      .filter((p) => p.length >= 7),
  );
  const statusCounts: Record<string, number> = {
    not_called: 0,
    queued: 0,
    dialling: 0,
    called: 0,
    needs_retry: 0,
    needs_hours: 0,
    do_not_call: 0,
  };
  const dispositionCounts: Record<string, number> = {};
  for (const c of leads) {
    let qs = String(c.callQueueStatus || 'not_called').toLowerCase();
    const phone = normalizePhoneExport(String(c.phone || ''));
    if (qs === 'queued' && phone && heldPhones.has(phone)) qs = 'needs_hours';
    statusCounts[qs] = (statusCounts[qs] || 0) + 1;
    const disp = String(c.lastCallDisposition || '').trim();
    if (disp) dispositionCounts[disp] = (dispositionCounts[disp] || 0) + 1;
  }

  const jobStatus: Record<string, number> = {};
  for (const j of queueJobs) {
    const st = String(j.status || 'queued').toLowerCase();
    jobStatus[st] = (jobStatus[st] || 0) + 1;
  }

  let answered = 0;
  let noAnswer = 0;
  let voicemail = 0;
  let failed = 0;
  const liveNow: Array<{ name: string; phone: string; status: string }> = [];
  const recentSaid: Array<{ name: string; outcome: string; snippet: string; at: number }> = [];

  for (const call of outboundCalls) {
    const status = String(call.status || '').toLowerCase();
    const outcome = `${call.outcome || ''} ${call.metadata && typeof call.metadata === 'object' ? (call.metadata as Record<string, unknown>).disposition || '' : ''}`.toLowerCase();
    const name = String(call.contactName || call.customerName || 'Lead');
    const phone = String(call.to || '');
    if (isOpenCallStatus(status)) {
      liveNow.push({ name, phone, status });
    }
    if (/no.?answer|busy/.test(outcome)) noAnswer += 1;
    else if (/voicemail|machine/.test(outcome)) voicemail += 1;
    else if (/fail/.test(outcome) || status === 'failed') failed += 1;
    else if (status === 'completed' || /interested|answered|meeting|callback/.test(outcome)) answered += 1;

    const snippet = snippetFromTranscript(call.transcript);
    if (snippet) {
      recentSaid.push({
        name,
        outcome: String(call.outcome || status || ''),
        snippet,
        at: Date.parse(String(call.endedAt || call.startedAt || '')) || 0,
      });
    }
  }
  recentSaid.sort((a, b) => b.at - a.at);
  const recent = recentSaid.slice(0, 5).map(({ at: _at, ...row }) => row);

  const queueState = getOutboundQueueState();
  const voice = getOutboundVoiceHealthStamp();
  const voiceLine = voice?.pausedForSilent
    ? `Voice paused after silent outbound (${voice.consecutiveSilentOutbound || 2} dead calls).`
    : voice?.ok === false
      ? `Voice health error: ${voice.error || 'not ready'}.`
      : 'Voice health OK.';

  const liveBit = liveNow.length
    ? `${liveNow.length} on the line now (${liveNow.map((r) => r.name).join(', ')}).`
    : 'Nobody on the line right now.';

  const contacted = (statusCounts.called || 0) + (statusCounts.needs_retry || 0);
  const heldHours = jobStatus.needs_hours || 0;
  const spokenHint = [
    batch ? `Campaign ${batch}:` : 'Latest campaign:',
    `${leads.length} leads.`,
    `${contacted} contacted`,
    `(${statusCounts.called || 0} called, ${statusCounts.needs_retry || 0} need retry).`,
    `${statusCounts.queued || 0} queued, ${statusCounts.dialling || 0} dialling, ${heldHours} held for hours.`,
    `Calls: ${outboundCalls.length} outbound (${answered} answered, ${noAnswer} no answer, ${voicemail} voicemail, ${failed} failed).`,
    liveBit,
    `Queue is ${queueState}.`,
    voiceLine,
  ].join(' ');

  return {
    batchId: batch || null,
    queueState,
    voiceHealth: voice || { ok: true, checkedAt: null },
    leads: {
      total: leads.length,
      statuses: statusCounts,
      dispositions: dispositionCounts,
    },
    jobs: {
      total: queueJobs.length,
      statuses: jobStatus,
      heldForHours: heldHours,
    },
    calls: {
      outbound: outboundCalls.length,
      answered,
      noAnswer,
      voicemail,
      failed,
      liveNow,
    },
    recentSaid: recent,
    spokenHint,
  };
}
