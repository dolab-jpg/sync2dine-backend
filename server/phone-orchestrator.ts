import { handleOrchestrator, type OrchestratorRequest, type OrchestratorResult } from './orchestrator-handler';
import { buildCynthiaPhoneSystemPrompt, buildGreeting, detectIntentFromSpeech, detectUpsetSentiment } from './phone-prompt';
import { executePhoneTool, getOpenRecruitmentJobs, PHONE_AUTO_ACTIONS } from './phone-tools';
import { executeCustomerTool } from './orchestrator-tool-exec';
import { resolveInboundChannel } from './channel-router';
import { handleChannelInbound } from './channel-inbound-handler';
import type { AgentCallContext, CallIntent } from './telephony/types';
import { OUTBOUND_CAMPAIGN_SCRIPTS } from './telephony/types';
import { getRequestOrgId } from './data-store';

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
  const isKnown = Boolean(callContext.customerId);
  const toolsUsed: string[] = [];

  const staffRoute = resolveInboundChannel(callContext.from, getRequestOrgId());
  if (staffRoute.mode === 'staff' || staffRoute.mode === 'foreman') {
    if (isFirstTurn) {
      const greeting = `Alright ${staffRoute.name ?? 'boss'}, Sync2Dine on the line. What do you need?`;
      return { content: greeting, intent: callContext.intent, toolsUsed, proposedActions: [] };
    }
    const inbound = await handleChannelInbound({
      orgId: getRequestOrgId(),
      phone: callContext.from,
      text: lastMessage,
      channel: 'phone',
      contactName: staffRoute.name,
      projectId: callContext.projectId,
    });
    return {
      content: inbound.replyEnglish.slice(0, 500),
      intent: callContext.intent,
      toolsUsed: inbound.toolsUsed,
      proposedActions: [],
    };
  }

  if (isFirstTurn) {
    const campaign = callContext.campaignTemplate
      ? OUTBOUND_CAMPAIGN_SCRIPTS[callContext.campaignTemplate]
      : null;
    const greeting = buildGreeting(
      callContext.customerName ?? 'there',
      isKnown,
      afterHours,
      callContext.direction,
      campaign ? `${campaign.greeting} ${campaign.purpose}` : undefined,
    );
    return { content: greeting, intent: callContext.intent, toolsUsed, proposedActions: [] };
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
    }).catch(() => {});
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
    void executePhoneTool('classifyCallIntent', { intent: detectedIntent, confidence: 0.75 }, {
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
    orgId: getRequestOrgId(),
    messages,
    orchestratorMode: 'phone',
    systemPrompt: buildCynthiaPhoneSystemPrompt({
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
      // Phone orchestrator already executed tools in-loop — don't double-send cards.
      if (action.action === 'sendToStaffCynthia' && action.output?.sent) {
        continue;
      }
      let output: Record<string, unknown>;
      if (CUSTOMER_READ_TOOLS.has(action.action)) {
        output = executeCustomerTool(action.action, action.input, orchestratorBody);
      } else {
        output = await executePhoneTool(action.action, { ...action.input, ...action.output }, orchestratorBody);
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
  for (const action of allActions) {
    if (action.action === 'sendToStaffCynthia' && action.output?.spokenConfirm) {
      const confirm = String(action.output.spokenConfirm);
      if (!content.toLowerCase().includes('cynthia')) {
        content = `${content} ${confirm}`.trim();
      }
    }
  }
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
