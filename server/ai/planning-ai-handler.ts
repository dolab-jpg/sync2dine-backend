/**
 * Planning & Consents agent.
 *
 * Fully autonomous, tool-calling agent for the UK planning-permission workflow.
 * The server decides which planning tools to call (in any order) and returns them
 * as `actions`. The client applies each action to the planning store and logs it
 * for audit + undo. The server itself holds no state.
 */

import { PLANNING_TOOLS } from './planning-tools';

interface PlanningMessage {
  role: string;
  content: string;
}

export interface PlanningApplicationContext {
  id?: string;
  customerName?: string;
  customerEmail?: string;
  address?: string;
  title?: string;
  applicationType?: string;
  stage?: string;
  pricing?: { amount?: number; sentAt?: string; acceptedAt?: string };
  council?: {
    name?: string;
    reference?: string;
    portalUrl?: string;
    submittedAt?: string;
    validationOfficer?: string;
    targetDecisionDate?: string;
  };
  changeRequests?: Array<{ id: string; description: string; deadline?: string; status: string }>;
  drawingsCount?: number;
  decision?: string;
}

export interface PlanningRequest {
  apiKey?: string;
  model?: string;
  messages: PlanningMessage[];
  application?: PlanningApplicationContext;
  sourceEmail?: string;
  userRole?: string;
  userName?: string;
}

export interface PlanningAction {
  action: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface PlanningResult {
  content: string;
  actions: PlanningAction[];
  mockMode?: boolean;
}

const MAX_TOOL_ROUNDS = 3;

function buildSystemPrompt(body: PlanningRequest): string {
  const app = body.application;
  const appLine = app
    ? `Current application:
- Customer: ${app.customerName ?? 'unknown'}${app.customerEmail ? ` <${app.customerEmail}>` : ''}
- Title: ${app.title ?? 'untitled'}
- Type: ${app.applicationType ?? 'householder'}
- Address: ${app.address ?? 'not set'}
- Stage: ${app.stage ?? 'pricing'}
- Pricing: ${app.pricing?.amount != null ? `£${app.pricing.amount}${app.pricing.sentAt ? ' (sent)' : ''}` : 'not set'}
- Council: ${app.council?.name ?? 'not set'}${app.council?.reference ? ` ref ${app.council.reference}` : ''}${app.council?.targetDecisionDate ? `, target ${app.council.targetDecisionDate}` : ''}
- Drawings on file: ${app.drawingsCount ?? 0}
- Open change requests: ${(app.changeRequests ?? []).filter((c) => c.status === 'open').map((c) => c.description).join('; ') || 'none'}
- Decision: ${app.decision ?? 'pending'}`
    : 'No application is currently linked.';

  const emailLine = body.sourceEmail
    ? `\n\nCouncil/validation email pasted by the user:\n"""\n${body.sourceEmail}\n"""`
    : '';

  return `You are the Builder Diddies Planning & Consents Agent — an autonomous assistant for a UK building company that handles planning permission and related consents end to end.

You manage: pricing planning services, producing drawings, getting customer sign-off on drawings, submitting to the Local Planning Authority (LPA), handling validation-team change requests, tracking deadlines and the council portal, recording the decision, and the post-approval consents (structural engineering, Building Regulations, and build-over agreements with the water authority).

${appLine}
User: ${body.userName ?? 'Staff'} (${body.userRole ?? 'staff'})${emailLine}

HOW YOU WORK:
- You have FULL AUTONOMY. Call whatever tools are needed to carry out the user's instruction, in any order. Every action is logged and can be undone, so act decisively rather than asking permission.
- The workflow stages are labels only — you are NOT forced to follow them in order.
- When the user pastes a council/validation email, parse it: call raiseChangeRequest once per distinct requested change, capture any deadline, and add a short aiComment with how to address it.
- You cannot browse the internet or council portals. For status checks, use portalStatusCheck to log a note and point staff at the portal URL.
- Use UK English and UK planning terminology (LPA, validation, determination period, conditions, discharge of conditions, Approved Documents, build-over agreement).
- Keep written customer/council emails professional and concise.
- After acting, reply with a short, plain-English summary of what you did and any deadlines or next steps.`;
}

function echoToolResult(name: string, args: Record<string, unknown>): Record<string, unknown> {
  // The server does not mutate state; it confirms the action so the model can chain.
  return { ok: true, applied: true, action: name, ...args };
}

function buildMockResult(body: PlanningRequest): PlanningResult {
  const text = (body.messages[body.messages.length - 1]?.content ?? '').toLowerCase();
  const actions: PlanningAction[] = [];
  const app = body.application;
  const customer = app?.customerName ?? 'there';

  const push = (action: string, input: Record<string, unknown>) =>
    actions.push({ action, input, output: echoToolResult(action, input) });

  if (body.sourceEmail) {
    push('raiseChangeRequest', {
      description: 'Amendment requested by the validation team (see pasted email).',
      sourceEmail: body.sourceEmail.slice(0, 280),
      aiComment: 'Review the pasted email and provide the requested information/drawings, then resend to the officer.',
    });
    push('setStage', { stage: 'changes_requested' });
  } else if (/pric|fee|quote|proposal/.test(text)) {
    push('sendPricingEmail', {
      subject: 'Planning application — our proposal',
      body: `Dear ${customer},\n\nThank you for your enquiry. We would be glad to handle your planning application, including drawings, submission to the council and managing the process through to decision.\n\nPlease let us know if you would like to proceed and we will get started.\n\nKind regards,\nThe Planning Team`,
    });
  } else if (/review|approve|sign.?off|drawing/.test(text)) {
    push('sendReviewEmail', {
      subject: 'Your planning drawings — please review',
      body: `Dear ${customer},\n\nYour planning drawings are ready to view. Please use the secure link in this email to review and approve them so we can submit to the council.\n\nKind regards,\nThe Planning Team`,
    });
    push('setStage', { stage: 'customer_approval' });
  } else if (/courtesy|come and see|view it|before approval/.test(text)) {
    push('sendCourtesyEmail', {
      subject: 'Good news on your planning application',
      body: `Dear ${customer},\n\nYour application is progressing well and looks likely to be approved shortly. We wanted to give you a courtesy heads-up so you can take a look. We'll confirm as soon as the formal decision is issued.\n\nKind regards,\nThe Planning Team`,
    });
  } else if (/approv/.test(text)) {
    push('markDecision', { decision: 'approved', note: 'Approved by the LPA.' });
    push('generatePostApprovalTasks', {
      workstream: 'buildingRegs',
      tasks: ['Submit Building Regulations application', 'Arrange Building Control inspections', 'Prepare construction drawings'],
    });
  } else if (/refus/.test(text)) {
    push('markDecision', { decision: 'refused', note: 'Refused by the LPA — review reasons and consider appeal or resubmission.' });
  } else if (/deadline|chase|portal|status/.test(text)) {
    push('portalStatusCheck', {
      note: `Open the council portal${app?.council?.reference ? ` and search reference ${app.council.reference}` : ''} to confirm the current status, then update the application.`,
    });
  } else if (/engineer|structural/.test(text)) {
    push('generatePostApprovalTasks', {
      workstream: 'engineering',
      tasks: ['Commission structural engineer', 'Obtain structural calculations', 'Issue calcs to Building Control'],
    });
  } else if (/build.?over|sewer|water/.test(text)) {
    push('generatePostApprovalTasks', {
      workstream: 'buildOver',
      tasks: ['Identify relevant water authority', 'Submit build-over agreement application', 'Obtain consent before works near the sewer'],
    });
  } else {
    push('addComment', { body: 'Noted. (Demo mode — configure OpenAI for full autonomous actions.)' });
  }

  return {
    content:
      'Planning Agent (demo mode): I have prepared the actions above. Configure OpenAI in Settings → Integrations for full autonomous handling.',
    actions,
    mockMode: true,
  };
}

export async function handlePlanningAI(body: PlanningRequest): Promise<PlanningResult> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const { createLLMClientForOrg, defaultChatModelForProvider } = await import('./llm-connection');
  const { resolveOrgIdFromBody } = await import('../org-context');
  const orgId = resolveOrgIdFromBody(body as { orgId?: string });

  const { client: openai, provider } = await createLLMClientForOrg(orgId, '/api/ai/planning', {
    bodyOpenAIApiKey: body.apiKey,
  });
  const model = defaultChatModelForProvider(provider, body.model ?? 'gpt-4o-mini');
  const systemPrompt = buildSystemPrompt(body);

  const chatMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: m.content,
    })),
  ];

  const actions: PlanningAction[] = [];
  let finalContent: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools: PLANNING_TOOLS,
      tool_choice: 'auto',
      max_tokens: 1200,
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
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const output = echoToolResult(call.function.name, args);
      actions.push({ action: call.function.name, input: args, output });
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
          content: 'Summarise what you did in warm, concise UK English (2-5 sentences). Mention any deadlines and the next step.',
        },
      ],
      max_tokens: 500,
    });
    finalContent = summaryPass.choices[0]?.message?.content ?? null;
  }

  return {
    content: finalContent ?? 'Done — let me know what else you need on this application.',
    actions,
  };
}
