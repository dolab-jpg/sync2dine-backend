/**
 * Extract recording URLs and call identity fields from Vapi / Twilio payloads.
 */

export type ExtractedRecordings = {
  recordingUrl?: string;
  stereoRecordingUrl?: string;
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function httpUrl(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : undefined;
}

/** Pull mono + stereo recording URLs from end-of-call / GET /call payloads. */
export function extractRecordingUrls(
  messageOrCall: Record<string, unknown> | undefined | null,
): ExtractedRecordings {
  if (!messageOrCall) return {};
  const artifact = asRecord(messageOrCall.artifact) || asRecord(messageOrCall);
  const nestedRecording = asRecord(artifact?.recording) || asRecord(messageOrCall.recording);
  const mono =
    httpUrl(artifact?.recordingUrl)
    || httpUrl(messageOrCall.recordingUrl)
    || httpUrl(nestedRecording?.url)
    || httpUrl(nestedRecording?.monoUrl)
    || httpUrl(nestedRecording?.recordingUrl);
  const stereo =
    httpUrl(artifact?.stereoRecordingUrl)
    || httpUrl(messageOrCall.stereoRecordingUrl)
    || httpUrl(nestedRecording?.stereoUrl)
    || httpUrl(nestedRecording?.stereoRecordingUrl);
  return {
    ...(mono ? { recordingUrl: mono } : {}),
    ...(stereo ? { stereoRecordingUrl: stereo } : {}),
  };
}

/** Prefer stereo for ops playback; fall back to mono. */
export function preferredRecordingUrl(urls: ExtractedRecordings): string | undefined {
  return urls.stereoRecordingUrl || urls.recordingUrl;
}

export function lineDidForDirection(
  direction: string,
  call: Record<string, unknown> | undefined,
  fallbackDid?: string,
): string {
  const dir = direction.toLowerCase();
  const from = String(call?.from ?? '').trim();
  const to = String(call?.to ?? '').trim();
  const phoneNumber = call?.phoneNumber;
  let phoneNumberStr = '';
  if (typeof phoneNumber === 'string') phoneNumberStr = phoneNumber.trim();
  else if (phoneNumber && typeof phoneNumber === 'object') {
    phoneNumberStr = String((phoneNumber as { number?: string }).number || '').trim();
  }
  const envDid = String(fallbackDid || process.env.SOHO66_FROM_NUMBER || '').trim();
  if (dir.includes('outbound')) return from || phoneNumberStr || envDid;
  return to || phoneNumberStr || envDid;
}

export function enrichCallListRow(call: Record<string, unknown>): Record<string, unknown> {
  const meta = asRecord(call.metadata) || {};
  const direction = String(call.direction ?? 'inbound');
  const partyPhone = String(meta.partyPhone || '').trim();
  const from = String(call.from || '').trim();
  const to = String(call.to || '').trim();
  const displayPhone = direction === 'outbound'
    ? (partyPhone || to || from)
    : (partyPhone || from || to);
  const lineDid = String(meta.lineDid || (direction === 'outbound' ? from : to) || '').trim();
  const hasStorage = Boolean(String(call.recordingStoragePath || '').trim());
  const hasProviderUrl = /^https?:\/\//i.test(String(call.recordingUrl || call.stereoRecordingUrl || ''));
  return {
    ...call,
    displayPhone: displayPhone || undefined,
    lineDid: lineDid || undefined,
    partyPhone: partyPhone || undefined,
    hasRecording: hasStorage || hasProviderUrl,
    recordingPlaybackPath: hasStorage || hasProviderUrl
      ? `/api/calls/${encodeURIComponent(String(call.id))}/recording`
      : undefined,
  };
}
