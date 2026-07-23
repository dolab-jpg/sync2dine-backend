import type { OrchestratorRequest } from './orchestrator-handler';
import { handleOrchestrator } from './orchestrator-handler';

export interface StaffAIRequest {
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  messages: Array<{ role: string; content: string }>;
  staffContext?: OrchestratorRequest['staffContext'];
  projectContext?: OrchestratorRequest['projectContext'];
}

export interface StaffAIAction {
  action: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface StaffAIResult {
  content: string;
  proposedActions?: StaffAIAction[];
  autoActions?: StaffAIAction[];
  detectedTrades?: Array<{ tradeId: string; confidence: number; reason?: string }>;
}

export async function handleStaffAI(body: StaffAIRequest): Promise<StaffAIResult> {
  const result = await handleOrchestrator({
    ...body,
    orchestratorMode: 'staff',
  });

  return {
    content: result.content,
    proposedActions: result.proposedActions,
    autoActions: result.autoActions,
    detectedTrades: result.detectedTrades,
  };
}
