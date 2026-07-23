/**
 * Download provider call audio and persist into private Supabase Storage bucket `call-recordings`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCallById, saveCall } from '../data-store';
import { getDemoKitchenOrgId } from '../home-org';
import { getVapiPrivateKey } from './vapi-client';
import {
  extractRecordingUrls,
  preferredRecordingUrl,
  type ExtractedRecordings,
} from '../call-recording-artifacts';

export const CALL_RECORDINGS_BUCKET = 'call-recordings';
const SIGNED_URL_TTL_SEC = 60 * 60; // 1 hour

let admin: SupabaseClient | null | undefined;

function getAdmin(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    admin = null;
    return null;
  }
  admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return admin;
}

export function isCallRecordingStorageConfigured(): boolean {
  return Boolean(getAdmin());
}

function extFromContentType(ct: string, url: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a';
  const path = url.split('?')[0] || '';
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : 'wav';
}

async function downloadAudio(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const headers: Record<string, string> = { Accept: 'audio/*,*/*' };
  const vapiKey = getVapiPrivateKey();
  // Private HIPAA R2 object URLs need Vapi Bearer; presigned URLs usually do not.
  const looksPresigned = /[?&](X-Amz-|Signature=|Expires=)/i.test(url);
  if (
    vapiKey
    && !looksPresigned
    && /vapi\.ai|storage\.vapi|r2\.cloudflarestorage\.com|hipaa-recordings/i.test(url)
  ) {
    headers.Authorization = `Bearer ${vapiKey}`;
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      console.warn(`[call-recording-store] download failed status=${res.status} url=${url.slice(0, 120)}`);
      return null;
    }
    const contentType = res.headers.get('content-type') || 'audio/wav';
    const ab = await res.arrayBuffer();
    if (!ab.byteLength) return null;
    return { buffer: Buffer.from(ab), contentType };
  } catch (err) {
    console.warn('[call-recording-store] download error:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function uploadBytes(
  orgId: string,
  callId: string,
  kind: 'mono' | 'stereo',
  buffer: Buffer,
  contentType: string,
  sourceUrl: string,
): Promise<string | null> {
  const client = getAdmin();
  if (!client) return null;
  const ext = extFromContentType(contentType, sourceUrl);
  const storagePath = `${orgId}/${callId}/${kind}.${ext}`;
  const { error } = await client.storage.from(CALL_RECORDINGS_BUCKET).upload(storagePath, buffer, {
    upsert: true,
    contentType,
  });
  if (error) {
    console.warn(`[call-recording-store] upload failed path=${storagePath}:`, error.message);
    return null;
  }
  return storagePath;
}

export async function createCallRecordingSignedUrl(
  storagePath: string,
  expiresInSec: number = SIGNED_URL_TTL_SEC,
): Promise<string | null> {
  const client = getAdmin();
  if (!client || !storagePath) return null;
  const { data, error } = await client.storage
    .from(CALL_RECORDINGS_BUCKET)
    .createSignedUrl(storagePath, expiresInSec);
  if (error || !data?.signedUrl) {
    console.warn('[call-recording-store] signed URL failed:', error?.message);
    return null;
  }
  return data.signedUrl;
}

export type IngestResult = {
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  recordingStoragePath?: string;
  stereoStoragePath?: string;
  recordingStoredAt?: string;
};

/** Download provider URLs and persist; updates the call row when successful. */
export async function ingestCallRecording(opts: {
  callId: string;
  orgId?: string | null;
  urls?: ExtractedRecordings;
  messageOrCall?: Record<string, unknown>;
}): Promise<IngestResult> {
  const callId = String(opts.callId || '').trim();
  if (!callId) return {};

  const existing = getCallById(callId);
  const existingMeta = (existing?.metadata as Record<string, unknown> | undefined) || {};
  const urls = opts.urls || extractRecordingUrls(opts.messageOrCall) || {};
  const recordingUrl = urls.recordingUrl
    || (existing?.recordingUrl ? String(existing.recordingUrl) : undefined);
  const stereoRecordingUrl = urls.stereoRecordingUrl
    || (existing?.stereoRecordingUrl ? String(existing.stereoRecordingUrl) : undefined);

  const result: IngestResult = {
    ...(recordingUrl ? { recordingUrl } : {}),
    ...(stereoRecordingUrl ? { stereoRecordingUrl } : {}),
  };

  if (existing?.recordingStoragePath && !stereoRecordingUrl) {
    result.recordingStoragePath = String(existing.recordingStoragePath);
    if (existing.stereoStoragePath) result.stereoStoragePath = String(existing.stereoStoragePath);
    if (existing.recordingStoredAt) result.recordingStoredAt = String(existing.recordingStoredAt);
    // Still stamp provider URLs if newly found
    if (recordingUrl || stereoRecordingUrl) {
      saveCall({
        id: callId,
        ...(recordingUrl ? { recordingUrl } : {}),
        ...(stereoRecordingUrl ? { stereoRecordingUrl } : {}),
      });
    }
    return result;
  }

  const orgId = String(opts.orgId || existingMeta.orgId || getDemoKitchenOrgId()).trim();
  const storedAt = new Date().toISOString();

  if (isCallRecordingStorageConfigured()) {
    if (stereoRecordingUrl && !existing?.stereoStoragePath) {
      const dl = await downloadAudio(stereoRecordingUrl);
      if (dl) {
        const path = await uploadBytes(orgId, callId, 'stereo', dl.buffer, dl.contentType, stereoRecordingUrl);
        if (path) result.stereoStoragePath = path;
      }
    }
    const monoOrPreferred = recordingUrl || preferredRecordingUrl({ recordingUrl, stereoRecordingUrl });
    if (monoOrPreferred && !existing?.recordingStoragePath) {
      const source = recordingUrl || monoOrPreferred;
      if (source !== stereoRecordingUrl || !result.stereoStoragePath) {
        const dl = await downloadAudio(source);
        if (dl) {
          const path = await uploadBytes(orgId, callId, 'mono', dl.buffer, dl.contentType, source);
          if (path) result.recordingStoragePath = path;
        }
      } else if (result.stereoStoragePath) {
        result.recordingStoragePath = result.stereoStoragePath;
      }
    }

    // If provider URLs failed (common for private R2), refresh artifact URLs from Vapi GET /call.
    if (!result.recordingStoragePath && !result.stereoStoragePath) {
      const vapiId = String(
        existingMeta.vapiCallId
        || existing?.providerCallId
        || '',
      ).trim();
      if (vapiId && !vapiId.startsWith('out-') && !vapiId.startsWith('dbg-')) {
        try {
          const { vapiFetch } = await import('./vapi-client');
          const { ok, json } = await vapiFetch(`/call/${encodeURIComponent(vapiId)}`);
          if (ok) {
            const refreshed = extractRecordingUrls(json);
            const tryUrl = preferredRecordingUrl(refreshed) || refreshed.stereoRecordingUrl || refreshed.recordingUrl;
            if (tryUrl) {
              const dl = await downloadAudio(tryUrl);
              if (dl) {
                const path = await uploadBytes(orgId, callId, 'stereo', dl.buffer, dl.contentType, tryUrl);
                if (path) {
                  result.stereoStoragePath = path;
                  result.recordingStoragePath = path;
                  if (refreshed.recordingUrl) result.recordingUrl = refreshed.recordingUrl;
                  if (refreshed.stereoRecordingUrl) result.stereoRecordingUrl = refreshed.stereoRecordingUrl;
                }
              }
            }
          }
        } catch (err) {
          console.warn(
            '[call-recording-store] vapi refresh ingest failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  if (result.recordingStoragePath || result.stereoStoragePath) {
    result.recordingStoredAt = storedAt;
  }

  saveCall({
    id: callId,
    ...(result.recordingUrl ? { recordingUrl: result.recordingUrl } : {}),
    ...(result.stereoRecordingUrl ? { stereoRecordingUrl: result.stereoRecordingUrl } : {}),
    ...(result.recordingStoragePath ? { recordingStoragePath: result.recordingStoragePath } : {}),
    ...(result.stereoStoragePath ? { stereoStoragePath: result.stereoStoragePath } : {}),
    ...(result.recordingStoredAt ? { recordingStoredAt: result.recordingStoredAt } : {}),
    metadata: {
      ...existingMeta,
      ...(result.recordingStoragePath ? { recordingStoragePath: result.recordingStoragePath } : {}),
      ...(result.stereoStoragePath ? { stereoStoragePath: result.stereoStoragePath } : {}),
    },
  });

  return result;
}

/** Resolve best playback URL: durable signed URL first, then provider URL. */
export async function resolveCallPlaybackUrl(callId: string): Promise<{
  url: string | null;
  source: 'storage' | 'provider' | 'none';
  storagePath?: string;
}> {
  const call = getCallById(callId);
  if (!call) return { url: null, source: 'none' };

  const storagePath = String(
    call.stereoStoragePath || call.recordingStoragePath || '',
  ).trim();
  if (storagePath) {
    const signed = await createCallRecordingSignedUrl(storagePath);
    if (signed) return { url: signed, source: 'storage', storagePath };
  }

  const provider = preferredRecordingUrl({
    recordingUrl: call.recordingUrl ? String(call.recordingUrl) : undefined,
    stereoRecordingUrl: call.stereoRecordingUrl ? String(call.stereoRecordingUrl) : undefined,
  });
  if (provider) return { url: provider, source: 'provider' };
  return { url: null, source: 'none' };
}
