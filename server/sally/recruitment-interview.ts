/**
 * Sally hiring interviews — isolated from restaurant Sales Brain / Trust Engine / CRM.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  enqueueOutboundCall,
  getDataStore,
  resolveCandidateByPhone,
  saveRecruitmentCandidate,
  saveRecruitmentInterview,
} from '../data-store';

export const RECRUITMENT_AIM = 'recruitment_interview';
export const RECRUITMENT_TEMPLATE = 'recruitment_interview';
export const RECRUITMENT_SOURCE = 'recruitment_interview';

const HIRE_MARK = 'recruitment_interview';

export type HireRecommendation = 'hire' | 'maybe' | 'no';

export type HireScoreParts = {
  hunger: number;
  salesProof: number;
  restaurantFit: number;
  outboundComfort: number;
  cvHonesty: number;
};

export type HireScorecard = HireScoreParts & {
  overall: number;
  recommendation: HireRecommendation;
  notes: string;
  rightToWork?: string;
  notice?: string;
  salaryExpectation?: string;
  travelOk?: string;
  callId?: string;
  candidateId?: string;
};

export type PersistHireScorecardInput = Omit<HireScorecard, 'overall'> & {
  overall?: number;
  phone?: string;
  name?: string;
};

export const SCORE_INTERVIEW_TOOL = {
  type: 'function' as const,
  function: {
    name: 'scoreInterview',
    description:
      'Save the hire scorecard for this Indeed sales interview. Call once you have enough signal, before ending. Never use captureLead, bookIntegrationMeeting, or restaurant CRM tools on this call.',
    parameters: {
      type: 'object',
      properties: {
        hunger: { type: 'number', description: 'Hunger / coachability 1–5' },
        salesProof: { type: 'number', description: 'Live sales proof (numbers, targets, closes) 1–5' },
        restaurantFit: { type: 'number', description: 'Comfort with restaurant owners / hospitality 1–5' },
        outboundComfort: { type: 'number', description: 'Outbound / phone / field comfort 1–5' },
        cvHonesty: { type: 'number', description: 'Clarity / honesty vs the CV 1–5' },
        overall: { type: 'number', description: 'Optional overall 1–5; computed if omitted' },
        recommendation: { type: 'string', enum: ['hire', 'maybe', 'no'] },
        notes: { type: 'string' },
        rightToWork: { type: 'string' },
        notice: { type: 'string' },
        salaryExpectation: { type: 'string' },
        travelOk: { type: 'string', description: 'Woking/Surrey and London travel' },
        candidateId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['hunger', 'salesProof', 'restaurantFit', 'outboundComfort', 'cvHonesty', 'recommendation', 'notes'],
    },
  },
};

function haystackContainsHireMark(...values: unknown[]): boolean {
  return values
    .map((v) => String(v || '').toLowerCase())
    .join(' ')
    .includes(HIRE_MARK);
}

export function isSallyRecruitmentCall(
  meta?: Record<string, unknown> | null,
  opts?: { campaignTemplate?: string; agentPersona?: string },
): boolean {
  const m = meta || {};
  if (
    haystackContainsHireMark(
      m.aim,
      m.template,
      m.campaignTemplate,
      opts?.campaignTemplate,
      m.source,
      m.brief,
    )
  ) {
    return true;
  }
  const aim = String(m.aim || '').toLowerCase();
  if (m.candidateId != null && String(m.candidateId).trim() && aim === 'recruitment') {
    return true;
  }
  return false;
}

export function isSallyPersona(
  meta?: Record<string, unknown> | null,
  opts?: { campaignTemplate?: string; agentPersona?: string },
): boolean {
  const persona = String(opts?.agentPersona || meta?.agentPersona || '').toLowerCase();
  return persona === 'sally';
}

function clampScore(value: unknown, fallback = 3): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export function computeOverallScore(parts: HireScoreParts): number {
  const hunger = clampScore(parts.hunger);
  const salesProof = clampScore(parts.salesProof);
  const restaurantFit = clampScore(parts.restaurantFit);
  const outboundComfort = clampScore(parts.outboundComfort);
  const cvHonesty = clampScore(parts.cvHonesty);
  const overall =
    hunger * 0.2
    + salesProof * 0.3
    + restaurantFit * 0.2
    + outboundComfort * 0.2
    + cvHonesty * 0.1;
  return Math.round(overall * 10) / 10;
}

export function recommendationFromOverall(overall: number): HireRecommendation {
  if (overall >= 3.8) return 'hire';
  if (overall >= 2.6) return 'maybe';
  return 'no';
}

export function flattenCallTranscript(transcript: unknown): string {
  if (typeof transcript === 'string') return transcript;
  if (!Array.isArray(transcript)) return '';
  return transcript
    .map((turn) => {
      const row = turn && typeof turn === 'object' ? (turn as Record<string, unknown>) : {};
      const role = String(row.role || '').trim();
      const content = String(row.content || row.message || '').trim();
      if (!content) return '';
      return role ? `${role}: ${content}` : content;
    })
    .filter(Boolean)
    .join('\n');
}

function countHits(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n += 1;
  }
  return n;
}

function scoreFromHits(hits: number, max = 4): number {
  return clampScore(1 + Math.min(max, hits));
}

export function heuristicHireScoreFromTranscript(text: string): HireScorecard {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const hunger = scoreFromHits(countHits(t, [
    /\bhungry\b/,
    /\bcoachable\b/,
    /\blearn\b/,
    /\bwilling\b/,
    /\bwant this\b/,
    /\bkeen\b/,
    /\bgraft\b/,
  ]));
  const salesProof = scoreFromHits(countHits(t, [
    /\bclos(e|ed|ing)\b/,
    /\btarget\b/,
    /\bquota\b/,
    /\bcommission\b/,
    /\bpipeline\b/,
    /\brevenue\b/,
    /\bpound|\bgbp|£|\bkpi\b/,
  ]), 5);
  const restaurantFit = scoreFromHits(countHits(t, [
    /\brestaurant\b/,
    /\btakeaway\b/,
    /\bhospitality\b/,
    /\bowner\b/,
    /\bchef\b/,
    /\bpub\b/,
    /\bhospitality\b/,
  ]));
  const outboundComfort = scoreFromHits(countHits(t, [
    /\bcold call/,
    /\bdoor.?to.?door\b/,
    /\bfield\b/,
    /\bwalk.?in\b/,
    /\boutbound\b/,
    /\bphone sales\b/,
  ]));
  const dishonest = /\bexaggerat|\binflat|\blie\b|\bmade up\b|\bcv (was|is) (off|wrong)/.test(t);
  const honest = /\bhonest\b|\bto be fair\b|\bi don'?t have\b|\bno experience\b/.test(t);
  const cvHonesty = dishonest ? 2 : honest ? 4 : t.length > 400 ? 3 : 2;
  const overall = computeOverallScore({
    hunger,
    salesProof,
    restaurantFit,
    outboundComfort,
    cvHonesty,
  });
  const notInterested = /\bnot interested\b|\bdon'?t want (the )?role\b|\bno longer looking\b/.test(t);
  return {
    hunger,
    salesProof,
    restaurantFit,
    outboundComfort,
    cvHonesty,
    overall,
    recommendation: notInterested ? 'no' : recommendationFromOverall(overall),
    notes: raw.slice(0, 900) || 'Heuristic score from transcript (Sally did not call scoreInterview).',
  };
}

export function lookupRecruitmentCandidateByPhone(phone: string): {
  candidateId: string | null;
  candidateName: string;
  desiredRole: string;
  brief?: string;
  cvSummary?: string;
  email?: string;
} {
  const hit = resolveCandidateByPhone(phone);
  if (!hit.candidateId) return hit;
  const store = getDataStore();
  const cand = store.recruitmentCandidates.find((c) => String(c.id) === hit.candidateId);
  if (!cand) return hit;
  const brief = cand.brief != null ? String(cand.brief) : undefined;
  const cvSummary = cand.cvSummary != null ? String(cand.cvSummary) : brief;
  return {
    ...hit,
    brief,
    cvSummary,
    email: cand.email != null ? String(cand.email) : undefined,
  };
}

export function applyInboundCandidateRecruitmentMeta(
  partyPhone: string,
  callMeta: Record<string, unknown>,
): {
  meta: Record<string, unknown>;
  contactName?: string;
  candidateId?: string;
} {
  const hit = lookupRecruitmentCandidateByPhone(partyPhone);
  if (!hit.candidateId) return { meta: callMeta };
  const contactName = hit.candidateName && hit.candidateName !== 'Guest'
    ? hit.candidateName
    : undefined;
  return {
    meta: {
      ...callMeta,
      aim: RECRUITMENT_AIM,
      source: RECRUITMENT_SOURCE,
      campaignTemplate: RECRUITMENT_TEMPLATE,
      candidateId: hit.candidateId,
      contactName: contactName || callMeta.contactName,
      brief: hit.cvSummary || hit.brief || callMeta.brief,
      cvSummary: hit.cvSummary || hit.brief || callMeta.cvSummary,
    },
    contactName,
    candidateId: hit.candidateId,
  };
}

export function candidateHasHireScoreForCall(callId: string, candidateId?: string | null): boolean {
  if (!callId) return false;
  const store = getDataStore();
  if (store.recruitmentInterviews.some((row) => String(row.callId || '') === callId && row.hireScorecard)) {
    return true;
  }
  if (!candidateId) return false;
  const cand = store.recruitmentCandidates.find((c) => String(c.id) === String(candidateId));
  if (!cand) return false;
  return String(cand.lastInterviewCallId || '') === callId && cand.hireScore != null;
}

export function persistHireScorecard(input: PersistHireScorecardInput): {
  candidate: Record<string, unknown>;
  interview: Record<string, unknown>;
} {
  const parts: HireScoreParts = {
    hunger: clampScore(input.hunger),
    salesProof: clampScore(input.salesProof),
    restaurantFit: clampScore(input.restaurantFit),
    outboundComfort: clampScore(input.outboundComfort),
    cvHonesty: clampScore(input.cvHonesty),
  };
  const overall = Number.isFinite(Number(input.overall))
    ? Math.round(Number(input.overall) * 10) / 10
    : computeOverallScore(parts);
  const notes = String(input.notes || '').slice(0, 2000);
  const notInterested = /\bnot interested\b|\bdon'?t want (the )?role\b|\bno longer looking\b/i.test(notes);
  const recommendation: HireRecommendation = notInterested
    ? 'no'
    : (['hire', 'maybe', 'no'].includes(String(input.recommendation || ''))
      ? (input.recommendation as HireRecommendation)
      : recommendationFromOverall(overall));
  const card: HireScorecard = {
    ...parts,
    overall,
    recommendation,
    notes,
    rightToWork: input.rightToWork != null ? String(input.rightToWork) : undefined,
    notice: input.notice != null ? String(input.notice) : undefined,
    salaryExpectation: input.salaryExpectation != null ? String(input.salaryExpectation) : undefined,
    travelOk: input.travelOk != null ? String(input.travelOk) : undefined,
    callId: input.callId,
    candidateId: input.candidateId,
  };

  const phone = String(input.phone || '').trim();
  const byPhone = phone ? lookupRecruitmentCandidateByPhone(phone) : { candidateId: null as string | null, candidateName: 'Guest', desiredRole: '' };
  const candidateId = String(input.candidateId || byPhone.candidateId || '').trim()
    || `CAND${Date.now()}`;
  const existing = getDataStore().recruitmentCandidates.find((c) => String(c.id) === candidateId);
  const status = recommendation === 'hire'
    ? 'offer'
    : recommendation === 'no'
      ? 'rejected'
      : 'interviewed';

  const candidate = saveRecruitmentCandidate({
    ...(existing || {}),
    id: candidateId,
    name: String(input.name || existing?.name || byPhone.candidateName || 'Candidate').trim(),
    phone: phone || existing?.phone,
    email: existing?.email,
    desiredRole: existing?.desiredRole || 'Restaurant sales (Sync2Dine)',
    source: existing?.source || RECRUITMENT_SOURCE,
    hireScore: overall,
    hireRecommendation: recommendation,
    lastInterviewCallId: input.callId,
    hireScorecard: card,
    hireDoNotCall: notInterested || recommendation === 'no' ? true : existing?.hireDoNotCall,
    status,
  });

  const interview = saveRecruitmentInterview({
    candidateId,
    candidateName: candidate.name,
    interviewers: ['Sally'],
    status: 'completed',
    rating: overall,
    feedback: notes,
    callId: input.callId,
    type: 'phone',
    hireScorecard: card,
    recommendation,
  });

  return { candidate, interview };
}

export function buildRecruitmentInterviewPrompt(input: {
  contactName?: string;
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  outboundBrief?: string;
  cvSummary?: string;
}): string {
  const contact = String(input.contactName || '').trim();
  const safeName = contact && !/^(guest|unknown|unknown caller)$/i.test(contact) ? contact : '';
  const cv = String(input.cvSummary || input.outboundBrief || '').trim();
  return [
    'You are Sally, Sync2Dine’s hiring interviewer on the phone.',
    'PRONUNCIATION: Say the company “sync Two dine”. Write Sync2Dine in tools.',
    'IDENTITY: You are Sally, an AI. Never introduce yourself as Cynthia, Judie, or Builder Diddies. Never pretend to be a human.',
    'THIS IS A JOB INTERVIEW, not a restaurant sales call.',
    cv.toLowerCase().includes('founder test')
      ? 'This is a recorded founder line test of hiring mode. Do not say they applied on Indeed. Confirm they can hear you, then run a short interview rehearsal.'
      : 'They applied on Indeed for a field sales role covering restaurants in Woking / Surrey AND London.',
    'This call is recorded. Tell them once if they have not already heard it.',
    'Speak natural UK English. One question at a time. Short turns. Listen more than you talk.',
    'JOB: Sales role in Sync2Dine’s AI business solution. They walk into restaurants in Woking, Surrey and London and sell Atmosphere (venue audio) and Judie (AI that takes orders on the phone). Lead with Atmosphere when the talk is room, music, spend or staff training — Judie when the talk is missed calls and orders.',
    'Do not invent pay, commission, or benefits. If they ask about money, take their salary expectation and say the package is confirmed later.',
    'Never pitch as if they are a restaurant buyer. Never ask for the manager or owner. Never transfer to a restaurant line.',
    'Never call captureLead, bookIntegrationMeeting, getOfferTerms, captureReferralAndQueue, researchRestaurant, rememberPerson, or any restaurant CRM / lead tool.',
    'If they are not interested in the job, thank them, call scoreInterview with recommendation no, then endCall.',
    'INTERVIEW FLOW (one question at a time, then wait):',
    '1) Confirm identity and that they applied on Indeed.',
    '2) What they sell today and to whom.',
    '3) A real close or target story (numbers if they have them — do not invent).',
    '4) Comfort walking into restaurants and speaking to owners.',
    '5) Why this role versus their current job.',
    '6) Right to work, notice, start date, salary expectation, travel (Surrey + London).',
    '7) Then a 30-second live pitch: they sell Atmosphere + Judie to YOU as if you own a busy takeaway. You are the owner in that exercise only — they are still the candidate.',
    'After the pitch (or if they clearly will not continue), you MUST call scoreInterview with hunger, salesProof, restaurantFit, outboundComfort, cvHonesty (1–5 each), recommendation hire|maybe|no, and notes.',
    'Then thank them and endCall.',
    safeName ? `Candidate name: ${safeName}.` : '- Name unknown — confirm who you are speaking to.',
    `Their number: ${input.partyPhone}`,
    input.direction === 'inbound'
      ? '- Inbound callback — they rang you back about the sales role. Continue the interview; do not start a restaurant pitch.'
      : '- Outbound — they applied on Indeed. Ask if they have ten minutes.',
    cv ? `CV / brief for this person (facts only, probe gaps, do not read it aloud as a list): ${cv.slice(0, 900)}` : '',
  ].filter(Boolean).join('\n');
}

function spokenFirstName(firstName?: string): string {
  const name = String(firstName || '').trim();
  if (!name || /^(guest|unknown|unknown caller|love)$/i.test(name)) return 'love';
  return name.split(/\s+/)[0];
}

export function recruitmentFirstMessage(opts: {
  firstName?: string;
  direction: 'inbound' | 'outbound';
  founderTest?: boolean;
}): string {
  const name = spokenFirstName(opts.firstName);
  if (opts.direction === 'inbound') {
    return `Alright ${name}, Sally from sync Two dine — thanks for ringing back about the sales role. This call is recorded. Ready to continue?`;
  }
  if (opts.founderTest) {
    return `Alright ${name}, it's Sally from sync Two dine. This is a recorded hiring-mode test for the AI sales role — Atmosphere and Judie. Can you hear me?`;
  }
  return `Alright ${name}, it's Sally from sync Two dine — you applied on Indeed for a restaurant sales role. Have you got ten minutes? This call is recorded.`;
}

export function recruitmentVoicemailMessage(): string {
  return "Hi, it's Sally from sync Two dine. I'm ringing about the restaurant sales role you applied for on Indeed. Call this number back when you can and I'll finish the interview. Thanks.";
}

export type IndeedSalesCandidateSeed = {
  name: string;
  phone: string;
  email?: string;
  location?: string;
  source: 'indeed';
  brief: string;
  desiredRole: 'Restaurant sales (Sync2Dine)';
};

export function loadIndeedSalesCandidateSeed(): IndeedSalesCandidateSeed[] {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'indeed-sales-candidates.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as IndeedSalesCandidateSeed[];
  return Array.isArray(raw) ? raw : [];
}

export function seedIndeedSalesCandidates(): {
  upserted: number;
  candidates: Array<Record<string, unknown>>;
} {
  const rows = loadIndeedSalesCandidateSeed();
  const saved: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const phone = String(row.phone || '').trim();
    if (!phone) continue;
    const existing = lookupRecruitmentCandidateByPhone(phone);
    const id = existing.candidateId || `indeed-${String(row.name || 'candidate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    saved.push(saveRecruitmentCandidate({
      id,
      name: row.name,
      phone,
      email: row.email || '',
      location: row.location || '',
      source: 'indeed',
      brief: row.brief,
      cvSummary: row.brief,
      desiredRole: row.desiredRole || 'Restaurant sales (Sync2Dine)',
      status: existing.candidateId
        ? (getDataStore().recruitmentCandidates.find((c) => String(c.id) === existing.candidateId)?.status || 'applied')
        : 'applied',
      messages: existing.candidateId
        ? (getDataStore().recruitmentCandidates.find((c) => String(c.id) === existing.candidateId)?.messages)
        : undefined,
    }));
  }
  return { upserted: saved.length, candidates: saved };
}

export function queueRecruitmentInterviews(): {
  queued: number;
  skipped: number;
  jobs: Array<Record<string, unknown>>;
} {
  const { candidates } = seedIndeedSalesCandidates();
  const store = getDataStore();
  const already = new Set(
    (store.outboundQueue || [])
      .filter((job) => {
        const ctx = (job.context && typeof job.context === 'object')
          ? (job.context as Record<string, unknown>)
          : {};
        const status = String(job.status || '');
        return (
          String(job.template || ctx.campaignTemplate || '') === RECRUITMENT_TEMPLATE
          && (status === 'queued' || status === 'dialling' || status === 'dialing')
        );
      })
      .map((job) => String(job.to || '')),
  );
  const jobs: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const cand of candidates) {
    const phone = String(cand.phone || '').trim();
    if (!phone) {
      skipped += 1;
      continue;
    }
    if (already.has(phone)) {
      skipped += 1;
      continue;
    }
    const name = String(cand.name || 'Candidate');
    const brief = String(cand.brief || cand.cvSummary || '').slice(0, 900);
    const job = enqueueOutboundCall({
      to: phone,
      template: RECRUITMENT_TEMPLATE,
      status: 'queued',
      context: {
        name,
        aim: RECRUITMENT_AIM,
        agentPersona: 'sally',
        source: RECRUITMENT_SOURCE,
        campaignTemplate: RECRUITMENT_TEMPLATE,
        venueAware: false,
        candidateId: cand.id,
        brief,
        cvSummary: brief,
      },
    });
    jobs.push(job);
    already.add(phone);
  }
  return { queued: jobs.length, skipped, jobs };
}
