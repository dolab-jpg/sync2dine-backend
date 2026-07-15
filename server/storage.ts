/**
 * Service-role uploads to Supabase Storage (private buckets).
 * Path layout matches the SPA: `{orgUuid}/{relativePath}`.
 */
import { getSupabaseAdmin, resolveOrgUuid } from './supabase-admin.js';

const DEFAULT_BUCKET = 'project-files';

export function isSupabaseStorageConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

export type StoredProjectFile = {
  id: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  source: string;
  uploadedBy: string;
  takenAt: string;
  caption?: string;
  messageId?: string;
  taskId?: string;
  bucket: string;
};

export async function uploadProjectMedia(opts: {
  orgId?: string | null;
  projectId: string;
  relativePath: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  source: string;
  uploadedBy: string;
  fileId?: string;
  caption?: string;
  messageId?: string;
  taskId?: string;
  bucket?: string;
}): Promise<StoredProjectFile | null> {
  if (!isSupabaseStorageConfigured()) return null;

  const orgUuid = await resolveOrgUuid(opts.orgId);
  const bucket = opts.bucket ?? DEFAULT_BUCKET;
  const storagePath = opts.relativePath;
  const fullPath = `${orgUuid}/${storagePath}`;
  const fileId = opts.fileId ?? `F${Date.now()}`;
  const takenAt = new Date().toISOString();
  const supabase = getSupabaseAdmin();

  const { error: uploadError } = await supabase.storage.from(bucket).upload(fullPath, opts.buffer, {
    upsert: true,
    contentType: opts.mimeType,
  });
  if (uploadError) {
    console.warn('[storage] upload failed:', uploadError.message);
    return null;
  }

  const { error: metaError } = await supabase.from('project_files').upsert(
    {
      id: fileId,
      org_id: orgUuid,
      project_id: opts.projectId,
      storage_path: storagePath,
      filename: opts.filename,
      mime_type: opts.mimeType,
      source: opts.source,
      uploaded_by: opts.uploadedBy,
      caption: opts.caption ?? null,
      taken_at: takenAt,
      message_id: opts.messageId ?? null,
      task_id: opts.taskId ?? null,
      bucket,
    } as never,
    { onConflict: 'org_id,id' },
  );
  if (metaError) {
    console.warn('[storage] project_files upsert failed:', metaError.message);
  }

  return {
    id: fileId,
    storagePath,
    filename: opts.filename,
    mimeType: opts.mimeType,
    source: opts.source,
    uploadedBy: opts.uploadedBy,
    takenAt,
    caption: opts.caption,
    messageId: opts.messageId,
    taskId: opts.taskId,
    bucket,
  };
}
