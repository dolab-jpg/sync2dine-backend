import { handleOrchestrator } from './orchestrator-handler';
import { resolveInboundChannel, type ChannelRoute } from './channel-router';
import {
  appendConversationMessage,
  conversationToOrchestratorMessages,
  getHandoffMode,
} from './conversation-store';
import {
  normalizeInboundText,
  localizeOutboundText,
  getSystemInstruction,
  getPhrase,
  normalizeLang,
} from './translation-service';
import {
  executeChannelActions,
  filterActionsForChannelMode,
  handleConfirmationReply,
  appendProjectAiAction,
} from './channel-action-executor';
import { getDataStore, setRequestOrgId } from './data-store';
import { readStudioConfigExport } from './ai-studio-routes';
import { executeBusinessSnapshot } from './orchestrator-tool-exec';
import { getOfficeTeamRoster } from './team-snapshot';
import { buildBritishVoicePrompt, formatKnowledgeChunks } from './british-voice';
import type { ServerAgentRole } from './role-permissions';
import type { OrchestratorRequest } from './orchestrator-types';
import { OpenAIConnectionError, requireOpenAIApiKeyAsync } from './openai-connection';

export type ChannelInboundChannel = 'whatsapp' | 'phone' | 'app' | 'web' | 'portal' | 'email';

export interface ChannelInboundRequest {
  orgId: string;
  phone: string;
  text: string;
  channel: ChannelInboundChannel;
  contactName?: string;
  projectId?: string | null;
  voiceReply?: boolean;
  apiKey?: string;
  model?: string;
  /** When true, skip AI even if handoff is ai_active (used for staff composer logs). */
  skipAi?: boolean;
  /**
   * Extra facts for the AI brain (customer/company/account). Not stored as a user message.
   * The model should answer from this + conversation memory — not ask the caller to repeat known facts.
   */
  brainContext?: string;
  /** When false, do not persist `text` as a user turn (e.g. synthetic call-connected prompts). */
  persistUser?: boolean;
}

export interface ChannelInboundResult {
  replyEnglish: string;
  replyLocalized: string;
  detectedLanguage: string;
  route: ChannelRoute;
  toolsUsed: string[];
  executedSummaries: string[];
}

function buildStaffContext(orgId: string, route: ChannelRoute): OrchestratorRequest['staffContext'] {
  const store = getDataStore(orgId);
  const staffContext: NonNullable<OrchestratorRequest['staffContext']> = {
    role: route.role ?? 'staff',
    userId: route.userId,
    userName: route.name,
    route: '/',
    customers: store.customers.slice(0, 200).map((c) => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      email: String(c.email ?? ''),
      phone: String(c.phone ?? ''),
      status: String(c.status ?? ''),
      source: c.source ? String(c.source) : undefined,
      notes: c.notes ? String(c.notes) : undefined,
    })),
    quotes: (store.quotes ?? []).slice(0, 200).map((q) => ({
      id: String(q.id ?? ''),
      customerId: String(q.customerId ?? ''),
      customerName: String(q.customerName ?? ''),
      tradeName: q.tradeName ? String(q.tradeName) : undefined,
      total: Number(q.total ?? 0),
      status: String(q.status ?? ''),
    })),
  };
  return staffContext;
}

function buildBusinessSnapshot(orgId: string, staffContext: OrchestratorRequest['staffContext']): OrchestratorRequest['businessSnapshot'] {
  const body: OrchestratorRequest = { messages: [], staffContext };
  const snapshot = executeBusinessSnapshot(body);
  return {
    ...snapshot,
    officeTeamRoster: getOfficeTeamRoster(),
  };
}

function resolveOrchestratorMode(route: ChannelRoute): OrchestratorRequest['orchestratorMode'] {
  if (route.mode === 'staff') return 'staff';
  if (route.mode === 'foreman') return 'foreman';
  if (route.mode === 'customer') return 'cyrus';
  return 'cyrus';
}

function resolveRole(route: ChannelRoute): ServerAgentRole {
  if (route.mode === 'staff') return (route.role as ServerAgentRole) ?? 'staff';
  if (route.mode === 'foreman') return 'builder';
  if (route.mode === 'customer') return 'customer';
  return 'unknown';
}

function buildChannelPrompt(channel: string, route: ChannelRoute): string {
  const base = channel === 'whatsapp'
    ? (route.mode === 'staff' ? 'whatsapp_staff' : route.mode === 'customer' ? 'whatsapp_customer' : 'whatsapp')
    : channel === 'phone'
      ? (route.mode === 'staff' ? 'phone_staff' : 'phone')
      : channel === 'web' || channel === 'portal'
        ? 'customer_portal'
        : 'overlay_chat';
  return base;
}

export async function handleChannelInbound(req: ChannelInboundRequest): Promise<ChannelInboundResult> {
  const { orgId, phone, text, channel, projectId } = req;
  setRequestOrgId(orgId);

  const route = resolveInboundChannel(phone, orgId);
  const handoffMode = getHandoffMode(orgId, phone);

  // Staff takeover: store inbound only, no auto-Cyrus reply
  if (req.skipAi || handoffMode === 'human_takeover') {
    const lang = normalizeLang(route.preferredLanguage);
    appendConversationMessage(orgId, phone, {
      role: 'user',
      content: text,
      bodyEnglish: text,
      detectedLanguage: lang,
      channel,
    }, { channel, contactName: req.contactName });
    const notice = handoffMode === 'human_takeover'
      ? 'Thanks — a team member will reply shortly.'
      : '';
    if (notice) {
      appendConversationMessage(orgId, phone, {
        role: 'assistant',
        content: notice,
        bodyEnglish: notice,
        channel,
        fromRole: 'system',
      }, { channel });
    }
    return {
      replyEnglish: notice,
      replyLocalized: notice,
      detectedLanguage: lang,
      route,
      toolsUsed: [],
      executedSummaries: ['human_takeover'],
    };
  }

  const confirm = await handleConfirmationReply(orgId, phone, text, {
    role: resolveRole(route),
    orgId,
    phone,
    approvedBy: route.name,
  });
  if (confirm.handled) {
    const lang = normalizeLang(route.preferredLanguage);
    const replyEnglish = confirm.reply ?? getPhrase(lang, 'done');
    const replyLocalized = await localizeOutboundText(replyEnglish, lang, orgId);
    appendConversationMessage(orgId, phone, {
      role: 'user',
      content: text,
      bodyEnglish: text,
      detectedLanguage: lang,
      channel,
    }, { channel, contactName: req.contactName });
    appendConversationMessage(orgId, phone, {
      role: 'assistant',
      content: replyLocalized,
      bodyEnglish: replyEnglish,
      channel,
    }, { channel });
    return {
      replyEnglish,
      replyLocalized,
      detectedLanguage: lang,
      route,
      toolsUsed: confirm.results?.map((r) => r.action) ?? [],
      executedSummaries: confirm.results?.map((r) => r.summary) ?? [],
    };
  }

  // Resolve org OpenAI key up front — no silent mock for live Cyrus channels
  let resolvedApiKey = req.apiKey;
  try {
    resolvedApiKey = await requireOpenAIApiKeyAsync(req.apiKey, orgId);
  } catch (err) {
    if (err instanceof OpenAIConnectionError) throw err;
    throw err;
  }

  const targetLang = normalizeLang(route.preferredLanguage);
  const normalized = await normalizeInboundText(text, targetLang, orgId);
  const history = conversationToOrchestratorMessages(orgId, phone, 20);
  const studio = readStudioConfigExport();
  const humourLevel = String(studio?.humourLevel ?? 'balanced');
  const companyInstructions = String(studio?.companyInstructions ?? '');

  if (req.persistUser !== false) {
    appendConversationMessage(orgId, phone, {
      role: 'user',
      content: text,
      bodyEnglish: normalized.english,
      detectedLanguage: targetLang,
      channel,
    }, { channel, contactName: req.contactName });
  }

  const channelKey = buildChannelPrompt(channel, route);
  const orchestratorChannel: OrchestratorRequest['channel'] =
    channelKey === 'whatsapp_staff' || channelKey === 'phone_staff'
      ? channelKey
      : channelKey === 'overlay_chat'
        ? 'overlay_chat'
        : 'customer_portal';
  const resolvedRole = resolveRole(route);
  const knowledgeChunks = Array.isArray(studio?.knowledgeChunks) ? studio.knowledgeChunks as unknown[] : [];
  const knowledgeBlock = formatKnowledgeChunks(knowledgeChunks);
  const rawLanguageInstruction = getSystemInstruction(targetLang);
  // Staff/foreman may chat in their own language, but that must never bleed into tool calls,
  // CRM writes, or customer-facing text (see FORMAL_TOOL_OUTPUT_RULE) — scope the instruction
  // explicitly so the per-language pack line can't be read as covering the whole reply.
  const languageInstruction =
    (route.mode === 'staff' || route.mode === 'foreman') && targetLang !== 'en'
      ? `LANGUAGE FOR YOUR SPOKEN/TYPED REPLY TO THIS COLLEAGUE ONLY (never for tool calls, CRM writes, documents, or any customer-facing text — those always stay in formal UK English): ${rawLanguageInstruction}`
      : rawLanguageInstruction;
  const brainBlock = String(req.brainContext || '').trim();
  const voicePrompt = [
    buildBritishVoicePrompt(
      String(studio?.humourLevel ?? 'balanced'),
      resolvedRole,
      [companyInstructions, knowledgeBlock, brainBlock].filter(Boolean).join('\n\n') || undefined,
      orchestratorChannel === 'whatsapp_staff' || orchestratorChannel === 'phone_staff'
        ? orchestratorChannel
        : channel === 'whatsapp'
          ? 'whatsapp'
          : channel === 'phone'
            ? 'phone'
            : 'customer_portal',
    ),
    languageInstruction,
    channel === 'phone'
      ? 'Live phone call: reply in 1-3 short spoken sentences only. No lists, markdown, or mentions of tools. Use the account and company memory you already have.'
      : '',
  ].filter(Boolean).join('\n\n');

  const staffContext = route.mode === 'staff' || route.mode === 'foreman'
    ? buildStaffContext(orgId, route)
    : undefined;

  const orchestratorBody: OrchestratorRequest = {
    messages: [...history, { role: 'user', content: normalized.english }],
    orchestratorMode: resolveOrchestratorMode(route),
    channel: orchestratorChannel,
    voicePrompt,
    apiKey: req.apiKey,
    model: req.model ?? 'gpt-4o-mini',
    aiStudio: {
      humourLevel,
      companyInstructions,
      knowledgeChunks,
      autonomyLevel: (studio?.autonomyLevel as OrchestratorRequest['aiStudio'] extends { autonomyLevel?: infer A } ? A : never) ?? 'autopilot',
    },
    businessSnapshot: staffContext ? buildBusinessSnapshot(orgId, staffContext) : undefined,
    staffContext,
    customerContext: route.mode === 'customer' || route.mode === 'unknown'
      ? {
          customerId: route.customerId,
          customerName: route.customerName,
          contactName: route.contactName ?? req.contactName,
          phone,
          projectId: projectId ?? route.projectId,
          role: 'customer',
        }
      : undefined,
    projectContext: projectId
      ? (() => {
          const p = getDataStore(orgId).projects.find((x) => String(x.id) === projectId);
          return p
            ? {
                projectId: String(p.id),
                projectName: String(p.projectName ?? 'Project'),
                customerId: String(p.customerId ?? ''),
                status: String(p.status ?? ''),
              }
            : undefined;
        })()
      : undefined,
  };

  const result = await handleOrchestrator(orchestratorBody);
  const allActions = [...result.proposedActions, ...(result.autoActions ?? [])];
  const filtered = filterActionsForChannelMode(allActions, route.mode === 'unknown' ? 'customer' : route.mode);

  const executed = await executeChannelActions(filtered, {
    role: resolveRole(route),
    orgId,
    phone,
    approvedBy: route.name,
    orchestratorBody,
  });

  const executedSummaries = executed.filter((e) => e.executed).map((e) => e.summary);
  const pendingConfirm = executed.find((e) => e.needsConfirm);
  let replyText = result.content ?? '';
  if (pendingConfirm?.confirmPrompt) {
    const confirmLine = targetLang === 'en'
      ? pendingConfirm.confirmPrompt
      : getPhrase(targetLang, 'confirm_yes_no');
    replyText = `${replyText}\n\n${confirmLine}`.trim();
  }
  if (executedSummaries.length) {
    const actionBlock = executedSummaries.join('\n');
    replyText = replyText ? `${replyText}\n\n${actionBlock}` : actionBlock;
  }
  if (!replyText.trim()) {
    replyText = getPhrase(targetLang, 'greeting');
  }

  const replyLocalized = await localizeOutboundText(replyText, targetLang, orgId);

  appendConversationMessage(orgId, phone, {
    role: 'assistant',
    content: replyLocalized,
    bodyEnglish: replyText,
    channel,
  }, { channel });

  const pid = projectId ?? route.projectId;
  if (pid && executed.some((e) => e.executed)) {
    appendProjectAiAction(String(pid), {
      id: `AI${Date.now()}`,
      action: 'channelExecute',
      input: { channel, phone, route: route.mode },
      output: { executed: executedSummaries, toolsUsed: executed.map((e) => e.action) },
      status: 'approved',
      createdAt: new Date().toISOString(),
    });
  }

  return {
    replyEnglish: replyText,
    replyLocalized,
    detectedLanguage: targetLang,
    route,
    toolsUsed: executed.map((e) => e.action),
    executedSummaries,
  };
}
