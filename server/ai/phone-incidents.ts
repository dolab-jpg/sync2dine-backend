/**
 * Thin phone / Vapi ops incident store for AI Audit ? Phone errors.
 * Primary store: server/data/phone-incidents.json (Vapi ingestion can append later).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isAuthEnforced, requireAuth } from '../auth';
import { handleCodeFixRoutes } from '../code-fix-handler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, '..', 'data', 'phone-incidents.json');

type PhoneIncidentSeverity =
  | 'tool_fail'
  | 'webhook_fail'
  | 'call_fail'
  | 'stuck_call'
  | 'finalize_error';

type PhoneIncidentStatus = 'open' | 'acked' | 'fixing' | 'resolved' | 'dismissed';

interface PhoneOpsIncident {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  count: number;
  orgId?: string;
  severity: PhoneIncidentSeverity;
  status: PhoneIncidentStatus;
  callId?: string;
  providerCallId?: string;
  callerPhone?: string;
  toolName?: string;
  error: string;
  spokenSoftFail?: boolean;
  outcome?: string;
  route?: string;
  details?: Record<string, unknown>;
  codeFixJobId?: string;
  notifiedAt?: string;
}

interface PhoneOpsWebhookHealth {
  lastWebhookOkAt?: string;
  lastWebhookErrorAt?: string;
  lastWebhookError?: string;
  lastWebhookStatus?: number;
}

interface PhoneStore {
  incidents: PhoneOpsIncident[];
  health: PhoneOpsWebhookHealth;
}

const AUDIT_DELETE_ROLES = new Set(['super_admin', 'manager', 'platform_owner']);

/** Severities that page ops via SMS/email when a call hard-fails or webhook breaks. */
const PAGE_SEVERITIES = new Set<PhoneIncidentSeverity>(['webhook_fail', 'call_fail', 'stuck_call']);
const RE_PAGE_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function readStore(): PhoneStore {
  try {
    if (!existsSync(STORE_PATH)) return { incidents: [], health: {} };
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf-8')) as Partial<PhoneStore>;
    return {
      incidents: Array.isArray(raw.incidents) ? raw.incidents : [],
      health: raw.health && typeof raw.health === 'object' ? raw.health : {},
    };
  } catch {
    return { incidents: [], health: {} };
  }
}

function writeStore(store: PhoneStore): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const trimmed = {
    ...store,
    incidents: store.incidents.slice(-5000),
  };
  writeFileSync(STORE_PATH, JSON.stringify(trimmed, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function requireMutationAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAuthEnforced()) return true;
  const auth = requireAuth(req);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function requireDeleteAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAuthEnforced()) return true;
  const auth = requireAuth(req);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  if (!AUDIT_DELETE_ROLES.has(auth.role)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return false;
  }
  return true;
}

function findIncident(id: string): PhoneOpsIncident | undefined {
  return readStore().incidents.find((i) => i.id === id);
}

function upsertIncident(incident: PhoneOpsIncident): PhoneOpsIncident {
  const store = readStore();
  const idx = store.incidents.findIndex((i) => i.id === incident.id);
  if (idx >= 0) store.incidents[idx] = incident;
  else store.incidents.push(incident);
  writeStore(store);
  return incident;
}

function hardDeleteIncident(id: string): boolean {
  const store = readStore();
  const next = store.incidents.filter((i) => i.id !== id);
  if (next.length === store.incidents.length) return false;
  writeStore({ ...store, incidents: next });
  return true;
}

function alertIncidents(incidents: PhoneOpsIncident[]): PhoneOpsIncident[] {
  return incidents.filter((i) => i.status === 'open' || i.status === 'fixing');
}

async function invokeCodeFix(
  action: 'offer' | 'enqueue',
  incident: PhoneOpsIncident,
  requester: { name?: string; role?: string; userId?: string },
  authHeader?: string,
): Promise<{ ok: boolean; jobId?: string; skipped?: boolean; error?: string }> {
  const { Readable } = await import('stream');
  const body = JSON.stringify({
    action,
    errorCode: `PHONE_${incident.severity}`.toUpperCase(),
    description: incident.error,
    route: incident.route || '/phone',
    requesterName: requester.name || 'Phone ops audit',
    requesterRole: requester.role || 'platform_owner',
    requesterUserId: requester.userId,
    orgId: incident.orgId,
  });

  const req = Readable.from([body]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/ai/code-fix';
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...(authHeader ? { authorization: authHeader } : {}),
  };

  let status = 500;
  let payload = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string | Buffer) {
      if (chunk != null) payload += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    },
  } as unknown as ServerResponse;

  Object.defineProperty(res, 'statusCode', {
    get() { return status; },
    set(v: number) { status = v; },
  });

  await handleCodeFixRoutes(req, res, '/api/ai/code-fix');
  try {
    const data = JSON.parse(payload || '{}') as {
      job?: { id?: string };
      skipped?: boolean;
      error?: string;
      message?: string;
    };
    if (status >= 400) {
      return { ok: false, error: data.error || data.message || `Request failed (${status})` };
    }
    const jobId = data.job?.id;
    if (jobId) {
      upsertIncident({
        ...incident,
        status: 'fixing',
        codeFixJobId: jobId,
        lastSeenAt: nowIso(),
      });
    }
    return { ok: true, jobId, skipped: data.skipped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function incidentNotifyCopy(severity: PhoneIncidentSeverity): { title: string; message: string } | null {
  switch (severity) {
    case 'call_fail':
      return {
        title: 'A phone call failed to start',
        message: 'A diner or sales call just failed. Callers may hear an error or dead air.',
      };
    case 'webhook_fail':
      return {
        title: 'Phone system could not take a call',
        message: 'The phone webhook failed. Incoming calls may not be answered.',
      };
    case 'stuck_call':
      return {
        title: 'A call looks stuck',
        message: 'A live call stopped progressing. Check Call Centre.',
      };
    default:
      return null;
  }
}

function shouldPagePhoneIncident(incident: PhoneOpsIncident, isNew: boolean): boolean {
  if (!PAGE_SEVERITIES.has(incident.severity)) return false;
  if (isNew) return true;
  if (incident.status !== 'open') return false;
  if (!incident.notifiedAt) return true;
  return Date.now() - new Date(incident.notifiedAt).getTime() >= RE_PAGE_MS;
}

function maybeNotifyPhoneIncident(incident: PhoneOpsIncident, isNew: boolean): PhoneOpsIncident {
  if (!shouldPagePhoneIncident(incident, isNew)) return incident;
  const copy = incidentNotifyCopy(incident.severity);
  if (!copy) return incident;

  const withNotify: PhoneOpsIncident = { ...incident, notifiedAt: nowIso() };

  void import('../ops-notify')
    .then(({ sendOpsNotify }) =>
      sendOpsNotify({
        event: 'ops_alert',
        severity: 'critical',
        title: copy.title,
        message: copy.message,
        code: `phone_${incident.severity}`,
        orgId: incident.orgId,
      }),
    )
    .catch(() => {});

  return withNotify;
}

/** Optional writer for future Vapi soft-fail hooks. */
export function recordPhoneIncident(partial: Omit<PhoneOpsIncident, 'id' | 'createdAt' | 'lastSeenAt' | 'count' | 'status'> & {
  id?: string;
  status?: PhoneIncidentStatus;
  count?: number;
}): PhoneOpsIncident {
  const store = readStore();
  const existing = partial.id
    ? store.incidents.find((i) => i.id === partial.id)
    : store.incidents.find(
        (i) =>
          i.error === partial.error
          && i.toolName === partial.toolName
          && i.callId === partial.callId
          && (i.status === 'open' || i.status === 'acked' || i.status === 'fixing'),
      );
  if (existing) {
    const next: PhoneOpsIncident = {
      ...existing,
      ...partial,
      count: existing.count + 1,
      lastSeenAt: nowIso(),
      status: partial.status ?? existing.status,
    };
    return upsertIncident(maybeNotifyPhoneIncident(next, false));
  }
  const created: PhoneOpsIncident = {
    id: partial.id || newId(),
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    count: partial.count ?? 1,
    status: partial.status ?? 'open',
    severity: partial.severity,
    error: partial.error,
    orgId: partial.orgId,
    callId: partial.callId,
    providerCallId: partial.providerCallId,
    callerPhone: partial.callerPhone,
    toolName: partial.toolName,
    spokenSoftFail: partial.spokenSoftFail,
    outcome: partial.outcome,
    route: partial.route,
    details: partial.details,
    codeFixJobId: partial.codeFixJobId,
    notifiedAt: partial.notifiedAt,
  };
  return upsertIncident(maybeNotifyPhoneIncident(created, true));
}

export function updatePhoneWebhookHealth(patch: PhoneOpsWebhookHealth): void {
  const store = readStore();
  writeStore({ ...store, health: { ...store.health, ...patch } });
}

export async function handlePhoneIncidents(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/ai/phone-incidents')) return false;

  // POST /api/ai/phone-incidents/delete-batch
  if (req.method === 'POST' && pathname === '/api/ai/phone-incidents/delete-batch') {
    if (!requireDeleteAuth(req, res)) return true;
    let body: { ids?: string[] } = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as { ids?: string[] };
    } catch {
      body = {};
    }
    const ids = [...new Set((body.ids ?? []).filter(Boolean))];
    if (ids.length === 0) {
      sendJson(res, 400, { error: 'ids required' });
      return true;
    }
    const results = ids.map((id) => ({ id, ok: hardDeleteIncident(id) }));
    sendJson(res, 200, { results, deleted: results.filter((r) => r.ok).length });
    return true;
  }

  // POST /api/ai/phone-incidents/batch-code-fix
  if (req.method === 'POST' && pathname === '/api/ai/phone-incidents/batch-code-fix') {
    if (!requireMutationAuth(req, res)) return true;
    let body: {
      ids?: string[];
      action?: 'offer' | 'enqueue';
      requesterName?: string;
      requesterRole?: string;
      requesterUserId?: string;
    } = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as typeof body;
    } catch {
      body = {};
    }
    const action = body.action === 'enqueue' ? 'enqueue' : 'offer';
    const cap = 5;
    const ids = (body.ids ?? []).filter(Boolean).slice(0, cap);
    const results: Array<{
      id: string;
      ok: boolean;
      jobId?: string;
      skipped?: boolean;
      error?: string;
    }> = [];
    let offered = 0;
    let enqueued = 0;
    for (const id of ids) {
      const incident = findIncident(id);
      if (!incident) {
        results.push({ id, ok: false, error: 'Not found' });
        continue;
      }
      const result = await invokeCodeFix(action, incident, {
        name: body.requesterName,
        role: body.requesterRole,
        userId: body.requesterUserId,
      }, typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
      results.push({ id, ...result });
      if (result.ok && !result.skipped) {
        if (action === 'offer') offered += 1;
        else enqueued += 1;
      }
    }
    sendJson(res, 200, { results, offered, enqueued, cap });
    return true;
  }

  // GET /api/ai/phone-incidents
  if (req.method === 'GET' && pathname === '/api/ai/phone-incidents') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = url.searchParams.get('status');
    const severity = url.searchParams.get('severity');
    const search = url.searchParams.get('search')?.toLowerCase();
    const store = readStore();
    let incidents = [...store.incidents].sort(
      (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
    );
    if (status) incidents = incidents.filter((i) => i.status === status);
    if (severity) incidents = incidents.filter((i) => i.severity === severity);
    if (search) {
      incidents = incidents.filter((i) => {
        const blob = [
          i.error,
          i.toolName,
          i.callId,
          i.providerCallId,
          i.callerPhone,
          i.route,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return blob.includes(search);
      });
    }
    const alerts = alertIncidents(store.incidents);
    sendJson(res, 200, {
      incidents,
      alerts,
      health: store.health,
      openCount: store.incidents.filter((i) => i.status === 'open').length,
    });
    return true;
  }

  // POST /api/ai/phone-incidents (create / record)
  if (req.method === 'POST' && pathname === '/api/ai/phone-incidents') {
    if (!requireMutationAuth(req, res)) return true;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const error = String(body.error ?? '').trim();
    const severity = String(body.severity ?? 'tool_fail') as PhoneIncidentSeverity;
    if (!error) {
      sendJson(res, 400, { error: 'error required' });
      return true;
    }
    const incident = recordPhoneIncident({
      severity,
      error,
      orgId: body.orgId ? String(body.orgId) : undefined,
      callId: body.callId ? String(body.callId) : undefined,
      providerCallId: body.providerCallId ? String(body.providerCallId) : undefined,
      callerPhone: body.callerPhone ? String(body.callerPhone) : undefined,
      toolName: body.toolName ? String(body.toolName) : undefined,
      spokenSoftFail: Boolean(body.spokenSoftFail),
      outcome: body.outcome ? String(body.outcome) : undefined,
      route: body.route ? String(body.route) : undefined,
      details: body.details && typeof body.details === 'object'
        ? (body.details as Record<string, unknown>)
        : undefined,
    });
    sendJson(res, 200, { incident });
    return true;
  }

  const idMatch = pathname.match(/^\/api\/ai\/phone-incidents\/([^/]+)(?:\/(ack|dismiss|resolve))?$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    const action = idMatch[2] as 'ack' | 'dismiss' | 'resolve' | undefined;

    if (req.method === 'GET' && !action) {
      const incident = findIncident(id);
      if (!incident) {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      sendJson(res, 200, { incident });
      return true;
    }

    if (req.method === 'DELETE' && !action) {
      if (!requireDeleteAuth(req, res)) return true;
      if (!hardDeleteIncident(id)) {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      sendJson(res, 200, { ok: true, id });
      return true;
    }

    if (req.method === 'POST' && action) {
      if (!requireMutationAuth(req, res)) return true;
      const incident = findIncident(id);
      if (!incident) {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      const statusMap = {
        ack: 'acked',
        dismiss: 'dismissed',
        resolve: 'resolved',
      } as const;
      const next = upsertIncident({
        ...incident,
        status: statusMap[action],
        lastSeenAt: nowIso(),
      });
      sendJson(res, 200, { incident: next });
      return true;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
