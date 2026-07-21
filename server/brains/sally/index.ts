import type { BrainBuildInput, BrainPackage, BrainSession, ChatFunctionTool } from '../types';
import {
  buildSallyBrainPrompt,
  getSallyPhoneSessionChatTools,
} from '../../sally-sales-phone';
import { getPhoneSessionChatTools, VERIFY_PIN_TOOL } from '../../phone-brain';
import { warmSallyKnowledgeCache } from '../../sally-product-kb/inject';
import { debugLog } from '../../debug-session-log';

function isStaffMode(input: BrainBuildInput): boolean {
  const { identity } = input;
  return (
    identity.kind === 'staff'
    || identity.kind === 'foreman'
    || /platform_owner|super_admin/i.test(identity.role)
  );
}

export const sallyBrain: BrainPackage = {
  id: 'sally',
  async buildSession(input: BrainBuildInput): Promise<BrainSession> {
    const staffMode = isStaffMode(input);
    const firstName = (input.contactName || input.identity.name || '').split(/\s+/)[0];
    // #region agent log
    debugLog('D', 'brains/sally', 'buildSession', {
      staffMode,
      kind: input.identity.kind,
      role: input.identity.role,
      verified: input.verified,
    }, 'full-spec');
    // #endregion
    void warmSallyKnowledgeCache().catch(() => {});

    const prompt = buildSallyBrainPrompt({
      partyPhone: input.partyPhone,
      direction: input.direction,
      outboundBrief: input.outboundBrief,
      contactName: input.contactName || input.identity.name,
      companyHint: input.companyHint,
      staffMode,
      staffName: input.identity.name,
      staffRole: input.identity.role,
      phoneAuthVerified: input.verified,
    });

    let firstMessage: string;
    if (staffMode) {
      firstMessage = input.verified
        ? `Alright ${firstName || 'love'}, Sally here — you're unlocked, what do you need?`
        : `Alright ${firstName || 'love'}, Sally here — say your four-digit security code when you can and I'll unlock the staff tools.`;
    } else if (input.direction === 'outbound') {
      firstMessage = firstName && !/^guest$/i.test(firstName)
        ? `Alright ${firstName}, it's Sally from Sync2Dine — you got a minute?`
        : `Alright love, it's Sally from Sync2Dine — who am I speaking with?`;
    } else {
      firstMessage = firstName && !/^guest$/i.test(firstName)
        ? `Alright ${firstName}, Sally from Sync2Dine — what can I do you for?`
        : `Alright, Sally from Sync2Dine — who am I speaking with?`;
    }

    const sallyTools = getSallyPhoneSessionChatTools();
    const staffTools = staffMode ? getPhoneSessionChatTools(input.identity, input.verified) : [];
    const byName = new Map<string, ChatFunctionTool>();
    for (const t of [...sallyTools, ...staffTools]) {
      byName.set(t.function.name, t as ChatFunctionTool);
    }
    if (staffMode && !byName.has('verifyStaffPhonePin')) {
      byName.set('verifyStaffPhonePin', VERIFY_PIN_TOOL as ChatFunctionTool);
    }
    const chatTools = Array.from(byName.values()).filter((t) => t.function.name !== 'endCall');

    return {
      id: 'sally',
      silencePersona: 'sally',
      instructions: prompt.instructions,
      language: prompt.language,
      firstMessage,
      assistantName: staffMode ? `Sally Sync2Dine (${input.identity.role})` : 'Sally Sync2Dine',
      chatTools,
      allowTransfer: false,
    };
  },
};
