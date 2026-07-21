import {
  getSalesBrainStore,
  syncSalesBrainStore,
  type SalesBrainRecommendation,
} from './store';

const MIN_SAMPLES = Number(process.env.SALES_BRAIN_REC_MIN_SAMPLES ?? 8);

/** Emit pending recommendations when enough insights share an objection. */
export function maybeEmitRecommendations(orgId: string): void {
  const store = getSalesBrainStore();
  const insights = store.insights.filter((i) => i.orgId === orgId);
  if (insights.length < MIN_SAMPLES) return;

  const counts = new Map<string, number>();
  for (const i of insights) {
    for (const o of i.objections || []) {
      counts.set(o, (counts.get(o) || 0) + 1);
    }
  }

  for (const [code, n] of counts) {
    if (n < Math.min(MIN_SAMPLES, 5)) continue;
    const exists = store.recommendations.some(
      (r) => r.orgId === orgId && r.status === 'pending' && r.type === `objection:${code}`,
    );
    if (exists) continue;
    const now = new Date().toISOString();
    const rec: SalesBrainRecommendation = {
      id: `sbr-${Date.now()}-${code}`,
      orgId,
      type: `objection:${code}`,
      proposedText:
        `When prospects hit "${code}", acknowledge first, explore the real concern, give one evidence line, then ask for the install meeting.`,
      evidenceSummary: `Associated with ${n} scored calls mentioning this objection (not proven causation).`,
      sampleSize: n,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    store.recommendations.push(rec);
  }
  if (store.recommendations.length > 200) {
    store.recommendations = store.recommendations.slice(-150);
  }
  syncSalesBrainStore(store);
}
