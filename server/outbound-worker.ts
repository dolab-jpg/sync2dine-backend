import { getDataStore, updateOutboundJob } from './data-store';

const POLL_MS = Number(process.env.OUTBOUND_POLL_MS ?? 15000);

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
  const store = getDataStore();
  const queue = (store.outboundQueue ?? []).filter(
    (j) => String(j.status ?? '') === 'queued'
  );
  if (!queue.length) return;

  for (const job of queue.slice(0, 3)) {
    const id = String(job.id ?? '');
    updateOutboundJob(id, { status: 'dialling', startedAt: new Date().toISOString() });
    try {
      const base = (process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, '');
      const res = await fetch(`${base}/api/phone/outbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: job.to,
          template: job.template,
          context: job.context,
        }),
      });
      if (res.ok) {
        updateOutboundJob(id, { status: 'completed', completedAt: new Date().toISOString() });
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
