import { handleOrchestrator, type OrchestratorRequest } from './orchestrator-handler';

export interface CyrusRequestBody {
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  messages: Array<{ role: string; content: string }>;
  customerContext?: OrchestratorRequest['customerContext'];
  projectContext?: OrchestratorRequest['projectContext'];
}

function buildFallbackCyrusPrompt(body: CyrusRequestBody): string {
  const customerName = String(body.customerContext?.customerName ?? 'there');
  const contactName = String(body.customerContext?.contactName ?? customerName);
  const projectName = String(body.projectContext?.projectName ?? 'your project');
  return `You are Cyrus, a friendly UK customer assistant for TradePro Ltd.
Customer: ${customerName}
Messaging contact: ${contactName}
Project context: ${projectName}
Keep replies concise (2-4 sentences), warm, and practical.`;
}

export async function handleCyrusViaOrchestrator(body: CyrusRequestBody): Promise<{
  content: string;
  toolsUsed: string[];
  proposedActions: Array<{ action: string; input: Record<string, unknown>; output: Record<string, unknown> }>;
}> {
  const result = await handleOrchestrator({
    ...body,
    systemPrompt: body.systemPrompt ?? buildFallbackCyrusPrompt(body),
    orchestratorMode: 'cyrus',
    customerContext: body.customerContext,
    projectContext: body.projectContext,
  });

  const toolsUsed = Array.from(new Set(result.proposedActions.map(action => action.action)));
  return {
    content: result.content,
    toolsUsed,
    proposedActions: result.proposedActions,
  };
}
