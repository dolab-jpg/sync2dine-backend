import {
  isValidServerTradeId,
  TRADE_EXTRACTABLE_FIELDS,
  TRADE_PLAYBOOK_PHASES,
  TRADE_REGISTRY,
  TRADE_IDS_CSV,
} from '../../trade-registry';
import { getDataStore } from '../../data-store';
import {
  assessExtraFromVision,
  assessProgressFromVision,
  resolvePhotoUrlsFromContext,
} from '../vision-handler';
import { canExecuteActionForRole, filterActionsForRole, getRequestRole, isGenericTool } from '../../role-permissions';
import { resolveSystemPrompt } from '../orchestrator-prompt';
import {
  executeCustomerTool,
  executeServerReadTool,
  executeUpdateLeadStatus,
  SERVER_READ_TOOLS,
} from '../../orchestrator-tool-exec';
import { PHONE_TOOLS, executePhoneTool, PHONE_AUTO_ACTIONS } from '../../phone-tools';
import {
  RESTAURANT_TOOL_DEFS,
  RESTAURANT_TOOL_NAMES,
  executeRestaurantTool,
} from '../restaurant-ai-tools';
import type {
  OrchestratorAction,
  OrchestratorMessage,
  OrchestratorMode,
  OrchestratorRequest,
  OrchestratorResult,
} from '../orchestrator-types';
import { PLANNING_ACTION_NAMES, PLANNING_TOOLS } from '../planning-tools';
import { GAP_AUTO_ACTIONS, GAP_CLOSING_TOOLS } from '../gap-closing-tools';
import { expandFacadeCall, FACADE_TOOLS, FACADE_WEB_STAFF_MODES, isFacadeEnabled } from '../tool-facade';
import {
  buildClarifyIntro,
  classifyTaskIntent,
  isProceedMessage,
  shouldClarifyBeforeExecute,
} from '../../task-planner';

import {
  hasPlanningContext,
  MAX_TOOL_ROUNDS,
  GENERIC_TOOLS,
  STAFF_TOOLS,
  CUSTOMER_TOOLS,
  EMAIL_TOOLS,
  CONTRACT_TOOLS,
  PROJECT_TOOLS,
  FOREMAN_TOOLS,
  COSTING_TOOLS,
  ACCOUNTS_TOOLS,
  LEAD_CYCLE_TOOLS,
  NAVIGATION_TOOLS,
  RESTAURANT_TOOLS,
} from './tool-catalog';
import { getToolsForMode, sanitizeToolsForOpenAI } from './tools-for-mode';
import { AUTO_ACTION_NAMES } from './auto-actions';

export * from './helpers';
export { buildMockResult } from './mock';
import { buildMockResult } from './mock';
import {
  applyRoleGate,
  resolveMode,
  toMessageRole,
  firstString,
  wrapMockResult,
  staffMockGreetingContent,
  safeParseObject,
  buildActionsSummaryText,
  executeVisionTool,
} from './helpers';

/** Minimal OpenAI chat client shape used by orchestrator runners. */
export type OpenAIChatClient = {
  chat: {
    completions: {
      create: (input: Record<string, unknown>) => Promise<{
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments?: string };
            }>;
          };
        }>;
      }>;
    };
  };
};

export async function runCustomerOrchestrator(
  openai: OpenAIChatClient,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): Promise<OrchestratorResult> {
  const model = body.model ?? 'gpt-4o-mini';
  const tools = getToolsForMode(resolveMode(body), body);
  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: resolveSystemPrompt(body) },
    ...messages.map((message) => ({
      role: toMessageRole(message.role),
      content: message.content,
    })),
  ];
  const proposedActions: OrchestratorAction[] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 900,
    });
    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls ?? [];

    if (!toolCalls.length) {
      finalContent = choice?.content ?? null;
      break;
    }

    chatMessages.push({
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const parsedInput = safeParseObject(call.function.arguments);
      const output = await executeServerReadTool(call.function.name, parsedInput, body);
      proposedActions.push({
        action: call.function.name,
        input: parsedInput,
        output,
      });
      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalContent) {
    const summaryPass = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        {
          role: 'user',
          content: 'Reply in warm, concise UK English using the tool results above. Keep it customer-friendly (2-4 sentences).',
        },
      ],
      max_tokens: 700,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  const autoActions = proposedActions.filter((action) => AUTO_ACTION_NAMES.has(action.action));
  const clientProposed = proposedActions.filter((action) => !AUTO_ACTION_NAMES.has(action.action));

  return applyRoleGate(body, {
    content: finalContent ?? 'How can I help with your project today?',
    proposedActions: clientProposed,
    autoActions: autoActions.length ? autoActions : proposedActions,
    detectedTrades: [],
  });
}

export async function runPhoneOrchestrator(
  openai: OpenAIChatClient,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): Promise<OrchestratorResult> {
  const model = body.model ?? 'gpt-4o-mini';
  const tools = getToolsForMode('phone', body);
  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: resolveSystemPrompt(body) },
    ...messages.map((message) => ({
      role: toMessageRole(message.role),
      content: message.content,
    })),
  ];
  const proposedActions: OrchestratorAction[] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 400,
    });
    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls ?? [];

    if (!toolCalls.length) {
      finalContent = choice?.content ?? null;
      break;
    }

    chatMessages.push({
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const parsedInput = safeParseObject(call.function.arguments);
      const toolName = call.function.name;
      let output: Record<string, unknown>;

      if (SERVER_READ_TOOLS.has(toolName)) {
        output = await executeServerReadTool(toolName, parsedInput, body);
      } else if (RESTAURANT_TOOL_NAMES.has(toolName)) {
        output = await executeRestaurantTool(toolName, parsedInput, body);
      } else if (['lookupQuote', 'lookupProjectStatus', 'getPortalLink', 'escalateToStaff'].includes(toolName)) {
        output = executeCustomerTool(toolName, parsedInput, body);
      } else {
        output = await executePhoneTool(toolName, parsedInput, body);
      }

      proposedActions.push({ action: toolName, input: parsedInput, output });
      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalContent) {
    const summaryPass = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        {
          role: 'user',
          content: 'Reply in warm, concise UK English for a phone call. Maximum 2-3 short sentences. No markdown or lists.',
        },
      ],
      max_tokens: 200,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  const autoActions = proposedActions.filter((action) => AUTO_ACTION_NAMES.has(action.action));
  const clientProposed = proposedActions.filter((action) => !AUTO_ACTION_NAMES.has(action.action));

  return applyRoleGate(body, {
    content: finalContent ?? 'How can I help you today?',
    proposedActions: clientProposed,
    autoActions,
    detectedTrades: [],
  });
}

export async function handleOrchestrator(body: OrchestratorRequest): Promise<OrchestratorResult> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages[messages.length - 1]?.content ?? '';
  const { mapOpenAIError } = await import('../openai-connection');
  const { createLLMClientForOrg } = await import('../llm-connection');
  const { resolveOrgIdFromBody } = await import('../../org-context');
  const orgId = resolveOrgIdFromBody(body as { orgId?: string });
  const mode = resolveMode(body);

  if (getRequestRole(body) === 'customer' && /invoice|send bill|payment request|draft invoice/i.test(lastMessage)) {
    return applyRoleGate(body, {
      content: "That's one for the office — I've flagged it for the team. They'll sort invoices and payments.",
      proposedActions: [],
      autoActions: [],
      detectedTrades: [],
    });
  }

  try {
    const { client: openai } = await createLLMClientForOrg(orgId, '/api/ai/orchestrate', {
      bodyOpenAIApiKey: body.apiKey,
      bodyDeepSeekApiKey: (body as { deepseekApiKey?: string }).deepseekApiKey,
      provider: (body as { provider?: string }).provider,
    });

    if (mode === 'customer' || mode === 'cyrus') {
      return await runCustomerOrchestrator(openai as unknown as Parameters<typeof runCustomerOrchestrator>[0], body, messages);
    }

    if (mode === 'phone') {
      return await runPhoneOrchestrator(openai as unknown as Parameters<typeof runCustomerOrchestrator>[0], body, messages);
    }

    return await runStaffOrchestrator(openai as unknown as Parameters<typeof runStaffOrchestrator>[0], body, messages);
  } catch (err) {
    throw mapOpenAIError(err);
  }
}

export async function runStaffOrchestrator(
  openai: OpenAIChatClient,
  body: OrchestratorRequest,
  messages: OrchestratorMessage[]
): Promise<OrchestratorResult> {
  const { resolveOrgIdFromBody } = await import('../../org-context');
  const orgId = resolveOrgIdFromBody(body as { orgId?: string });
  const model = body.model ?? 'gpt-4o-mini';
  const mode = resolveMode(body);
  const lastMessage = messages[messages.length - 1]?.content ?? '';
  const autonomy = body.aiStudio?.autonomyLevel ?? 'balanced';
  const classification = classifyTaskIntent(lastMessage, body, messages);

  if (
    !isProceedMessage(lastMessage)
    && !body.pendingTask
    && shouldClarifyBeforeExecute(classification, autonomy, body, lastMessage)
  ) {
    const pendingTaskId = `task-${Date.now()}`;
    const intro = buildClarifyIntro(classification.summary, body.aiStudio?.humourLevel);
    const numbered = classification.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    return applyRoleGate(body, {
      content: `${intro}\n\n${numbered}`,
      proposedActions: [],
      autoActions: [],
      detectedTrades: [],
      phase: 'clarify',
      clarifyingQuestions: classification.questions,
      taskSummary: classification.summary,
      pendingTaskId,
    });
  }

  const tools = getToolsForMode(mode, body);
  const attachedImages = Array.isArray(body.images) ? body.images.filter((u): u is string => typeof u === 'string' && u.length > 0).slice(0, 6) : [];
  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: resolveSystemPrompt(body) },
    ...messages.map((message, index) => {
      const isLastUser =
        index === messages.length - 1
        && toMessageRole(message.role) === 'user'
        && attachedImages.length > 0;
      if (isLastUser) {
        const parts: Array<Record<string, unknown>> = [
          { type: 'text', text: message.content || 'Please review the attached image(s).' },
        ];
        for (const url of attachedImages) {
          parts.push({ type: 'image_url', image_url: { url } });
        }
        return { role: toMessageRole(message.role), content: parts };
      }
      return {
        role: toMessageRole(message.role),
        content: message.content,
      };
    }),
  ];
  const proposedActions: OrchestratorAction[] = [];
  let detectedTrades: OrchestratorResult['detectedTrades'] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      max_tokens: 1500,
    });
    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls ?? [];

    if (!toolCalls.length) {
      finalContent = choice?.content ?? null;
      break;
    }

    chatMessages.push({
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      let parsedInput = safeParseObject(call.function.arguments);
      let toolName = call.function.name;

      // Expand facade calls (searchRecords, manageQuote, …) to their CANONICAL
      // action + flat args BEFORE any execution, AUTO_ACTION_NAMES splitting,
      // or role filtering — so every downstream gate sees canonical names and
      // proposedActions/autoActions stay client-compatible. The facade name is
      // kept as requestedAs for the conversation audit trail.
      const facade = expandFacadeCall(toolName, parsedInput);
      let requestedAs: string | undefined;
      if (facade) {
        requestedAs = toolName;
        toolName = facade.canonicalAction;
        parsedInput = facade.canonicalArgs;
      }
      let output: Record<string, unknown>;

      if (SERVER_READ_TOOLS.has(toolName)) {
        output = await executeServerReadTool(toolName, parsedInput, body);
      } else if (RESTAURANT_TOOL_NAMES.has(toolName)) {
        output = await executeRestaurantTool(toolName, parsedInput, { ...body, orgId: orgId ?? undefined });
        proposedActions.push({
          action: toolName,
          input: parsedInput,
          output: requestedAs ? { ...output, requestedAs } : output,
        });
      } else if (toolName === 'sendToStaffCynthia') {
        // Persist the Cynthia card server-side so phone/WhatsApp/channel paths land
        // even when no browser client is online to run toolRuntime.
        output = await executePhoneTool(toolName, parsedInput, { ...body, orgId: orgId ?? undefined });
        proposedActions.push({
          action: toolName,
          input: parsedInput,
          output: requestedAs ? { ...output, requestedAs } : output,
        });
      } else {
        output = toolName === 'updateLeadStatus'
          ? executeUpdateLeadStatus(parsedInput)
          : parsedInput;
        const { resolveOpenAIApiKeyAsync } = await import('../openai-connection');
        const visionKey = await resolveOpenAIApiKeyAsync(body.apiKey, orgId) ?? '';
        const executedOutput = await executeVisionTool(
          toolName,
          parsedInput,
          body,
          visionKey
        );
        if (executedOutput) output = executedOutput;
        proposedActions.push({
          action: toolName,
          input: parsedInput,
          output: requestedAs ? { ...output, requestedAs } : output,
        });
      }

      if (toolName === 'detectTrades' && Array.isArray(output.trades)) {
        detectedTrades = (output.trades as Array<{ tradeId?: string; confidence?: number; reason?: string }>).filter(
          (trade) => trade.tradeId && isValidServerTradeId(trade.tradeId)
        ) as OrchestratorResult['detectedTrades'];
      }

      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalContent) {
    const actionSummary = buildActionsSummaryText(proposedActions);
    const summaryPass = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        {
          role: 'user',
          content: `Summarise what you found or did in warm conversational UK English. Tool results:\n${actionSummary}\nInclude cost breakdowns as markdown tables when relevant.`,
        },
      ],
      max_tokens: 900,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  // Append spoken confirm when a Cynthia card was pushed server-side
  let content =
    finalContent ?? buildActionsSummaryText(proposedActions) ?? 'How can I help with your quote or project today?';
  for (const action of proposedActions) {
    if (action.action === 'sendToStaffCynthia' && action.output?.spokenConfirm) {
      const confirm = String(action.output.spokenConfirm);
      if (!content.toLowerCase().includes('cynthia')) {
        content = `${content} ${confirm}`.trim();
      }
    }
  }

  const autoActions = proposedActions.filter((action) => AUTO_ACTION_NAMES.has(action.action));
  const clientProposed = proposedActions.filter((action) => !AUTO_ACTION_NAMES.has(action.action));

  return applyRoleGate(body, {
    content,
    proposedActions: clientProposed,
    autoActions,
    detectedTrades,
    phase: proposedActions.length > 0 ? 'execute' : 'chat',
  });
}


