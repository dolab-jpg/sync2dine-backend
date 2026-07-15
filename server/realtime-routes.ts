/**
 * OpenAI Realtime phone API: session config, tool exec, transcript persistence.
 * Shares PIN / identity / tool gating with Vapi via phone-auth + phone-session.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  appendCallTurn,
  appendCustomerCallActivity,
  computeCallDurationSec,
  computeCallSentiment,
  DEFAULT_ORG_ID,
  getCallById,
  getRequestOrgId,
  isAgentActive,
  resolveContactByPhone,
  saveCall,
  setRequestOrgId,
} from './data-store';
import { appendConversationMessage } from './conversation-store';
import { getOrgOpenAIApiKey, listOrganizations, ensureOrgOpenAIKeyLoaded } from './organizations';
import { executeCustomerTool, executeServerReadTool, SERVER_READ_TOOLS } from './orchestrator-tool-exec';
import { executePhoneTool, PHONE_AUTO_ACTIONS } from './phone-tools';
import {
  buildPhoneBrainPrompt,
  getRealtimePhoneTools,
  REALTIME_PHONE_MODEL_DEFAULT,
  REALTIME_PHONE_VOICE_DEFAULT,
} from './phone-brain';
import {
  isIdentityBound,
  isPhoneAuthVerified,
  isToolAllowedForPhoneSession,
  looksLikePhonePinEntry,
  resolvePhoneAuthCallId,
  resolvePhoneCallerIdentity,
  verifyStaffPhonePinForCall,
} from './phone-auth';
import { buildStaffOrchBody } from './phone-session';

const CUSTOMER_TOOL_NAMES = new Set([
  'lookupCustomerByPhone',
  'getAccountBriefing',
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
  'getBusinessSnapshot',
  'getTeamPerformance',
]);

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

function resolveOpenAiOrgId(): string {
  const current = getRequestOrgId();
  if (current && current !== 'default' && getOrgOpenAIApiKey(current)) return current;
  for (const org of listOrganizations()) {
    if (getOrgOpenAIApiKey(org.id)) return org.id;
  }
  return current || DEFAULT_ORG_ID;
}

function partyPhoneFromPayload(body: Record<string, unknown>): string {
  const direction = String(body.direction || 'outbound');
  if (direction === 'outbound') {
    return String(body.to || body.partyPhone || body.from || '').trim();
  }
  return String(body.from || body.partyPhone || body.to || '').trim();
}

function ensureCallRecord(body: Record<string, unknown>): Record<string, unknown> {
  setRequestOrgId(DEFAULT_ORG_ID);
  const callId = String(body.callId || '').trim();
  if (!callId) throw new Error('callId required');
  const existing = getCallById(callId);
  if (existing) return existing;
  const partyPhone = partyPhoneFromPayload(body);
  const resolved = resolveContactByPhone(partyPhone);
  return saveCall({
    id: callId,
    providerCallId: body.providerCallId ? String(body.providerCallId) : undefined,
    direction: (body.direction as 'inbound' | 'outbound') || 'outbound',
    from: String(body.from || ''),
    to: String(body.to || ''),
    status: 'in_progress',
    transcript: [],
    startedAt: new Date().toISOString(),
    contactName: resolved.customerName || resolved.contactName,
    customerId: resolved.customerId,
    campaignTemplate: body.campaignTemplate ? String(body.campaignTemplate) : undefined,
  });
}

export async function handleRealtimeSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isAgentActive()) {
    sendJson(res, 503, { error: 'Agent inactive' });
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const callId = String(body.callId || '').trim();
  if (!callId) {
    sendJson(res, 400, { error: 'callId required' });
    return;
  }

  const call = ensureCallRecord(body);
  const partyPhone = partyPhoneFromPayload({ ...body, ...call });
  const orgId = DEFAULT_ORG_ID;
  setRequestOrgId(orgId);

  const openaiOrgId = resolveOpenAiOrgId();
  await ensureOrgOpenAIKeyLoaded(openaiOrgId);
  const apiKey = getOrgOpenAIApiKey(openaiOrgId);
  if (!apiKey) {
    sendJson(res, 503, { error: 'No OpenAI API key configured for organisation' });
    return;
  }

  const direction = (String(body.direction || call.direction || 'outbound') as 'inbound' | 'outbound');
  const identity = resolvePhoneCallerIdentity(partyPhone, orgId);
  const verified = isPhoneAuthVerified(callId);
  const partyResolved = resolveContactByPhone(partyPhone);
  const { instructions, resolved } = buildPhoneBrainPrompt({
    orgId,
    partyPhone,
    direction,
    campaignTemplate: String(body.campaignTemplate || call.campaignTemplate || '') || undefined,
    contactName: identity.kind !== 'customer' ? identity.name : (partyResolved.customerName || partyResolved.contactName),
    identity,
    callId,
    phoneAuthVerified: verified,
  });

  if (resolved.customerId) {
    saveCall({
      id: callId,
      customerId: resolved.customerId,
      contactName: resolved.customerName || resolved.contactName,
    });
  }

  const model = String(process.env.REALTIME_MODEL || REALTIME_PHONE_MODEL_DEFAULT).trim()
    || REALTIME_PHONE_MODEL_DEFAULT;
  const voice = String(process.env.REALTIME_VOICE || REALTIME_PHONE_VOICE_DEFAULT).trim()
    || REALTIME_PHONE_VOICE_DEFAULT;

  sendJson(res, 200, {
    model,
    voice,
    instructions,
    tools: getRealtimePhoneTools(identity, verified),
    apiKey,
    callId,
    partyPhone,
    customerId: resolved.customerId ?? null,
    customerName: resolved.customerName || resolved.contactName || null,
    orgId,
    identity: {
      kind: identity.kind,
      role: identity.role,
      name: identity.name,
      userId: identity.userId,
      verified,
      identityBound: isIdentityBound(identity),
    },
  });
}

export async function handleRealtimeTool(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const callIdRaw = String(body.callId || '').trim();
  const name = String(body.name || '').trim();
  if (!callIdRaw || !name) {
    sendJson(res, 400, { error: 'callId and name required' });
    return;
  }

  setRequestOrgId(DEFAULT_ORG_ID);
  const callId = resolvePhoneAuthCallId(callIdRaw);
  const call = getCallById(callId) ?? ensureCallRecord(body);
  const partyPhone = partyPhoneFromPayload({ ...body, ...call });
  const identity = resolvePhoneCallerIdentity(partyPhone);

  let args: Record<string, unknown> = {};
  const rawArgs = body.arguments;
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>;
  }

  if (!isToolAllowedForPhoneSession(name, callId, identity)) {
    if (isPhoneAuthVerified(callId) && !isIdentityBound(identity)) {
      sendJson(res, 200, {
        ok: true,
        name,
        output: {
          error: 'Staff identity is not bound to a profile UUID',
          code: 'identity_not_bound',
        },
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      name,
      output: {
        error: 'Phone PIN required — ask the caller to enter their security code, then call verifyStaffPhonePin',
        phoneAuth: 'pending',
      },
    });
    return;
  }

  if (name === 'verifyStaffPhonePin') {
    const output = verifyStaffPhonePinForCall(callId, partyPhone, String(args.pin ?? args.code ?? ''));
    sendJson(res, 200, { ok: true, name, output: { ...output, userId: identity.userId, identityBound: isIdentityBound(identity) } });
    return;
  }

  if (name === 'endCall') {
    const existing = getCallById(callId);
    if (existing?.status === 'completed' || existing?.endedAt) {
      sendJson(res, 200, {
        ok: true,
        name,
        output: { ended: true, shouldHangup: true, alreadyEnded: true, reason: args.reason || 'agent_ended' },
      });
      return;
    }
    saveCall({
      id: callId,
      status: 'completed',
      endedAt: new Date().toISOString(),
      outcome: String(args.reason || 'agent_ended'),
    });
    sendJson(res, 200, {
      ok: true,
      name,
      output: { ended: true, shouldHangup: true, reason: args.reason || 'agent_ended' },
    });
    return;
  }

  const orchBody = buildStaffOrchBody({
    call,
    callId,
    partyPhone,
    identity,
    orgId: DEFAULT_ORG_ID,
  });

  let output: Record<string, unknown>;
  try {
    if (CUSTOMER_TOOL_NAMES.has(name)) {
      output = executeCustomerTool(name, args, orchBody);
    } else if (STAFF_READ_TOOL_NAMES.has(name) || SERVER_READ_TOOLS.has(name)) {
      output = await executeServerReadTool(name, args, orchBody);
    } else if (PHONE_AUTO_ACTIONS.has(name) || name.startsWith('book') || name.startsWith('capture') || name === 'saveQuote' || name === 'sendCustomerMessage') {
      output = await executePhoneTool(name, args, orchBody);
    } else {
      const customerTry = executeCustomerTool(name, args, orchBody);
      if (customerTry && !('error' in customerTry && String(customerTry.error).includes('Unknown'))) {
        output = customerTry;
      } else {
        output = await executePhoneTool(name, args, orchBody);
      }
    }
  } catch (err) {
    output = { error: err instanceof Error ? err.message : String(err) };
  }

  sendJson(res, 200, { ok: true, name, output });
}

export async function handleRealtimeTranscript(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const callIdRaw = String(body.callId || '').trim();
  const roleRaw = String(body.role || '').trim().toLowerCase();
  const text = String(body.text || '').trim();
  if (!callIdRaw || !text) {
    sendJson(res, 400, { error: 'callId and text required' });
    return;
  }

  setRequestOrgId(DEFAULT_ORG_ID);
  const callId = resolvePhoneAuthCallId(callIdRaw);
  const call = getCallById(callId) ?? ensureCallRecord(body);
  const partyPhone = partyPhoneFromPayload({ ...body, ...call });
  const resolved = resolveContactByPhone(partyPhone);
  const identity = resolvePhoneCallerIdentity(partyPhone);

  const isUser = roleRaw === 'user' || roleRaw === 'caller' || roleRaw === 'customer';
  const turnRole = isUser ? 'caller' : 'agent';
  const convRole = isUser ? 'user' : 'assistant';

  // Spoken PIN detection (parity with Vapi)
  if (isUser && identity.kind !== 'customer' && looksLikePhonePinEntry(text) && !isPhoneAuthVerified(callId)) {
    verifyStaffPhonePinForCall(callId, partyPhone, text);
  }

  appendCallTurn(callId, { role: turnRole, content: text });
  appendConversationMessage(
    DEFAULT_ORG_ID,
    partyPhone,
    {
      role: convRole,
      content: text,
      bodyEnglish: text,
      channel: 'phone',
    },
    {
      channel: 'phone',
      contactName: identity.kind !== 'customer' ? identity.name : (resolved.customerName || resolved.contactName),
    },
  );

  const updated = getCallById(callId) ?? call;
  saveCall({
    id: callId,
    contactName: identity.kind !== 'customer' ? identity.name : (resolved.customerName || resolved.contactName),
    customerId: resolved.customerId,
    sentiment: computeCallSentiment(updated),
    durationSec: computeCallDurationSec(updated),
  });

  if (resolved.customerId && isUser) {
    appendCustomerCallActivity({
      customerId: resolved.customerId,
      callId,
      summary: `Caller: ${text.slice(0, 200)}`,
    });
  }

  sendJson(res, 200, { ok: true, callId, role: turnRole });
}

export async function handleRealtimeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/agent/realtime/session' && req.method === 'POST') {
    await handleRealtimeSession(req, res);
    return true;
  }
  if (pathname === '/api/agent/realtime/tool' && req.method === 'POST') {
    await handleRealtimeTool(req, res);
    return true;
  }
  if (pathname === '/api/agent/realtime/transcript' && req.method === 'POST') {
    await handleRealtimeTranscript(req, res);
    return true;
  }
  return false;
}
