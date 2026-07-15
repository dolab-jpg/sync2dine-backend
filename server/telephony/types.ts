export type TelephonyProviderId = 'mock' | 'twilio' | 'soho66' | 'vapi';

export type CallDirection = 'inbound' | 'outbound';

export type CallIntent =
  | 'new_sales_lead'
  | 'existing_customer'
  | 'recruitment'
  | 'supplier'
  | 'complaint'
  | 'general'
  | 'after_hours'
  | 'unknown';

export type CallStatus =
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'busy'
  | 'transferred'
  | 'queued';

export type OutboundCampaignTemplate =
  | 'quote_chase'
  | 'payment_reminder'
  | 'appointment_reminder'
  | 'recruitment_screening'
  | 'satisfaction_check'
  | 'lead_callback';

export interface CallTurn {
  role: 'caller' | 'agent' | 'system';
  content: string;
  timestamp: string;
}

export interface CallSession {
  id: string;
  providerCallId?: string;
  direction: CallDirection;
  from: string;
  to: string;
  status: CallStatus;
  intent?: CallIntent;
  outcome?: string;
  customerId?: string | null;
  candidateId?: string | null;
  projectId?: string | null;
  transcript: CallTurn[];
  recordingUrl?: string;
  escalated?: boolean;
  transferredTo?: string;
  campaignTemplate?: OutboundCampaignTemplate;
  startedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundJob {
  id: string;
  to: string;
  template: OutboundCampaignTemplate;
  status: 'queued' | 'dialing' | 'completed' | 'failed' | 'cancelled';
  context: Record<string, unknown>;
  scheduledAt?: string;
  createdAt: string;
  callId?: string;
  error?: string;
}

export interface CallEvent {
  type: 'call_started' | 'speech_turn' | 'call_ended' | 'status_update';
  callId: string;
  providerCallId?: string;
  from: string;
  to: string;
  direction: CallDirection;
  speechResult?: string;
  confidence?: number;
  status?: CallStatus;
  recordingUrl?: string;
  raw?: Record<string, unknown>;
}

export interface AgentCallContext {
  callId: string;
  direction: CallDirection;
  from: string;
  to: string;
  customerId?: string | null;
  customerName?: string;
  candidateId?: string | null;
  projectId?: string | null;
  intent?: CallIntent;
  campaignTemplate?: OutboundCampaignTemplate;
  isAfterHours?: boolean;
  messages?: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
}

export interface TelephonyResponse {
  speak: string;
  gather?: boolean;
  transferTo?: string;
  hangup?: boolean;
  ssml?: boolean;
}

export interface TelephonyConfig {
  provider: TelephonyProviderId;
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  webhookBaseUrl?: string;
  transferNumber?: string;
  afterHoursEnabled?: boolean;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  sipUsername?: string;
  sipPassword?: string;
  sipDomain?: string;
  sipBridgeUrl?: string;
}

export interface TelephonyProvider {
  id: TelephonyProviderId;
  parseInboundRequest(body: Record<string, unknown>, headers: Record<string, string>): CallEvent | null;
  buildResponse(response: TelephonyResponse, callId: string, config: TelephonyConfig): { contentType: string; body: string };
  verifyWebhook(body: string, url: string, headers: Record<string, string>, config: TelephonyConfig): boolean;
  placeCall(to: string, context: AgentCallContext, config: TelephonyConfig): Promise<{ callId: string; providerCallId?: string }>;
  testConnection(config: TelephonyConfig): Promise<{ ok: boolean; message: string }>;
}

export const OUTBOUND_CAMPAIGN_SCRIPTS: Record<OutboundCampaignTemplate, { greeting: string; purpose: string }> = {
  quote_chase: {
    greeting: 'Hello, this is Cynthia calling from TradePro.',
    purpose: 'I am following up on the quote we sent you. Do you have a moment to discuss it?',
  },
  payment_reminder: {
    greeting: 'Hello, this is Cynthia from TradePro.',
    purpose: 'I am calling regarding an upcoming payment on your project. May I speak with you briefly?',
  },
  appointment_reminder: {
    greeting: 'Hello, this is Cynthia from TradePro.',
    purpose: 'I am calling to confirm your upcoming site survey appointment.',
  },
  recruitment_screening: {
    greeting: 'Hello, this is Cynthia from TradePro recruitment.',
    purpose: 'Thank you for your interest in joining our team. I would like to ask you a few quick questions.',
  },
  satisfaction_check: {
    greeting: 'Hello, this is Cynthia from TradePro.',
    purpose: 'We wanted to check in on how your project is going and see if there is anything we can help with.',
  },
  lead_callback: {
    greeting: 'Hello, this is Cynthia from TradePro.',
    purpose: 'You recently enquired about our services. I am calling back to see how we can help.',
  },
};
