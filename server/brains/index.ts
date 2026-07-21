import { isSallySalesCall } from '../sally-sales-phone';
import type { BrainBuildInput, BrainId, BrainPackage, BrainSession } from './types';
import { sallyBrain } from './sally/index';
import { judieBrain } from './judie/index';

const PACKAGES: Record<BrainId, BrainPackage> = {
  sally: sallyBrain,
  judie: judieBrain,
};

export function resolveBrainId(input: {
  callMeta?: Record<string, unknown>;
  campaignTemplate?: string;
  agentPersona?: string;
}): BrainId {
  const meta = input.callMeta || {};
  if (
    isSallySalesCall(meta, {
      campaignTemplate: input.campaignTemplate,
      agentPersona: input.agentPersona || String(meta.agentPersona || ''),
    })
  ) {
    return 'sally';
  }
  const persona = String(input.agentPersona || meta.agentPersona || '').toLowerCase();
  if (persona === 'lizzie') return 'judie'; // legacy
  return 'judie';
}

export function getBrainPackage(id: BrainId): BrainPackage {
  return PACKAGES[id];
}

export async function buildBrainSession(input: BrainBuildInput): Promise<BrainSession> {
  const id = resolveBrainId({
    callMeta: input.callMeta,
    campaignTemplate: input.campaignTemplate,
    agentPersona: input.agentPersona,
  });
  return PACKAGES[id].buildSession(input);
}

export type { BrainId, BrainSession, BrainBuildInput, BrainPackage, SilencePersona } from './types';
