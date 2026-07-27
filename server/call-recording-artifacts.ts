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
    httpUrl(artifact?.presignedMonoUrl)
    || httpUrl(artifact?.recordingUrl)
    || httpUrl(messageOrCall.recordingUrl)
    || httpUrl(nestedRecording?.url)
    || httpUrl(nestedRecording?.monoUrl)
    || httpUrl(nestedRecording?.recordingUrl)
    || httpUrl(asRecord(nestedRecording?.mono)?.url)
    || httpUrl(asRecord(nestedRecording?.mono)?.presignedUrl);
  const stereo =
    httpUrl(artifact?.presignedStereoUrl)
    || httpUrl(artifact?.stereoRecordingUrl)
    || httpUrl(messageOrCall.stereoRecordingUrl)
    || httpUrl(nestedRecording?.stereoUrl)
    || httpUrl(nestedRecording?.stereoRecordingUrl)
    || httpUrl(nestedRecording?.presignedStereoUrl);
  return {
    ...(mono ? { recordingUrl: mono } : {}),
    ...(stereo ? { stereoRecordingUrl: stereo } : {}),
  };
}

/** Prefer stereo for ops playback; fall back to mono. */
export function preferredRecordingUrl(urls: ExtractedRecordings): string | undefined {
  return urls.stereoRecordingUrl || urls.recordingUrl;
}

/** Pull E.164 / national digits out of a SIP URI or raw phone field. */
export function normalizeDidCandidate(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // sip:+442071128727@host:5060  or  sip:442071128727@host
  const sipUser = s.match(/^sip:([^@;>]+)/i)?.[1] || '';
  const candidate = sipUser || s;
  // Keep leading + and digits only
  const cleaned = candidate.replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  // Reject bare SIP hosts / credential ids mistaken as numbers
  if (/[a-z]/i.test(candidate) && !/^\+?\d+$/.test(cleaned)) return '';
  return cleaned;
}

/** UK mobiles / private CLI — never treat as the restaurant inbound DID. */
export function isLikelyCallerCli(did: string): boolean {
  const digits = String(did || '').replace(/\D/g, '');
  if (!digits) return false;
  // +447… / 07… mobile, or short non-geographic junk
  if (digits.startsWith('447') || (digits.startsWith('07') && digits.length >= 10)) return true;
  if (digits.startsWith('7') && digits.length === 10) return true;
  return false;
}

export function lineDidForDirection(
  direction: string,
  call: Record<string, unknown> | undefined,
  fallbackDid?: string,
): string {
  const dir = direction.toLowerCase();
  const from = normalizeDidCandidate(String(call?.from ?? ''));
  const to = normalizeDidCandidate(String(call?.to ?? ''));
  const phoneNumber = call?.phoneNumber;
  let phoneNumberStr = '';
  if (typeof phoneNumber === 'string') phoneNumberStr = normalizeDidCandidate(phoneNumber);
  else if (phoneNumber && typeof phoneNumber === 'object') {
    phoneNumberStr = normalizeDidCandidate(String((phoneNumber as { number?: string }).number || ''));
  }
  const envDid = normalizeDidCandidate(String(fallbackDid || process.env.SOHO66_FROM_NUMBER || ''));
  if (dir.includes('outbound')) return from || phoneNumberStr || envDid;
  // Prefer the BYO phoneNumber.number (always E.164) over `to`, because SIP inbound
  // often sets `to` to sip:+E164@<credential>.sip.vapi.ai which used to break DID routing.
  // Never use a mobile CLI as the business line DID.
  const candidates = [phoneNumberStr, to, envDid].filter(Boolean);
  for (const c of candidates) {
    if (!isLikelyCallerCli(c)) return c;
  }
  return '';
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
