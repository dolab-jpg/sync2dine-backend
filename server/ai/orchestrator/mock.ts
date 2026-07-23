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

import {
  applyRoleGate,
  resolveMode,
  toMessageRole,
  safeParseObject,
  buildActionSummary,
  buildActionsSummaryText,
  extractCustomerFromMessage,
  inferTradesFromText,
  mockFieldsForTrade,
  inferRouteFromText,
  extractSearchQuery,
  firstString,
  readAssignedContractors,
  getTradePhaseSummary,
  readStringArray,
  buildChangeOrderFromAssessment,
  executeVisionTool,
  summarizeProjectStatus,
  buildCustomerReplyFromActions,
  wrapMockResult,
  staffMockGreetingContent,
  detectQuoteWonIntent,
  extractCustomerNameFromMessage,
} from './helpers';

export function buildMockResult(userMessage: string, body: OrchestratorRequest): OrchestratorResult {
  const lower = userMessage.toLowerCase();
  const trimmed = userMessage.trim();
  const mode = resolveMode(body);
  const requestRole = getRequestRole(body);

  if (requestRole === 'customer' && /invoice|send bill|payment request|draft invoice/i.test(userMessage)) {
    return applyRoleGate(body, {
      content: "That's one for the office — I've flagged it for the team. They'll sort invoices and payments.",
      proposedActions: [],
      autoActions: [],
      detectedTrades: [],
    });
  }
  const includeStaffTools = mode === 'staff' || mode === 'auto';
  const includeProjectTools = mode === 'project' || mode === 'foreman' || mode === 'auto';
  const includeForemanTools = mode === 'project' || mode === 'foreman';
  const includeCustomerTools = mode === 'customer' || mode === 'cyrus';
  const proposedActions: OrchestratorAction[] = [];
  let detectedTrades: OrchestratorResult['detectedTrades'] = [];

  if (includeCustomerTools) {
    const trimmed = userMessage.trim();
    const isGreeting = /^(hi|hiya|hello|hey|yo|good\s+(morning|afternoon|evening))[\s!.,?]*$/i.test(trimmed);
    const isThanks = /^(thanks|thank\s+you|thanks\s+a\s+lot|thank\s+u|cheers|ta|nice one|much appreciated|appreciate it)[\s!.,]*$/i.test(trimmed);
    // Short acknowledgements ("ok", "great", "sounds good") are not questions — answering
    // them with a full status dump and a fresh escalation makes the bot feel robotic.
    const isAck = /^(ok|oka?y|okey|oky|k|kk|kay|right|righto|alright|all\s*right|cool|great|grand|perfect|brilliant|lovely|nice|sound|sounds\s+good|good|fine|sure|ok\s+thanks|okay\s+thanks|yep|yeah|yes|yup|no\s+worries|gotcha|got\s+it|understood|noted|fab|magic|champion|sweet|ace|will\s+do)[\s!.,]*$/i.test(trimmed);
    const alreadyEscalated = (body.messages ?? []).some(
      (m) => m.role === 'assistant' && /passed your question to the office team/i.test(m.content ?? ''),
    );
    const statusIntent = /(status|progress|project|working|work|tomorrow|today|when|schedule|start|finish|builder|team|anyone|update|happening|going|on\s*site)/i.test(lower);

    if (lower.includes('quote') || lower.includes('qoute') || lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
      proposedActions.push({
        action: 'lookupQuote',
        input: {},
        output: executeCustomerTool('lookupQuote', {}, body),
      });
    }
    if (statusIntent) {
      proposedActions.push({
        action: 'lookupProjectStatus',
        input: {},
        output: executeCustomerTool('lookupProjectStatus', {}, body),
      });
    }
    if (lower.includes('portal') || lower.includes('link')) {
      proposedActions.push({
        action: 'getPortalLink',
        input: {
          projectId: firstString(body.projectContext?.projectId, body.customerContext?.projectId),
        },
        output: executeCustomerTool('getPortalLink', {
          projectId: firstString(body.projectContext?.projectId, body.customerContext?.projectId),
        }, body),
      });
    }
    if (/upset|angry|unhappy|complaint|manager|human|person/i.test(userMessage)) {
      proposedActions.push({
        action: 'escalateToStaff',
        input: { reason: 'Customer sentiment indicates escalation request' },
        output: executeCustomerTool('escalateToStaff', { reason: 'Customer sentiment indicates escalation request' }, body),
      });
    }

    // Unmatched question: answer with live project data and flag for the team.
    // Skip acknowledgements/greetings/thanks, and don't re-escalate if the office
    // team has already been looped in earlier in this conversation.
    if (!proposedActions.length && !isGreeting && !isThanks && !isAck) {
      proposedActions.push({
        action: 'lookupProjectStatus',
        input: {},
        output: executeCustomerTool('lookupProjectStatus', {}, body),
      });
      if (!alreadyEscalated) {
        proposedActions.push({
          action: 'escalateToStaff',
          input: { reason: `Customer question needs a staff answer: "${trimmed}"` },
          output: executeCustomerTool('escalateToStaff', { reason: `Customer question needs a staff answer: "${trimmed}"` }, body),
        });
      }
    }

    const customerName = firstString(body.customerContext?.customerName);
    const firstName = customerName?.split(' ')[0];

    let content: string;
    if (isGreeting) {
      content = `Hello${firstName ? ` ${firstName}` : ''}! I can check your project progress, quotes, payments, or pass a question to the team. What would you like to know?`;
    } else if (isThanks) {
      content = "You're very welcome — give me a shout if you need anything else.";
    } else if (isAck) {
      content = alreadyEscalated
        ? "No problem — the office team will be in touch shortly. Anything else I can help with in the meantime?"
        : "No problem at all. I'm here if you need anything else — project progress, quotes or payments.";
    } else {
      content = buildCustomerReplyFromActions(proposedActions)
        ?? 'How can I help with your quote or project today?';
    }

    return applyRoleGate(body, {
      content,
      proposedActions: proposedActions.filter((a) => !AUTO_ACTION_NAMES.has(a.action)),
      autoActions: proposedActions.filter((a) => AUTO_ACTION_NAMES.has(a.action)),
      detectedTrades: [],
    });
  }

  if (includeStaffTools) {
    const greetingContent = staffMockGreetingContent(body, trimmed);
    if (greetingContent) {
      return applyRoleGate(body, {
        content: greetingContent,
        proposedActions: [],
        autoActions: [],
        detectedTrades: [],
      });
    }

    const classification = classifyTaskIntent(userMessage, body, body.messages ?? []);
    const autonomy = body.aiStudio?.autonomyLevel ?? 'balanced';
    if (
      shouldClarifyBeforeExecute(classification, autonomy, body, userMessage)
      && !body.pendingTask
      && !isProceedMessage(userMessage)
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

    if (detectQuoteWonIntent(lower)) {
      const customerName = extractCustomerNameFromMessage(userMessage, body.staffContext?.customers);
      const quote = body.staffContext?.quotes?.find((q) =>
        customerName
          ? String(q.customerName ?? '').toLowerCase().includes(customerName.toLowerCase().split(' ')[0] ?? '')
          : false
      ) ?? body.staffContext?.quotes?.[0];
      const withPaymentPlan = /payment plan|instalment|installment/i.test(lower);
      if (quote) {
        proposedActions.push({
          action: 'convertQuoteToProject',
          input: {},
          output: {
            quoteId: quote.id,
            customerName: quote.customerName,
            markQuoteAccepted: true,
            withPaymentPlan,
          },
        });
      }
    }

    const ctx = body.staffContext;
    detectedTrades = inferTradesFromText(userMessage);
    if (ctx?.tradeId && isValidServerTradeId(ctx.tradeId) && !detectedTrades.some(d => d.tradeId === ctx.tradeId)) {
      detectedTrades.unshift({ tradeId: ctx.tradeId, confidence: 0.7, reason: 'From current page context' });
    }

    if (detectedTrades.length > 0) {
      proposedActions.push({
        action: 'detectTrades',
        input: {},
        output: { trades: detectedTrades },
      });
    }

    const primaryTrade = detectedTrades[0]?.tradeId ?? ctx?.tradeId ?? null;
    const primaryConfidence = detectedTrades[0]?.confidence ?? (ctx?.tradeId ? 0.7 : 0);
    if (
      primaryTrade
      && isValidServerTradeId(primaryTrade)
      && primaryConfidence >= 0.5
      && (lower.includes('quote') || lower.includes('estimate') || lower.includes('measure') || detectedTrades.length > 0)
    ) {
      proposedActions.push({
        action: 'proposeQuoteFields',
        input: {},
        output: { tradeId: primaryTrade, fields: mockFieldsForTrade(primaryTrade) },
      });
    }

    const customers = ctx?.customers ?? [];
    const extracted = extractCustomerFromMessage(userMessage);
    const existing = extracted.name
      ? customers.find(c => String(c.name ?? '').toLowerCase().includes(extracted.name!.toLowerCase()))
      : undefined;

    if (extracted.name || existing || lower.includes('customer') || lower.includes('client') || lower.includes('make me')) {
      const tradeIds = detectedTrades.map(d => d.tradeId);
      const customerOutput = {
        customerId: existing?.id,
        name: existing?.name ?? extracted.name ?? '',
        email: existing?.email ?? extracted.email ?? '',
        phone: existing?.phone ?? extracted.phone ?? '',
        interestedTrades: tradeIds.length > 0 ? tradeIds : (primaryTrade ? [primaryTrade] : []),
        isNew: !existing,
      };
      proposedActions.push({
        action: 'saveCustomer',
        input: {},
        output: customerOutput,
      });

      if (
        primaryTrade
        && isValidServerTradeId(primaryTrade)
        && (lower.includes('quote') || lower.includes('qoute') || lower.includes('£') || extracted.budget || /\b\d+\s*k\b/i.test(lower))
      ) {
        const budget = extracted.budget ?? 5000;
        proposedActions.push({
          action: 'saveQuote',
          input: {},
          output: {
            tradeId: primaryTrade,
            customerName: customerOutput.name,
            status: 'draft',
            total: budget,
            openQuote: lower.includes('open') || lower.includes('save'),
            items: [{ name: `${primaryTrade} materials`, quantity: 1, price: Math.round(budget * 0.55), total: Math.round(budget * 0.55) }],
            labour: [{ description: 'Installation labour', rateType: 'fixed', rate: Math.round(budget * 0.35), total: Math.round(budget * 0.35) }],
            extras: [{ description: 'Fixings & sundries', price: Math.round(budget * 0.1) }],
            wizardAnswers: { finish: lower.includes('standard') ? 'standard' : undefined },
          },
        });
      }
    }

    if (
      primaryTrade
      && isValidServerTradeId(primaryTrade)
      && (lower.includes('open quote') || lower.includes('start quote'))
    ) {
      proposedActions.push({
        action: 'startQuote',
        input: {},
        output: {
          tradeId: primaryTrade,
          customerId: existing?.id ?? ctx?.customerId,
          prefillFields: mockFieldsForTrade(primaryTrade),
        },
      });
    }
  }

  if (includeProjectTools) {
    const projectName = String(body.projectContext?.projectName ?? 'the project');
    if (lower.includes('payment') || lower.includes('plan')) {
      proposedActions.push({
        action: 'proposePaymentPlan',
        input: {},
        output: {
          stages: [
            { name: 'Booking Deposit', percentage: 10, amount: 0, notes: 'Secures start date' },
            { name: 'Project Start', percentage: 40, amount: 0, notes: 'Released when work begins' },
            { name: 'Mid-point', percentage: 30, amount: 0, notes: 'At 50% completion' },
            { name: 'Completion', percentage: 20, amount: 0, notes: 'On sign-off' },
          ],
        },
      });
    }
    if (lower.includes('schedule') || lower.includes('task') || lower.includes('day off') || lower.includes('friday')) {
      proposedActions.push({
        action: 'proposeSchedule',
        input: {},
        output: {
          tasks: [
            { title: 'Strip out', description: 'Remove existing suite', assignedTo: 'Builder', targetDate: '', priority: 'high' },
            { title: 'First fix plumbing', description: 'Pipework and waste', assignedTo: 'Builder', targetDate: '', priority: 'high' },
            { title: 'Waterproofing', description: 'Tanking system', assignedTo: 'Builder', targetDate: '', priority: 'medium' },
            { title: 'Second fix', description: 'Fit sanitaryware', assignedTo: 'Builder', targetDate: '', priority: 'medium' },
          ],
          milestones: [{ title: 'Strip-out complete', targetDate: '' }],
          workingDaysOff: lower.includes('friday') ? ['Friday'] : [],
        },
      });
    }
    if (lower.includes('invoice')) {
      proposedActions.push({
        action: 'draftInvoice',
        input: {},
        output: {
          stageName: 'Project Start',
          lineItems: [{ description: `Bathroom installation — ${projectName}`, amount: 0 }],
          total: 0,
        },
      });
    }
    if (lower.includes('contract')) {
      proposedActions.push({
        action: 'draftContract',
        input: {},
        output: {
          terms: 'Standard UK home improvement contract. Subject to site inspection. 14-day cooling-off period applies.',
        },
      });
    }
    if (lower.includes('builder') || lower.includes('contractor') || lower.includes('price')) {
      proposedActions.push({
        action: 'draftBuilderMessage',
        input: {},
        output: {
          subject: `Price enquiry — ${projectName}`,
          body: 'Hi, please confirm your price for the attached scope of works.',
        },
      });
      if (/\d+/.test(userMessage)) {
        proposedActions.push({
          action: 'logBuilderPrice',
          input: {},
          output: { builderName: 'Builder', priceQuoted: 0, notes: userMessage },
        });
      }
    }
    if (
      lower.includes('change order')
      || lower.includes('variation')
      || lower.includes('scope change')
      || lower.includes('extra work')
    ) {
      proposedActions.push({
        action: 'proposeChangeOrder',
        input: {},
        output: {
          title: 'Variation request',
          description: 'Additional scope identified and drafted for staff financial approval.',
          amount: 0,
          reason: 'Scope update',
        },
      });
    }
    if ((lower.includes('notify') || lower.includes('send')) && lower.includes('change order')) {
      proposedActions.push({
        action: 'notifyCustomerChangeOrder',
        input: {},
        output: {
          changeOrderId: '',
        },
      });
    }
    if (lower.includes('complete') || lower.includes('done') || lower.includes('task')) {
      proposedActions.push({
        action: 'updateTaskStatus',
        input: {},
        output: { taskTitle: 'Strip out', status: 'completed' },
      });
    }
    if (lower.includes('photo') || lower.includes('tag') || lower.includes('caption')) {
      proposedActions.push({
        action: 'tagPhoto',
        input: {},
        output: { caption: 'Progress photo — site update', tags: ['progress'] },
      });
    }
  }

  if (includeForemanTools) {
    const projectName = String(body.projectContext?.projectName ?? 'the project');
    const projectId = String(body.projectContext?.projectId ?? '');
    const builderName = String(body.projectContext?.builderName ?? body.projectContext?.builderId ?? 'Builder');
    const assignedContractors = readAssignedContractors(body.projectContext);
    const scopedTradeId = firstString(body.projectContext?.tradeId, body.staffContext?.tradeId);

    if (lower.includes('brief') || lower.includes('builder update') || lower.includes('foreman')) {
      const tradeScopeLine = assignedContractors.length > 0
        ? assignedContractors
            .map((contractor) => {
              const trade = contractor.trade ?? contractor.tradeId ?? 'general';
              const firstPhase = getTradePhaseSummary(contractor.tradeId ?? scopedTradeId).split(' -> ')[0];
              return `${trade}: ${firstPhase}`;
            })
            .join('; ')
        : '';
      proposedActions.push({
        action: 'sendBuilderBrief',
        input: {},
        output: {
          projectId,
          builderName,
          body: `Morning brief for ${projectName}: confirm today's priorities, blockers, and H&S checks.${tradeScopeLine ? ` Trade scopes: ${tradeScopeLine}.` : ''}`,
          channels: ['app'],
        },
      });

      if (
        assignedContractors.length > 0
        && (lower.includes('contractor') || lower.includes('trade') || lower.includes('sub'))
      ) {
        const matchingTrade = scopedTradeId && isValidServerTradeId(scopedTradeId)
          ? assignedContractors.find((contractor) => contractor.tradeId === scopedTradeId)
          : undefined;
        const target = matchingTrade ?? assignedContractors[0];
        proposedActions.push({
          action: 'sendContractorBrief',
          input: {},
          output: {
            projectId,
            contractorId: target.id,
            tradeId: target.tradeId ?? scopedTradeId,
            body: `Trade brief for ${target.name}: focus on ${target.trade ?? target.tradeId ?? 'your scope'} work package and confirm blockers by 16:00.`,
            channels: ['app'],
          },
        });
      }
    }

    if (lower.includes('daily plan') || lower.includes('weekly plan') || lower.includes('monthly plan') || lower.includes('propose plan')) {
      const cadence = lower.includes('weekly')
        ? 'weekly'
        : lower.includes('monthly')
          ? 'monthly'
          : 'daily';
      const tradeScopedTasks = assignedContractors.slice(0, 4).map((contractor) => {
        const phases = getTradePhaseSummary(contractor.tradeId ?? scopedTradeId).split(' -> ');
        return {
          title: `${contractor.trade ?? contractor.tradeId ?? 'Trade'} package`,
          owner: contractor.name,
          due: '',
          phase: phases[0] ?? 'survey',
        };
      });
      proposedActions.push({
        action: 'proposePlan',
        input: {},
        output: {
          cadence,
          title: `${cadence[0].toUpperCase()}${cadence.slice(1)} foreman plan`,
          tasks: [
            { title: 'Review open tasks and dependencies', owner: builderName, due: '' },
            ...tradeScopedTasks,
            { title: 'Confirm materials and access windows', owner: 'Office', due: '' },
          ],
          milestones: tradeScopedTasks.length > 0
            ? tradeScopedTasks.map((task) => ({ title: `${task.title} phase checkpoint`, targetDate: '' }))
            : [{ title: 'Site progress checkpoint', targetDate: '' }],
        },
      });
    }

    if (lower.includes('payment gate') || lower.includes('stage gate') || lower.includes('ready to invoice')) {
      proposedActions.push({
        action: 'checkPaymentGate',
        input: {},
        output: {
          stageName: 'Project Start',
          evidenceNeeded: ['Progress photos', 'Task completion note', 'Customer acknowledgement'],
        },
      });
    }

    if (lower.includes('photo') || lower.includes('site photo') || lower.includes('site photos')) {
      proposedActions.push({
        action: 'requestSitePhotos',
        input: {},
        output: {
          taskTitle: 'Current active task',
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        },
      });
    }

    if (lower.includes('relay') || lower.includes('customer update')) {
      proposedActions.push({
        action: 'relayCustomerUpdate',
        input: {},
        output: {
          body: `Customer update for ${projectName}: work is progressing and next steps are on track.`,
          channels: ['app'],
        },
      });
    }

    if (lower.includes('builder replied') || lower.includes('builder response')) {
      proposedActions.push({
        action: 'logBuilderReply',
        input: {},
        output: {
          projectId,
          fromPhone: '',
          body: userMessage,
        },
      });
    }

    if (
      lower.includes('assess extra')
      || lower.includes('variation photo')
      || lower.includes('extra scope')
      || (lower.includes('photo') && (lower.includes('extra') || lower.includes('change order')))
    ) {
      const mockExtra = {
        title: 'Electric underfloor heating',
        description: 'Photos suggest prep and kit for underfloor heating not included in base scope.',
        amountMin: 720,
        amountMax: 1180,
        confidence: 0.66,
        risks: ['Confirm thermostat location and electrical loading.', 'Verify floor build-up tolerance before install.'],
      };
      proposedActions.push({
        action: 'assessExtraFromPhotos',
        input: {},
        output: {
          ...mockExtra,
          tradeId: firstString(body.projectContext?.tradeId, body.staffContext?.tradeId) ?? 'general',
          photoCount: 2,
          proposeChangeOrder: buildChangeOrderFromAssessment(mockExtra, body.projectContext),
        },
      });
      proposedActions.push({
        action: 'proposeChangeOrder',
        input: {},
        output: buildChangeOrderFromAssessment(mockExtra, body.projectContext),
      });
    }

    if (
      lower.includes('assess progress')
      || lower.includes('progress photo')
      || lower.includes('site progress')
    ) {
      const progressOutput = {
        snagList: ['Minor silicone touch-up needed at shower tray edge.'],
        suggestedTaskUpdates: [{ taskTitle: 'Second fix', status: 'in_progress', note: 'Visible fixtures now being installed.' }],
        summary: 'Photos show second-fix stage progressing with one minor snag.',
      };
      proposedActions.push({
        action: 'assessProgress',
        input: {},
        output: progressOutput,
      });
      proposedActions.push({
        action: 'updateTaskStatus',
        input: {},
        output: { taskTitle: 'Second fix', status: 'in_progress' },
      });
    }
  }

  if (lower.includes('search customer') || lower.includes('find customer') || lower.includes('lookup customer')) {
    proposedActions.push({
      action: 'searchCustomers',
      input: {},
      output: { query: extractSearchQuery(userMessage, 'customer'), limit: 10 },
    });
  }
  if (lower.includes('search project') || lower.includes('find project') || lower.includes('lookup project')) {
    proposedActions.push({
      action: 'searchProjects',
      input: {},
      output: { query: extractSearchQuery(userMessage, 'project'), limit: 10 },
    });
  }
  if (lower.includes('search quote') || lower.includes('find quote') || lower.includes('lookup quote')) {
    proposedActions.push({
      action: 'searchQuotes',
      input: {},
      output: { query: extractSearchQuery(userMessage, 'quote'), limit: 10 },
    });
  }
  if (lower.includes('go to') || lower.includes('open ') || lower.includes('navigate')) {
    const route = inferRouteFromText(lower);
    if (route) {
      proposedActions.push({
        action: 'navigateTo',
        input: {},
        output: { route, reason: 'Inferred from user navigation intent' },
      });
    }
  }

  const staffRole = body.staffContext?.role ?? body.customerContext?.role;
  if (staffRole === 'customer') {
    const customerActions = proposedActions.filter((a) =>
      ['lookupQuote', 'lookupProjectStatus', 'getPortalLink', 'escalateToStaff'].includes(a.action)
    );
    const autoActions = customerActions.filter((a) => AUTO_ACTION_NAMES.has(a.action));
    return applyRoleGate(body, {
      content: customerActions.length
        ? 'Right — here is what I found for you.'
        : 'How can I help with your quote or project today?',
      proposedActions: customerActions.filter((a) => !AUTO_ACTION_NAMES.has(a.action)),
      autoActions,
      detectedTrades: [],
    });
  }

  const filteredStaff = proposedActions.filter((a) => a.action !== 'detectTrades');
  const primaryOnly = filteredStaff;

  const autoActions = primaryOnly.filter(action => AUTO_ACTION_NAMES.has(action.action));
  const summaryText = buildActionsSummaryText(primaryOnly);
  if (primaryOnly.length > 0) {
    return applyRoleGate(body, {
      content: detectedTrades.length > 0
        ? `Right then — I've picked up ${detectedTrades.map((d) => d.tradeId).join(' and ')}. ${summaryText}`
        : summaryText || 'Sorted — here is what I suggest.',
      proposedActions: primaryOnly.filter((a) => !AUTO_ACTION_NAMES.has(a.action)),
      autoActions,
      detectedTrades,
    });
  }

  return applyRoleGate(body, {
    content: 'Demo mode — configure OpenAI in Settings → Integrations for full answers. Try asking about a quote, customer, or bathroom job.',
    proposedActions: [],
    autoActions: [],
    detectedTrades,
  });
}

type OpenAIChatClient = {
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

