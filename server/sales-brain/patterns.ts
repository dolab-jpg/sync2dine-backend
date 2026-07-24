import {
  getSalesBrainStore,
  syncSalesBrainStore,
  newSalesBrainId,
  type SalesBrainRecommendation,
} from './store';

const MIN_SAMPLES = Number(process.env.SALES_BRAIN_REC_MIN_SAMPLES ?? 8);

function pushRec(
  store: ReturnType<typeof getSalesBrainStore>,
  orgId: string,
  type: string,
  proposedText: string,
  evidenceSummary: string,
  sampleSize: number,
): void {
  const exists = store.recommendations.some(
    (r) => r.orgId === orgId && r.status === 'pending' && r.type === type,
  );
  if (exists) return;
  const now = new Date().toISOString();
  const rec: SalesBrainRecommendation = {
    id: newSalesBrainId(),
    orgId,
    type,
    proposedText,
    evidenceSummary,
    sampleSize,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  store.recommendations.push(rec);
}

/** Emit pending recommendations from objections, competitors, and outcomes (Tier 2 pattern recognition). */
export function maybeEmitRecommendations(orgId: string): void {
  const store = getSalesBrainStore();
  const insights = store.insights.filter((i) => i.orgId === orgId);
  if (insights.length < Math.min(MIN_SAMPLES, 5)) return;

  const objectionCounts = new Map<string, number>();
  const competitorCounts = new Map<string, number>();
  const objectiveCounts = new Map<string, number>();
  let trustDown = 0;
  let trustUp = 0;

  for (const i of insights) {
    for (const o of i.objections || []) {
      objectionCounts.set(o, (objectionCounts.get(o) || 0) + 1);
    }
    for (const c of i.competitors || []) {
      const key = String(c).toLowerCase().slice(0, 40);
      if (!key) continue;
      competitorCounts.set(key, (competitorCounts.get(key) || 0) + 1);
    }
    if (i.callObjective) {
      objectiveCounts.set(i.callObjective, (objectiveCounts.get(i.callObjective) || 0) + 1);
    }
    if (i.trust?.trustDelta === 'down') trustDown += 1;
    if (i.trust?.trustDelta === 'up') trustUp += 1;
  }

  const threshold = Math.min(MIN_SAMPLES, 5);

  for (const [code, n] of objectionCounts) {
    if (n < threshold) continue;
    pushRec(
      store,
      orgId,
      `objection:${code}`,
      `When prospects hit "${code}", acknowledge first, explore the real concern, give one evidence line, then ask for the install meeting only if trust allows.`,
      `Associated with ${n} scored calls mentioning this objection (not proven causation).`,
      n,
    );
  }

  for (const [comp, n] of competitorCounts) {
    if (n < threshold) continue;
    pushRec(
      store,
      orgId,
      `competitor:${comp}`,
      `When "${comp}" comes up, differentiate honestly (e.g. Atmosphere ≠ Spotify; Judie takes full orders into the app). Never invent competitor prices.`,
      `Mentioned on ${n} scored calls.`,
      n,
    );
  }

  if (trustDown >= threshold && trustDown > trustUp) {
    pushRec(
      store,
      orgId,
      'trust:down_cluster',
      'Recent calls show trust dropping — lead with listening, avoid re-reading IDs, prefer leave_goodwill or callback over a forced meeting.',
      `${trustDown} calls scored trustDelta=down vs ${trustUp} up.`,
      trustDown,
    );
  }

  // Soft experimentation note: openings that correlate with meeting_booked (human approve still required)
  const meetingN = insights.filter((i) => i.outcome === 'meeting_booked').length;
  if (meetingN >= threshold) {
    pushRec(
      store,
      orgId,
      'experiment:meeting_openings',
      'Keep permission + curiosity opens that led to meetings; retire desperate hard-sell opens. A/B via approved snippets only.',
      `${meetingN} meeting_booked outcomes in recent insights.`,
      meetingN,
    );
  }

  if (store.recommendations.length > 200) {
    store.recommendations = store.recommendations.slice(-150);
  }
  syncSalesBrainStore(store);
}
