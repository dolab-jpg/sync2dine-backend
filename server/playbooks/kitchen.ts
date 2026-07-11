export const kitchenPlaybook = {
  phases: ['Demolition', 'First Fix', 'Installation', 'Finishes', 'Second Fix', 'Handover'],
  complianceNotes: [
    'Apply Part P requirements for kitchen electrical changes.',
    'Protect gas works with Gas Safe registered engineers.',
    'Use suitable extraction routes to meet Part F guidance.',
    'Install fire-rated protection where required around services.',
  ],
  snagChecklist: [
    'Check unit doors and drawer fronts for alignment.',
    'Verify appliance operation and commissioning records.',
    'Inspect worktop joints, cutouts, and sealant quality.',
    'Confirm all sockets, switches, and under-cabinet lights.',
    'Test sink wastes, traps, and appliance water connections.',
  ],
  commonExtras: [
    'Quartz worktop upgrade',
    'Boiling water tap',
    'Integrated bin and storage packs',
    'Under-cabinet LED strip lighting',
  ],
} as const;
