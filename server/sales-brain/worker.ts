import { getSalesBrainStore, syncSalesBrainStore } from './store';
import { scoreSalesCall } from './score-call';
import { maybeEmitRecommendations } from './patterns';

const POLL_MS = Number(process.env.SALES_BRAIN_POLL_MS ?? 20000);

export function startSalesBrainWorker(): void {
  if (process.env.DISABLE_SALES_BRAIN_WORKER === '1') return;
  setInterval(() => {
    void processSalesBrainQueue().catch((err) => {
      console.error('[sales-brain] worker error:', err);
    });
  }, POLL_MS);
  console.log('[sales-brain] worker started');
}

async function processSalesBrainQueue(): Promise<void> {
  const store = getSalesBrainStore();
  const job = store.jobs.find((j) => j.status === 'queued');
  if (!job) return;

  job.status = 'running';
  job.attempts += 1;
  job.updatedAt = new Date().toISOString();
  syncSalesBrainStore(store);

  try {
    const insight = await scoreSalesCall({
      callId: job.callId,
      orgId: job.orgId,
      agentPersona: job.agentPersona,
      aim: job.aim,
    });
    const s2 = getSalesBrainStore();
    s2.insights = s2.insights.filter((i) => !(i.callId === insight.callId && i.orgId === insight.orgId));
    s2.insights.push(insight);
    if (s2.insights.length > 400) s2.insights = s2.insights.slice(-300);
    const j = s2.jobs.find((x) => x.id === job.id);
    if (j) {
      j.status = 'done';
      j.updatedAt = new Date().toISOString();
    }
    syncSalesBrainStore(s2);
    maybeEmitRecommendations(job.orgId);
    // #region agent log
    void import('../debug-session-log').then(({ debugLog }) => {
      debugLog('SB', 'sales-brain/worker.ts', 'job scored', {
        callId: job.callId,
        outcome: insight.outcome || null,
        objections: insight.objections.length,
      });
    }).catch(() => {});
    // #endregion
  } catch (err) {
    const s2 = getSalesBrainStore();
    const j = s2.jobs.find((x) => x.id === job.id);
    if (j) {
      j.status = j.attempts >= 3 ? 'failed' : 'queued';
      j.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      j.updatedAt = new Date().toISOString();
    }
    syncSalesBrainStore(s2);
  }
}
