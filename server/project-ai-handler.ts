import type { OrchestratorRequest } from './orchestrator-handler';
import { handleOrchestrator } from './orchestrator-handler';

export interface ProjectAIRequest {
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  messages: Array<{ role: string; content: string }>;
  projectContext?: OrchestratorRequest['projectContext'];
  staffContext?: OrchestratorRequest['staffContext'];
}

export interface ProjectAIToolResult {
  content: string;
  proposedActions?: Array<{
    action: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }>;
  autoActions?: Array<{
    action: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }>;
  detectedTrades?: Array<{ tradeId: string; confidence: number; reason?: string }>;
}

export async function handleProjectAI(body: ProjectAIRequest): Promise<ProjectAIToolResult> {
  const result = await handleOrchestrator({
    ...body,
    orchestratorMode: 'project',
  });

  return {
    content: result.content,
    proposedActions: result.proposedActions,
    autoActions: result.autoActions,
    detectedTrades: result.detectedTrades,
  };
}
