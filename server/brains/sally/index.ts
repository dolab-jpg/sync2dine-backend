import type { BrainBuildInput, BrainPackage, BrainSession, ChatFunctionTool } from '../types';
import {
  buildSallyBrainPrompt,
  getSallyPhoneSessionChatTools,
} from '../../phone/sally-sales-phone';
import { getPhoneSessionChatTools, VERIFY_PIN_TOOL } from '../../phone/phone-brain';
import { warmSallyKnowledgeCache } from '../../sally-product-kb/inject';
import { debugLog } from '../../debug-session-log';
import { SYNC2DINE_SPOKEN } from '../../home-org';
import {
  isSallyRecruitmentCall,
  recruitmentFirstMessage,
  lookupRecruitmentCandidateByPhone,
} from '../../sally/recruitment-interview';

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

    const meta = (input.callMeta && typeof input.callMeta === 'object')
      ? { ...input.callMeta }
      : {};
    const inboundCandidate = input.direction === 'inbound'
      ? lookupRecruitmentCandidateByPhone(input.partyPhone)
      : { candidateId: null as string | null, candidateName: '', cvSummary: undefined as string | undefined };
    const recruitment = isSallyRecruitmentCall(meta, {
      campaignTemplate: input.campaignTemplate,
      agentPersona: input.agentPersona,
    }) || Boolean(inboundCandidate.candidateId);
    if (inboundCandidate.candidateId) {
      meta.aim = meta.aim || 'recruitment_interview';
      meta.source = meta.source || 'recruitment_interview';
      meta.candidateId = inboundCandidate.candidateId;
      if (inboundCandidate.cvSummary && !meta.cvSummary) meta.cvSummary = inboundCandidate.cvSummary;
    }
    const contactName = (recruitment && inboundCandidate.candidateName && inboundCandidate.candidateName !== 'Guest')
      ? inboundCandidate.candidateName
      : (input.contactName || input.identity.name);
    const prompt = buildSallyBrainPrompt({
      partyPhone: input.partyPhone,
      direction: input.direction,
      outboundBrief: input.outboundBrief || (recruitment ? inboundCandidate.cvSummary : undefined),
      contactName,
      companyHint: input.companyHint,
      staffMode: staffMode && !recruitment,
      staffName: input.identity.name,
      staffRole: input.identity.role,
      phoneAuthVerified: input.verified,
      callMeta: meta,
    });

    const source = String(meta.source || '').toLowerCase();
    const isReferral =
      source === 'gatekeeper_referral'
      || Boolean(meta.referral)
      || Boolean(meta.referredByName)
      || /REFERRAL:/i.test(String(input.outboundBrief || ''));
    const referrerName = String(meta.referredByName || '').trim();
    const usableFirst =
      firstName
      && !/^guest$/i.test(firstName)
      && !/^(unknown|unknown caller|manager|owner|boss)$/i.test(firstName);
    const recruitFirst = (recruitment && inboundCandidate.candidateName && inboundCandidate.candidateName !== 'Guest')
      ? inboundCandidate.candidateName.split(/\s+/)[0]
      : (input.contactName || String(meta.name || meta.contactName || firstName) || '').split(/\s+/)[0];

    let firstMessage: string;
    if (recruitment && !staffMode) {
      const founderHay = `${meta.cvSummary || ''} ${meta.brief || ''} ${input.outboundBrief || ''}`.toLowerCase();
      firstMessage = recruitmentFirstMessage({
        firstName: recruitFirst,
        direction: input.direction,
        founderTest: founderHay.includes('founder test'),
      });
    } else if (staffMode) {
      // Cynthia-style staff call-in: same PIN-gated tools (inbox, compose/send email, CRM) on Sally.
      firstMessage = input.verified
        ? `Alright ${firstName || 'love'}, Sally here — staff tools are unlocked. I can brief your inbox, draft and send company emails, or pull CRM — what do you need?`
        : `Alright ${firstName || 'love'}, Sally here for staff. Say your four-digit security code and I'll unlock inbox, emails, and CRM like Cynthia does.`;
    } else if (input.direction === 'outbound' && isReferral) {
      firstMessage = referrerName
        ? `Alright love, it's Sally from ${SYNC2DINE_SPOKEN} — ${referrerName} on the main line asked me to give you a ring. Got a minute?`
        : `Alright love, it's Sally from ${SYNC2DINE_SPOKEN} — your colleague on the main line asked me to give you a ring. Got a minute?`;
    } else if (input.direction === 'outbound') {
      firstMessage = usableFirst
        ? `Alright ${firstName}, it's Sally from ${SYNC2DINE_SPOKEN} — you got a minute?`
        : `Alright love, it's Sally from ${SYNC2DINE_SPOKEN} — is the manager or owner about?`;
    } else {
      firstMessage = usableFirst
        ? `Alright ${firstName}, Sally from ${SYNC2DINE_SPOKEN} — what can I do you for?`
        : `Alright, Sally from ${SYNC2DINE_SPOKEN} — is the manager or owner about?`;
    }

    const sallyTools = getSallyPhoneSessionChatTools(meta);
    const staffTools = staffMode && !recruitment
      ? getPhoneSessionChatTools(input.identity, input.verified)
      : [];
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
      // Staff callers get the shorter staff dead-air ladder (see phone/vapi-assistant.ts).
      silencePersona: staffMode ? 'staff' : 'sally',
      instructions: prompt.instructions,
      language: prompt.language,
      firstMessage,
      assistantName: staffMode ? `Sally Sync2Dine (${input.identity.role})` : 'Sally Sync2Dine',
      chatTools,
      allowTransfer: false,
    };
  },
};
