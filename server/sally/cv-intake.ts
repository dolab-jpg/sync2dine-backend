/**
 * CV intake: uploaded file → candidate profile (with the original CV attached) → Sally screening call.
 * A CV with a UK mobile starts screening immediately; one without is parked until a number is added.
 */
import { enqueueOutboundCall, getDataStore, saveRecruitmentCandidate } from '../data-store';
import { parseCv } from './cv-parse';
import { cvMimeType, storeCandidateCv } from './cv-store';
import {
  RECRUITMENT_AIM,
  RECRUITMENT_SOURCE,
  RECRUITMENT_TEMPLATE,
  lookupRecruitmentCandidateByPhone,
} from './recruitment-interview';

export type CvIntakeOutcome = {
  filename: string;
  ok: boolean;
  candidateId?: string;
  name?: string;
  phone?: string;
  email?: string;
  queued: boolean;
  needsPhone: boolean;
  reason?: string;
};

function slugId(name: string, filename: string): string {
  const base = (name || filename.replace(/\.[a-z0-9]+$/i, '') || 'candidate')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `cv-${base || 'candidate'}-${Date.now().toString(36)}`;
}

function findByEmail(email?: string): Record<string, unknown> | undefined {
  if (!email) return undefined;
  const wanted = email.trim().toLowerCase();
  if (!wanted) return undefined;
  return getDataStore().recruitmentCandidates.find(
    (c) => String(c.email || '').trim().toLowerCase() === wanted,
  );
}

function screenAlreadyQueued(phone: string): boolean {
  return (getDataStore().outboundQueue || []).some((job) => {
    const ctx = (job.context && typeof job.context === 'object')
      ? (job.context as Record<string, unknown>)
      : {};
    const status = String(job.status || '');
    return (
      String(job.to || '') === phone
      && String(job.template || ctx.campaignTemplate || '') === RECRUITMENT_TEMPLATE
      && (status === 'queued' || status === 'dialling' || status === 'dialing')
    );
  });
}

/** One uploaded CV → profile (+ screening call when we have a mobile). */
export async function ingestCvFile(file: {
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}): Promise<CvIntakeOutcome> {
  const filename = String(file.filename || 'cv').trim();
  if (!file.buffer?.length) {
    return { filename, ok: false, queued: false, needsPhone: false, reason: 'empty_file' };
  }

  const parsed = parseCv(file.buffer, filename);
  const phone = parsed.phone || '';
  const existing = (phone ? lookupRecruitmentCandidateByPhone(phone) : { candidateId: null }).candidateId
    ? getDataStore().recruitmentCandidates.find(
      (c) => String(c.id) === String(lookupRecruitmentCandidateByPhone(phone).candidateId),
    )
    : findByEmail(parsed.email);

  const candidateId = String(existing?.id || slugId(parsed.name || '', filename));
  const stored = await storeCandidateCv({
    candidateId,
    filename,
    buffer: file.buffer,
    mimeType: file.mimeType || cvMimeType(filename),
  });

  const doNotCall = existing?.hireDoNotCall === true;
  const candidate = saveRecruitmentCandidate({
    ...(existing || {}),
    id: candidateId,
    name: parsed.name || existing?.name || 'Candidate',
    phone: phone || existing?.phone || '',
    email: parsed.email || existing?.email || '',
    location: parsed.location || existing?.location || '',
    desiredRole: existing?.desiredRole || 'Restaurant sales (Sync2Dine)',
    source: existing?.source || 'cv_upload',
    status: existing?.status || 'applied',
    currentEmploymentStatus: existing?.currentEmploymentStatus || 'unknown',
    createdAt: existing?.createdAt || new Date().toISOString(),
    // The CRM list and profile iterate these, so never leave them unset.
    skills: Array.isArray(existing?.skills) ? existing?.skills : [],
    certifications: Array.isArray(existing?.certifications) ? existing?.certifications : [],
    preferredLocations: Array.isArray(existing?.preferredLocations) ? existing?.preferredLocations : [],
    rating: Number(existing?.rating) || 0,
    cvFilename: filename,
    cvStoragePath: stored?.storagePath,
    cvUploadedAt: new Date().toISOString(),
    cvText: parsed.text,
    cvSummary: parsed.summary,
    brief: parsed.summary,
    needsPhone: !phone && !existing?.phone,
  });

  const dialPhone = phone || String(existing?.phone || '').trim();
  let queued = false;
  let reason: string | undefined;
  if (!dialPhone) {
    reason = 'needs_phone';
  } else if (doNotCall) {
    reason = 'do_not_call';
  } else if (screenAlreadyQueued(dialPhone)) {
    reason = 'already_queued';
  } else {
    enqueueOutboundCall({
      to: dialPhone,
      template: RECRUITMENT_TEMPLATE,
      status: 'queued',
      context: {
        name: candidate.name,
        aim: RECRUITMENT_AIM,
        agentPersona: 'sally',
        source: RECRUITMENT_SOURCE,
        campaignTemplate: RECRUITMENT_TEMPLATE,
        venueAware: false,
        candidateId,
        brief: parsed.summary.slice(0, 900),
        cvSummary: parsed.summary.slice(0, 900),
      },
    });
    queued = true;
  }

  return {
    filename,
    ok: true,
    candidateId,
    name: String(candidate.name || ''),
    phone: dialPhone || undefined,
    email: parsed.email,
    queued,
    needsPhone: !dialPhone,
    reason,
  };
}

export async function ingestCvFiles(files: Array<{
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}>): Promise<{ results: CvIntakeOutcome[]; created: number; queued: number; needsPhone: number }> {
  const results: CvIntakeOutcome[] = [];
  for (const file of files) {
    // Sequential: each CV may match a profile the previous one just created.
    results.push(await ingestCvFile(file));
  }
  return {
    results,
    created: results.filter((r) => r.ok).length,
    queued: results.filter((r) => r.queued).length,
    needsPhone: results.filter((r) => r.ok && r.needsPhone).length,
  };
}
