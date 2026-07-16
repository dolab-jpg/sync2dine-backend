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
  getRequestOrgId,
  isAfterHours,
  isAgentActive,
  markCustomerDialling,
  resolveCandidateByPhone,
  resolveContactByPhone,
  resolvePhoneLineByDid,
  saveCall,
  syncData,
  setRequestOrgId,
  updateOutboundJob,
} from './data-store';
import { resolveOrgIdForRequest } from './auth';
import { OpenAIConnectionError } from './openai-connection';
import { getOrganizationByPhoneDid } from './organizations';
import { handleChannelInbound } from './channel-inbound-handler';
import { buildPhoneBrainPrompt } from './phone-brain';
import {
  getTelephonyProvider,
  resolveTelephonyConfig,
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

function resolvePhoneOrgId(toDid: string): string {
  const byDid = getOrganizationByPhoneDid(toDid);
  if (byDid?.id) return byDid.id;
  // Keep CRM on the default local store — never switch to a cloud org UUID just because it has an OpenAI key.
  const current = getRequestOrgId();
  if (current && current !== DEFAULT_ORG_ID && current !== 'default') {
    // Only keep non-default if it actually has CRM data loaded; otherwise default.
    return DEFAULT_ORG_ID;
  }
  return DEFAULT_ORG_ID;
}

function getOrCreateCall(event: CallEvent): Record<string, unknown> {
  setRequestOrgId(resolvePhoneOrgId(event.to));

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
  const partyPhone = event.direction === 'outbound'
    ? String(event.to || call.to || event.from || '')
    : String(event.from || call.from || '');
  const resolved = resolveContactByPhone(partyPhone);
  const afterHours = isAfterHours();

  if (resolved.customerId) {
    saveCall({
      id: call.id,
      customerId: resolved.customerId,
      contactName: resolved.customerName,
      to: event.to,
      from: event.from,
      direction: event.direction,
    });
  }

  const orgId = resolvePhoneOrgId(
    event.direction === 'outbound'
      ? String(event.from || call.from || event.to || '')
      : String(event.to || call.to || ''),
  );

  const { instructions: phonePrompt } = buildPhoneBrainPrompt({
    orgId,
    partyPhone,
    direction: (event.direction as 'inbound' | 'outbound') || 'outbound',
    campaignTemplate: call.campaignTemplate ? String(call.campaignTemplate) : undefined,
    contactName: resolved.customerName || resolved.contactName,
  });

  const brainContext = [
    phonePrompt,
    afterHours ? 'Office is currently outside normal hours — still help, offer a callback if needed.' : '',
  ].filter(Boolean).join('\n\n');

  const isConnect = !speechText?.trim();
  const inboundText = isConnect
    ? (event.direction === 'outbound'
      ? 'The phone call just connected. Greet them naturally in one or two short spoken sentences using the account memory you already have.'
      : 'An inbound phone call just connected. Greet them warmly in one or two short spoken sentences using any account memory you have.')
    : String(speechText).trim();

  if (speechText) {
    appendCallTurn(String(call.id), { role: 'caller', content: speechText });
    await appendAuditLog(call, 'user', speechText, resolved.customerName);
  }

  // One AI brain (same stack as Cyrus): company studio + account memory + chat history
  const channelResult = await handleChannelInbound({
    orgId,
    phone: partyPhone,
    text: inboundText,
    channel: 'phone',
    contactName: resolved.customerName || resolved.contactName,
    projectId: resolved.projectId,
    brainContext,
    persistUser: !isConnect,
  });

  const speak = String(channelResult.replyLocalized || channelResult.replyEnglish || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
    || (isConnect
      ? `Hello${resolved.customerName ? ` ${resolved.customerName}` : ''}, it's Lizzie from Sync2Dine. How can I help today?`
      : "Sorry, I didn't quite catch that — could you say that again?");

  appendCallTurn(String(call.id), { role: 'agent', content: speak });
  await appendAuditLog(call, 'assistant', speak, 'Lizzie');

  const updated = getCallById(String(call.id)) ?? call;
  saveCall({
    id: call.id,
    contactName: resolved.customerName,
    customerId: resolved.customerId,
    sentiment: computeCallSentiment(updated),
    durationSec: computeCallDurationSec(updated),
  });

  if (resolved.customerId && speechText) {
    const { appendCustomerCallActivity } = await import('./data-store');
    appendCustomerCallActivity({
      customerId: resolved.customerId,
      callId: String(call.id),
      summary: `Caller: ${speechText.slice(0, 160)} | Lizzie: ${speak.slice(0, 160)}`,
    });
  }

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

  return { speak, gather: true, hangup: false };
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

  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type'] ?? '');
  const to = String(body.to ?? '');
  const from = String(body.from ?? config.fromNumber ?? '');

  const existing = getCallById(callId);
  saveCall({
    id: callId,
    direction: 'outbound',
    status: 'in_progress',
    campaignTemplate: template,
    to: to || existing?.to,
    from: from || existing?.from,
    transcript: Array.isArray(existing?.transcript) ? existing?.transcript as unknown[] : [],
    startedAt: (existing?.startedAt as string) ?? new Date().toISOString(),
  });

  const event: CallEvent = {
    type: 'call_started',
    callId,
    from,
    to,
    direction: 'outbound',
    status: 'in_progress',
  };

  // AI opener via tools (no canned script)
  const response = await processCallTurn(event, undefined);

  const built = provider.buildResponse(response, callId, config);
  res.statusCode = 200;
  res.setHeader('Content-Type', built.contentType);
  res.end(built.body);
}

export async function handleOutboundCallApi(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const { to, template, context, scheduledAt, fromWorker } = body;

  if (!to || !template) {
    sendJson(res, 400, { error: 'to and template are required' });
    return;
  }

  const callId = `out-${Date.now()}`;
  const meta = {
    ...(context && typeof context === 'object' ? context : {}),
    customerId: context?.customerId,
    aim: context?.aim ?? context?.reason,
    brief: context?.brief ?? context?.aim ?? context?.reason,
  };

  if (body.enqueueOnly === true || body.enqueueOnly === '1') {
    const { enqueueOutboundCall } = await import('./data-store');
    const job = enqueueOutboundCall({
      to: String(to),
      template: String(template),
      status: 'queued',
      context: meta,
      scheduledAt,
      callId,
    });
    sendJson(res, 200, { success: true, jobId: job.id, status: 'queued', enqueueOnly: true });
    return;
  }

  const config = resolveTelephonyConfig();
  const provider = getTelephonyProvider(config);

  // Worker already owns the queue row — dial only, do not enqueue another job.
  if (fromWorker === true || fromWorker === '1') {
    try {
      const result = await provider.placeCall(String(to), {
        callId,
        direction: 'outbound',
        from: config.fromNumber ?? '',
        to: String(to),
        campaignTemplate: template as OutboundCampaignTemplate,
        metadata: meta,
      }, config);
      saveCall({
        id: result.callId,
        providerCallId: result.providerCallId,
        direction: 'outbound',
        from: config.fromNumber ?? '',
        to: String(to),
        status: 'ringing',
        campaignTemplate: template,
        customerId: meta.customerId ? String(meta.customerId) : undefined,
        transcript: [],
        startedAt: new Date().toISOString(),
        metadata: meta,
      });
      if (meta.customerId) {
        markCustomerDialling(String(meta.customerId), result.callId);
        appendCustomerCallActivity({
          customerId: String(meta.customerId),
          callId: result.callId,
          summary: `Outbound dialling${meta.brief ? `: ${String(meta.brief).slice(0, 120)}` : ''}`,
          detail: meta.brief ? String(meta.brief).slice(0, 800) : 'Outbound call started',
          aim: meta.aim ? String(meta.aim) : 'callback',
          type: 'callback',
          createdBy: 'staff',
        });
      }
      sendJson(res, 200, { success: true, callId: result.callId, fromWorker: true, status: 'dialling' });
      return;
    } catch (err) {
      sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Dial failed' });
      return;
    }
  }

  const { enqueueOutboundCall } = await import('./data-store');
  const job = enqueueOutboundCall({
    to: String(to),
    template: String(template),
    status: 'queued',
    context: meta,
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
        metadata: meta,
      }, config);
      updateOutboundJob(String(job.id), { status: 'dialling', callId: result.callId });
      saveCall({
        id: result.callId,
        providerCallId: result.providerCallId,
        direction: 'outbound',
        from: config.fromNumber ?? '',
        to: String(to),
        status: 'ringing',
        campaignTemplate: template,
        customerId: meta.customerId ? String(meta.customerId) : undefined,
        transcript: [],
        startedAt: new Date().toISOString(),
        metadata: meta,
      });
      if (meta.customerId) {
        markCustomerDialling(String(meta.customerId), result.callId);
        appendCustomerCallActivity({
          customerId: String(meta.customerId),
          callId: result.callId,
          summary: `Outbound dialling${meta.brief ? `: ${String(meta.brief).slice(0, 120)}` : ''}`,
          detail: meta.brief ? String(meta.brief).slice(0, 800) : 'Outbound call started',
          aim: meta.aim ? String(meta.aim) : 'callback',
          type: 'callback',
          createdBy: 'staff',
        });
      }
      sendJson(res, 200, { success: true, jobId: job.id, callId: result.callId, status: 'dialling' });
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

  sendJson(res, 200, { success: true, jobId: job.id, scheduled: true, status: 'queued' });
}

export async function handleOutboundBulkApi(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as {
    rows?: Array<{ company?: string; name?: string; phone?: string; customerId?: string }>;
    template?: string;
    batchId?: string;
    brief?: string;
  };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) {
    sendJson(res, 400, { error: 'rows array is required' });
    return;
  }
  const template = String(body.template ?? 'lead_callback');
  const batchId = String(body.batchId ?? `sales-csv-${new Date().toISOString().slice(0, 10)}`);
  const defaultBrief = String(body.brief ?? 'Sales outreach — introduce Sync2Dine takeaway phone platform.');
  const { enqueueOutboundCall } = await import('./data-store');
  const jobs: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const phone = String(row.phone ?? '').trim();
    const company = String(row.company ?? row.name ?? '').trim();
    if (!phone) {
      skipped.push('missing phone');
      continue;
    }
    const job = enqueueOutboundCall({
      to: phone,
      template,
      status: 'queued',
      context: {
        customerId: row.customerId,
        company,
        aim: 'sales_outreach',
        brief: company ? `${defaultBrief} Company: ${company}.` : defaultBrief,
        source: 'sales_csv_dial',
        batchId,
      },
    });
    jobs.push(job);
  }

  sendJson(res, 200, {
    success: true,
    queued: jobs.length,
    skipped: skipped.length,
    batchId,
    jobs: jobs.slice(0, 50),
  });
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
  let body: { from?: string; speech?: string; callId?: string; orgId?: string; to?: string } = {};
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const headerOrgId = resolveOrgIdForRequest(req, body);
  if (headerOrgId) setRequestOrgId(headerOrgId);

  const { from, speech, callId: existingCallId, to } = body;
  const callId = existingCallId ?? `mock-${Date.now()}`;

  const event: CallEvent = {
    type: speech ? 'speech_turn' : 'call_started',
    callId,
    from: String(from ?? '447700900123'),
    to: String(to ?? '442012345678'),
    direction: 'inbound',
    speechResult: speech ? String(speech) : undefined,
  };

  try {
    const response = await processCallTurn(event, speech ? String(speech) : undefined);
    sendJson(res, 200, {
      callId,
      ...response,
      call: getCallById(callId),
    });
  } catch (err) {
    if (err instanceof OpenAIConnectionError) {
      sendJson(res, 503, { error: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error ? err.message : 'Mock call failed';
    sendJson(res, 500, { error: message });
  }
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
  if (pathname === '/api/calls/outbound/bulk' && req.method === 'POST') {
    await handleOutboundBulkApi(req, res);
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
