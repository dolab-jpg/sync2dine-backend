/**
 * Vapi webhook adapter: assistant-request, tool-calls, transcript, status, end-of-call.
 * Reuses Cyrus phone brain + existing customer/phone tool executors.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { appendFileSync } from 'fs';
import {
  appendCallTurn,
  appendCustomerCallActivity,
  completeOutboundJobsForCall,
  computeCallDurationSec,
  computeCallSentiment,
  ensureGuestCustomerForCall,
  getAgentCapacitySnapshot,
  getAgentSettings,
  getCallById,
  getCallByProviderId,
  getDataStore,
  isAgentActive,
  resolveContactByPhone,
  saveCall,
  setRequestOrgId,
  stampCustomerLastRecording,
} from '../data-store';
import { mapEndedReasonToDisposition } from './lead-call-disposition';
import { appendConversationMessage } from '../conversation-store';
import {
  executeCustomerTool,
  executeServerReadTool,
  SERVER_READ_TOOLS,
} from '../orchestrator-tool-exec';
import { executePhoneTool, PHONE_AUTO_ACTIONS } from './phone-tools';
import { backfillCallRecordingOnFinalize } from './call-recording-backfill';
import {
  extractRecordingUrls,
  lineDidForDirection,
  preferredRecordingUrl,
} from '../call-recording-artifacts';
import { ingestCallRecording } from './call-recording-store';
import type { OrchestratorRequest } from '../orchestrator-types';
import { getDemoKitchenOrgId } from '../home-org';
import {
  resolveInboundDidRoute,
  type InboundDidRoute,
} from './phone-lines';
import {
  getVapiServerSecret,
  getVapiPublicKey,
  getVapiRegion,
  toE164Uk,
  vapiFetch,
} from './vapi-client';
import { buildStaffOrchBody } from './phone-session';
import { buildVapiAssistantForParty } from './vapi-assistant';
import { SALLY_PERSONA } from './sally-sales-phone';
import { resolveTransferDestination, resolveTransferNumber } from './transfer-numbers';
import { assertVapiProductionReady, isProductionRuntime } from '../provider-gates';
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
import { listTeamMembers } from '../conversation-store';
import { persistCallLanguagePreference, spokenLanguageNudge } from './phone-language';
import { normalizeLang } from '../language-packs';
import { getVapiVoiceConfigForLang, voiceIdForLang } from './phone-voices';
import { languageFriendName } from './phone-language-friends';

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
/** Prior tool JSON results for safe dedupe (never invent ok:true). */
const seenToolResults = new Map<string, string>();
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

/** Structured Vapi webhook audit → /tmp/vapi-webhook-audit.log */
function auditVapiWebhook(payload: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...payload });
  console.log('[vapi-audit]', line);
  try {
    appendFileSync('/tmp/vapi-webhook-audit.log', `${line}\n`);
  } catch (err) {
    console.warn('[vapi-audit] write failed', err instanceof Error ? err.message : err);
  }
}

function verifyVapiRequest(req: IncomingMessage): boolean {
  const secret = getVapiServerSecret();
  if (!secret) {
    // Production must never accept unauthenticated webhooks
    if (isProductionRuntime()) {
      auditVapiWebhook({ event: 'auth_reject', reason: 'missing_VAPI_SERVER_SECRET' });
      return false;
    }
    return true; // allow only in explicit non-production / mock mode
  }
  const header = req.headers['x-vapi-secret']
    || req.headers['x-vapi-signature']
    || req.headers.authorization;
  if (typeof header === 'string' && header.includes(secret)) return true;
  if (typeof header === 'string' && header.trim() === secret) return true;
  if (Array.isArray(header) && header.some((h) => h.includes(secret))) return true;
  auditVapiWebhook({
    event: 'auth_reject',
    reason: 'secret_mismatch',
    hasHeader: Boolean(header),
  });
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

/**
 * Resolve org from trusted inbound DID (call meta / Vapi phoneNumber).
 * Never trusts LLM-supplied orgId. A present DID always re-resolves (authoritative).
 * Cached resolvedOrgId is used only when the current webhook omits the DID.
 * Demo-kitchen fallback only when DID is absent.
 */
function resolveOrgRouteForVapiCall(
  callLike: Record<string, unknown> | undefined,
  vapiCall?: Record<string, unknown>,
): InboundDidRoute {
  const meta = ((callLike?.metadata || {}) as Record<string, unknown>);
  const directionRaw = String(
    vapiCall?.type || callLike?.direction || 'inbound',
  ).toLowerCase();
  const direction = directionRaw.includes('outbound') ? 'outbound' : 'inbound';
  // Prefer live Vapi identity; do not invent env DID when probing unknown-number failures.
  const liveDid = lineDidForDirection(direction, vapiCall || callLike, '');
  const cachedDid = String(meta.lineDid || '').trim();
  const lineDid = liveDid || cachedDid;

  if (lineDid) {
    // Authoritative: never let a stale/forged resolvedOrgId override a real DID match failure.
    return resolveInboundDidRoute(lineDid, { allowDemoFallback: false });
  }

  const priorOrg = String(meta.resolvedOrgId || callLike?.orgId || '').trim();
  const priorPurpose = String(meta.linePurpose || meta.agentPersona || '').toLowerCase();
  if (priorOrg) {
    return {
      ok: true,
      orgId: priorOrg,
      lineDid: '',
      purpose: priorPurpose === 'sally'
        ? 'sally'
        : priorPurpose === 'staff'
          ? 'staff'
          : priorPurpose === 'cynthia'
            ? 'cynthia'
            : 'aria',
      source: 'phone_line',
      lineId: meta.lineId != null ? String(meta.lineId) : undefined,
    };
  }

  return resolveInboundDidRoute('', { allowDemoFallback: true });
}

function phoneOrgIdFromRoute(route: InboundDidRoute): string {
  if (route.ok) return route.orgId;
  return getDemoKitchenOrgId();
}

/** @deprecated Prefer resolveOrgRouteForVapiCall — kept for softphone paths without a DID. */
function phoneOrgId(): string {
  return getDemoKitchenOrgId();
}

function applyRouteToCallMeta(
  existingMeta: Record<string, unknown>,
  route: InboundDidRoute,
): Record<string, unknown> {
  if (!route.ok) {
    return {
      ...existingMeta,
      didRouteError: route.error,
      lineDid: route.lineDid || existingMeta.lineDid,
    };
  }
  const agentPersona = route.purpose === 'sally'
    ? SALLY_PERSONA
    : route.purpose === 'cynthia'
      ? 'cynthia'
      : 'judie';
  return {
    ...existingMeta,
    resolvedOrgId: route.orgId,
    lineDid: route.lineDid || existingMeta.lineDid,
    linePurpose: route.purpose,
    lineId: route.lineId,
    didRouteSource: route.source,
    agentPersona: existingMeta.agentPersona || agentPersona,
    didRouteError: undefined,
  };
}

/** Fill empty from/to/partyPhone/lineDid on an existing call when later webhooks carry CLI. */
function backfillCallIdentity(
  callId: string,
  vapiCall: Record<string, unknown>,
  metaIn: Record<string, unknown> = {},
): Record<string, unknown> {
  const existing = getCallById(callId);
  if (!existing) return existing as unknown as Record<string, unknown>;
  const existingMeta = (existing.metadata as Record<string, unknown> | undefined) || {};
  const directionRaw = String(vapiCall.type || existing.direction || '').toLowerCase();
  const direction = directionRaw.includes('outbound') ? 'outbound' : String(existing.direction || 'inbound');
  const partyPhone = partyPhoneFromCall(vapiCall)
    || toE164Uk(String(metaIn.partyPhone || existingMeta.partyPhone || ''));
  const lineDid = lineDidForDirection(
    direction,
    vapiCall,
    String(process.env.SOHO66_FROM_NUMBER || existingMeta.lineDid || ''),
  );
  const fromEmpty = !String(existing.from || '').trim();
  const toEmpty = !String(existing.to || '').trim();
  const partyEmpty = !String(existingMeta.partyPhone || '').trim();
  const lineEmpty = !String(existingMeta.lineDid || '').trim();
  if (!partyPhone && !lineDid && !fromEmpty && !toEmpty) {
    return existing;
  }
  const from = direction === 'outbound'
    ? (String(existing.from || '').trim() || lineDid)
    : (String(existing.from || '').trim() || partyPhone);
  const to = direction === 'outbound'
    ? (String(existing.to || '').trim() || partyPhone)
    : (String(existing.to || '').trim() || lineDid);

  let contactName = existing.contactName;
  let customerId = existing.customerId;
  if (partyPhone && partyEmpty) {
    const identity = resolvePhoneCallerIdentity(partyPhone);
    const resolved = resolveContactByPhone(partyPhone);
    contactName = identity.kind !== 'customer'
      ? identity.name
      : (resolved.customerName || resolved.contactName || contactName);
    customerId = resolved.customerId ?? customerId;
  }

  return saveCall({
    id: callId,
    providerCallId: String(existing.providerCallId || vapiCall.id || ''),
    ...(fromEmpty || partyPhone ? { from } : {}),
    ...(toEmpty || lineDid ? { to } : {}),
    ...(contactName ? { contactName } : {}),
    ...(customerId != null ? { customerId } : {}),
    metadata: {
      ...existingMeta,
      ...metaIn,
      vapiCallId: String(existingMeta.vapiCallId || vapiCall.id || ''),
      ...(partyPhone ? { partyPhone } : {}),
      ...(lineDid ? { lineDid } : {}),
    },
  });
}

function ensureCallFromVapi(message: Record<string, unknown>): Record<string, unknown> {
  const call = (message.call || message) as Record<string, unknown>;
  const vapiId = String(call.id || message.callId || `vapi-${Date.now()}`);
  const metaIn = (call.metadata || message.metadata || {}) as Record<string, unknown>;
  const tradeproCallId = String(metaIn.tradeproCallId || '').trim();

  const stampAndReturn = (row: Record<string, unknown>): Record<string, unknown> => {
    const route = resolveOrgRouteForVapiCall(row, call);
    if (route.ok) {
      setRequestOrgId(route.orgId);
    } else {
      // Keep request org on demo only when DID missing; unknown DID stays fail-closed for tools.
      if (route.error === 'missing_did') setRequestOrgId(getDemoKitchenOrgId());
    }
    const meta = (row.metadata as Record<string, unknown> | undefined) || {};
    const nextMeta = applyRouteToCallMeta({ ...meta, ...metaIn }, route);
    if (
      nextMeta.resolvedOrgId !== meta.resolvedOrgId
      || nextMeta.lineDid !== meta.lineDid
      || nextMeta.linePurpose !== meta.linePurpose
      || nextMeta.didRouteError !== meta.didRouteError
    ) {
      return saveCall({
        id: String(row.id),
        orgId: route.ok ? route.orgId : undefined,
        metadata: nextMeta,
      });
    }
    return row;
  };

  const byProvider = getCallByProviderId(vapiId);
  if (byProvider) {
    const merged = mergeOrphanVapiCall(String(byProvider.id), vapiId, metaIn);
    return stampAndReturn(backfillCallIdentity(String(merged.id), call, metaIn));
  }
  if (tradeproCallId) {
    const byTrade = getCallById(tradeproCallId);
    if (byTrade) {
      const merged = mergeOrphanVapiCall(tradeproCallId, vapiId, {
        ...((byTrade.metadata as Record<string, unknown> | undefined) || {}),
        ...metaIn,
      });
      return stampAndReturn(backfillCallIdentity(String(merged.id), call, metaIn));
    }
  }
  const existing = getCallById(vapiId);
  if (existing) {
    return stampAndReturn(backfillCallIdentity(String(existing.id), call, metaIn));
  }

  // Provisional route so identity/contact resolve under the correct org store.
  const provisionalRoute = resolveOrgRouteForVapiCall({ metadata: metaIn }, call);
  if (provisionalRoute.ok) setRequestOrgId(provisionalRoute.orgId);
  else if (provisionalRoute.error === 'missing_did') setRequestOrgId(getDemoKitchenOrgId());

  const partyPhone = partyPhoneFromCall(call) || toE164Uk(String(metaIn.partyPhone || ''));
  const identity = resolvePhoneCallerIdentity(partyPhone);
  const resolved = resolveContactByPhone(partyPhone);
  const directionRaw = String(call.type || '').toLowerCase();
  const direction = directionRaw.includes('outbound') ? 'outbound' : 'inbound';
  const lineDid = lineDidForDirection(direction, call, String(process.env.SOHO66_FROM_NUMBER || ''));
  const routeMeta = applyRouteToCallMeta({ ...metaIn, lineDid }, provisionalRoute);

  return saveCall({
    id: tradeproCallId || vapiId,
    providerCallId: vapiId,
    provider: 'vapi',
    orgId: provisionalRoute.ok ? provisionalRoute.orgId : undefined,
    direction,
    from: direction === 'outbound' ? lineDid : partyPhone,
    to: direction === 'outbound' ? partyPhone : lineDid,
    status: 'in_progress',
    transcript: [],
    startedAt: new Date().toISOString(),
    contactName: identity.kind !== 'customer'
      ? identity.name
      : (resolved.customerName || resolved.contactName),
    customerId: resolved.customerId,
    metadata: {
      ...routeMeta,
      vapiCallId: vapiId,
      tradeproCallId: tradeproCallId || undefined,
      partyPhone,
      lineDid,
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
    ...(orphan?.stereoRecordingUrl && !primary?.stereoRecordingUrl
      ? { stereoRecordingUrl: orphan.stereoRecordingUrl }
      : {}),
    ...(orphan?.recordingStoragePath && !primary?.recordingStoragePath
      ? { recordingStoragePath: orphan.recordingStoragePath }
      : {}),
    ...(orphan?.from && !primary?.from ? { from: orphan.from } : {}),
    ...(orphan?.to && !primary?.to ? { to: orphan.to } : {}),
    ...(orphan?.contactName && !primary?.contactName ? { contactName: orphan.contactName } : {}),
    ...(orphan?.customerId && !primary?.customerId ? { customerId: orphan.customerId } : {}),
    transcript: mergedTranscript,
    metadata: {
      ...primaryMeta,
      vapiCallId: vapiId,
      tradeproCallId: tradeproId,
      ...(primaryMeta.partyPhone || orphan?.metadata
        ? {
            partyPhone: primaryMeta.partyPhone
              || ((orphan?.metadata as Record<string, unknown> | undefined)?.partyPhone),
          }
        : {}),
      ...(primaryMeta.lineDid
        || ((orphan?.metadata as Record<string, unknown> | undefined)?.lineDid)
        ? {
            lineDid: primaryMeta.lineDid
              || ((orphan?.metadata as Record<string, unknown> | undefined)?.lineDid),
          }
        : {}),
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
  const extracted = extractRecordingUrls(message);
  const recordingUrl = preferredRecordingUrl(extracted)
    || String(artifact?.recordingUrl || message.recordingUrl || '').trim()
    || undefined;
  const stereoRecordingUrl = extracted.stereoRecordingUrl;
  const monoRecordingUrl = extracted.recordingUrl;
  const endedReason = String(message.endedReason || message.ended_reason || message.reason || '');
  const cost = message.cost ?? (message.costBreakdown as Record<string, unknown> | undefined)?.total;

  const after = getCallById(callId);
  const afterMeta = (after?.metadata as Record<string, unknown> | undefined) || {};
  const transferredTo = String(
    after?.transferredTo
    || afterMeta.transferredTo
    || afterMeta.transferNumber
    || '',
  ).trim() || undefined;
  const toolOutcome = String(after?.outcome || afterMeta.toolOutcome || '');
  const disposition = mapEndedReasonToDisposition(endedReason, {
    transferred: Boolean(transferredTo) || toolOutcome.toLowerCase().includes('transfer'),
    toolOutcome,
  });

  const fallbackSummary = (() => {
    if (summary) return summary;
    const turns = Array.isArray(after?.transcript) ? after!.transcript as Array<{ role?: string; content?: string }> : [];
    const snippet = turns
      .slice(-4)
      .map((t) => String(t.content ?? '').trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300);
    if (snippet) return snippet;
    if (endedReason) return `Call ended: ${endedReason}`;
    return 'Outbound call completed (no summary from provider).';
  })();

  const durationSec = after ? computeCallDurationSec(after) : undefined;
  const lineDid = String(afterMeta.lineDid || '').trim()
    || lineDidForDirection(String(after?.direction || 'inbound'), message.call as Record<string, unknown> | undefined);

  saveCall({
    id: callId,
    status: 'completed',
    endedAt: new Date().toISOString(),
    recordingUrl: monoRecordingUrl || recordingUrl || (after?.recordingUrl as string | undefined),
    ...(stereoRecordingUrl ? { stereoRecordingUrl } : {}),
    outcome: disposition || endedReason || (after?.outcome as string | undefined),
    transferredTo,
    sentiment: after ? computeCallSentiment(after) : undefined,
    durationSec,
    metadata: {
      ...afterMeta,
      partyPhone: afterMeta.partyPhone || partyPhone || undefined,
      lineDid: lineDid || afterMeta.lineDid,
      vapiEndedReason: endedReason || undefined,
      vapiSummary: summary || undefined,
      ...(cost != null ? { vapiCost: cost } : {}),
      disposition,
      brief: afterMeta.brief ?? afterMeta.aim,
    },
  });

  // Phone-minute metering: outbound trunk + AI talk time for weekly fare billing
  try {
    const dir = String(after?.direction || '').toLowerCase();
    if (durationSec && durationSec > 0) {
      if (dir === 'outbound') {
        const toNumber = String(after?.to || partyPhone || '');
        void import('./phone-billing').then(({ recordOutboundPhoneUsage }) => {
          recordOutboundPhoneUsage({
            orgId: phoneOrgId(),
            seconds: durationSec,
            toNumber,
            fromNumber: after?.from ? String(after.from) : undefined,
            callId,
          });
        }).catch(() => {});
      } else {
        void import('../usage').then(({ recordProviderUsage }) => {
          recordProviderUsage({
            orgId: phoneOrgId(),
            provider: 'phone',
            unit: 'seconds',
            quantity: durationSec,
            endpoint: 'phone.ai',
            model: 'inbound',
            metadata: {
              billAs: 'ai',
              callId,
              direction: dir || 'inbound',
            },
            costUsd: 0,
          });
        }).catch(() => {});
      }
    }
  } catch {
    /* metering must not break finalize */
  }

  const finalProviderUrl = monoRecordingUrl || stereoRecordingUrl || recordingUrl;
  void backfillCallRecordingOnFinalize(callId, finalProviderUrl, phoneOrgId());
  void ingestCallRecording({
    callId,
    orgId: phoneOrgId(),
    urls: {
      recordingUrl: monoRecordingUrl || recordingUrl,
      stereoRecordingUrl,
    },
    messageOrCall: message,
  });

  void import('../analytics-routes').then(({ pushAnalyticsEvent }) => {
    pushAnalyticsEvent({
      type: 'call.ended',
      callId,
      direction: after?.direction ?? 'inbound',
      durationSec: after ? computeCallDurationSec(after) : undefined,
      outcome: disposition || endedReason || undefined,
      recordingUrl: finalProviderUrl || undefined,
    });
  }).catch(() => {});

  completeOutboundJobsForCall(callId, { disposition, endedReason: endedReason || undefined });

  const resolved = resolveContactByPhone(partyPhone);
  const customerId = resolved.customerId
    || (afterMeta.customerId != null ? String(afterMeta.customerId) : null)
    || (after?.customerId != null ? String(after.customerId) : null);

  if (customerId) {
    const settings = getAgentSettings();
    const noteHint = settings.postCallNotePrompt
      ? ` ${settings.postCallNotePrompt}`
      : '';
    const detailParts = [
      fallbackSummary,
      transferredTo ? `Transferred to: ${transferredTo}` : '',
      afterMeta.brief ? `Staff brief was: ${String(afterMeta.brief).slice(0, 200)}` : '',
    ].filter(Boolean);
    const finalRecordingUrl = recordingUrl || (after?.recordingUrl as string | undefined);
    const aim = afterMeta.aim != null ? String(afterMeta.aim) : (afterMeta.brief != null ? 'callback' : undefined);
    const isSally = String(afterMeta.agentPersona || '').toLowerCase() === 'sally'
      || String(aim || '').toLowerCase() === 'sales_outreach'
      || String(aim || '').toLowerCase() === 'meeting_confirm'
      || String(aim || '').toLowerCase() === 'demo_book';
    const crmLite = isSally
      ? ' | CRM: DM? Pain? Budget? Supplier? Objection? Sentiment? Upsell/cross-sell? Next step?'
      : '';
    appendCustomerCallActivity({
      customerId,
      callId,
      summary: fallbackSummary.slice(0, 400),
      outcome: endedReason || disposition,
      disposition,
      aim,
      detail: `${detailParts.join(' ').slice(0, 700)}${crmLite}${noteHint ? '' : ''}`.slice(0, 900),
      type: 'call',
      updateCallQueue: true,
      transferredTo,
      recordingUrl: finalRecordingUrl,
      createdBy: isSally ? 'sally' : 'cynthia',
    });
    // #region agent log
    void import('../debug-session-log').then(({ debugLog }) => {
      const cust = getDataStore().customers.find((c) => String(c.id) === String(customerId));
      const acts = Array.isArray(cust?.activities) ? cust!.activities! : [];
      const forCall = acts.filter((a) => String((a as { callId?: string }).callId || '') === String(callId));
      const callerSpam = acts.filter((a) => /^Caller:/i.test(String((a as { summary?: string }).summary || '')));
      debugLog('E', 'vapi-routes.ts:finalize:crm', 'EOC CRM activity write', {
        callId,
        createdBy: isSally ? 'sally' : 'cynthia',
        activitiesForCall: forCall.length,
        callerSpamCount: callerSpam.length,
        skipCrmOnNotify: true,
      });
    }).catch(() => {});
    // #endregion
    stampCustomerLastRecording(customerId, finalRecordingUrl, callId);

    // Sales Brain: enqueue only — never await scorer on the webhook path
    void import('../sales-brain/enqueue').then(({ enqueueSalesBrainJob }) => {
      enqueueSalesBrainJob({
        callId,
        agentPersona: isSally ? 'sally' : String(afterMeta.agentPersona || 'judie'),
        aim: aim || null,
      });
    }).catch(() => {});

    // T−30 meeting confirm: pickup = go ahead; no-answer/voicemail = cancel
    if (String(aim || '').toLowerCase() === 'meeting_confirm') {
      const answered = !/no-answer|no_answer|busy|voicemail|machine|silence-timed-out|customer-did-not-answer|failed/i.test(
        `${endedReason} ${disposition}`,
      ) && Boolean(durationSec && durationSec >= 3);
      // #region agent log
      void import('../debug-session-log').then(({ debugLog }) => {
        debugLog('C', 'vapi-routes.ts:finalize:meeting_confirm', 'EOC meeting confirm branch', {
          callId,
          answered,
          durationSec: durationSec ?? null,
          endedReason: endedReason || null,
          disposition: disposition || null,
        });
      }).catch(() => {});
      // #endregion
      void import('./sally-sales-phone').then(({ resolveMeetingConfirmOutcome }) => {
        resolveMeetingConfirmOutcome({
          customerId,
          partyPhone,
          callId,
          endedReason,
          disposition,
          answered,
        });
      }).catch(() => {});
    }
  }

  // Sally sales: staff card only — CRM activity already written above (skipCrmActivity)
  void import('./sally-sales-phone')
    .then(({ isSallySalesCall, notifySallyCallEnded }) => {
      const sally = isSallySalesCall(afterMeta, { agentPersona: String(afterMeta.agentPersona || '') });
      auditVapiWebhook({
        event: 'finalize_sally_notify',
        callId,
        sally,
        customerId: customerId || null,
        hasRecording: Boolean(recordingUrl || after?.recordingUrl),
        transcriptLen: Array.isArray(after?.transcript) ? (after!.transcript as unknown[]).length : 0,
        disposition: disposition || endedReason || null,
      });
      if (sally) {
        notifySallyCallEnded({
          callId,
          customerId,
          partyPhone,
          summary: fallbackSummary,
          disposition: disposition || endedReason,
          skipCrmActivity: true,
        });
      }
    })
    .catch((err) => {
      auditVapiWebhook({
        event: 'finalize_sally_notify_error',
        callId,
        error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
      });
    });
}

async function buildTransientAssistant(message: Record<string, unknown>) {
  const call = ensureCallFromVapi(message);
  const meta = (call.metadata as Record<string, unknown> | undefined) || {};
  if (meta.didRouteError && meta.didRouteError !== 'missing_did') {
    const failed = resolveInboundDidRoute(String(meta.lineDid || ''), { allowDemoFallback: false });
    const spoken = !failed.ok
      ? failed.spokenHint
      : 'This number is not set up for Sync2Dine yet — please try again later.';
    return {
      name: 'Sync2Dine',
      firstMessage: spoken,
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: 'Say only the configured first message. Do not take orders. Then end the call.',
        }],
        tools: [{ type: 'endCall' }],
      },
      silenceTimeoutSeconds: 20,
      maxDurationSeconds: 60,
    };
  }

  const partyPhone = String(meta.partyPhone
    || partyPhoneFromCall(message.call as Record<string, unknown>)
    || '');
  const direction = (call.direction as 'inbound' | 'outbound') || 'outbound';
  const route = resolveOrgRouteForVapiCall(call, message.call as Record<string, unknown>);
  const orgId = route.ok ? route.orgId : getDemoKitchenOrgId();
  if (route.ok) setRequestOrgId(orgId);
  const agentPersona = route.ok && route.purpose === 'sally'
    ? SALLY_PERSONA
    : route.ok && route.purpose === 'cynthia'
      ? 'cynthia'
      : String(meta.agentPersona || 'judie');
  const identity = resolvePhoneCallerIdentity(partyPhone);
  const { assistant } = await buildVapiAssistantForParty({
    partyPhone,
    direction,
    campaignTemplate: call.campaignTemplate ? String(call.campaignTemplate) : undefined,
    callId: String(call.id),
    contactName: identity.kind !== 'customer'
      ? identity.name
      : String(call.contactName || ''),
    agentPersona,
    orgId,
  });
  saveCall({
    id: String(call.id),
    orgId,
    metadata: {
      ...meta,
      callerKind: identity.kind,
      callerRole: identity.role,
      agentPersona,
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

function shouldSkipDuplicateTool(callId: string, toolCallId: string): { skip: boolean; priorResult?: string } {
  const key = `${callId}:${toolCallId}`;
  const now = Date.now();
  for (const [k, ts] of seenToolCalls) {
    if (now - ts > TOOL_IDEMPOTENCY_TTL_MS) {
      seenToolCalls.delete(k);
      seenToolResults.delete(k);
    }
  }
  if (seenToolCalls.has(key)) {
    return { skip: true, priorResult: seenToolResults.get(key) };
  }
  seenToolCalls.set(key, now);
  return { skip: false };
}

function rememberToolResult(callId: string, toolCallId: string, resultJson: string): void {
  seenToolResults.set(`${callId}:${toolCallId}`, resultJson);
}

function buildStaffOrchBodyFromCall(
  call: Record<string, unknown>,
  callId: string,
  partyPhone: string,
  identity: ReturnType<typeof resolvePhoneCallerIdentity>,
): OrchestratorRequest {
  const route = resolveOrgRouteForVapiCall(call);
  const orgId = route.ok ? route.orgId : getDemoKitchenOrgId();
  if (route.ok) setRequestOrgId(orgId);
  return buildStaffOrchBody({ call, callId, partyPhone, identity, orgId });
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
      spokenName: languageFriendName(language),
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

  const callMeta = (call?.metadata as Record<string, unknown> | undefined) || {};
  const { isSallySalesCall, executeSallySalesPhoneTool } = await import('./sally-sales-phone');
  if (isSallySalesCall(callMeta) && (
    name === 'getOfferTerms'
    || name === 'bookDemo'
    || name === 'bookIntegrationMeeting'
    || name === 'sendSalesFollowUp'
  )) {
    const route = resolveOrgRouteForVapiCall(call);
    return executeSallySalesPhoneTool(name, args, {
      callId,
      partyPhone,
      orgId: route.ok ? route.orgId : undefined,
    });
  }

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

function summarizeToolResult(toolName: string, output: unknown, error?: string): string {
  if (error) return `tool:${toolName} → error: ${error.slice(0, 160)}`;
  if (output == null) return `tool:${toolName} → ok`;
  if (typeof output === 'string') {
    const t = output.trim();
    return `tool:${toolName} → ${t.slice(0, 180) || 'ok'}`;
  }
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (o.error != null) return `tool:${toolName} → error: ${String(o.error).slice(0, 160)}`;
    const bits = [
      o.ok === false ? 'failed' : 'ok',
      o.customerId != null ? `customer ${String(o.customerId)}` : '',
      o.orderId != null ? `order ${String(o.orderId)}` : '',
      o.bookingId != null ? `booking ${String(o.bookingId)}` : '',
      o.summary != null ? String(o.summary) : '',
      o.message != null ? String(o.message) : '',
      o.spoken != null ? String(o.spoken) : '',
    ].filter(Boolean);
    return `tool:${toolName} → ${bits.join(' · ').slice(0, 220)}`;
  }
  return `tool:${toolName} → ok`;
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
    phoneOrgId(),
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
  // Keep transcript on the call record only — do not spam customer.activities with every turn.
  // #region agent log
  if (role === 'user') {
    void import('../debug-session-log').then(({ debugLog }) => {
      debugLog('E', 'vapi-routes.ts:persistTranscriptTurn', 'transcript turn (no CRM append)', {
        callId,
        role,
        textLen: trimmed.length,
        crmAppendDisabled: true,
      });
    }).catch(() => {});
  }
  // #endregion
}

function extractMonitorUrls(callOrMessage: Record<string, unknown>): {
  listenUrl?: string;
  controlUrl?: string;
} {
  const call = (callOrMessage.call || callOrMessage) as Record<string, unknown>;
  const monitor = (call.monitor || callOrMessage.monitor || {}) as Record<string, unknown>;
  const listenUrl = String(monitor.listenUrl || call.listenUrl || '').trim();
  const controlUrl = String(monitor.controlUrl || call.controlUrl || '').trim();
  return {
    ...(listenUrl ? { listenUrl } : {}),
    ...(controlUrl ? { controlUrl } : {}),
  };
}

async function enrichMonitorUrlsFromVapi(
  callId: string,
  vapiCallId: string,
  existing?: { listenUrl?: string; controlUrl?: string },
): Promise<{ listenUrl?: string; controlUrl?: string }> {
  if (existing?.listenUrl) return existing;
  try {
    const { ok, json } = await vapiFetch(`/call/${encodeURIComponent(vapiCallId)}`);
    if (!ok) return existing ?? {};
    const monitor = (json.monitor || {}) as Record<string, unknown>;
    const listenUrl = String(monitor.listenUrl || '').trim();
    const controlUrl = String(monitor.controlUrl || '').trim();
    if (listenUrl || controlUrl) {
      saveCall({
        id: callId,
        ...(listenUrl ? { listenUrl } : {}),
        ...(controlUrl ? { controlUrl } : {}),
        metadata: {
          ...(((getCallById(callId)?.metadata as Record<string, unknown> | undefined) || {})),
          ...(listenUrl ? { listenUrl } : {}),
          ...(controlUrl ? { controlUrl } : {}),
        },
      });
      if (listenUrl) stampListenUrlOnOrders(callId, listenUrl);
    }
    return {
      ...(listenUrl ? { listenUrl } : {}),
      ...(controlUrl ? { controlUrl } : {}),
    };
  } catch {
    return existing ?? {};
  }
}

/** Stamp listenUrl onto any orders linked to an active call (9D). */
function stampListenUrlOnOrders(callId: string, listenUrl: string): void {
  if (!callId || !listenUrl) return;
  try {
    const store = getDataStore();
    const orders = Array.isArray(store.orders) ? store.orders : [];
    for (const order of orders) {
      const sourceCall = String(order.sourceCallId ?? '');
      const callIds = Array.isArray(order.callIds) ? order.callIds.map(String) : [];
      if (sourceCall !== callId && !callIds.includes(callId)) continue;
      if (order.listenUrl === listenUrl) continue;
      order.listenUrl = listenUrl;
    }
  } catch {
    // ignore
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
    auditVapiWebhook({ event: 'agent_inactive', type: String((body.message as Record<string, unknown> | undefined)?.type || body.type || '') });
    sendJson(res, 503, { error: 'Agent inactive' });
    return;
  }

  const message = (body.message || body) as Record<string, unknown>;
  const type = String(message.type || body.type || '');
  const vapiCallPreview = ((message.call || {}) as Record<string, unknown>).id
    || message.callId
    || '';
  const priorByProvider = vapiCallPreview
    ? getCallByProviderId(String(vapiCallPreview))
    : undefined;

  if (type === 'assistant-request') {
    const capacity = getAgentCapacitySnapshot();
    const directionRaw = String(((message.call || {}) as Record<string, unknown>).type || '').toLowerCase();
    const isOutbound = directionRaw.includes('outbound');
    if (!isOutbound && capacity.overflowArmed && !capacity.canAcceptInboundAi) {
      const overflow = capacity.overflowNumber
        || getAgentSettings().overflowNumber
        || getAgentSettings().transferNumbers?.general
        || '';
      if (overflow) {
        sendJson(res, 200, {
          destination: {
            type: 'number',
            number: overflow,
            message: 'All lines are busy — connecting you to the restaurant now.',
          },
        });
        return;
      }
    }
    const call = ensureCallFromVapi(message);
    const vapiId = String(
      ((message.call || {}) as Record<string, unknown>).id
      || message.callId
      || call.providerCallId
      || '',
    );
    auditVapiWebhook({
      type,
      vapiCallId: vapiId || null,
      matchedLocalCallId: String(call.id),
      matchMethod: priorByProvider ? 'providerCallId' : (getCallById(String(call.id)) ? 'localId' : 'new'),
      authOk: true,
    });
    if (vapiId) {
      void enrichMonitorUrlsFromVapi(String(call.id), vapiId, extractMonitorUrls(message));
    }
    const assistant = await buildTransientAssistant(message);
    sendJson(res, 200, { assistant });
    return;
  }

  if (type === 'tool-calls' || type === 'function-call') {
    const call = ensureCallFromVapi(message);
    const callMetaEarly = (call.metadata as Record<string, unknown> | undefined) || {};
    if (callMetaEarly.didRouteError && callMetaEarly.didRouteError !== 'missing_did') {
      const toolsBlocked = parseToolCalls(message);
      sendJson(res, 200, {
        results: toolsBlocked.map((tool) => ({
          toolCallId: tool.id,
          result: JSON.stringify({
            ok: false,
            error: 'unknown_did',
            spokenHint: 'This number is not set up for Sync2Dine yet.',
          }),
        })),
      });
      return;
    }
    const partyPhone = String(callMetaEarly.partyPhone
      || partyPhoneFromCall(message.call as Record<string, unknown>)
      || '');
    const tools = parseToolCalls(message);
    auditVapiWebhook({
      type,
      vapiCallId: String(call.providerCallId || vapiCallPreview || ''),
      matchedLocalCallId: String(call.id),
      matchMethod: priorByProvider ? 'providerCallId' : 'ensure',
      authOk: true,
      tools: tools.map((t) => t.name),
    });
    const results = await Promise.all(tools.map(async (tool) => {
      const dedupe = shouldSkipDuplicateTool(String(call.id), tool.id);
      if (dedupe.skip) {
        const prior = dedupe.priorResult
          ?? JSON.stringify({ ok: false, deduped: true, error: 'duplicate_tool_no_prior_result' });
        appendCallTurn(String(call.id), {
          role: 'system',
          content: `tool:${tool.name} → deduped`,
        });
        return {
          toolCallId: tool.id,
          result: prior,
        };
      }
      try {
        const output = await executeTool(tool.name, tool.arguments, call, partyPhone);
        const resultJson = JSON.stringify(output);
        rememberToolResult(String(call.id), tool.id, resultJson);
        appendCallTurn(String(call.id), {
          role: 'system',
          content: summarizeToolResult(tool.name, output),
        });
        const outputOk = !(output && typeof output === 'object' && 'ok' in output && (output as { ok?: unknown }).ok === false);
        auditVapiWebhook({
          type: 'tool-result',
          toolName: tool.name,
          ok: outputOk,
          matchedLocalCallId: String(call.id),
        });
        return {
          toolCallId: tool.id,
          result: resultJson,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const resultJson = JSON.stringify({ ok: false, error: message });
        rememberToolResult(String(call.id), tool.id, resultJson);
        appendCallTurn(String(call.id), {
          role: 'system',
          content: `tool:${tool.name} → error: ${message.slice(0, 160)}`,
        });
        auditVapiWebhook({
          type: 'tool-result',
          toolName: tool.name,
          ok: false,
          error: message.slice(0, 120),
          matchedLocalCallId: String(call.id),
        });
        return {
          toolCallId: tool.id,
          result: resultJson,
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
    auditVapiWebhook({
      type,
      vapiCallId: String(call.providerCallId || vapiCallPreview || ''),
      matchedLocalCallId: String(call.id),
      authOk: true,
      transcriptLen: text.length,
      role,
      isFinal,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (type === 'status-update') {
    const call = ensureCallFromVapi(message);
    const status = String(message.status || message.endedReason || '').toLowerCase();
    const terminal =
      status.includes('end')
      || status === 'ended'
      || status === 'completed'
      || status.includes('hang')
      || status.includes('cancel')
      || status === 'busy'
      || status.includes('no-answer')
      || status.includes('no_answer')
      || status.includes('customer-ended')
      || status.includes('assistant-ended')
      || status.includes('silence-timed-out')
      || status.includes('max-duration');
    const mapped = terminal
      ? 'completed'
      : status.includes('fail') || status.includes('error')
        ? 'failed'
        : status.includes('ring')
          ? 'ringing'
          : 'in_progress';
    const monitor = extractMonitorUrls(message);
    if (!terminal && !monitor.listenUrl) {
      const vapiId = String(call.providerCallId || ((message.call || {}) as Record<string, unknown>).id || '');
      if (vapiId) void enrichMonitorUrlsFromVapi(String(call.id), vapiId, monitor);
    }
    const meta = { ...((call.metadata as Record<string, unknown> | undefined) || {}) };
    if (terminal) {
      delete meta.listenUrl;
      delete meta.controlUrl;
    } else if (monitor.listenUrl || monitor.controlUrl) {
      Object.assign(meta, monitor);
    }
    // Keep partyPhone on the row for CRM finalize
    const partyFromMsg = partyPhoneFromCall(message.call as Record<string, unknown>);
    if (partyFromMsg && !meta.partyPhone) meta.partyPhone = partyFromMsg;
    saveCall({
      id: call.id,
      status: mapped,
      ...(terminal
        ? { listenUrl: null, controlUrl: null }
        : monitor),
      metadata: meta,
      ...(mapped === 'completed' || mapped === 'failed'
        ? {
            endedAt: new Date().toISOString(),
            outcome: terminal
              ? String(message.endedReason || message.status || 'remote_ended')
              : undefined,
          }
        : {}),
    });
    auditVapiWebhook({
      type,
      status,
      mapped,
      terminal,
      vapiCallId: String(call.providerCallId || vapiCallPreview || ''),
      matchedLocalCallId: String(call.id),
      authOk: true,
    });
    // Do not full-finalize here — end-of-call-report owns CRM/notify. Status only closes the row.
    sendJson(res, 200, { ok: true });
    return;
  }

  if (type === 'end-of-call-report' || type === 'hang') {
    const call = ensureCallFromVapi(message);
    const artifact = message.artifact as Record<string, unknown> | undefined;
    const recUrls = extractRecordingUrls(message);
    auditVapiWebhook({
      type,
      vapiCallId: String(call.providerCallId || vapiCallPreview || ''),
      matchedLocalCallId: String(call.id),
      matchMethod: priorByProvider ? 'providerCallId' : 'ensure',
      authOk: true,
      hasArtifact: Boolean(artifact),
      recordingUrlPresent: Boolean(preferredRecordingUrl(recUrls) || message.recordingUrl),
      endedReason: String(message.endedReason || message.ended_reason || ''),
      transcriptLen: Array.isArray(call.transcript) ? (call.transcript as unknown[]).length : 0,
    });
    // Always close the row even if finalize throws mid-way on CRM append
    try {
      const partyPhone = String((call.metadata as Record<string, unknown> | undefined)?.partyPhone
        || partyPhoneFromCall(message.call as Record<string, unknown>)
        || '');
      finalizeVapiCall(String(call.id), message, partyPhone);
    } catch (err) {
      console.warn('[vapi] finalizeVapiCall error — forcing completed:', err instanceof Error ? err.message : err);
      saveCall({
        id: String(call.id),
        status: 'completed',
        endedAt: new Date().toISOString(),
        outcome: 'finalize_error',
      });
    }
    // Belt-and-braces: never leave hang/EOC as in_progress or ringing
    const after = getCallById(String(call.id));
    const afterStatus = String(after?.status ?? '');
    if (after && (afterStatus === 'ringing' || afterStatus === 'in_progress')) {
      saveCall({
        id: String(call.id),
        status: 'completed',
        endedAt: new Date().toISOString(),
        outcome: String(after.outcome ?? 'hang'),
      });
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  auditVapiWebhook({ type: type || 'unknown', authOk: true, vapiCallId: String(vapiCallPreview || '') });
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
  const orgId = String(body.orgId || headerOrg || phoneOrgId()).trim();
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

  const { assistant, identity, verified } = await buildVapiAssistantForParty({
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

  auditVapiWebhook({
    event: 'webhook_entry',
    pathname,
    method: req.method,
    hasSecretHeader: Boolean(
      req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'] || req.headers.authorization,
    ),
  });

  if (!verifyVapiRequest(req)) {
    sendJson(res, 401, { error: 'Invalid or missing Vapi webhook secret' });
    return true;
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  } catch {
    auditVapiWebhook({ event: 'bad_json', pathname });
    sendJson(res, 400, { error: 'Invalid JSON' });
    return true;
  }

  try {
    await handleVapiMessage(req, res, body);
  } catch (err) {
    auditVapiWebhook({
      event: 'webhook_handler_error',
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    console.error('[vapi] webhook error', err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
