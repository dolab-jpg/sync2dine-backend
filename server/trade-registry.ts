/** Minimal trade registry for server-side AI handlers (mirrors client trade configs). */
export const TRADE_REGISTRY = [
  {
    id: 'bathroom',
    name: 'Bathroom',
    signals: 'bathroom, toilet, shower, basin, tiles, wet room, ensuite, refit',
    phases: ['Demolition', 'First Fix', 'Prep', 'Finishes', 'Second Fix', 'Handover'],
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    signals: 'units, worktop, cooker, sink, appliances',
    phases: ['Demolition', 'First Fix', 'Installation', 'Finishes', 'Second Fix', 'Handover'],
  },
  {
    id: 'electrical',
    name: 'Electrical',
    signals: 'consumer unit, sockets, wiring, lights, fuse box, rewire',
    phases: ['Survey', 'First Fix', 'Installation', 'Second Fix', 'Testing', 'Certification'],
  },
  { id: 'plumbing', name: 'Plumbing', signals: 'boiler, radiators, pipes, cylinder, heating' },
  { id: 'roofing', name: 'Roofing', signals: 'tiles, slate, guttering, fascia, chimney, flat roof' },
  { id: 'flooring', name: 'Flooring', signals: 'laminate, vinyl, carpet, subfloor, floorboards' },
  { id: 'painting', name: 'Painting', signals: 'walls, ceiling, emulsion, woodwork, decorator' },
  { id: 'plastering', name: 'Plastering', signals: 'skim, render, cracks, plasterboard, artex' },
  { id: 'extensions', name: 'Extensions', signals: 'rear extension, side return, orangery, conservatory' },
  { id: 'windows', name: 'Windows & Doors', signals: 'double glazing, UPVC, bi-fold, front door' },
  { id: 'loft', name: 'Loft Conversion', signals: 'loft, dormer, velux, attic, head height' },
  { id: 'landscaping', name: 'Landscaping', signals: 'patio, decking, garden, driveway, fencing' },
] as const;

export type ServerTradeId = (typeof TRADE_REGISTRY)[number]['id'];

export const TRADE_EXTRACTABLE_FIELDS: Record<string, string[]> = {
  bathroom: ['length', 'width', 'floorLocation', 'access', 'removal', 'finish'],
  kitchen: ['length', 'width', 'floorLocation', 'access', 'removal', 'finish'],
  electrical: ['rooms', 'jobType', 'consumerUnit', 'sockets', 'lights'],
  plumbing: ['rooms', 'boilerType', 'radiators', 'cylinder'],
  roofing: ['area', 'finish', 'roofType', 'removal'],
  flooring: ['length', 'width', 'finish', 'subfloor', 'rooms'],
  painting: ['rooms', 'length', 'width', 'prepLevel', 'finish'],
  plastering: ['length', 'width', 'finish', 'removal'],
  extensions: ['length', 'width', 'storeys', 'specLevel', 'access'],
  windows: ['windows', 'doors', 'finish'],
  loft: ['area', 'conversionType', 'rooms', 'bathroom'],
  landscaping: ['length', 'width', 'surfaceType', 'linearMetres', 'access'],
};

export const TRADE_PLAYBOOK_PHASES: Record<string, string[]> = {
  bathroom: ['survey', 'strip_out', 'first_fix', 'waterproofing', 'second_fix', 'handover'],
  kitchen: ['survey', 'strip_out', 'first_fix', 'installation', 'second_fix', 'handover'],
  electrical: ['survey', 'first_fix', 'inspection', 'second_fix', 'certification'],
  plumbing: ['survey', 'first_fix', 'pressure_test', 'second_fix', 'commissioning'],
  roofing: ['survey', 'access_setup', 'strip_out', 'weatherproofing', 'finish', 'handover'],
  flooring: ['survey', 'prep', 'install', 'finish', 'handover'],
  painting: ['survey', 'prep', 'prime', 'top_coats', 'snagging'],
  plastering: ['survey', 'prep', 'first_coat', 'finish_coat', 'drying', 'snagging'],
  extensions: ['survey', 'groundworks', 'shell', 'first_fix', 'second_fix', 'handover'],
  windows: ['survey', 'measure', 'remove_existing', 'install', 'seal_and_finish', 'handover'],
  loft: ['survey', 'structural', 'first_fix', 'insulation', 'second_fix', 'handover'],
  landscaping: ['survey', 'ground_prep', 'infrastructure', 'finish_surfaces', 'handover'],
};

export function buildTradeRegistryPrompt(): string {
  return TRADE_REGISTRY.map(
    t => `- ${t.id}: ${t.name} (signals: ${t.signals})`
  ).join('\n');
}

export function buildTradePlaybookPrompt(): string {
  return TRADE_REGISTRY.map(trade => {
    const phases = TRADE_PLAYBOOK_PHASES[trade.id] ?? ['survey', 'delivery', 'handover'];
    return `- ${trade.id}: ${phases.join(' -> ')}`;
  }).join('\n');
}

export function isValidServerTradeId(id: string): id is ServerTradeId {
  return TRADE_REGISTRY.some(t => t.id === id);
}
