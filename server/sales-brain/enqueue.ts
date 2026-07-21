import { getHomeOrgId } from '../home-org';
import { getSalesBrainStore, syncSalesBrainStore, type SalesBrainJob } from './store';

export function enqueueSalesBrainJob(opts: {
  callId: string;
  agentPersona?: string;
  aim?: string | null;
  orgId?: string;
}): { queued: boolean; jobId?: string } {
  const callId = String(opts.callId || '').trim();
  if (!callId) return { queued: false };
  const orgId = opts.orgId || getHomeOrgId();
  const store = getSalesBrainStore();
  const existing = store.jobs.find((j) => j.callId === callId && j.orgId === orgId);
  if (existing && (existing.status === 'queued' || existing.status === 'running' || existing.status === 'done')) {
    return { queued: false, jobId: existing.id };
  }
  const now = new Date().toISOString();
  const job: SalesBrainJob = {
    id: `sbj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    callId,
    orgId,
    status: 'queued',
    attempts: 0,
    agentPersona: opts.agentPersona,
    aim: opts.aim ?? null,
    createdAt: now,
    updatedAt: now,
  };
  store.jobs.push(job);
  // Cap jobs list
  if (store.jobs.length > 500) store.jobs = store.jobs.slice(-400);
  syncSalesBrainStore(store);
  // #region agent log
  void import('../debug-session-log').then(({ debugLog }) => {
    debugLog('SB', 'sales-brain/enqueue.ts', 'job queued', {
      callId,
      jobId: job.id,
      persona: opts.agentPersona || null,
    });
  }).catch(() => {});
  // #endregion
  return { queued: true, jobId: job.id };
}
