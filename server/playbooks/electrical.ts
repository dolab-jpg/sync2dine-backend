export const electricalPlaybook = {
  phases: ['Survey', 'First Fix', 'Installation', 'Second Fix', 'Testing', 'Certification'],
  complianceNotes: [
    'All works must align with BS 7671 (current edition).',
    'Issue certification for notifiable and applicable works.',
    'Use appropriately rated RCD/RCBO protection for circuits.',
    'Complete dead and live tests before energizing final circuits.',
  ],
  snagChecklist: [
    'Test polarity, earth continuity, and insulation resistance.',
    'Label consumer unit schedule and circuit directories.',
    'Check socket and switch faceplates are secure and level.',
    'Verify lighting switching logic and dimmer compatibility.',
    'Confirm smoke/heat alarm interlink operation where installed.',
  ],
  commonExtras: [
    'Consumer unit upgrade',
    'Additional socket circuits',
    'Smart lighting controls',
    'EV charger-ready supply route',
  ],
} as const;
