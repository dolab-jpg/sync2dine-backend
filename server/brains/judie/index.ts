import type { BrainBuildInput, BrainPackage, BrainSession, ChatFunctionTool } from '../types';
import {
  buildPhoneBrainPrompt,
  getPhoneSessionChatTools,
} from '../../phone/phone-brain';
import { withOrgContext } from '../../data-store';
import { getOrganizationById } from '../../organizations';

/**
 * Judie = diner ordering only (one shared brain).
 * Restaurant identity comes from DID-resolved orgId — not a per-client brain package.
 * Staff / platform CRM tools live on Sally (PIN), not here.
 */
export const judieBrain: BrainPackage = {
  id: 'judie',
  buildSession(input: BrainBuildInput): BrainSession {
    const orgId = String(input.orgId || input.callMeta?.resolvedOrgId || '').trim();
    if (!orgId) {
      throw new Error('Judie diner session requires trusted orgId from DID routing');
    }

    const firstName = (input.contactName || input.identity.name || '').split(/\s+/)[0];
    // Force diner path for prompt/tools even if caller is staff on this line
    const dinerIdentity = {
      ...input.identity,
      kind: 'customer' as const,
    };

    const restaurantName =
      String(getOrganizationById(orgId)?.name || '').trim() || 'the restaurant';

    const built = withOrgContext(orgId, () =>
      buildPhoneBrainPrompt({
        orgId,
        partyPhone: input.partyPhone,
        direction: input.direction,
        campaignTemplate: input.campaignTemplate,
        outboundBrief: input.outboundBrief,
        contactName: input.contactName || input.identity.name,
        identity: dinerIdentity,
        callId: input.callId,
        phoneAuthVerified: false,
        languageOverride: input.languageOverride,
        restaurantName,
      }),
    );

    // Never greet as "Hi Guest" — unknown callers get a clean venue open line.
    const knownName = firstName && !/^guest$/i.test(firstName) ? firstName : '';
    let firstMessage: string;
    if (input.direction === 'outbound') {
      firstMessage = knownName
        ? `Hello ${knownName}, it's Judie from ${restaurantName} — how can I help you today?`
        : `Hello ${restaurantName}, how can I help you today?`;
    } else {
      // Inbound: short open, then wait. Do not invent an order/table ask before they speak.
      firstMessage = `Hello ${restaurantName}, how can I help you today?`;
    }

    const tools = getPhoneSessionChatTools(dinerIdentity, false) as ChatFunctionTool[];
    const chatTools = tools.filter((t) => t.function.name !== 'endCall');

    return {
      id: 'judie',
      silencePersona: 'judie',
      instructions: built.instructions,
      language: built.language,
      firstMessage,
      assistantName: `Judie ${restaurantName}`,
      chatTools,
      allowTransfer: true,
    };
  },
};
