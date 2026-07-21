/** Shared phone brain package contract — sally | judie only. */
import type { PhoneCallerIdentity } from '../phone-auth';

export type BrainId = 'sally' | 'judie';

export type SilencePersona = 'sally' | 'judie' | 'staff';

export type ChatFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type BrainBuildInput = {
  partyPhone: string;
  direction: 'inbound' | 'outbound';
  identity: PhoneCallerIdentity;
  verified: boolean;
  callId?: string;
  campaignTemplate?: string;
  outboundBrief?: string;
  contactName?: string;
  companyHint?: string;
  languageOverride?: string;
  callMeta?: Record<string, unknown>;
  agentPersona?: string;
};

export type BrainSession = {
  id: BrainId;
  silencePersona: SilencePersona;
  instructions: string;
  language: string;
  firstMessage: string;
  assistantName: string;
  chatTools: ChatFunctionTool[];
  /** Warm transfer destinations allowed (Judie yes, Sally sales no). */
  allowTransfer: boolean;
};

export interface BrainPackage {
  id: BrainId;
  buildSession(input: BrainBuildInput): Promise<BrainSession> | BrainSession;
}
