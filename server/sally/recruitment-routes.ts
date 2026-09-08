import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnforced, requireAuth } from '../auth';
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
