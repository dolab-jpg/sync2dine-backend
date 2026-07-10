import type { IncomingMessage, ServerResponse } from 'http';
import {
  appendCallTurn,
  computeCallDurationSec,
  computeCallSentiment,
  getCallById,
  getCallByProviderId,
  getDataStore,
  getProjectById,
  isAfterHours,
  isAgentActive,
  resolveCandidateByPhone,
  resolveContactByPhone,
  resolvePhoneLineByDid,
  saveCall,
  syncData,
  setRequestOrgId,
  updateOutboundJob,
} from './data-store';
import { getOrganizationByPhoneDid } from './organizations';
import { handlePhoneTurn } from './phone-orchestrator';
import {
  getTelephonyProvider,
  resolveTelephonyConfig,
  OUTBOUND_CAMPAIGN_SCRIPTS,
  type AgentCallContext,
  type CallEvent,
  type OutboundCampaignTemplate,
} from './telephony';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseBody(raw: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(raw);
  const result: Record<string, unknown> = {};
  params.forEach((value, key) => { result[key] = value; });
  return result;
}

function headersToRecord(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value[0] ?? '';
  }
  return headers;
}

function getOrCreateCall(event: CallEvent): Record<string, unknown> {
  const org = getOrganizationByPhoneDid(event.to);
  setRequestOrgId(org?.id ?? 'default');

  const existing = getCallById(event.callId) ?? getCallByProviderId(event.providerCallId ?? '');
  if (existing) return existing;

  const matchedLine = resolvePhoneLineByDid(event.to);
  const call = saveCall({
    id: event.callId,
    providerCallId: event.providerCallId,
    direction: event.direction,
    from: event.from,
    to: event.to,
    status: event.status ?? 'in_progress',
    transcript: [],
    startedAt: new Date().toISOString(),
    contactName: resolveContactByPhone(event.from).customerName,
    lineId: matchedLine?.id ?? 'unknown',
    lineLabel: matchedLine?.label ?? (matchedLine ? undefined : 'Unknown line'),
  });
  return call;
}

function buildAgentContext(
  call: Record<string, unknown>,
  resolved: ReturnType<typeof resolveContactByPhone>,
  candidate: ReturnType<typeof resolveCandidateByPhone>,
): AgentCallContext {
  return {
    callId: String(call.id),
    direction: (call.direction as AgentCallContext['direction']) ?? 'inbound',
    from: String(call.from ?? ''),
    to: String(call.to ?? ''),
    customerId: resolved.customerId,
    customerName: resolved.customerName,
    candidateId: candidate.candidateId,
    projectId: resolved.projectId,
    intent: call.intent as AgentCallContext['intent'],
    campaignTemplate: call.campaignTemplate as AgentCallContext['campaignTemplate'],
    isAfterHours: isAfterHours(),
  };
}

function getTranscriptMessages(call: Record<string, unknown>): Array<{ role: string; content: string }> {
  const turns = Array.isArray(call.transcript) ? call.transcript as Array<{ role: string; content: string }> : [];
  return turns.map(t => ({ role: t.role === 'caller' ? 'user' : 'assistant', content: t.content }));
}

async function appendAuditLog(
  call: Record<string, unknown>,
  role: 'user' | 'assistant',
  content: string,
  customerName: string,
): Promise<void> {
  try {
    const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const logPath = join(dirname(fileURLToPath(import.meta.url)), 'data', 'conversation-logs.json');
    let logs: unknown[] = [];
    if (existsSync(logPath)) {
      logs = JSON.parse(readFileSync(logPath, 'utf-8')) as unknown[];
    }
    const threadId = `phone:${call.id}`;
    logs.push({
      id: `log-${Date.now()}`,
      threadId,
      userId: String(call.from ?? 'unknown'),
      userName: customerName,
      role: 'customer',
      scope: 'phone',
      role_message: role,
      content: content.slice(0, 10000),
      timestamp: new Date().toISOString(),
    });
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, JSON.stringify(logs.slice(-50000), null, 2));
  } catch {
    // audit optional
  }
}

async function processCallTurn(
  event: CallEvent,
  speechText?: string,
): Promise<{ speak: string; gather?: boolean; transferTo?: string; hangup?: boolean }> {
  if (!isAgentActive()) {
    return {
      speak: 'Our office is unavailable right now. Please call back during business hours or leave a message on our website. Goodbye.',
      gather: false,
      hangup: true,
    };
  }

  const call = getOrCreateCall(event);
  const resolved = resolveContactByPhone(event.from);
  const candidate = resolveCandidateByPhone(event.from);
  const afterHours = isAfterHours();

  if (speechText) {
    appendCallTurn(String(call.id), { role: 'caller', content: speechText });
    await appendAuditLog(call, 'user', speechText, resolved.customerName);
  }

  const updatedCall = getCallById(String(call.id)) ?? call;
  const messages = getTranscriptMessages(updatedCall);
  if (speechText) {
    messages.push({ role: 'user', content: speechText });
  }

  const agentContext = buildAgentContext(updatedCall, resolved, candidate);
  agentContext.isAfterHours = afterHours;

  const project = resolved.projectId ? getProjectById(resolved.projectId) : undefined;
  const todayTasks = project
    ? ((project.tasks as Array<Record<string, unknown>> ?? [])
        .filter(t => t.status !== 'completed')
        .slice(0, 3)
        .map(t => String(t.title)))
    : [];

  const result = await handlePhoneTurn({
    callContext: agentContext,
    messages,
    customerContext: {
      customerId: resolved.customerId,
      customerName: resolved.customerName,
      phone: event.from,
      contactName: resolved.contactName,
      contactRole: resolved.contactRole,
      projectId: resolved.projectId,
      role: 'customer',
    },
    projectContext: project
      ? {
          projectId: String(project.id),
          projectName: String(project.projectName ?? 'Project'),
          status: String(project.status ?? 'unknown'),
          todayTasks,
        }
      : undefined,
  });

  appendCallTurn(String(call.id), { role: 'agent', content: result.content });
  await appendAuditLog(call, 'assistant', result.content, 'Aria');

  if (result.intent) {
    saveCall({ id: call.id, intent: result.intent, contactName: resolved.customerName });
  }

  const updated = getCallById(String(call.id)) ?? call;
  saveCall({
    id: call.id,
    contactName: resolved.customerName,
    customerId: resolved.customerId,
    sentiment: computeCallSentiment(updated),
    durationSec: computeCallDurationSec(updated),
  });

  if (detectEscalation(speechText ?? '')) {
    const store = getDataStore();
    if (resolved.projectId) {
      const proj = store.projects.find(p => String(p.id) === resolved.projectId);
      if (proj) {
        proj.escalated = true;
        syncData(store);
      }
    }
    saveCall({ id: call.id, escalated: true, sentiment: 'negative' });
  }

  return {
    speak: result.content,
    gather: !result.transferTo && !result.hangup,
    transferTo: result.transferTo,
    hangup: result.hangup,
  };
}

function detectEscalation(text: string): boolean {
  return /upset|angry|unhappy|complaint|terrible|awful|disappointed|manager|speak to someone/i.test(text);
}

export async function handlePhoneInbound(req: IncomingMessage, res: ServerResponse, url: URL) {
  const config = resolveTelephonyConfig();
  const provider = getTelephonyProvider(config);
  const raw = await readBody(req);
  const contentType = req.headers['content-type'] ?? '';
  const body = parseBody(raw, contentType);
  const callId = url.searchParams.get('callId') ?? String(body.callId ?? `call-${Date.now()}`);

  if (config.provider === 'twilio') {
    const fullUrl = `${config.webhookBaseUrl ?? ''}${url.pathname}${url.search}`;
    if (!provider.verifyWebhook(raw, fullUrl, headersToRecord(req), config)) {
      sendJson(res, 401, { error: 'Invalid signature' });
      return;
    }
  }

  body.callId = callId;
  const event = provider.parseInboundRequest(body, headersToRecord(req));
  if (!event) {
    sendJson(res, 400, { error: 'Invalid call event' });
    return;
  }
  event.callId = callId;

  const isStart = event.type === 'call_started' || (!event.speechResult && event.type !== 'speech_turn');
  const response = await processCallTurn(event, isStart ? undefined : event.speechResult);

  const built = provider.buildResponse(response, callId, config);
  res.statusCode = 200;
  res.setHeader('Content-Type', built.contentType);
  res.end(built.body);
}

export async function handlePhoneStatus(req: IncomingMessage, res: ServerResponse) {
  const config = resolveTelephonyConfig();
  const provider = getTelephonyProvider(config);
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type'] ?? '');
  const event = provider.parseInboundRequest(body, headersToRecord(req));

  if (event?.providerCallId || event?.callId) {
    const call = getCallByProviderId(event.providerCallId ?? '') ?? getCallById(event.callId);
    if (call && event.status) {
      saveCall({
        id: call.id,
        status: event.status,
        recordingUrl: event.recordingUrl,
        endedAt: ['completed', 'failed', 'no_answer', 'busy'].includes(event.status)
          ? new Date().toISOString()
          : undefined,
        durationSec: ['completed', 'failed', 'no_answer', 'busy'].includes(event.status)
          ? computeCallDurationSec({ ...call, endedAt: new Date().toISOString() })
          : undefined,
      });
    }
  }

  res.statusCode = 200;
  res.end('OK');
}

export async function handlePhoneOutboundWebhook(req: IncomingMessage, res: ServerResponse, url: URL) {
  const config = resolveTelephonyConfig();
  const provider = getTelephonyProvider(config);
  const callId = url.searchParams.get('callId') ?? `out-${Date.now()}`;
  const template = (url.searchParams.get('template') ?? 'lead_callback') as OutboundCampaignTemplate;
  const script = OUTBOUND_CAMPAIGN_SCRIPTS[template];

  saveCall({
    id: callId,
    direction: 'outbound',
    status: 'in_progress',
    campaignTemplate: template,
    transcript: [],
    startedAt: new Date().toISOString(),
  });

  const greeting = `${script.greeting} ${script.purpose}`;
  appendCallTurn(callId, { role: 'agent', content: greeting });

  const built = provider.buildResponse({ speak: greeting, gather: true }, callId, config);
  res.statusCode = 200;
  res.setHeader('Content-Type', built.contentType);
  res.end(built.body);
}

export async function handleOutboundCallApi(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { to, template, context, scheduledAt } = body;

  if (!to || !template) {
    sendJson(res, 400, { error: 'to and template are required' });
    return;
  }

  const config = resolveTelephonyConfig();
  const provider = getTelephonyProvider(config);
  const callId = `out-${Date.now()}`;

  const { enqueueOutboundCall } = await import('./data-store');
  const job = enqueueOutboundCall({
    to: String(to),
    template: String(template),
    status: 'queued',
    context: context ?? {},
    scheduledAt,
    callId,
  });

  if (!scheduledAt) {
    try {
      const result = await provider.placeCall(String(to), {
        callId,
        direction: 'outbound',
        from: config.fromNumber ?? '',
        to: String(to),
        campaignTemplate: template as OutboundCampaignTemplate,
        metadata: context,
      }, config);
      updateOutboundJob(String(job.id), { status: 'dialing', callId: result.callId });
      saveCall({
        id: result.callId,
        providerCallId: result.providerCallId,
        direction: 'outbound',
        from: config.fromNumber ?? '',
        to: String(to),
        status: 'ringing',
        campaignTemplate: template,
        transcript: [],
        startedAt: new Date().toISOString(),
      });
      sendJson(res, 200, { success: true, jobId: job.id, callId: result.callId });
      return;
    } catch (err) {
      updateOutboundJob(String(job.id), {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Dial failed',
      });
      sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Dial failed', jobId: job.id });
      return;
    }
  }

  sendJson(res, 200, { success: true, jobId: job.id, scheduled: true });
}

export async function handleCallsListApi(req: IncomingMessage, res: ServerResponse, url?: URL) {
  const store = getDataStore();
  const limit = Math.min(Number(url?.searchParams.get('limit') ?? 100), 100);
  const calls = store.calls.slice(0, limit).map(c => ({
    ...c,
    sentiment: c.sentiment ?? computeCallSentiment(c),
    durationSec: c.durationSec ?? computeCallDurationSec(c),
  }));
  sendJson(res, 200, {
    calls,
    outboundQueue: store.outboundQueue.slice(0, 50),
  });
}

export async function handleCallDetailApi(_req: IncomingMessage, res: ServerResponse, callId: string) {
  const call = getCallById(callId);
  if (!call) {
    sendJson(res, 404, { error: 'Call not found' });
    return;
  }
  sendJson(res, 200, { call });
}

export async function handleMockCallApi(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { from, speech, callId: existingCallId } = body;
  const callId = existingCallId ?? `mock-${Date.now()}`;

  const event: CallEvent = {
    type: speech ? 'speech_turn' : 'call_started',
    callId,
    from: String(from ?? '447700900123'),
    to: '442012345678',
    direction: 'inbound',
    speechResult: speech ? String(speech) : undefined,
  };

  const response = await processCallTurn(event, speech ? String(speech) : undefined);

  sendJson(res, 200, {
    callId,
    ...response,
    call: getCallById(callId),
  });
}

export async function handlePhoneRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname === '/webhooks/voice/inbound' && req.method === 'POST') {
    await handlePhoneInbound(req, res, url);
    return true;
  }
  if (pathname === '/webhooks/voice/turn' && req.method === 'POST') {
    await handlePhoneInbound(req, res, url);
    return true;
  }
  if (pathname === '/webhooks/voice/status' && req.method === 'POST') {
    await handlePhoneStatus(req, res);
    return true;
  }
  if (pathname === '/webhooks/voice/outbound' && req.method === 'POST') {
    await handlePhoneOutboundWebhook(req, res, url);
    return true;
  }
  if (pathname === '/api/calls/outbound' && req.method === 'POST') {
    await handleOutboundCallApi(req, res);
    return true;
  }
  if (pathname === '/api/calls' && req.method === 'GET') {
    await handleCallsListApi(req, res, url);
    return true;
  }
  if (pathname === '/api/calls/mock' && req.method === 'POST') {
    await handleMockCallApi(req, res);
    return true;
  }
  const detailMatch = pathname.match(/^\/api\/calls\/([^/]+)$/);
  if (detailMatch && req.method === 'GET') {
    await handleCallDetailApi(req, res, decodeURIComponent(detailMatch[1]));
    return true;
  }
  return false;
}
