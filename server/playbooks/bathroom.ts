export const bathroomPlaybook = {
  phases: ['Demolition', 'First Fix', 'Prep', 'Finishes', 'Second Fix', 'Handover'],
  complianceNotes: [
    'Use BS 7671 safe zones for any electrical alterations.',
    'Maintain water regulations compliance for hot/cold feeds.',
    'Install extraction to satisfy Part F ventilation requirements.',
    'Use certified waterproofing systems in wet zones.',
  ],
  snagChecklist: [
    'Check silicone joints and movement gaps around fixtures.',
    'Confirm fall to waste on shower trays and wet areas.',
    'Pressure test supply lines and inspect visible joints.',
    'Test extractor fan run-on timer and airflow.',
    'Verify grout lines, tile alignment, and chipped edges.',
  ],
  commonExtras: [
    'Electric underfloor heating',
    'Recessed LED mirror cabinet',
    'Premium brassware upgrade',
    'Niche shelving and feature lighting',
  ],
} as const;
