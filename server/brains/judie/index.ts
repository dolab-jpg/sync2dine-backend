import type { BrainBuildInput, BrainPackage, BrainSession, ChatFunctionTool } from '../types';
import {
  buildPhoneBrainPrompt,
  getPhoneSessionChatTools,
} from '../../phone/phone-brain';
import { DEFAULT_ORG_ID } from '../../data-store';

/**
 * Judie = diner ordering only.
 * Staff / platform CRM tools live on Sally (PIN), not here.
 */
export const judieBrain: BrainPackage = {
  id: 'judie',
  buildSession(input: BrainBuildInput): BrainSession {
    const firstName = (input.contactName || input.identity.name || '').split(/\s+/)[0];
    // Force diner path for prompt/tools even if caller is staff on this line
    const dinerIdentity = {
      ...input.identity,
      kind: 'customer' as const,
    };
    const built = buildPhoneBrainPrompt({
      orgId: DEFAULT_ORG_ID,
      partyPhone: input.partyPhone,
      direction: input.direction,
      campaignTemplate: input.campaignTemplate,
      outboundBrief: input.outboundBrief,
      contactName: input.contactName || input.identity.name,
      identity: dinerIdentity,
      callId: input.callId,
      phoneAuthVerified: false,
      languageOverride: input.languageOverride,
    });

    let firstMessage: string;
    if (input.direction === 'outbound') {
      firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, it's Judie from Sync2Dine — how are you getting on?`;
    } else {
      firstMessage = `Hi${firstName ? ` ${firstName}` : ''}, Judie from Sync2Dine here — how can I help?`;
    }

    const tools = getPhoneSessionChatTools(dinerIdentity, false) as ChatFunctionTool[];
    const chatTools = tools.filter((t) => t.function.name !== 'endCall');

    return {
      id: 'judie',
      silencePersona: 'judie',
      instructions: built.instructions,
      language: built.language,
      firstMessage,
      assistantName: 'Judie Sync2Dine',
      chatTools,
      allowTransfer: true,
    };
  },
};
