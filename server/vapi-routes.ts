/**
 * Vapi webhook adapter: assistant-request, tool-calls, transcript, status, end-of-call.
 * Reuses Cyrus phone brain + existing customer/phone tool executors.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  appendCallTurn,
  appendCustomerCallActivity,
  computeCallDurationSec,
  computeCallSentiment,
  DEFAULT_ORG_ID,
  getCallById,
  getCallByProviderId,
  getDataStore,
  isAgentActive,
  resolveContactByPhone,
  saveCall,
  setRequestOrgId,
} from './data-store';
import { appendConversationMessage } from './conversation-store';
import {
  executeCustomerTool,
  executeServerReadTool,
  SERVER_READ_TOOLS,
} from './orchestrator-tool-exec';
import { executePhoneTool, PHONE_AUTO_ACTIONS } from './phone-tools';
import type { OrchestratorRequest } from './orchestrator-types';
import {
  getVapiServerSecret,
  getVapiPublicKey,
  getVapiRegion,
  toE164Uk,
  vapiFetch,
} from './vapi-client';
import { buildStaffOrchBody } from './phone-session';
import { buildVapiAssistantForParty } from './vapi-assistant';
import { resolveTransferDestination, resolveTransferNumber } from './transfer-numbers';
import { assertVapiProductionReady, isProductionRuntime } from './provider-gates';
import {
  isToolAllowedForPhoneSession,
  resolvePhoneCallerIdentity,
  verifyStaffPhonePinForCall,
  isPhoneAuthVerified,
  looksLikePhonePinEntry,
  mergePhoneAuthMetadata,
  resolvePhoneAuthCallId,
  isIdentityBound,
} from './phone-auth';
import { listTeamMembers } from './conversation-store';
import { persistCallLanguagePreference, spokenLanguageNudge } from './phone-language';
import { normalizeLang } from './language-packs';
import { getVapiVoiceConfigForLang, voiceIdForLang } from './phone-voices';

const CUSTOMER_TOOL_NAMES = new Set([
  'lookupCustomerByPhone',
  'getAccountBriefing',
  'getLeadBrief',
  'addLeadNote',
  'listPendingCallbacks',
  'lookupQuote',
  'lookupProjectStatus',
  'getPortalLink',
  'escalateToStaff',
  'logCallActivity',
]);

const STAFF_READ_TOOL_NAMES = new Set([
  'searchCustomers',
  'searchProjects',
  'searchQuotes',
  'searchLeads',
  'getLeadBrief',
  'listPendingCallbacks',
  'getBusinessSnapshot',
  'getTeamPerformance',
]);

/** Prevent duplicate tool side-effects within a process lifetime. */
const seenToolCalls = new Map<string, number>();
const TOOL_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyVapiRequest(req: IncomingMessage): boolean {
  const secret = getVapiServerSecret();
  if (!secret) {
    // Production must never accept unauthenticated webhooks
    if (isProductionRuntime()) return false;
    return true; // allow only in explicit non-production / mock mode
  }
  const header = req.headers['x-vapi-secret']
    || req.headers['x-vapi-signature']
    || req.headers.authorization;
  if (typeof header === 'string' && header.includes(secret)) return true;
  if (typeof header === 'string' && header.trim() === secret) return true;
  if (Array.isArray(header) && header.some((h) => h.includes(secret))) return true;
  return false;
}

function partyPhoneFromCall(call: Record<string, unknown> | undefined): string {
  if (!call) return '';
  const customer = call.customer as Record<string, unknown> | undefined;
  const direction = String(call.type || call.direction || '');
  const customerNumber = String(customer?.number || '').trim();
  if (customerNumber) return toE164Uk(customerNumber);
  // outbound: customer is the party; inbound: use customer or from
  const from = String((call as { from?: string }).from || '').trim();
  const to = String((call as { to?: string }).to || '').trim();
  if (direction.toLowerCase().includes('outbound')) return toE164Uk(customerNumber || to || from);
  return toE164Uk(from || customerNumber || to);
}

function ensureCallFromVapi(message: Record<string, unknown>): Record<string, unknown> {
  setRequestOrgId(DEFAULT_ORG_ID);
  const call = (message.call || message) as Record<string, unknown>;
  const vapiId = String(call.id || message.callId || `vapi-${Date.now()}`);
  const metaIn = (call.metadata || message.metadata || {}) as Record<string, unknown>;
  const tradeproCallId = String(metaIn.tradeproCallId || '').trim();

  const byProvider = getCallByProviderId(vapiId);
  if (byProvider) {
    // Link provider id + merge any orphan UUID-as-id twin transcripts
    return mergeOrphanVapiCall(String(byProvider.id), vapiId, metaIn);
  }
  if (tradeproCallId) {
    const byTrade = getCallById(tradeproCallId);
    if (byTrade) {
      return mergeOrphanVapiCall(tradeproCallId, vapiId, {
        ...((byTrade.metadata as Record<string, unknown> | undefined) || {}),
        ...metaIn,
      });
    }
  }
  const existing = getCallById(vapiId);
  if (existing) return existing;

  const partyPhone = partyPhoneFromCall(call) || toE164Uk(String(metaIn.partyPhone || ''));
  const identity = resolvePhoneCallerIdentity(partyPhone);
  const resolved = resolveContactByPhone(partyPhone);
  const directionRaw = String(call.type || '').toLowerCase();
  const direction = directionRaw.includes('outbound') ? 'outbound' : 'inbound';

  return saveCall({
    id: tradeproCallId || vapiId,
    providerCallId: vapiId,
    provider: 'vapi',
    direction,
    from: direction === 'outbound'
      ? String(process.env.SOHO66_FROM_NUMBER || '')
      : partyPhone,
    to: direction === 'outbound' ? partyPhone : String(process.env.SOHO66_FROM_NUMBER || ''),
    status: 'in_progress',
    transcript: [],
    startedAt: new Date().toISOString(),
    contactName: identity.kind !== 'customer'
      ? identity.name
      : (resolved.customerName || resolved.contactName),
    customerId: resolved.customerId,
    metadata: {
      ...metaIn,
      vapiCallId: vapiId,
      tradeproCallId: tradeproCallId || undefined,
      partyPhone,
      callerKind: identity.kind,
      callerRole: identity.role,
      phoneAuth: identity.needsPin ? 'pending' : 'n/a',
    },
  });
}

/** Prefer TradePro call id; swallow webhook orphans that used Vapi UUID as local id. */
function mergeOrphanVapiCall(
  tradeproId: string,
  vapiId: string,
  metaIn: Record<string, unknown>,
): Record<string, unknown> {
  const primary = getCallById(tradeproId);
  const orphan = vapiId !== tradeproId ? getCallById(vapiId) : undefined;
  const primaryMeta = mergePhoneAuthMetadata(
    {
      ...((primary?.metadata as Record<string, unknown> | undefined) || {}),
      ...((orphan?.metadata as Record<string, unknown> | undefined) || {}),
    },
    metaIn,
  );
  const orphanTurns = Array.isArray(orphan?.transcript) ? orphan!.transcript as unknown[] : [];
  const primaryTurns = Array.isArray(primary?.transcript) ? primary!.transcript as unknown[] : [];
  const mergedTranscript = primaryTurns.length >= orphanTurns.length
    ? primaryTurns
    : orphanTurns;

  const saved = saveCall({
    id: tradeproId,
    providerCallId: vapiId,
    provider: 'vapi',
    ...(orphan?.recordingUrl && !primary?.recordingUrl ? { recordingUrl: orphan.recordingUrl } : {}),
    ...(orphan?.contactName && !primary?.contactName ? { contactName: orphan.contactName } : {}),
    ...(orphan?.customerId && !primary?.customerId ? { customerId: orphan.customerId } : {}),
    transcript: mergedTranscript,
    metadata: {
      ...primaryMeta,
      vapiCallId: vapiId,
      tradeproCallId: tradeproId,
    },
  });

  if (orphan && String(orphan.id) !== tradeproId) {
    saveCall({
      id: String(orphan.id),
      status: 'merged',
      metadata: {
        ...mergePhoneAuthMetadata(
          (orphan.metadata as Record<string, unknown> | undefined) || {},
          { mergedInto: tradeproId },
        ),
        mergedInto: tradeproId,
      },
    });
  }
  return saved;
}

function finalizeVapiCall(
  callId: string,
  message: Record<string, unknown>,
  partyPhone: string,
): void {
  const existing = getCallById(callId);
  const existingTurns = Array.isArray(existing?.transcript) ? existing!.transcript.length : 0;
  const artifact = message.artifact as Record<string, unknown> | undefined;
  const messages = Array.isArray(artifact?.messages)
    ? artifact!.messages as Array<Record<string, unknown>>
    : Array.isArray(message.messages)
      ? message.messages as Array<Record<string, unknown>>
      : [];

  if (existingTurns < 2 && messages.length) {
    for (const m of messages) {
      const rawRole = String(m.role || '').toLowerCase();
      if (rawRole === 'system') continue;
      const role: 'user' | 'assistant' = rawRole === 'assistant' ? 'assistant' : 'user';
      const text = String(m.message || m.content || '').trim();
      if (text) persistTranscriptTurn(callId, partyPhone, role, text);
    }
  }

  // Fallback: full transcript string from Vapi
  const refreshed = getCallById(callId);
  const turnsNow = Array.isArray(refreshed?.transcript) ? refreshed!.transcript.length : 0;
  const transcriptBlob = String(message.transcript || artifact?.transcript || '').trim();
  if (turnsNow < 2 && transcriptBlob) {
    for (const line of transcriptBlob.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      let role: 'user' | 'assistant' = 'user';
      let text = trimmed;
      if (lower.startsWith('ai:') || lower.startsWith('assistant:') || lower.startsWith('bot:')) {
        role = 'assistant';
        text = trimmed.replace(/^(ai|assistant|bot):\s*/i, '');
      } else if (lower.startsWith('user:') || lower.startsWith('customer:') || lower.startsWith('caller:')) {
        role = 'user';
        text = trimmed.replace(/^(user|customer|caller):\s*/i, '');
      }
      if (text) persistTranscriptTurn(callId, partyPhone, role, text);
    }
  }

  const summary = String(
    message.summary
    || (message.analysis as Record<string, unknown> | undefined)?.summary
    || '',
  ).trim();
  const recordingUrl = String(
    artifact?.recordingUrl
    || message.recordingUrl
    || '',
  ).trim() || undefined;
  const endedReason = String(message.endedReason || message.ended_reason || message.reason || '');

  const after = getCallById(callId);
  saveCall({
    id: callId,
    status: 'completed',
    endedAt: new Date().toISOString(),
    recordingUrl: recordingUrl || (after?.recordingUrl as string | undefined),
    outcome: endedReason || (after?.outcome as string | undefined),
    sentiment: after ? computeCallSentiment(after) : undefined,
    durationSec: after ? computeCallDurationSec(after) : undefined,
    metadata: {
      ...((after?.metadata as Record<string, unknown> | undefined) || {}),
      vapiEndedReason: endedReason || undefined,
      vapiSummary: summary || undefined,
    },
  });

  const afterMeta = (after?.metadata as Record<string, unknown> | undefined) || {};
  const resolved = resolveContactByPhone(partyPhone);
  const customerId = resolved.customerId
    || (afterMeta.customerId != null ? String(afterMeta.customerId) : null)
    || (after?.customerId != null ? String(after.customerId) : null);
  if (customerId && summary) {
    appendCustomerCallActivity({
      customerId,
      callId,
      summary: summary.slice(0, 400),
      outcome: endedReason || undefined,
      aim: afterMeta.aim != null ? String(afterMeta.aim) : undefined,
      detail: summary.slice(0, 800),
      type: 'call',
    });
  }
}

function buildTransientAssistant(message: Record<string, unknown>) {
  const call = ensureCallFromVapi(message);
  const partyPhone = String((call.metadata as Record<string, unknown> | undefined)?.partyPhone
    || partyPhoneFromCall(message.call as Record<string, unknown>)
    || '');
  const direction = (call.direction as 'inbound' | 'outbound') || 'outbound';
  const identity = resolvePhoneCallerIdentity(partyPhone);
  const { assistant } = buildVapiAssistantForParty({
    partyPhone,
    direction,
    campaignTemplate: call.campaignTemplate ? String(call.campaignTemplate) : undefined,
    callId: String(call.id),
    contactName: identity.kind !== 'customer'
      ? identity.name
      : String(call.contactName || ''),
  });
  saveCall({
    id: String(call.id),
    metadata: {
      ...((call.metadata as Record<string, unknown> | undefined) || {}),
      callerKind: identity.kind,
      callerRole: identity.role,
      phoneAuth: isPhoneAuthVerified(String(call.id))
        ? 'verified'
        : (identity.needsPin ? 'pending' : 'n/a'),
    },
    contactName: identity.kind !== 'customer' ? identity.name : (call.contactName as string | undefined),
  });
  return assistant;
}

function parseToolCalls(message: Record<string, unknown>): Array<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  const list: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const toolCallList = Array.isArray(message.toolCallList)
    ? message.toolCallList as Array<Record<string, unknown>>
    : Array.isArray(message.toolWithToolCallList)
      ? (message.toolWithToolCallList as Array<Record<string, unknown>>).map((row) => row.toolCall as Record<string, unknown>).filter(Boolean)
      : [];

  for (const item of toolCallList) {
    const id = String(item.id || item.toolCallId || '');
    const fn = (item.function as Record<string, unknown> | undefined) || item;
    const name = String(fn.name || item.name || '');
    let args: Record<string, unknown> = {};
    const rawArgs = fn.arguments ?? item.arguments ?? item.parameters;
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs || '{}') as Record<string, unknown>; } catch { args = {}; }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs as Record<string, unknown>;
    }
    if (id && name) list.push({ id, name, arguments: args });
  }

  // Older shape: message.toolCalls
  if (!list.length && Array.isArray(message.toolCalls)) {
    for (const item of message.toolCalls as Array<Record<string, unknown>>) {
      const id = String(item.id || '');
      const fn = item.function as Record<string, unknown> | undefined;
      const name = String(fn?.name || '');
      let args: Record<string, unknown> = {};
      const rawArgs = fn?.arguments;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs || '{}') as Record<string, unknown>; } catch { args = {}; }
      }
      if (id && name) list.push({ id, name, arguments: args });
    }
  }

  return list;
}

function shouldSkipDuplicateTool(callId: string, toolCallId: string): boolean {
  const key = `${callId}:${toolCallId}`;
  const now = Date.now();
  for (const [k, ts] of seenToolCalls) {
    if (now - ts > TOOL_IDEMPOTENCY_TTL_MS) seenToolCalls.delete(k);
  }
  if (seenToolCalls.has(key)) return true;
  seenToolCalls.set(key, now);
  return false;
}

function buildStaffOrchBodyFromCall(
  call: Record<string, unknown>,
  callId: string,
  partyPhone: string,
  identity: ReturnType<typeof resolvePhoneCallerIdentity>,
): OrchestratorRequest {
  return buildStaffOrchBody({ call, callId, partyPhone, identity, orgId: DEFAULT_ORG_ID });
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  call: Record<string, unknown>,
  partyPhone: string,
): Promise<Record<string, unknown>> {
  const callId = resolvePhoneAuthCallId(String(call.id));
  const identity = resolvePhoneCallerIdentity(partyPhone);

  if (!isToolAllowedForPhoneSession(name, callId, identity)) {
    if (isPhoneAuthVerified(callId) && !isIdentityBound(identity)) {
      return {
        error: 'Staff identity is not bound to a profile UUID — privileged tools unavailable',
        code: 'identity_not_bound',
        phoneAuth: 'verified',
      };
    }
    return {
      error: 'Phone PIN required — ask the caller to enter their security code, then call verifyStaffPhonePin',
      phoneAuth: 'pending',
    };
  }

  if (name === 'verifyStaffPhonePin') {
    const result = verifyStaffPhonePinForCall(callId, partyPhone, String(args.pin ?? args.code ?? ''));
    if (result.verified) {
      return {
        ...result,
        phoneAuth: 'verified',
        userId: identity.userId,
        identityBound: isIdentityBound(identity),
        hint: isIdentityBound(identity)
          ? 'Unlocked. Use getBusinessSnapshot, searchCustomers (query list), searchQuotes, lookupQuote, getTeamPerformance, saveQuote, sendCustomerMessage, sendToStaffCynthia, bookCallback. Prefer spokenTotal/spokenHint for money. Speak real CRM answers — do not say you cannot access data.'
          : 'PIN accepted but this phone is not bound to a profiles.id — ask an admin to fix Team registration before CRM tools work.',
      };
    }
    return result;
  }

  if (name === 'endCall') {
    const existing = getCallById(callId);
    if (existing?.status === 'completed' || existing?.endedAt) {
      return { ended: true, shouldHangup: true, alreadyEnded: true, reason: args.reason || 'agent_ended' };
    }
    saveCall({
      id: callId,
      status: 'completed',
      endedAt: new Date().toISOString(),
      outcome: String(args.reason || 'agent_ended'),
    });
    return { ended: true, shouldHangup: true, reason: args.reason || 'agent_ended' };
  }

  if (name === 'setCallLanguage') {
    const { language, persisted } = await persistCallLanguagePreference(
      identity,
      String(args.language || args.lang || 'en'),
    );
    const voiceId = voiceIdForLang(language);
    const voiceConfig = getVapiVoiceConfigForLang(language);
    const fresh = getCallById(callId);
    const meta = ((fresh?.metadata as Record<string, unknown> | undefined) || {});
    const vapiCallId = String(
      call.providerCallId
      || meta.vapiCallId
      || (fresh as { providerCallId?: string } | undefined)?.providerCallId
      || call.id
      || '',
    ).trim();

    let voiceUpdated = false;
    if (vapiCallId) {
      try {
        const patch = await vapiFetch(`/call/${vapiCallId}`, {
          method: 'PATCH',
          body: JSON.stringify({ voice: voiceConfig }),
        });
        voiceUpdated = patch.ok;
        if (!patch.ok) {
          console.warn(
            `[setCallLanguage] voice PATCH failed status=${patch.status} call=${vapiCallId}`,
            patch.raw?.slice?.(0, 200),
          );
        }
      } catch (err) {
        console.warn('[setCallLanguage] voice PATCH error:', err instanceof Error ? err.message : err);
      }
    }

    saveCall({
      id: callId,
      metadata: {
        ...meta,
        callLanguage: language,
        callVoiceId: voiceId,
        callVoiceUpdated: voiceUpdated,
      },
    });
    return {
      ok: true,
      language,
      voiceId,
      voiceUpdated,
      remembered: persisted,
      instruction: spokenLanguageNudge(language),
      sayFirst: spokenLanguageNudge(language),
      normalized: normalizeLang(language),
    };
  }

  if (name === 'transferToHuman') {
    const takeMessage = Boolean(args.takeMessage);
    const department = String(args.department || 'general');
    const transferNumber = resolveTransferNumber(department);
    const destination = !takeMessage
      ? resolveTransferDestination({
          department,
          reason: String(args.reason || args.message || ''),
          message: String(args.message || ''),
        })
      : null;
    const willTransfer = Boolean(destination) && !takeMessage;
    const fresh = getCallById(callId);
    saveCall({
      id: callId,
      outcome: willTransfer ? 'transferred' : 'message_taken',
      ...(willTransfer ? { status: 'transferred' } : {}),
      transferredTo: department,
      metadata: {
        ...((fresh?.metadata as Record<string, unknown> | undefined) || {}),
        transferNumber: transferNumber || undefined,
        transferMode: willTransfer ? 'warm-transfer-experimental' : undefined,
      },
    });
    return {
      transferred: willTransfer,
      transferNumber: transferNumber || null,
      department: args.department ?? 'general',
      message: args.message ?? args.reason,
      takeMessage: takeMessage || !destination,
      destination: destination || undefined,
    };
  }

  const orchBody = buildStaffOrchBodyFromCall(call, callId, partyPhone, identity);

  if (CUSTOMER_TOOL_NAMES.has(name)) {
    return executeCustomerTool(name, args, orchBody);
  }
  if (STAFF_READ_TOOL_NAMES.has(name) || SERVER_READ_TOOLS.has(name)) {
    return executeServerReadTool(name, args, orchBody);
  }
  if (PHONE_AUTO_ACTIONS.has(name)) {
    return executePhoneTool(name, args, orchBody);
  }
  const customerTry = executeCustomerTool(name, args, orchBody);
  if (customerTry && Object.keys(customerTry).length > 0) return customerTry;
  return executePhoneTool(name, args, orchBody);
}

function persistTranscriptTurn(
  callId: string,
  partyPhone: string,
  role: 'user' | 'assistant',
  text: string,
) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const identity = resolvePhoneCallerIdentity(partyPhone);
  const isStaffParty = identity.kind === 'staff' || identity.kind === 'foreman';
  const resolved = isStaffParty
    ? { customerId: null as string | null, customerName: identity.name || '', contactName: identity.name || '' }
    : resolveContactByPhone(partyPhone);
  const turnRole = role === 'user' ? 'caller' : 'agent';
  appendCallTurn(callId, { role: turnRole, content: trimmed });
  appendConversationMessage(
    DEFAULT_ORG_ID,
    partyPhone,
    {
      role,
      content: trimmed,
      bodyEnglish: trimmed,
      channel: 'phone',
    },
    {
      channel: 'phone',
      contactName: resolved.customerName || resolved.contactName || identity.name,
    },
  );
  const updated = getCallById(callId);
  if (updated) {
    saveCall({
      id: callId,
      contactName: resolved.customerName || resolved.contactName || identity.name,
      customerId: resolved.customerId || undefined,
      sentiment: computeCallSentiment(updated),
      durationSec: computeCallDurationSec(updated),
    });
  }
  // Never append staff handset chatter onto a CRM customer row that shares the same phone.
  if (!isStaffParty && resolved.customerId && role === 'user') {
    appendCustomerCallActivity({
      customerId: resolved.customerId,
      callId,
      summary: `Caller: ${trimmed.slice(0, 200)}`,
    });
  }
}

async function handleVapiMessage(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  if (!verifyVapiRequest(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (!isAgentActive()) {
    sendJson(res, 503, { error: 'Agent inactive' });
    return;
  }

  const message = (body.message || body) as Record<string, unknown>;
  const type = String(message.type || body.type || '');

  if (type === 'assistant-request') {
    const assistant = buildTransientAssistant(message);
    sendJson(res, 200, { assistant });
    return;
  }

  if (type === 'tool-calls' || type === 'function-call') {
    const call = ensureCallFromVapi(message);
    const partyPhone = String((call.metadata as Record<string, unknown> | undefined)?.partyPhone
      || partyPhoneFromCall(message.call as Record<string, unknown>)
      || '');
    const tools = parseToolCalls(message);
    const results = await Promise.all(tools.map(async (tool) => {
      if (shouldSkipDuplicateTool(String(call.id), tool.id)) {
        return {
          toolCallId: tool.id,
          result: JSON.stringify({ ok: true, deduped: true }),
        };
      }
      try {
        const output = await executeTool(tool.name, tool.arguments, call, partyPhone);
        return {
          toolCallId: tool.id,
          result: JSON.stringify(output),
        };
      } catch (err) {
        return {
          toolCallId: tool.id,
          result: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        };
      }
    }));
    sendJson(res, 200, { results });
    return;
  }

  if (type === 'transcript' || type === 'conversation-update') {
    const call = ensureCallFromVapi(message);
    const partyPhone = String((call.metadata as Record<string, unknown> | undefined)?.partyPhone
      || partyPhoneFromCall(message.call as Record<string, unknown>)
      || '');
    const roleRaw = String(message.role || message.transcriptType || '').toLowerCase();
    const text = String(message.transcript || message.text || message.content || '').trim();
    const role: 'user' | 'assistant' = roleRaw.includes('assist') || roleRaw === 'bot' || roleRaw === 'agent'
      ? 'assistant'
      : 'user';
    // Only persist final transcripts when marked, or any non-empty when type=transcript
    const isFinal = message.transcriptType === 'final' || message.isFinal === true || type === 'transcript';
    if (text && isFinal) {
      persistTranscriptTurn(String(call.id), partyPhone, role, text);
      // Spoken (or keypad-as-speech) PIN: auto-verify without waiting for the model tool call
      if (role === 'user' && looksLikePhonePinEntry(text)) {
        const identity = resolvePhoneCallerIdentity(partyPhone);
        if (identity.needsPin && !isPhoneAuthVerified(String(call.id))) {
          verifyStaffPhonePinForCall(String(call.id), partyPhone, text);
        }
      }
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (type === 'status-update') {
    const call = ensureCallFromVapi(message);
    const status = String(message.status || '').toLowerCase();
    const mapped = status.includes('end') || status === 'ended' || status === 'completed'
      ? 'completed'
      : status.includes('fail')
        ? 'failed'
        : status.includes('ring')
          ? 'ringing'
          : 'in_progress';
    saveCall({
      id: call.id,
      status: mapped,
      ...(mapped === 'completed' || mapped === 'failed'
        ? { endedAt: new Date().toISOString() }
        : {}),
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (type === 'end-of-call-report' || type === 'hang') {
    const call = ensureCallFromVapi(message);
    const partyPhone = String((call.metadata as Record<string, unknown> | undefined)?.partyPhone
      || partyPhoneFromCall(message.call as Record<string, unknown>)
      || '');
    finalizeVapiCall(String(call.id), message, partyPhone);
    sendJson(res, 200, { ok: true });
    return;
  }

  // unknown — acknowledge
  sendJson(res, 200, { ok: true });
}

export async function handleVapiWebSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const health = assertVapiProductionReady();
  if (!health.ok && isProductionRuntime()) {
    sendJson(res, 503, { error: 'Vapi/AI stack not connected', code: 'provider_unavailable', details: health.errors });
    return;
  }
  const publicKey = getVapiPublicKey();
  if (!publicKey) {
    sendJson(res, 503, { error: 'VAPI_PUBLIC_KEY is not configured', code: 'provider_unavailable' });
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const headerUser = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
  const headerOrg = typeof req.headers['x-org-id'] === 'string' ? req.headers['x-org-id'].trim() : '';
  const staffUserId = String(body.userId || headerUser || '').trim();
  const orgId = String(body.orgId || headerOrg || DEFAULT_ORG_ID).trim();
  if (!staffUserId) {
    sendJson(res, 401, { error: 'Authenticated userId required', code: 'staff_not_resolved' });
    return;
  }

  setRequestOrgId(orgId);
  const member = listTeamMembers(orgId).find((m) => String(m.userId || m.id) === staffUserId);
  const partyPhone = String(body.staffPhone || member?.phone || '').trim();
  if (!partyPhone) {
    sendJson(res, 422, {
      error: 'Staff phone not registered — set phone on Team profile for Cynthia voice',
      code: 'identity_not_bound',
    });
    return;
  }

  const callId = `cynthia-voice-${Date.now()}`;
  saveCall({
    id: callId,
    direction: 'inbound',
    status: 'in_progress',
    from: partyPhone,
    to: 'cynthia_voice',
    contactName: member?.name || 'Staff',
    startedAt: new Date().toISOString(),
    metadata: {
      channel: 'cynthia_voice',
      staffUserId,
      orgId,
      partyPhone: toE164Uk(partyPhone),
    },
  });

  const { assistant, identity, verified } = buildVapiAssistantForParty({
    partyPhone: toE164Uk(partyPhone),
    direction: 'inbound',
    callId,
    contactName: member?.name,
  });

  sendJson(res, 200, {
    ok: true,
    publicKey,
    region: getVapiRegion(),
    callId,
    staffUserId,
    orgId,
    identity: { kind: identity.kind, role: identity.role, name: identity.name, userId: identity.userId },
    verified,
    assistant,
  });
}

export async function handleVapiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/vapi/web-session' && req.method === 'POST') {
    await handleVapiWebSession(req, res);
    return true;
  }
  if (pathname === '/api/vapi/health' && req.method === 'GET') {
    const health = assertVapiProductionReady();
    sendJson(res, health.ok ? 200 : 503, health);
    return true;
  }
  if (pathname !== '/webhooks/vapi' && pathname !== '/api/vapi/webhook') {
    return false;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  if (!verifyVapiRequest(req)) {
    sendJson(res, 401, { error: 'Invalid or missing Vapi webhook secret' });
    return true;
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return true;
  }

  try {
    await handleVapiMessage(req, res, body);
  } catch (err) {
    console.error('[vapi] webhook error', err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
