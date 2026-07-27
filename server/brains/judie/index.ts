import type { BrainBuildInput, BrainPackage, BrainSession, ChatFunctionTool } from '../types';
import {
  buildPhoneBrainPrompt,
  getPhoneSessionChatTools,
} from '../../phone/phone-brain';
import { getDataStore, withOrgContext } from '../../data-store';
import { getOrganizationById } from '../../organizations';

/**
 * Judie = diner ordering only (one shared brain).
 * Restaurant identity comes from DID-resolved orgId - not a per-client brain package.
 * Staff / platform CRM tools live on Sally (PIN), not here.
 */

/** Inbound open: Sync to Dine + best restaurant, then Favourites, then how can I help. */
function buildJudieInboundGreeting(restaurantName: string, sayToday: string, aboutUs: string): string {
  const venue = restaurantName.trim() || 'Sync2Dine';
  // TTS often mumbles "Sync2Dine" - speak as "Sync to Dine".
  const spokenVenue = /sync\s*2\s*dine/i.test(venue) ? 'Sync to Dine' : venue;
  const favourites = sayToday.replace(/[.!?]+$/, '').trim();
  const favBit = favourites ? ` Favourites: ${favourites}.` : '';
  if (/sync\s*2\s*dine/i.test(venue)) {
    return `Sync to Dine, the best restaurant around Birmingham.${favBit} How can I help?`;
  }
  const aboutLead = aboutUs.split(/[.!?]/)[0]?.trim() || '';
  if (aboutLead && aboutLead.length <= 90 && /birmingham|best|around/i.test(aboutLead)) {
    return `${spokenVenue}, ${aboutLead}.${favBit} How can I help?`;
  }
  return `Hello ${spokenVenue}.${favBit} How can I help you today?`;
}

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

    let sayToday = '';
    let aboutUs = '';
    const built = withOrgContext(orgId, () => {
      const agent = getDataStore().agentSettings;
      sayToday = String(agent?.sayToday || '').trim();
      aboutUs = String(agent?.aboutUs || '').trim();
      return buildPhoneBrainPrompt({
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
      });
    });

    // Never greet as "Hi Guest" - unknown callers get a clean venue open line.
    const knownName = firstName && !/^guest$/i.test(firstName) ? firstName : '';
    let firstMessage: string;
    if (input.direction === 'outbound') {
      firstMessage = knownName
        ? `Hello ${knownName}, it's Judie from ${restaurantName} - how can I help you today?`
        : `Hello ${restaurantName}, how can I help you today?`;
    } else {
      // Inbound: short open, then wait. Do not invent an order/table ask before they speak.
      firstMessage = buildJudieInboundGreeting(restaurantName, sayToday, aboutUs);
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
