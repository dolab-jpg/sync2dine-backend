export type OrchestratorMode = 'staff' | 'project' | 'foreman' | 'planning' | 'customer' | 'cyrus' | 'phone' | 'auto';

export interface OrchestratorMessage {
  role: string;
  content: string;
}

export interface BusinessSnapshot {
  customerCount?: number;
  quoteCount?: number;
  projectCount?: number;
  builderCount?: number;
  officeStaffCount?: number;
  managerCount?: number;
  salesStaffCount?: number;
  recentCustomerNames?: string[];
  recentQuoteSummaries?: string[];
  leadPipeline?: Record<string, unknown>;
  officeTeamRoster?: Array<Record<string, unknown>>;
}

export type OrchestratorChannel = 'overlay_chat' | 'formal_doc' | 'customer_portal' | 'whatsapp_staff' | 'phone_staff' | 'whatsapp' | 'phone';
export type TaskPhase = 'chat' | 'clarify' | 'execute' | 'complete';
export type AutonomyLevel = 'assist' | 'balanced' | 'autopilot';

export interface PendingTaskPayload {
  id: string;
  summary: string;
  questions: string[];
  askedAt: string;
}

export interface OrchestratorRequest {
  orgId?: string;
  systemPrompt?: string;
  voicePrompt?: string;
  companyName?: string;
  model?: string;
  apiKey?: string;
  messages: OrchestratorMessage[];
  orchestratorMode?: OrchestratorMode;
  channel?: OrchestratorChannel;
  pendingTask?: PendingTaskPayload;
  aiStudio?: {
    companyInstructions?: string;
    autonomyLevel?: AutonomyLevel;
    humourLevel?: string;
    knowledgeChunks?: unknown[];
  };
  businessSnapshot?: BusinessSnapshot;
  staffContext?: {
    role?: string;
    route?: string;
    tradeId?: string | null;
    customerId?: string | null;
    userName?: string;
    userId?: string;
    customers?: Array<{
      id: string;
      name: string;
      email: string;
      phone: string;
      interestedTrades?: string[];
      status?: string;
      source?: string;
      leadScore?: number;
      nextFollowUp?: string;
      budget?: string;
      notes?: string;
    }>;
    quotes?: Array<{
      id: string;
      customerId: string;
      customerName: string;
      tradeId?: string;
      tradeName?: string;
      total: number;
      status: string;
    }>;
    planningApplicationId?: string | null;
  };
  projectContext?: Record<string, unknown>;
  /** Active planning application snapshot for Planning & Consents mode */
  planningApplicationContext?: Record<string, unknown>;
  customerContext?: {
    customerId?: string | null;
    customerName?: string;
    phone?: string;
    contactName?: string;
    contactRole?: string;
    projectId?: string | null;
    quoteId?: string | null;
    role?: string;
  };
  /** Role-scoped snapshot from client (customers, quotes, projects, etc.) */
  dataContext?: Record<string, unknown[] | Record<string, unknown>>;
  /** Phone call context for Aria voice agent */
  callContext?: {
    callId?: string;
    direction?: 'inbound' | 'outbound';
    from?: string;
    to?: string;
    customerId?: string | null;
    customerName?: string;
    candidateId?: string | null;
    projectId?: string | null;
    intent?: string;
    campaignTemplate?: string;
    isAfterHours?: boolean;
  };
}

export interface OrchestratorAction {
  action: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface OrchestratorResult {
  content: string;
  proposedActions: OrchestratorAction[];
  autoActions: OrchestratorAction[];
  detectedTrades: Array<{ tradeId: string; confidence: number; reason?: string }>;
  mockMode?: boolean;
  phase?: TaskPhase;
  clarifyingQuestions?: string[];
  taskSummary?: string;
  pendingTaskId?: string;
}
