import { isSallySalesCall } from '../phone/sally-sales-phone';
import type { BrainBuildInput, BrainId, BrainPackage, BrainSession } from './types';
import { sallyBrain } from './sally/index';
import { judieBrain } from './judie/index';
import { cynthiaBrain } from './cynthia/index';
import { CYNTHIA_PERSONA } from './cynthia/branding';
import { debugLog } from '../debug-session-log';

const PACKAGES: Record<BrainId, BrainPackage> = {
  sally: sallyBrain,
  judie: judieBrain,
  cynthia: cynthiaBrain,
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
  const purpose = String(meta.linePurpose || '').toLowerCase();
  if (persona === CYNTHIA_PERSONA || purpose === 'cynthia') return 'cynthia';
  if (persona === 'lizzie') return 'judie'; // legacy Judie alias
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
  const session = await PACKAGES[id].buildSession(input);
  // #region agent log
  debugLog('B', 'brains/index.ts:buildBrainSession', 'session built', {
    resolvedId: id,
    silencePersona: session.silencePersona,
    toolCount: session.chatTools.length,
    allowTransfer: session.allowTransfer,
    instructionsLen: session.instructions.length,
    hasProductKb: /SALLY PRODUCT KNOWLEDGE/i.test(session.instructions),
    direction: input.direction,
    identityKind: input.identity.kind,
    agentPersona: String(input.agentPersona || ''),
  }, 'live-debug');
  // #endregion
  return session;
}

export type { BrainId, BrainSession, BrainBuildInput, BrainPackage, SilencePersona } from './types';
