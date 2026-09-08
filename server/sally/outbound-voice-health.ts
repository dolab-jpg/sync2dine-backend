/**
 * Pre-dial Vapi health + silent-outbound detection.
 * Pauses the autodialer after consecutive dead-agent outbound calls.
 */
import { assertVapiProductionReady, type ProviderHealth } from '../provider-gates';
import { getAgentSettings, updateAgentSettings } from '../data-store';
import { getTelephonyProvider, resolveTelephonyConfig } from '../telephony';
import { recordPhoneIncident } from '../ai/phone-incidents';

export type VoiceReady = { ok: boolean; error?: string };

export type OutboundVoiceHealthStamp = {
  ok: boolean;
  error?: string;
  checkedAt: string;
  consecutiveSilentOutbound?: number;
  lastSilentCallId?: string;
  pausedForSilent?: boolean;
};

const HEALTH_CACHE_MS = 45_000;
const SILENT_PAUSE_AFTER = 2;

export function combineVoiceReady(
  production: Pick<ProviderHealth, 'ok' | 'errors'>,
  connection: { ok: boolean; message: string },
): VoiceReady {
  if (!production.ok) {
    return { ok: false, error: (production.errors || []).filter(Boolean).join('; ') || 'Vapi is not production-ready' };
  }
  if (!connection.ok) {
    return { ok: false, error: connection.message || 'Vapi connection failed' };
  }
  return { ok: true };
}

export function getOutboundVoiceHealthStamp(): OutboundVoiceHealthStamp | undefined {
  const raw = getAgentSettings().outboundVoiceHealth;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as OutboundVoiceHealthStamp;
}

export function stampOutboundVoiceHealth(patch: Partial<OutboundVoiceHealthStamp>): OutboundVoiceHealthStamp {
  const prev = getOutboundVoiceHealthStamp() || {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    consecutiveSilentOutbound: 0,
  };
  const next: OutboundVoiceHealthStamp = {
    ...prev,
    ...patch,
    checkedAt: patch.checkedAt || new Date().toISOString(),
  };
  updateAgentSettings({ outboundVoiceHealth: next });
  return next;
}

export function assistantSpeechTurns(transcript: unknown): number {
  if (!Array.isArray(transcript)) return 0;
  return transcript.filter((turn) => {
    const row = turn && typeof turn === 'object' ? turn as Record<string, unknown> : {};
    const role = String(row.role || '').toLowerCase();
    const content = String(row.content || '').trim();
    if (!content) return false;
    return role === 'agent' || role === 'assistant' || role === 'bot' || role === 'sally' || role === 'judie' || role === 'cynthia';
  }).length;
}

export function isSilentOutboundCall(opts: {
  direction?: string;
  endedReason?: string;
  disposition?: string;
  durationSec?: number;
  transcript?: unknown;
}): boolean {
  if (String(opts.direction || '').toLowerCase() !== 'outbound') return false;
  const reason = `${opts.endedReason || ''} ${opts.disposition || ''}`.toLowerCase();
  const speech = assistantSpeechTurns(opts.transcript);
  if (speech > 0) return false;
  if (/no-answer|no_answer|busy|voicemail|machine|customer-did-not-answer|customer-ended|caller-ended|customer-hangup|\bhangup\b/.test(reason)
    && !/silence-timed-out/.test(reason)) {
    return false;
  }
  if (/silence-timed-out/.test(reason)) return true;
  const dur = Number(opts.durationSec ?? 0);
  return Number.isFinite(dur) && dur >= 8;
}

export function nextSilentStreak(prevConsecutive: number, silent: boolean): {
  consecutive: number;
  shouldPause: boolean;
} {
  if (!silent) return { consecutive: 0, shouldPause: false };
  const consecutive = prevConsecutive + 1;
  return { consecutive, shouldPause: consecutive >= SILENT_PAUSE_AFTER };
}

export function noteOutboundCallSpeech(opts: {
  callId: string;
  direction?: string;
  endedReason?: string;
  disposition?: string;
  durationSec?: number;
  transcript?: unknown;
  partyPhone?: string;
  aim?: string;
  template?: string;
}): { silent: boolean; paused: boolean; consecutive: number } {
  const hireMark = `${opts.aim || ''} ${opts.template || ''}`.toLowerCase().includes('recruitment_interview');
  const reason = `${opts.endedReason || ''} ${opts.disposition || ''}`.toLowerCase();
  const speech = assistantSpeechTurns(opts.transcript);
  const trueDeadAgent = speech === 0 && /silence-timed-out/.test(reason);
  if (hireMark && !trueDeadAgent) {
    const prev = getOutboundVoiceHealthStamp();
    return {
      silent: false,
      paused: false,
      consecutive: Number(prev?.consecutiveSilentOutbound ?? 0),
    };
  }
  const silent = isSilentOutboundCall(opts);
  const prev = getOutboundVoiceHealthStamp();
  const streak = nextSilentStreak(Number(prev?.consecutiveSilentOutbound ?? 0), silent);
  const patch: Partial<OutboundVoiceHealthStamp> = {
    consecutiveSilentOutbound: streak.consecutive,
    lastSilentCallId: silent ? opts.callId : prev?.lastSilentCallId,
  };
  if (silent) {
    try {
      recordPhoneIncident({
        severity: 'call_fail',
        error: 'silent_outbound: agent did not speak',
        callId: opts.callId,
        callerPhone: opts.partyPhone,
        outcome: opts.endedReason || opts.disposition,
        route: '/api/calls/outbound',
        details: { kind: 'silent_outbound', durationSec: opts.durationSec ?? null },
      });
    } catch {
      /* incident store must not break finalize */
    }
  }
  if (streak.shouldPause) {
    patch.pausedForSilent = true;
    patch.ok = false;
    patch.error = 'Paused outbound: two consecutive silent calls (agent did not speak)';
    updateAgentSettings({ outboundQueueState: 'paused', outboundVoiceHealth: {
      ...(prev || { ok: false, checkedAt: new Date().toISOString() }),
      ...patch,
      checkedAt: new Date().toISOString(),
    } });
    return { silent, paused: true, consecutive: streak.consecutive };
  }
  stampOutboundVoiceHealth(patch);
  return { silent, paused: false, consecutive: streak.consecutive };
}

export async function ensureOutboundVoiceReady(): Promise<boolean> {
  const cached = getOutboundVoiceHealthStamp();
  const checkedAt = cached?.checkedAt ? Date.parse(cached.checkedAt) : NaN;
  const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < HEALTH_CACHE_MS;
  if (cached?.ok && fresh && !cached.pausedForSilent) return true;

  const production = assertVapiProductionReady();
  let connection = { ok: true, message: 'skipped' };
  try {
    const telConfig = resolveTelephonyConfig();
    connection = await getTelephonyProvider(telConfig).testConnection(telConfig);
  } catch (err) {
    connection = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const ready = combineVoiceReady(production, connection);
  stampOutboundVoiceHealth({
    ok: ready.ok,
    error: ready.error,
    pausedForSilent: ready.ok ? false : cached?.pausedForSilent,
  });
  return ready.ok;
}
