/**
 * Tier 2 — rich follow-through drafts after a Sally call (async; does not slow live TTS).
 */
import type { TrustEngineScores } from './trust-engine';

export type FollowThroughDraft = {
  emailSubject: string;
  emailBody: string;
  crmTask: string;
  nextObjective: string;
  reminderISO: string | null;
  onboardingNote: string;
};

export function draftSallyFollowThrough(input: {
  venueName?: string;
  contactName?: string;
  callObjective?: string;
  trust?: TrustEngineScores | null;
  pitchAngle?: string;
  nextSlotISO?: string | null;
}): FollowThroughDraft {
  const venue = String(input.venueName || 'your venue').trim();
  const name = String(input.contactName || 'there').trim();
  const obj = String(input.callObjective || 'educate');
  const trustDown = input.trust?.trustDelta === 'down';

  const emailSubject =
    obj === 'meet'
      ? `Sync2Dine — install meeting next steps for ${venue}`
      : trustDown
        ? `Thanks for your time — Sync2Dine`
        : `Sync2Dine — useful next step for ${venue}`;

  const emailBody = [
    `Hi ${name},`,
    '',
    trustDown
      ? 'Thanks for speaking with Sally today — no pressure from our side.'
      : 'Thanks for chatting with Sally from Sync2Dine today.',
    obj === 'meet'
      ? 'This confirms your 20-minute install / senior-management integration meeting. We will ring 30 minutes before to confirm.'
      : obj === 'callback'
        ? 'We will call back at a better time for you.'
        : input.pitchAngle === 'no_kitchen_revenue'
          ? 'If you ever enable collection or takeaway, Judie can take those phone orders into the app so you do not miss the revenue.'
          : 'Happy to share how Judie (phone orders/bookings) and Atmosphere (venue audio) help hospitality teams.',
    '',
    'Cheers,',
    'Sally · Sync2Dine',
  ].join('\n');

  const nextObjective =
    obj === 'meet'
      ? 'T-30 confirm then run install meeting'
      : obj === 'stop'
        ? 'Do not dial — respect DNC'
        : trustDown
          ? 'leave_goodwill — short nurture only'
          : obj === 'callback'
            ? 'callback at preferred window'
            : 'educate then qualify toward install meeting';

  return {
    emailSubject,
    emailBody,
    crmTask: `Sally follow-through: objective=${obj}; venue=${venue}; trust=${input.trust?.trustDelta || 'flat'}`,
    nextObjective,
    reminderISO: input.nextSlotISO || null,
    onboardingNote:
      obj === 'meet'
        ? 'Prepare install checklist + package preference after confirm call.'
        : 'No onboarding pack until meeting booked.',
  };
}
