/**
 * Candidate message threads (Indeed / SMS / email / phone notes).
 * Stored on recruitmentCandidates.messages — not restaurant CRM activities.
 */
import {
  getDataStore,
  resolveCandidateByPhone,
  saveRecruitmentCandidate,
} from '../data-store';

export const RECRUITMENT_MESSAGE_CHANNELS = ['indeed', 'sms', 'email', 'phone'] as const;
export type RecruitmentMessageChannel = (typeof RECRUITMENT_MESSAGE_CHANNELS)[number];
export type RecruitmentMessageDirection = 'in' | 'out';

export type RecruitmentMessage = {
  id: string;
  candidateId: string;
  direction: RecruitmentMessageDirection;
  channel: RecruitmentMessageChannel;
  body: string;
  at: string;
  externalId?: string;
  fromLabel?: string;
};

const MAX_THREAD = 200;

function isChannel(raw: string): raw is RecruitmentMessageChannel {
  return (RECRUITMENT_MESSAGE_CHANNELS as readonly string[]).includes(raw);
}

function newId(): string {
  return `rmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseRecruitmentChannel(raw: unknown): RecruitmentMessageChannel {
  const s = String(raw || 'indeed').toLowerCase();
  return isChannel(s) ? s : 'indeed';
}

export function parseRecruitmentDirection(raw: unknown): RecruitmentMessageDirection {
  return String(raw || '').toLowerCase() === 'in' ? 'in' : 'out';
}

export function listRecruitmentSnapshot(): {
  jobs: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  interviews: Array<Record<string, unknown>>;
  applications: Array<Record<string, unknown>>;
  onboardingTasks: Array<Record<string, unknown>>;
} {
  const store = getDataStore();
  return {
    jobs: store.recruitmentJobs || [],
    candidates: store.recruitmentCandidates || [],
    interviews: store.recruitmentInterviews || [],
    applications: store.recruitmentApplications || [],
    onboardingTasks: store.recruitmentOnboardingTasks || [],
  };
}

export function listRecruitmentMessages(candidateId: string): RecruitmentMessage[] {
  const store = getDataStore();
  const cand = store.recruitmentCandidates.find((c) => String(c.id) === candidateId);
  const raw = Array.isArray(cand?.messages) ? cand!.messages : [];
  return raw.filter((m) => m && typeof m === 'object') as RecruitmentMessage[];
}

export function appendRecruitmentMessage(input: {
  candidateId?: string;
  phone?: string;
  name?: string;
  direction?: unknown;
  channel?: unknown;
  body: string;
  at?: string;
  externalId?: string;
  fromLabel?: string;
}): RecruitmentMessage {
  const body = String(input.body || '').trim();
  if (!body) throw new Error('message body is required');

  const store = getDataStore();
  let candidate: Record<string, unknown> | undefined;
  const idHint = String(input.candidateId || '').trim();
  if (idHint) {
    candidate = store.recruitmentCandidates.find((c) => String(c.id) === idHint);
  }
  if (!candidate && input.phone) {
    const hit = resolveCandidateByPhone(String(input.phone));
    if (hit.candidateId) {
      candidate = store.recruitmentCandidates.find((c) => String(c.id) === hit.candidateId);
    }
  }
  if (!candidate && input.name) {
    const needle = String(input.name).trim().toLowerCase();
    candidate = store.recruitmentCandidates.find(
      (c) => String(c.name || '').trim().toLowerCase() === needle,
    );
  }
  if (!candidate) throw new Error('candidate not found');

  const candidateId = String(candidate.id);
  const existing = listRecruitmentMessages(candidateId);
  const externalId = input.externalId ? String(input.externalId).slice(0, 160) : '';
  if (externalId) {
    const dup = existing.find((m) => m.externalId === externalId && m.body === body);
    if (dup) return dup;
  }

  const msg: RecruitmentMessage = {
    id: newId(),
    candidateId,
    direction: parseRecruitmentDirection(input.direction),
    channel: parseRecruitmentChannel(input.channel),
    body: body.slice(0, 8000),
    at: input.at && !Number.isNaN(Date.parse(String(input.at)))
      ? new Date(String(input.at)).toISOString()
      : new Date().toISOString(),
    ...(externalId ? { externalId } : {}),
    ...(input.fromLabel ? { fromLabel: String(input.fromLabel).slice(0, 80) } : {}),
  };
  const next = [...existing, msg].slice(-MAX_THREAD);
  saveRecruitmentCandidate({ id: candidateId, messages: next });
  return msg;
}
