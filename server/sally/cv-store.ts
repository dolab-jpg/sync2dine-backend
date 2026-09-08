/**
 * Candidate CV files in the private Supabase bucket `candidate-cvs`.
 * Mirrors phone/call-recording-store: service-role upload, short-lived signed reads.
 * Falls back to local disk so uploads still work before Supabase storage is configured.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getHomeOrgId } from '../home-org';
import { resolveOrgUuid } from '../supabase-admin';

export const CANDIDATE_CVS_BUCKET = 'candidate-cvs';
const SIGNED_URL_TTL_SEC = 60 * 60;
const LOCAL_DIR = resolve(process.cwd(), 'server', 'data', 'candidate-cvs');

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

export function isCvStorageConfigured(): boolean {
  return Boolean(getAdmin());
}

export function cvMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.rtf')) return 'application/rtf';
  return 'text/plain';
}

function safeName(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-120) || 'cv';
}

/** Store the original file. Returns a storage path usable by candidateCvUrl(). */
export async function storeCandidateCv(opts: {
  candidateId: string;
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}): Promise<{ storagePath: string; storage: 'supabase' | 'local' } | null> {
  const filename = safeName(opts.filename);
  const contentType = opts.mimeType || cvMimeType(filename);
  const client = getAdmin();
  if (client) {
    const orgUuid = await resolveOrgUuid(getHomeOrgId());
    const storagePath = `${orgUuid}/${opts.candidateId}/${filename}`;
    const { error } = await client.storage.from(CANDIDATE_CVS_BUCKET).upload(storagePath, opts.buffer, {
      upsert: true,
      contentType,
    });
    if (!error) return { storagePath, storage: 'supabase' };
    console.warn(`[cv-store] supabase upload failed path=${storagePath}:`, error.message);
  }
  try {
    const localPath = join(LOCAL_DIR, opts.candidateId, filename);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, opts.buffer);
    return { storagePath: `local:${opts.candidateId}/${filename}`, storage: 'local' };
  } catch (err) {
    console.warn('[cv-store] local write failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Signed URL for a Supabase-stored CV; null for local files (served by the API instead). */
export async function candidateCvSignedUrl(
  storagePath: string,
  expiresInSec: number = SIGNED_URL_TTL_SEC,
): Promise<string | null> {
  const path = String(storagePath || '');
  if (!path || path.startsWith('local:')) return null;
  const client = getAdmin();
  if (!client) return null;
  const { data, error } = await client.storage
    .from(CANDIDATE_CVS_BUCKET)
    .createSignedUrl(path, expiresInSec);
  if (error || !data?.signedUrl) {
    console.warn('[cv-store] signed URL failed:', error?.message);
    return null;
  }
  return data.signedUrl;
}

/** Bytes for a locally stored CV so the API can stream it. */
export function readLocalCandidateCv(storagePath: string): { buffer: Buffer; filename: string } | null {
  const path = String(storagePath || '');
  if (!path.startsWith('local:')) return null;
  const relative = path.slice('local:'.length);
  const full = join(LOCAL_DIR, relative);
  // Keep reads inside the CV directory even if a stored path is malformed.
  if (!resolve(full).startsWith(LOCAL_DIR) || !existsSync(full)) return null;
  return { buffer: readFileSync(full), filename: relative.split('/').pop() || 'cv' };
}
