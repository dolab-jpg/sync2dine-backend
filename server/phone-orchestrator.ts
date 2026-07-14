import { handleOrchestrator, type OrchestratorRequest, type OrchestratorResult } from './orchestrator-handler';
import { buildAriaSystemPrompt, buildGreeting, detectIntentFromSpeech, detectUpsetSentiment } from './phone-prompt';
import { executePhoneTool, getOpenRecruitmentJobs, PHONE_AUTO_ACTIONS } from './phone-tools';
import { executeCustomerTool } from './orchestrator-tool-exec';
import { getRequestOrgId } from './data-store';
import { getOrgOpenAIApiKey, listOrganizations } from './organizations';
import type { AgentCallContext, CallIntent } from './telephony/types';
import { OUTBOUND_CAMPAIGN_SCRIPTS } from './telephony/types';

function resolveOpenAiOrgId(): string {
  const current = getRequestOrgId();
  if (current && current !== 'default' && getOrgOpenAIApiKey(current)) return current;
  for (const org of listOrganizations()) {
    if (getOrgOpenAIApiKey(org.id)) return org.id;
  }
  return current || 'default';
}

export interface PhoneOrchestratorRequest {
  callContext: AgentCallContext;
  messages: Array<{ role: string; content: string }>;
  apiKey?: string;
  model?: string;
  customerContext?: OrchestratorRequest['customerContext'];
  projectContext?: OrchestratorRequest['projectContext'];
}

const CUSTOMER_READ_TOOLS = new Set([
  'lookupQuote',
  'lookupProjectStatus',
  'getPortalLink',
  'escalateToStaff',
  'lookupCustomerByPhone',
  'getAccountBriefing',
  'logCallActivity',
]);

export async function handlePhoneTurn(body: PhoneOrchestratorRequest): Promise<{
  content: string;
  intent?: CallIntent;
  transferTo?: string;
  hangup?: boolean;
  toolsUsed: string[];
  proposedActions: OrchestratorResult['proposedActions'];
}> {
  const { callContext, messages } = body;
  const lastMessage = messages[messages.length - 1]?.content ?? '';
  const isFirstTurn = messages.length <= 1 && !lastMessage.trim();
  const afterHours = callContext.isAfterHours ?? false;
  const toolsUsed: string[] = [];

  // Outbound (and inbound) first turn: let Aria use tools + role — no canned scripts.
  if (isFirstTurn) {
    const purposeHint = callContext.campaignTemplate
      ? OUTBOUND_CAMPAIGN_SCRIPTS[callContext.campaignTemplate]?.purpose
      : undefined;
    const openJobs = getOpenRecruitmentJobs();
    const orchestratorBody: OrchestratorRequest = {
      orgId: resolveOpenAiOrgId(),
      messages: [
        {
          role: 'user',
          content: callContext.direction === 'outbound'
            ? `[Outbound call connected. Soft purpose hint (do not recite verbatim): ${purposeHint ?? 'follow up helpfully'}. Call lookupCustomerByPhone with phone ${body.customerContext?.phone ?? callContext.to ?? ''} and getAccountBriefing, then greet naturally in 1-2 short spoken sentences. Log the call with logCallActivity.]`
            : '[Inbound call connected. Greet warmly in 1-2 short spoken sentences. If you know the caller, acknowledge them.]',
        },
      ],
      orchestratorMode: 'phone',
      systemPrompt: buildAriaSystemPrompt({
        messages: [],
        callContext: callContext as OrchestratorRequest['callContext'],
        customerContext: body.customerContext,
        projectContext: body.projectContext,
      }),
      apiKey: body.apiKey,
      model: body.model ?? 'gpt-4o-mini',
      customerContext: {
        ...body.customerContext,
        role: 'agent',
      },
      projectContext: body.projectContext,
      callContext: callContext as OrchestratorRequest['callContext'],
      dataContext: { recruitmentJobs: openJobs },
    };

    const result = await handleOrchestrator(orchestratorBody);
    const allActions = [...result.proposedActions, ...result.autoActions];
    for (const action of allActions) toolsUsed.push(action.action);

    const content = (result.content || '').trim()
      || buildGreeting(
        callContext.customerName ?? 'there',
        Boolean(callContext.customerId),
        afterHours,
        callContext.direction,
      );

    return {
      content: content.slice(0, 500),
      intent: callContext.intent,
      toolsUsed,
      proposedActions: allActions,
    };
  }

  if (detectUpsetSentiment(lastMessage)) {
    const escalateOutput = executeCustomerTool('escalateToStaff', {
      reason: `Phone complaint: "${lastMessage.slice(0, 200)}"`,
    }, {
      messages,
      customerContext: body.customerContext,
      projectContext: body.projectContext,
      callContext: callContext as OrchestratorRequest['callContext'],
    });
    executePhoneTool('classifyCallIntent', { intent: 'complaint', confidence: 0.95 }, {
      messages,
      callContext: callContext as OrchestratorRequest['callContext'],
    });
    toolsUsed.push('escalateToStaff', 'classifyCallIntent');
    return {
      content: "I'm really sorry to hear that. Let me get someone from the team to help you right away. Can I take your name and the best number to reach you on?",
      intent: 'complaint',
      toolsUsed,
      proposedActions: [{ action: 'escalateToStaff', input: {}, output: escalateOutput }],
    };
  }

  const detectedIntent = detectIntentFromSpeech(lastMessage);
  if (detectedIntent !== 'general' && !callContext.intent) {
    executePhoneTool('classifyCallIntent', { intent: detectedIntent, confidence: 0.75 }, {
      messages,
      callContext: callContext as OrchestratorRequest['callContext'],
    });
    callContext.intent = detectedIntent;
    toolsUsed.push('classifyCallIntent');
  }

  const openJobs = getOpenRecruitmentJobs();
  const jobSummary = openJobs.length
    ? openJobs.map(j => `${j.title} (${j.location})`).join('; ')
    : 'Sales, construction, and office roles';

  const orchestratorBody: OrchestratorRequest = {
    orgId: resolveOpenAiOrgId(),
    messages,
    orchestratorMode: 'phone',
    systemPrompt: buildAriaSystemPrompt({
      messages,
      callContext: callContext as OrchestratorRequest['callContext'],
      customerContext: body.customerContext,
      projectContext: body.projectContext,
    }),
    apiKey: body.apiKey,
    model: body.model ?? 'gpt-4o-mini',
    customerContext: {
      ...body.customerContext,
      role: 'agent',
    },
    projectContext: body.projectContext,
    callContext: {
      ...callContext,
      intent: callContext.intent ?? detectedIntent,
    },
    dataContext: {
      recruitmentJobs: openJobs,
    },
  };

  orchestratorBody.systemPrompt += `\n\nOpen recruitment roles: ${jobSummary}`;

  const result = await handleOrchestrator(orchestratorBody);
  const allActions = [...result.proposedActions, ...result.autoActions];

  let transferTo: string | undefined;
  let hangup = false;

  for (const action of allActions) {
    toolsUsed.push(action.action);
    if (PHONE_AUTO_ACTIONS.has(action.action) || CUSTOMER_READ_TOOLS.has(action.action)) {
      let output: Record<string, unknown>;
      if (CUSTOMER_READ_TOOLS.has(action.action)) {
        output = executeCustomerTool(action.action, action.input, orchestratorBody);
      } else {
        output = executePhoneTool(action.action, { ...action.input, ...action.output }, orchestratorBody);
      }
      action.output = output;

      if (action.action === 'transferToHuman' && output.transferred && output.transferNumber) {
        transferTo = String(output.transferNumber);
      }
      if (action.action === 'transferToHuman' && output.takeMessage) {
        hangup = false;
      }
    }
  }

  let content = result.content;
  if (content.length > 500) {
    content = content.slice(0, 497) + '...';
  }

  return {
    content,
    intent: (callContext.intent ?? detectedIntent) as CallIntent,
    transferTo,
    hangup,
    toolsUsed: [...new Set(toolsUsed)],
    proposedActions: allActions,
  };
}
