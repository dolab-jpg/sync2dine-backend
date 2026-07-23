import type { BrainBuildInput, BrainPackage, BrainSession, ChatFunctionTool } from '../types';
import {
  buildPhoneBrainPrompt,
  getPhoneSessionChatTools,
} from '../../phone/phone-brain';
import { DEFAULT_ORG_ID } from '../../data-store';
import {
  BUILDER_DIDDIES_COMPANY,
  brandPhonePromptAsCynthia,
} from './branding';

/**
 * Cynthia = Builder Diddies / construction CRM phone brain.
 * Reuses phone-brain staff/customer/foreman tools (PIN-gated for staff).
 * Not Judie diner ordering; not Sally Sync2Dine sales.
 */
export const cynthiaBrain: BrainPackage = {
  id: 'cynthia',
  buildSession(input: BrainBuildInput): BrainSession {
    const firstName = (input.contactName || input.identity.name || '').split(/\s+/)[0];
    const orgId =
      String(input.callMeta?.resolvedOrgId || '').trim()
      || DEFAULT_ORG_ID;

    const built = buildPhoneBrainPrompt({
      orgId,
      partyPhone: input.partyPhone,
      direction: input.direction,
      campaignTemplate: input.campaignTemplate,
      outboundBrief: input.outboundBrief,
      contactName: input.contactName || input.identity.name,
      identity: input.identity,
      callId: input.callId,
      phoneAuthVerified: input.verified,
      languageOverride: input.languageOverride,
    });

    const company = BUILDER_DIDDIES_COMPANY.companyName;
    const who = BUILDER_DIDDIES_COMPANY.assistantName;
    let firstMessage: string;
    if (input.identity.kind === 'staff' || input.identity.kind === 'foreman') {
      firstMessage = input.verified
        ? `Hi${firstName ? ` ${firstName}` : ''}, it's ${who} — staff tools are unlocked. What do you need?`
        : `Hi${firstName ? ` ${firstName}` : ''}, ${who} from ${company}. Say your four-digit security code and I'll unlock inbox, emails, and CRM.`;
    } else if (input.direction === 'outbound') {
      firstMessage = `Hello${firstName ? ` ${firstName}` : ''}, it's ${who} from ${company}. How are you getting on?`;
    } else {
      firstMessage = `Hello${firstName ? ` ${firstName}` : ''}, it's ${who} from ${company}. How can I help today?`;
    }

    const tools = getPhoneSessionChatTools(input.identity, input.verified) as ChatFunctionTool[];
    const chatTools = tools.filter((t) => t.function.name !== 'endCall');

    return {
      id: 'cynthia',
      silencePersona: 'cynthia',
      instructions: brandPhonePromptAsCynthia(built.instructions),
      language: built.language,
      firstMessage,
      assistantName: `${who} ${company}`,
      chatTools,
      allowTransfer: true,
    };
  },
};
