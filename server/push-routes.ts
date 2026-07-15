import type { IncomingMessage, ServerResponse } from 'http';
import { upsertDeviceToken, listDeviceTokens } from './push/deviceTokenStore';
import { sendPushToUser } from './push/pushSender';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isInternalPushAuth(req: IncomingMessage): boolean {
  const secret = process.env.INTERNAL_PUSH_SECRET?.trim() || process.env.VAPI_SERVER_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers['x-internal-push-secret'] || req.headers.authorization;
  if (typeof header === 'string' && (header === secret || header.includes(secret))) return true;
  return false;
}

function isSameOrgStaff(req: IncomingMessage, orgId: string): boolean {
  const headerOrg = typeof req.headers['x-org-id'] === 'string' ? req.headers['x-org-id'].trim() : '';
  const role = typeof req.headers['x-user-role'] === 'string' ? req.headers['x-user-role'].trim().toLowerCase() : '';
  const userId = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
  if (!headerOrg || headerOrg !== orgId || !userId) return false;
  return ['staff', 'manager', 'super_admin', 'admin'].includes(role) || Boolean(userId);
}

export async function handlePushRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/api/push/register' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as {
        token?: string;
        platform?: string;
        userId?: string;
        orgId?: string;
      };

      const token = body.token?.trim();
      if (!token) {
        sendJson(res, 400, { ok: false, error: 'token required' });
        return true;
      }

      const headerUser = typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'].trim() : '';
      const headerOrg = typeof req.headers['x-org-id'] === 'string' ? req.headers['x-org-id'].trim() : '';
      const userId = (body.userId || headerUser || '').trim() || undefined;
      const orgId = (body.orgId || headerOrg || '').trim() || undefined;

      const platform = body.platform === 'ios' || body.platform === 'android' || body.platform === 'web'
        ? body.platform
        : 'android';

      const saved = upsertDeviceToken({
        token,
        platform,
        userId,
        orgId,
      });

      sendJson(res, 200, { ok: true, id: saved.token.slice(0, 8), updatedAt: saved.updatedAt, userId, orgId });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'register failed' });
    }
    return true;
  }

  if (pathname === '/api/push/notify' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as {
        userId?: string;
        orgId?: string;
        title?: string;
        body?: string;
        data?: Record<string, string>;
        route?: string;
      };
      const userId = String(body.userId || '').trim();
      const orgId = String(body.orgId || (typeof req.headers['x-org-id'] === 'string' ? req.headers['x-org-id'] : '')).trim();
      if (!userId || !orgId) {
        sendJson(res, 400, { ok: false, error: 'userId and orgId required' });
        return true;
      }
      if (!isInternalPushAuth(req) && !isSameOrgStaff(req, orgId)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized push notify' });
        return true;
      }
      const result = await sendPushToUser(orgId, userId, {
        title: String(body.title || 'Cynthia'),
        body: String(body.body || ''),
        route: body.route || body.data?.route,
        data: {
          type: 'cynthia_card',
          ...(body.data || {}),
        },
      });
      sendJson(res, 200, { ok: true, sent: result.sent, dryRun: result.dryRun, errors: result.errors });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'notify failed' });
    }
    return true;
  }

  if (pathname === '/api/push/tokens' && req.method === 'GET') {
    const role = typeof req.headers['x-user-role'] === 'string' ? req.headers['x-user-role'].trim().toLowerCase() : '';
    if (!isInternalPushAuth(req) && !['super_admin', 'manager', 'admin'].includes(role)) {
      sendJson(res, 401, { ok: false, error: 'Admin access required' });
      return true;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId') ?? undefined;
    const orgId = url.searchParams.get('orgId') ?? undefined;
    const tokens = listDeviceTokens({ userId, orgId });
    sendJson(res, 200, { ok: true, count: tokens.length, tokens: tokens.map(t => ({ ...t, token: `${t.token.slice(0, 8)}…` })) });
    return true;
  }

  return false;
}
