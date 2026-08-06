/**
 * Approved Atmosphere sales talking points for Sally product knowledge.
 * Non-price only — prices stay in getOfferTerms / saas-packages.
 *
 * Language boundary: commercial service proposition for outbound/web Sally.
 * Does not prove an in-app Atmosphere control dashboard exists in Sync2Dine staff UI.
 */
import type { SallyChunkCategory } from './store';

export type AtmosphereTalkingPoint = {
  category: SallyChunkCategory;
  title: string;
  body: string;
  evidence_note?: string;
};

/** Stable titles used to idempotently upsert approved chunks. */
export const ATMOSPHERE_APPROVED_TALKING_POINTS: AtmosphereTalkingPoint[] = [
  {
    category: 'usp',
    title: 'Exclusive keyword soundtrack',
    body:
      'Atmosphere creates an exclusive soundtrack for that venue from their tastes, brand, and keywords — not Spotify and not a shared playlist.',
    evidence_note: 'Approved Atmosphere sales USP; service proposition.',
  },
  {
    category: 'usp',
    title: 'Seating vs kitchen atmosphere',
    body:
      'Match guest seating or dining-room mood separately from kitchen and back-of-house music so each area gets the right atmosphere.',
    evidence_note: 'Approved Atmosphere sales USP; service proposition.',
  },
  {
    category: 'usp',
    title: 'Controllable announcements',
    body:
      'Owners direct promotional and operational announcements — specials, birthday parties, catering, opening and closing, promos on a controllable schedule.',
    evidence_note: 'Approved Atmosphere sales USP; service proposition.',
  },
  {
    category: 'usp',
    title: 'Multi-week training modules',
    body:
      'Staff training modules can play over multiple weeks while service continues, so motivation, customer service, and output improve together without stopping the floor.',
    evidence_note: 'Approved Atmosphere sales USP; service proposition.',
  },
  {
    category: 'success',
    title: 'Proven sales-lift track record',
    body:
      'Atmosphere has a proven track record helping venues increase sales by shaping the guest environment and promoting relevant in-venue offers. Cite as evidence; never invent ROI percentages or guarantee identical results for this prospect.',
    evidence_note: 'Approved success claim — evidence language only, no invented %.',
  },
  {
    category: 'objection',
    title: 'Atmosphere vs Spotify',
    body:
      'Atmosphere is not a music stream. It combines exclusive brand audio, seating vs kitchen moods, controllable announcements, and multi-week staff training as one venue system.',
    evidence_note: 'Approved objection pivot.',
  },
  {
    category: 'pain',
    title: 'Atmosphere discovery angles',
    body:
      'Diagnose whether the bigger issue is getting people through the door, increasing spend once they are in, maintaining service standards, or training and motivating staff — then pick two or three matching Atmosphere USPs.',
    evidence_note: 'Discovery guidance for Sally; do not recite as a feature dump.',
  },
];
