import { createIngestJob, listIngestJobs } from './store';
import { runSallyKnowledgeIngest } from './ingest';

const POLL_MS = Number(process.env.SALLY_KB_POLL_MS ?? 25000);
let busy = false;

export function startSallyKnowledgeWorker(): void {
  if (process.env.DISABLE_SALLY_KB_WORKER === '1') return;
  setInterval(() => {
    void tick().catch((err) => {
      console.error('[sally-kb] worker error:', err);
    });
  }, POLL_MS);
  console.log('[sally-kb] worker started');
}

async function tick(): Promise<void> {
  if (busy) return;
  const jobs = await listIngestJobs(5);
  const queued = jobs.find((j) => j.status === 'queued');
  if (!queued) return;
  busy = true;
  try {
    await runSallyKnowledgeIngest(String(queued.id));
  } finally {
    busy = false;
  }
}

/** Enqueue ingest and optionally run immediately. */
export async function enqueueSallyKnowledgeIngest(opts?: {
  runNow?: boolean;
}): Promise<{ jobId: string }> {
  const jobId = await createIngestJob();
  if (opts?.runNow !== false) {
    void runSallyKnowledgeIngest(jobId).catch(() => {});
  }
  return { jobId };
}
