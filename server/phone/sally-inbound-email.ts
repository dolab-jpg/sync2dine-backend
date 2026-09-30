/**
 * Inbound Sally call report: after end-of-call, email the owner the summary,
 * full transcript and recording (attached) from the connected info@sync2gear.com Gmail.
 */
import { getCallById, saveCall } from '../data-store';
import { sendOpsAlertEmail, type OpsEmailAttachment } from '../ops-gmail-send';
import { flattenCallTranscript } from '../sally/recruitment-interview';
import {
  createCallRecordingSignedUrl,
  downloadAudio,
  resolveCallPlaybackUrl,
  type IngestResult,
} from './call-recording-store';
import { SALLY_PERSONA } from './sally-sales-phone';

const DEFAULT_TO = 'dolab@dolab.me, info@sync2gear.com';
const DEFAULT_FROM = 'info@sync2gear.com';
/** Gmail caps a message at 25 MB after base64 (~33% overhead). */
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const LINK_TTL_SEC = 7 * 24 * 60 * 60;

const inFlight = new Set<string>();

export function isInboundSallyCall(call: Record<string, unknown> | undefined | null): boolean {
  if (!call) return false;
  if (String(call.direction || '').toLowerCase() !== 'inbound') return false;
  const meta = (call.metadata as Record<string, unknown> | undefined) || {};
  return String(meta.linePurpose || '').toLowerCase() === 'sally'
    || String(meta.agentPersona || '').toLowerCase() === SALLY_PERSONA;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(sec: unknown): string {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

function formatLondon(iso: unknown): string {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
}

function speakerLabel(role: string): string {
  return role === 'assistant' ? 'Sally' : 'Caller';
}

async function loadRecording(callId: string): Promise<{
  attachment?: OpsEmailAttachment;
  link?: string;
  note?: string;
}> {
  const call = getCallById(callId);
  const storagePath = String(call?.recordingStoragePath || call?.stereoStoragePath || '').trim();
  const link = storagePath
    ? (await createCallRecordingSignedUrl(storagePath, LINK_TTL_SEC)) || undefined
    : undefined;

  const playback = await resolveCallPlaybackUrl(callId);
  const source = link || playback.url;
  if (!source) return { note: 'No recording was available for this call.' };

  const audio = await downloadAudio(source);
  if (!audio) return { link: link || playback.url || undefined, note: 'Recording could not be downloaded to attach.' };
  if (audio.buffer.length > MAX_ATTACHMENT_BYTES) {
    return { link: link || playback.url || undefined, note: 'Recording is too large to attach — use the link.' };
  }
  const ext = /mpeg|mp3/i.test(audio.contentType) ? 'mp3'
    : /ogg/i.test(audio.contentType) ? 'ogg'
      : /mp4|m4a/i.test(audio.contentType) ? 'm4a'
        : 'wav';
  return {
    link,
    attachment: {
      filename: `sally-call-${callId}.${ext}`,
      content: audio.buffer,
      contentType: audio.contentType,
    },
  };
}

export function buildSallyInboundReportEmail(
  call: Record<string, unknown>,
  summaryIn: string,
  recording: { attachment?: OpsEmailAttachment; link?: string; note?: string },
): { subject: string; text: string; html: string } {
  const meta = (call.metadata as Record<string, unknown> | undefined) || {};
  const caller = String(meta.partyPhone || call.from || 'unknown number');
  const name = String(call.contactName || '').trim();
  const callerLabel = name ? `${name} (${caller})` : caller;
  const summary = summaryIn.trim() || 'No summary was generated for this call.';

  const turns = Array.isArray(call.transcript)
    ? (call.transcript as Array<{ role?: string; content?: string }>)
      .map((t) => ({ who: speakerLabel(String(t.role || '')), text: String(t.content ?? '').trim() }))
      .filter((t) => t.text)
    : [];
  const transcriptText = turns.length
    ? turns.map((t) => `${t.who}: ${t.text}`).join('\n')
    : (flattenCallTranscript(call.transcript) || 'No transcript was captured.');

  const facts: Array<[string, string]> = [
    ['Caller', callerLabel],
    ['Line called', String(meta.lineDid || call.to || 'Sally line')],
    ['Started', formatLondon(call.startedAt)],
    ['Duration', formatDuration(call.durationSec)],
    ['Outcome', String(call.outcome || meta.disposition || meta.vapiEndedReason || 'unknown')],
  ];

  const text = [
    `Inbound call to Sally from ${callerLabel}`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    'SUMMARY',
    summary,
    '',
    'RECORDING',
    recording.attachment ? 'Attached to this email.' : (recording.note || ''),
    recording.link ? `Link (valid 7 days): ${recording.link}` : '',
    '',
    'TRANSCRIPT',
    transcriptText,
  ].filter((line, i, arr) => line !== '' || arr[i - 1] !== '').join('\n');

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:680px">
<h2 style="margin:0 0 12px">Inbound call to Sally</h2>
<table style="border-collapse:collapse;margin-bottom:16px">${facts.map(([k, v]) => (
    `<tr><td style="padding:3px 12px 3px 0;color:#555">${escapeHtml(k)}</td><td style="padding:3px 0"><b>${escapeHtml(v)}</b></td></tr>`
  )).join('')}</table>
<h3 style="margin:16px 0 6px">Summary</h3>
<p style="white-space:pre-wrap;margin:0">${escapeHtml(summary)}</p>
<h3 style="margin:16px 0 6px">Recording</h3>
<p style="margin:0">${recording.attachment ? 'Attached to this email.' : escapeHtml(recording.note || '')}${
    recording.link ? ` <a href="${escapeHtml(recording.link)}">Listen online</a> (link valid 7 days).` : ''
  }</p>
<h3 style="margin:16px 0 6px">Transcript</h3>
${turns.length
    ? turns.map((t) => `<p style="margin:0 0 8px"><b>${escapeHtml(t.who)}:</b> ${escapeHtml(t.text)}</p>`).join('\n')
    : `<p style="white-space:pre-wrap">${escapeHtml(transcriptText)}</p>`}
</body></html>`;

  return {
    subject: `Sally inbound call — ${callerLabel} (${formatDuration(call.durationSec)})`,
    text,
    html,
  };
}

/** Never throws. Sends at most once per call. */
export async function emailSallyInboundCallReport(opts: {
  callId: string;
  summary: string;
  recordingIngest?: Promise<IngestResult>;
}): Promise<void> {
  const callId = String(opts.callId || '').trim();
  if (!callId || inFlight.has(callId)) return;
  const initial = getCallById(callId);
  if (!isInboundSallyCall(initial)) return;
  const initialMeta = (initial?.metadata as Record<string, unknown> | undefined) || {};
  if (initialMeta.sallyInboundReportEmailedAt) return;

  inFlight.add(callId);
  try {
    if (opts.recordingIngest) await opts.recordingIngest.catch(() => undefined);

    const call = (getCallById(callId) || initial!) as unknown as Record<string, unknown>;
    const recording = await loadRecording(callId);
    const email = buildSallyInboundReportEmail(call, opts.summary, recording);

    const result = await sendOpsAlertEmail({
      to: process.env.SALLY_INBOUND_REPORT_TO?.trim() || DEFAULT_TO,
      fromEmail: process.env.SALLY_INBOUND_REPORT_FROM?.trim() || DEFAULT_FROM,
      ...email,
      attachments: recording.attachment ? [recording.attachment] : undefined,
    });

    if (result.ok) {
      const latest = getCallById(callId);
      saveCall({
        id: callId,
        metadata: {
          ...((latest?.metadata as Record<string, unknown> | undefined) || {}),
          sallyInboundReportEmailedAt: new Date().toISOString(),
          sallyInboundReportVia: result.via,
          sallyInboundReportFrom: result.from,
        },
      });
      console.log(`[sally-inbound-email] sent call=${callId} via=${result.via} from=${result.from ?? '-'} recording=${Boolean(recording.attachment)}`);
    } else {
      console.warn(`[sally-inbound-email] send failed call=${callId}: ${result.error}`);
    }
  } catch (err) {
    console.warn('[sally-inbound-email] error:', err instanceof Error ? err.message : err);
  } finally {
    inFlight.delete(callId);
  }
}
