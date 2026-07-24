/**
 * Trust Engine — highest-level Sally objective.
 * Live: slim silent principle only. Learning: after-call scores ? next-dial inject.
 */

export type TrustDelta = 'up' | 'down' | 'flat';
export type LikelihoodBand = 'low' | 'medium' | 'high';

export type TrustEngineScores = {
  trustDelta: TrustDelta;
  credibility: number; // 0–5
  confidence: number;
  perceivedExpertise: number;
  relationshipStrength: number;
  brandPerception: number;
  answerFutureLikelihood: LikelihoodBand;
  referralLikelihood: LikelihoodBand;
  longTermGoodwill: LikelihoodBand;
};

export const TRUST_ENGINE_LIVE_PRINCIPLE = [
  'TRUST ENGINE (highest objective — silent; never monologue this):',
  'Before each material move (price, push close, humour, re-ask phone/postcode, upsell): will this increase or decrease trust?',
  'Prefer leave_goodwill / educate / callback over a forced meeting if trust would drop.',
  'Never invent facts, never re-read IDs already on file, never sound desperate.',
  'Admit uncertainty briefly when you do not know — then use a tool or book a human follow-up.',
].join('\n');

export function emptyTrustScores(): TrustEngineScores {
  return {
    trustDelta: 'flat',
    credibility: 3,
    confidence: 3,
    perceivedExpertise: 3,
    relationshipStrength: 3,
    brandPerception: 3,
    answerFutureLikelihood: 'medium',
    referralLikelihood: 'low',
    longTermGoodwill: 'medium',
  };
}

/** Fast heuristic from transcript / outcome — always available without LLM. */
export function heuristicTrustScores(opts: {
  transcriptLower: string;
  rapportScore?: number;
  outcome?: string;
  objections?: string[];
}): TrustEngineScores {
  const t = opts.transcriptLower;
  const base = emptyTrustScores();
  const rapport = typeof opts.rapportScore === 'number' ? opts.rapportScore : 3;
  const objN = (opts.objections || []).length;
  const dnc = /do not call|remove|stop calling|not interested/.test(t) || opts.outcome === 'dnc';
  const angry = /rude|annoyed|pissed|waste of time|scam|lie/.test(t);
  const warm = /cheers|lovely|thanks|sorted|appreciate|fair enough|makes sense/.test(t);
  const meeting = opts.outcome === 'meeting_booked' || /booked|meeting|install/.test(t);

  let delta: TrustDelta = 'flat';
  if (dnc || angry) delta = 'down';
  else if (warm || meeting || rapport >= 4) delta = 'up';

  const clamp = (n: number) => Math.max(0, Math.min(5, Math.round(n)));
  const band = (n: number): LikelihoodBand => (n >= 4 ? 'high' : n <= 2 ? 'low' : 'medium');

  const credibility = clamp(rapport - (angry ? 2 : 0) - (objN > 2 ? 1 : 0) + (warm ? 1 : 0));
  const expertise = clamp(3 + (/judie|atmosphere|minutes|orders/.test(t) ? 1 : 0) - (angry ? 1 : 0));
  const strength = clamp((rapport + credibility) / 2 + (meeting ? 1 : 0) - (dnc ? 2 : 0));
  const brand = clamp(3 + (warm ? 1 : 0) - (angry || dnc ? 2 : 0));
  const answerN = clamp(strength + (delta === 'up' ? 1 : delta === 'down' ? -2 : 0));
  const referralN = clamp(strength - 1 + (meeting ? 1 : 0) - (dnc ? 3 : 0));
  const goodwillN = clamp(brand + (delta === 'up' ? 1 : 0) - (delta === 'down' ? 2 : 0));

  return {
    trustDelta: delta,
    credibility,
    confidence: clamp(rapport),
    perceivedExpertise: expertise,
    relationshipStrength: strength,
    brandPerception: brand,
    answerFutureLikelihood: band(answerN),
    referralLikelihood: band(referralN),
    longTermGoodwill: band(goodwillN),
  };
}

/** Compact next-dial inject (facts only — no dialogue scripts). */
export function formatTrustPromptBlock(scores: TrustEngineScores | null | undefined): string {
  if (!scores) return '';
  return [
    'TRUST ENGINE (prior call — use naturally; do not recite scores):',
    `trust=${scores.trustDelta}; referral=${scores.referralLikelihood}; answer_again=${scores.answerFutureLikelihood}; goodwill=${scores.longTermGoodwill}`,
    `credibility=${scores.credibility}/5; expertise=${scores.perceivedExpertise}/5; relationship=${scores.relationshipStrength}/5; brand=${scores.brandPerception}/5`,
    scores.trustDelta === 'down'
      ? 'Prior trust dropped — lead with listening, no pushy close, prefer leave_goodwill or callback.'
      : scores.trustDelta === 'up'
        ? 'Prior trust up — you may progress toward meeting if fit is clear.'
        : 'Prior trust flat — earn the next step; do not force.',
  ].join('\n');
}

export function parseTrustFromCustomer(customer: Record<string, unknown> | null | undefined): TrustEngineScores | null {
  const raw = customer?.sallyTrust;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const delta = String(o.trustDelta || 'flat');
  const band = (v: unknown): LikelihoodBand => {
    const s = String(v || 'medium').toLowerCase();
    if (s === 'high' || s === 'low') return s;
    return 'medium';
  };
  return {
    trustDelta: delta === 'up' || delta === 'down' ? delta : 'flat',
    credibility: Number(o.credibility) || 3,
    confidence: Number(o.confidence) || 3,
    perceivedExpertise: Number(o.perceivedExpertise) || 3,
    relationshipStrength: Number(o.relationshipStrength) || 3,
    brandPerception: Number(o.brandPerception) || 3,
    answerFutureLikelihood: band(o.answerFutureLikelihood),
    referralLikelihood: band(o.referralLikelihood),
    longTermGoodwill: band(o.longTermGoodwill),
  };
}
