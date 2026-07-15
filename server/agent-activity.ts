/**
 * Agent activity emitter — the "Cynthia is doing this" live feed.
 *
 * emitAgentActivity() is fire-and-forget: it never throws and never blocks the
 * caller. Events go to the org/user-scoped `agent_activity_events` Supabase
 * table (streamed to devices via Realtime) when Supabase is configured, and
 * always into an in-memory ring buffer so the replay API works without it.
 *
 * Standalone by design: orchestrator-handler / tool-facade / phone-tools can
 * call emitAgentActivity() with one line when they are ready to wire in.
 */
import { randomUUID } from 'crypto';

export const AGENT_ACTIVITY_PHASES = [
  'started',
  'working',
  'changed',
  'saved',
  'navigate',
  'completed',
  'error',
] as const;

export type AgentActivityPhase = (typeof AGENT_ACTIVITY_PHASES)[number];

export function isAgentActivityPhase(value: unknown): value is AgentActivityPhase {
  return typeof value === 'string' && (AGENT_ACTIVITY_PHASES as readonly string[]).includes(value);
}

export interface AgentActivityInput {
  orgId?: string | null;
  targetUserId: string;
  sessionId?: string;
  channel?: string;
  capability?: string;
  action?: string;
  phase: AgentActivityPhase;
  summary: string;
  route?: string;
  payload?: Record<string, unknown>;
}

export interface AgentActivityEvent {
  id: string;
  orgId: string;
  targetUserId: string;
  seq: number;
  sessionId?: string;
  channel?: string;
  capability?: string;
  action?: string;
  phase: AgentActivityPhase;
  summary: string;
  route?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export const MAX_SUMMARY_LENGTH = 500;
export const MAX_PAYLOAD_JSON_LENGTH = 8_000;
const RING_BUFFER_SIZE = 200;

const SENSITIVE_KEY_RE = /(token|password|secret|api[-_]?key|authorization|bearer|credential)/i;

/** Recursively drop keys that look like secrets; cap depth to stay cheap. */
export function sanitizeActivityPayload(
  payload: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (depth > 4) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeActivityPayload(value as Record<string, unknown>, depth + 1);
      if (nested !== undefined) clean[key] = nested;
    } else {
      clean[key] = value;
    }
  }
  try {
    if (JSON.stringify(clean).length > MAX_PAYLOAD_JSON_LENGTH) {
      return { truncated: true };
    }
  } catch {
    return undefined;
  }
  return clean;
}

export function clampSummary(summary: string): string {
  const trimmed = String(summary ?? '').trim();
  if (trimmed.length <= MAX_SUMMARY_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

// ── In-memory ring buffer (per org) ──

let ringSeq = 0;
const ringBuffers = new Map<string, AgentActivityEvent[]>();

function pushToRingBuffer(event: AgentActivityEvent): void {
  const key = event.orgId || 'default';
  const buffer = ringBuffers.get(key) ?? [];
  buffer.push(event);
  if (buffer.length > RING_BUFFER_SIZE) buffer.splice(0, buffer.length - RING_BUFFER_SIZE);
  ringBuffers.set(key, buffer);
}

export function listRingBufferEvents(opts: {
  orgId?: string | null;
  targetUserId: string;
  sinceSeq?: number;
  limit?: number;
}): AgentActivityEvent[] {
  const key = opts.orgId?.trim() || 'default';
  const buffer = ringBuffers.get(key) ?? [];
  const since = Number.isFinite(opts.sinceSeq) ? Number(opts.sinceSeq) : 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), RING_BUFFER_SIZE);
  return buffer
    .filter((e) => e.targetUserId === opts.targetUserId && e.seq > since)
    .slice(-limit);
}

/** Test helper — reset module state between test cases. */
export function __resetAgentActivityForTests(): void {
  ringBuffers.clear();
  ringSeq = 0;
}

// ── Emission ──

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

async function insertIntoSupabase(event: AgentActivityEvent): Promise<void> {
  const { getSupabaseAdmin, resolveOrgUuid } = await import('./supabase-admin.js');
  const orgUuid = await resolveOrgUuid(event.orgId);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('agent_activity_events').insert({
    id: event.id,
    org_id: orgUuid,
    target_user_id: event.targetUserId,
    session_id: event.sessionId ?? null,
    channel: event.channel ?? null,
    capability: event.capability ?? null,
    action: event.action ?? null,
    phase: event.phase,
    summary: event.summary,
    route: event.route ?? null,
    payload: event.payload ?? null,
    created_at: event.createdAt,
  } as never);
  if (error) throw new Error(error.message);
}

/**
 * Record one activity event. Never throws; failures are swallowed with a
 * console.warn so tool execution is never slowed down or broken by the feed.
 */
export function emitAgentActivity(input: AgentActivityInput): AgentActivityEvent | null {
  try {
    const targetUserId = String(input.targetUserId ?? '').trim();
    if (!targetUserId || targetUserId === 'default-staff') return null;
    if (!isAgentActivityPhase(input.phase)) return null;

    const event: AgentActivityEvent = {
      id: randomUUID(),
      orgId: input.orgId?.trim() || 'default',
      targetUserId,
      seq: ++ringSeq,
      sessionId: input.sessionId,
      channel: input.channel,
      capability: input.capability,
      action: input.action,
      phase: input.phase,
      summary: clampSummary(input.summary) || input.phase,
      route: input.route,
      payload: sanitizeActivityPayload(input.payload),
      createdAt: new Date().toISOString(),
    };

    pushToRingBuffer(event);

    if (supabaseConfigured()) {
      void insertIntoSupabase(event).catch((err) => {
        console.warn('[agent-activity] Supabase insert failed:', err instanceof Error ? err.message : err);
      });
    }
    return event;
  } catch (err) {
    console.warn('[agent-activity] emit failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Replay events for one user: Supabase when configured, else the ring buffer. */
export async function listAgentActivity(opts: {
  orgId?: string | null;
  targetUserId: string;
  sinceSeq?: number;
  limit?: number;
}): Promise<AgentActivityEvent[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), RING_BUFFER_SIZE);
  if (!supabaseConfigured()) {
    return listRingBufferEvents({ ...opts, limit });
  }
  try {
    const { getSupabaseAdmin, resolveOrgUuid } = await import('./supabase-admin.js');
    const orgUuid = await resolveOrgUuid(opts.orgId);
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from('agent_activity_events')
      .select('*')
      .eq('org_id', orgUuid)
      .eq('target_user_id', opts.targetUserId)
      .order('seq', { ascending: false })
      .limit(limit);
    const since = Number(opts.sinceSeq);
    if (Number.isFinite(since) && since > 0) {
      query = query.gt('seq', since);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        id: String(row.id),
        orgId: String(row.org_id),
        targetUserId: String(row.target_user_id),
        seq: Number(row.seq),
        sessionId: row.session_id ? String(row.session_id) : undefined,
        channel: row.channel ? String(row.channel) : undefined,
        capability: row.capability ? String(row.capability) : undefined,
        action: row.action ? String(row.action) : undefined,
        phase: String(row.phase) as AgentActivityPhase,
        summary: String(row.summary ?? ''),
        route: row.route ? String(row.route) : undefined,
        payload: (row.payload ?? undefined) as Record<string, unknown> | undefined,
        createdAt: String(row.created_at ?? ''),
      }))
      .reverse();
  } catch (err) {
    console.warn('[agent-activity] Supabase read failed, falling back to ring buffer:', err instanceof Error ? err.message : err);
    return listRingBufferEvents({ ...opts, limit });
  }
}
