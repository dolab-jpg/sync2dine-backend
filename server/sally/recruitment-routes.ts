import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth } from '../auth';
import { getDataStore } from '../data-store';
import { ingestCvFiles } from './cv-intake';
import { candidateCvSignedUrl, cvMimeType, readLocalCandidateCv } from './cv-store';
import { queueRecruitmentInterviews, seedIndeedSalesCandidates } from './recruitment-interview';
import {
  appendRecruitmentMessage,
  listRecruitmentMessages,
  listRecruitmentSnapshot,
} from './recruitment-messages';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function readRawBody(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('upload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Buffer-safe multipart parse — CVs are binary, so no string round-tripping. */
function parseMultipartFiles(body: Buffer, boundary: string): Array<{ filename: string; buffer: Buffer; mimeType?: string }> {
  const files: Array<{ filename: string; buffer: Buffer; mimeType?: string }> = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let index = body.indexOf(delimiter);
  while (index >= 0) {
    const partStart = index + delimiter.length;
    const next = body.indexOf(delimiter, partStart);
    if (next < 0) break;
    const part = body.subarray(partStart, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const filename = headers.match(/filename="([^"]*)"/)?.[1];
      if (filename) {
        let content = part.subarray(headerEnd + 4);
        // Trim the CRLF the encoder puts before the next boundary.
        if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
          content = content.subarray(0, content.length - 2);
        }
        if (content.length) {
          files.push({
            filename,
            buffer: content,
            mimeType: headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim(),
          });
        }
      }
    }
    index = next;
  }
  return files;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function staffOk(req: IncomingMessage): boolean {
  if (!isAuthEnforced()) return true;
  return Boolean(requireAuth(req));
}

export async function handleRecruitmentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/recruitment')) return false;

  if (!staffOk(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (pathname === '/api/recruitment' && req.method === 'GET') {
    const snap = listRecruitmentSnapshot();
    sendJson(res, 200, snap);
    return true;
  }

  if (pathname === '/api/recruitment/seed-indeed' && req.method === 'POST') {
    await readBody(req).catch(() => '');
    const result = seedIndeedSalesCandidates();
    sendJson(res, 200, { ok: true, upserted: result.upserted });
    return true;
  }

  if (pathname === '/api/recruitment/queue-interviews' && req.method === 'POST') {
    await readBody(req).catch(() => '');
    const result = queueRecruitmentInterviews();
    sendJson(res, 200, {
      ok: true,
      queued: result.queued,
      skipped: result.skipped,
      jobs: result.jobs.map((job) => ({
        id: job.id,
        to: job.to,
        template: job.template,
        status: job.status,
      })),
    });
    return true;
  }

  if (pathname === '/api/recruitment/cvs' && req.method === 'POST') {
    const contentType = String(req.headers['content-type'] || '');
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!contentType.includes('multipart/form-data') || !boundary) {
      sendJson(res, 400, { error: 'Expected multipart/form-data with CV files' });
      return true;
    }
    let body: Buffer;
    try {
      body = await readRawBody(req);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === 'upload_too_large';
      sendJson(res, tooLarge ? 413 : 400, {
        error: tooLarge ? 'CVs must be under 25MB each upload' : 'Could not read upload',
      });
      return true;
    }
    const files = parseMultipartFiles(body, (boundary[1] || boundary[2] || '').trim());
    if (!files.length) {
      sendJson(res, 400, { error: 'No CV files found in upload' });
      return true;
    }
    try {
      const result = await ingestCvFiles(files);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'CV intake failed' });
    }
    return true;
  }

  const cvMatch = pathname.match(/^\/api\/recruitment\/candidates\/([^/]+)\/cv$/);
  if (cvMatch && req.method === 'GET') {
    const candidateId = decodeURIComponent(cvMatch[1]);
    const candidate = getDataStore().recruitmentCandidates.find((c) => String(c.id) === candidateId);
    const storagePath = String(candidate?.cvStoragePath || '');
    if (!candidate || !storagePath) {
      sendJson(res, 404, { error: 'No CV on file for this candidate' });
      return true;
    }
    const signed = await candidateCvSignedUrl(storagePath);
    if (signed) {
      res.statusCode = 302;
      res.setHeader('Location', signed);
      res.end();
      return true;
    }
    const local = readLocalCandidateCv(storagePath);
    if (!local) {
      sendJson(res, 404, { error: 'CV file is no longer available' });
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', cvMimeType(local.filename));
    res.setHeader('Content-Disposition', `inline; filename="${local.filename.replace(/"/g, '')}"`);
    res.end(local.buffer);
    return true;
  }

  const threadMatch = pathname.match(/^\/api\/recruitment\/candidates\/([^/]+)\/messages$/);
  if (threadMatch && req.method === 'GET') {
    const candidateId = decodeURIComponent(threadMatch[1]);
    sendJson(res, 200, { candidateId, messages: listRecruitmentMessages(candidateId) });
    return true;
  }

  if (pathname === '/api/recruitment/messages' && req.method === 'POST') {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    try {
      const message = appendRecruitmentMessage({
        candidateId: body.candidateId != null ? String(body.candidateId) : undefined,
        phone: body.phone != null ? String(body.phone) : undefined,
        name: body.name != null ? String(body.name) : undefined,
        direction: body.direction,
        channel: body.channel,
        body: String(body.body || body.message || ''),
        at: body.at != null ? String(body.at) : undefined,
        externalId: body.externalId != null ? String(body.externalId) : undefined,
        fromLabel: body.fromLabel != null ? String(body.fromLabel) : undefined,
      });
      sendJson(res, 200, { ok: true, message });
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Could not save message';
      sendJson(res, text.includes('not found') ? 404 : 400, { error: text });
    }
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
