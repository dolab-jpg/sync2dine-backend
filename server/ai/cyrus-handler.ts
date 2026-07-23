export interface CyrusRequestBody {
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  messages: Array<{ role: string; content: string }>;
  customerContext?: Record<string, unknown>;
  projectContext?: Record<string, unknown>;
}

export async function handleCyrusChat(body: CyrusRequestBody): Promise<{ content: string }> {
  const { handleCyrusViaOrchestrator } = await import('../cyrus-orchestrator');
  const result = await handleCyrusViaOrchestrator({
    systemPrompt: body.systemPrompt,
    model: body.model,
    apiKey: body.apiKey,
    messages: body.messages,
    customerContext: body.customerContext,
    projectContext: body.projectContext,
  });
  return { content: result.content };
}
