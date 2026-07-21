import {
  getDataStore,
  updateOutboundJob,
  getOutboundQueueState,
  isWithinCallQueueQuietHours,
  getAgentCapacitySnapshot,
} from './data-store';

const POLL_MS = Number(process.env.OUTBOUND_POLL_MS ?? 15000);

/**
 * Max simultaneous live calls per org (inbound + outbound).
 * Restaurant default: 4 inbound + 1 outbound (5 total).
 */
export function startOutboundWorker(): void {
  if (process.env.DISABLE_OUTBOUND_WORKER === '1') return;
  setInterval(async () => {
    try {
      await processOutboundQueue();
    } catch (err) {
      console.error('Outbound worker error:', err);
    }
  }, POLL_MS);
}

async function processOutboundQueue(): Promise<void> {
  const queueState = getOutboundQueueState();
  if (queueState !== 'running') return;

  const inQuietHours = isWithinCallQueueQuietHours();
  const capacity = getAgentCapacitySnapshot();
  if (capacity.outboundSlotsFree <= 0) return;

  const store = getDataStore();
  const queue = (store.outboundQueue ?? []).filter((j) => {
    if (String(j.status ?? '') !== 'queued') return false;
    const ctx = (j.context && typeof j.context === 'object')
      ? (j.context as Record<string, unknown>)
      : {};
    const bypassQuiet =
      j.bypassQuietHours === true
      || String(ctx.aim || '').toLowerCase() === 'meeting_confirm';
    // #region agent log
    if (String(ctx.aim || '').toLowerCase() === 'meeting_confirm' || j.bypassQuietHours === true) {
      void import('./debug-session-log').then(({ debugLog }) => {
        debugLog('B', 'outbound-worker.ts:filter', 'meeting_confirm queue eligibility', {
          jobId: String(j.id || ''),
          aim: String(ctx.aim || ''),
          bypassQuietHours: j.bypassQuietHours === true,
          bypassQuiet,
          inQuietHours,
          wouldSkipForQuiet: inQuietHours && !bypassQuiet,
          scheduledAt: j.scheduledAt || null,
        });
      }).catch(() => {});
    }
    // #endregion
    if (inQuietHours && !bypassQuiet) return false;
    const scheduled = j.scheduledAt ? Date.parse(String(j.scheduledAt)) : NaN;
    if (Number.isFinite(scheduled) && scheduled > Date.now()) return false;
    return true;
  });
  if (!queue.length) return;

  for (const job of queue.slice(0, capacity.outboundSlotsFree)) {
    const id = String(job.id ?? '');
    updateOutboundJob(id, { status: 'dialling', startedAt: new Date().toISOString() });
    try {
      const base = (process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, '');
      const ctx = (job.context && typeof job.context === 'object')
        ? (job.context as Record<string, unknown>)
        : {};
      const res = await fetch(`${base}/api/calls/outbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: job.to,
          template: job.template,
          fromWorker: true,
          context: {
            ...ctx,
            customerId: ctx.customerId ?? job.customerId,
            aim: ctx.aim ?? ctx.reason,
            brief: ctx.brief ?? ctx.aim ?? ctx.reason,
            source: ctx.source ?? 'outbound_queue',
          },
        }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as { callId?: string };
        updateOutboundJob(id, {
          status: 'dialling',
          callId: data.callId ?? job.callId,
          dialAcceptedAt: new Date().toISOString(),
        });
      } else {
        const errText = await res.text().catch(() => 'dial failed');
        updateOutboundJob(id, { status: 'failed', error: errText.slice(0, 200) });
      }
    } catch (err) {
      updateOutboundJob(id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
