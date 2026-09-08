/**
 * Sally hiring interviews — isolated from restaurant Sales Brain / Trust Engine / CRM.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  enqueueOutboundCall,
  getAgentSettings,
  getDataStore,
  resolveCandidateByPhone,
  saveRecruitmentCandidate,
  saveRecruitmentInterview,
  updateAgentSettings,
} from '../data-store';

export const RECRUITMENT_AIM = 'recruitment_interview';
export const RECRUITMENT_TEMPLATE = 'recruitment_interview';
export const RECRUITMENT_SOURCE = 'recruitment_interview';

const HIRE_MARK = 'recruitment_interview';

/** Follow-up dial whose only job is booking the in-person interview. */
export const ARRANGE_INTERVIEW_AIM = 'arrange_face_to_face';

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
      'Save the hire scorecard for this sales interview. Call once you have enough signal, before ending. Set needsInterviewCall when you are recommending hire but could not pin a face-to-face slot on this call — Sally will ring them back to book it. Never use captureLead, bookIntegrationMeeting, or restaurant CRM tools on this call.',
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
        needsInterviewCall: {
          type: 'boolean',
          description: 'True when recommending hire but no in-person slot was agreed on this call',
        },
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

/** Sally's second call to a candidate she already recommended: book the face-to-face, do not re-interview. */
export function isArrangeInterviewCall(meta?: Record<string, unknown> | null): boolean {
  const m = meta || {};
  if (m.arrangeInterview === true) return true;
  return String(m.aim || m.purpose || '').toLowerCase() === ARRANGE_INTERVIEW_AIM;
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

/** Is there already an in-person interview on the books for this candidate? */
export function hasScheduledFaceToFace(candidateId: string): boolean {
  if (!candidateId) return false;
  return getDataStore().recruitmentInterviews.some((row) => (
    String(row.candidateId || '') === String(candidateId)
    && String(row.type || '') === 'in-person'
    && String(row.status || '') === 'scheduled'
  ));
}

/**
 * Sally rings a recommended candidate back purely to book the Woking face-to-face.
 * No-ops when a visit is already booked or an arrange call is already queued.
 */
export function queueFaceToFaceArrangement(opts: {
  candidateId?: string;
  phone: string;
  name?: string;
  cvSummary?: string;
}): { queued: boolean; reason?: string; job?: Record<string, unknown> } {
  const phone = String(opts.phone || '').trim();
  if (!phone) return { queued: false, reason: 'no_phone' };
  const candidateId = String(opts.candidateId || '').trim();
  if (candidateId && hasScheduledFaceToFace(candidateId)) {
    return { queued: false, reason: 'already_booked' };
  }
  const store = getDataStore();
  const pending = (store.outboundQueue || []).some((job) => {
    const ctx = (job.context && typeof job.context === 'object')
      ? (job.context as Record<string, unknown>)
      : {};
    const status = String(job.status || '');
    return (
      String(job.to || '') === phone
      && isArrangeInterviewCall(ctx)
      && (status === 'queued' || status === 'dialling' || status === 'dialing')
    );
  });
  if (pending) return { queued: false, reason: 'already_queued' };

  const job = enqueueOutboundCall({
    to: phone,
    template: RECRUITMENT_TEMPLATE,
    status: 'queued',
    context: {
      name: opts.name || 'Candidate',
      aim: ARRANGE_INTERVIEW_AIM,
      agentPersona: 'sally',
      source: RECRUITMENT_SOURCE,
      campaignTemplate: RECRUITMENT_TEMPLATE,
      venueAware: false,
      arrangeInterview: true,
      candidateId: candidateId || undefined,
      cvSummary: opts.cvSummary ? String(opts.cvSummary).slice(0, 900) : undefined,
    },
  });
  return { queued: true, job };
}

export function persistHireScorecard(input: PersistHireScorecardInput): {
  candidate: Record<string, unknown>;
  interview: Record<string, unknown>;
  faceToFace: { booked: boolean; arrangeCallQueued: boolean };
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
  let recommendation: HireRecommendation = notInterested
    ? 'no'
    : (['hire', 'maybe', 'no'].includes(String(input.recommendation || ''))
      ? (input.recommendation as HireRecommendation)
      : recommendationFromOverall(overall));
  // Hard gate: this job is walking into venues cold. Not comfortable going out = not a hire.
  if (recommendation === 'hire' && parts.outboundComfort < 4) {
    recommendation = 'maybe';
  }
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

  // Hires get a face-to-face with the founder. Sally arranges it herself — no senior callback.
  const booked = hasScheduledFaceToFace(candidateId);
  let arrangeCallQueued = false;
  if (recommendation === 'hire' && !booked) {
    const dialPhone = phone || String(existing?.phone || '').trim();
    arrangeCallQueued = queueFaceToFaceArrangement({
      candidateId,
      phone: dialPhone,
      name: String(candidate.name || ''),
      cvSummary: existing?.cvSummary != null ? String(existing.cvSummary) : undefined,
    }).queued;
  }
  if (recommendation === 'hire') {
    saveRecruitmentCandidate({
      id: candidateId,
      faceToFaceBooked: booked,
      faceToFaceArrangeQueued: arrangeCallQueued,
    });
  }

  return { candidate, interview, faceToFace: { booked, arrangeCallQueued } };
}

/** Spoken fallback until the founder gives Sally the exact address on the owner line. */
export const HIRING_INTERVIEW_LOCATION_DEFAULT = 'our Woking office';

export type HiringDirective = {
  instruction: string;
  interviewLocation: string;
  updatedAt?: string;
  updatedBy?: string;
};

/** Founder's standing hiring instruction + face-to-face location (set by voice on the owner line). */
export function getHiringDirective(): HiringDirective {
  const settings = getAgentSettings();
  const location = String(settings.hiringInterviewLocation || '').trim();
  return {
    instruction: String(settings.hiringInstruction || '').trim(),
    interviewLocation: location || HIRING_INTERVIEW_LOCATION_DEFAULT,
    updatedAt: settings.hiringDirectiveUpdatedAt,
    updatedBy: settings.hiringDirectiveUpdatedBy,
  };
}

export function setHiringDirective(patch: {
  instruction?: string;
  interviewLocation?: string;
  updatedBy?: string;
  clearInstruction?: boolean;
}): HiringDirective {
  const next: Record<string, unknown> = {
    hiringDirectiveUpdatedAt: new Date().toISOString(),
  };
  if (patch.clearInstruction) {
    next.hiringInstruction = '';
  } else if (patch.instruction != null && String(patch.instruction).trim()) {
    next.hiringInstruction = String(patch.instruction).trim().slice(0, 1200);
  }
  if (patch.interviewLocation != null && String(patch.interviewLocation).trim()) {
    next.hiringInterviewLocation = String(patch.interviewLocation).trim().slice(0, 200);
  }
  if (patch.updatedBy != null && String(patch.updatedBy).trim()) {
    next.hiringDirectiveUpdatedBy = String(patch.updatedBy).trim().slice(0, 120);
  }
  updateAgentSettings(next as Parameters<typeof updateAgentSettings>[0]);
  return getHiringDirective();
}

/** The founder's mobile — this line is owner ops on Sally, never a candidate interview. */
export function hiringOwnerPhone(): string {
  return String(process.env.HIRING_OWNER_PHONE || '+447576442345').trim();
}

export function isHiringOwnerPhone(phone: string): boolean {
  const digits = (value: string) => String(value || '').replace(/\D/g, '').slice(-10);
  const target = digits(hiringOwnerPhone());
  const candidate = digits(phone);
  return target.length === 10 && candidate === target;
}

export function buildRecruitmentInterviewPrompt(input: {
  contactName?: string;
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  outboundBrief?: string;
  cvSummary?: string;
  /** Second call to a candidate Sally already screened and recommended — book the face-to-face. */
  arrangeInterviewOnly?: boolean;
}): string {
  const contact = String(input.contactName || '').trim();
  const safeName = contact && !/^(guest|unknown|unknown caller)$/i.test(contact) ? contact : '';
  const cv = String(input.cvSummary || input.outboundBrief || '').trim();
  const founderTest = cv.toLowerCase().includes('founder test');
  const directive = getHiringDirective();
  const where = directive.interviewLocation;

  const identityBlock = [
    'You are Sally, Sync2Dine’s hiring interviewer on the phone.',
    'PRONUNCIATION: Say the company “sync Two dine”. Write Sync2Dine in tools.',
    'IDENTITY: You are Sally, an AI. Never introduce yourself under any other assistant or company name, and never pretend to be a human.',
    'THIS IS A JOB INTERVIEW, not a restaurant sales call. Never ask for the manager or owner. Never pitch them as if they were a restaurant buyer. Never transfer to a restaurant line.',
    'This call is recorded. Tell them once if they have not already heard it.',
    'Speak natural UK English. One question at a time, then stop and let them answer. Short turns. Listen far more than you talk.',
    'Never call captureLead, bookIntegrationMeeting, getOfferTerms, captureReferralAndQueue, researchRestaurant, rememberPerson, or any restaurant CRM / lead tool.',
    'CONFIDENTIAL — KEEP PRODUCT DETAIL THIN. All you say about what we sell: our top product is Atmosphere, AI-generated audio atmosphere that lets a venue control the room and lift its takings. Nothing more. No pricing, no packages, no other products, no how it works, no client names, no internal process. Do not run a product pitch exercise on this call.',
    'If they press for more detail about the product or the company, tell them that is covered properly at the face-to-face, and move back to your questions.',
  ];

  const closingBlock = [
    'CLOSING:',
    '- Before you finish you MUST call scoreInterview: hunger, salesProof, restaurantFit, outboundComfort and cvHonesty each 1–5, recommendation hire | maybe | no, plus notes covering what you learned.',
    '- Only recommend hire if they are genuinely comfortable going out cold — that means outboundComfort 4 or 5. However good they sound otherwise, if they are not comfortable knocking on doors they are maybe or no.',
    `- When you are recommending hire: invite them in for a face-to-face at ${where} to meet the founder. If they can give you a day and a rough time on this call, call bookInterview with type in-person and that location. If they cannot, tell them you will ring them back to arrange it and set needsInterviewCall true on scoreInterview.`,
    '- YOU arrange that face-to-face yourself. Never tell anyone that a senior, a manager, or a colleague will call them back.',
    '- If they are not interested in the job, thank them, call scoreInterview with recommendation no, then endCall.',
    '- Never read your scores or numbers out loud.',
    '- Then thank them and endCall.',
  ];

  const contextBlock = [
    safeName ? `Candidate name: ${safeName}.` : 'Name unknown — confirm who you are speaking to.',
    `Their number: ${input.partyPhone}`,
    cv
      ? `CV / notes for this person (facts to work through and probe — never read it out as a list): ${cv.slice(0, 900)}`
      : 'No CV on file — get their history verbally instead.',
    directive.instruction
      ? `STANDING INSTRUCTION FROM THE FOUNDER (follow this over your defaults): ${directive.instruction}`
      : '',
  ];

  if (input.arrangeInterviewOnly) {
    return [
      ...identityBlock,
      'THIS CALL HAS ONE JOB: they already passed your phone screen and you are ringing back to book their face-to-face. Do not re-interview them.',
      `Get a day and a rough time they can come to ${where} to meet the founder, then call bookInterview with type in-person and that location. Confirm it back to them before you finish.`,
      'If they now sound unsure about the role or about going out to restaurants in person, say the visit is to talk it through properly, take what they say, and call scoreInterview again with your updated view.',
      'If they cannot commit to a day, agree roughly when you will try again, note it, and endCall politely.',
      ...contextBlock,
      'Then endCall.',
    ].filter(Boolean).join('\n');
  }

  return [
    ...identityBlock,
    founderTest
      ? 'This is a recorded founder-line test of hiring mode. Do not say they applied for anything. Confirm they can hear you, then run a short interview rehearsal.'
      : 'They applied for a field sales role covering restaurants in Woking, Surrey and London.',
    'YOU RUN THIS LIKE A PROFESSIONAL RECRUITER, not a script. You choose the order, you follow up on what they actually say, you challenge anything vague, and you keep hold of the call.',
    'THE JOB — be straight about it: field sales on the road. They go out to restaurants in person, get in front of owners, take the owner’s details, and then follow those leads up by phone from the office. New places they do not know, cold approach, then the office contact work afterwards.',
    'THE THING THAT DECIDES IT: are they genuinely comfortable walking into somewhere new and starting a conversation with a stranger. Do not accept a one-word yes — make them give you a real example of having done it.',
    'PAY: you may say plainly that it is highly rewarding, high earning, and rewards people who deliver. NEVER quote a salary, rate, band, commission percentage or any figure — you do not have those numbers, and the package is confirmed at the face-to-face. Ask what they are looking to earn and record their answer.',
    'COVER ALL OF THIS BEFORE YOU SCORE (conversationally, in whatever order fits — do not read it out as a list):',
    '- Who you are speaking to, and that they applied for the sales role.',
    '- Their CV role by role: what they sold, who they sold it to, targets and real numbers, why they left, and any gaps.',
    '- Any face-to-face, door-to-door, cold approach, outbound phone or hospitality experience.',
    '- Why this role rather than what they are doing now.',
    '- Right to work in the UK, notice period, and when they could start.',
    '- Travel: can they cover Woking and Surrey, and get into London.',
    '- What they want to earn.',
    'WRITE IT DOWN AS YOU GO like any decent recruiter would: call logCandidate or screenCandidate during the call with their experience, field comfort, right to work, notice, availability and contact details. Do not leave it all to the end.',
    ...closingBlock,
    ...contextBlock,
    input.direction === 'inbound'
      ? 'Inbound — they rang you back about the sales role. Pick the interview back up; do not start a restaurant pitch.'
      : 'Outbound — they applied for the role. Check they have ten minutes before you dig in.',
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
  arrangeInterviewOnly?: boolean;
}): string {
  const name = spokenFirstName(opts.firstName);
  if (opts.arrangeInterviewOnly) {
    return `Alright ${name}, it's Sally from sync Two dine — good news, we'd like you to come in and meet us about the sales role. This call is recorded. Have you got a minute to sort a day?`;
  }
  if (opts.direction === 'inbound') {
    return `Alright ${name}, Sally from sync Two dine — thanks for ringing back about the sales role. This call is recorded. Ready to continue?`;
  }
  if (opts.founderTest) {
    return `Alright ${name}, it's Sally from sync Two dine. This is a recorded hiring-mode test for the sales role. Can you hear me?`;
  }
  return `Alright ${name}, it's Sally from sync Two dine — you applied for our restaurant sales role. Have you got ten minutes? This call is recorded.`;
}

export function recruitmentVoicemailMessage(): string {
  return "Hi, it's Sally from sync Two dine. I'm ringing about the restaurant sales role you applied for. Call this number back when you can and I'll finish the interview. Thanks.";
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
