import type { IncomingMessage, ServerResponse } from 'http';
import { upsertDeviceToken, listDeviceTokens } from './push/deviceTokenStore';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'token required' }));
        return true;
      }

      const platform = body.platform === 'ios' || body.platform === 'android' || body.platform === 'web'
        ? body.platform
        : 'android';

      const saved = upsertDeviceToken({
        token,
        platform,
        userId: body.userId,
        orgId: body.orgId,
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, id: saved.token.slice(0, 8), updatedAt: saved.updatedAt }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'register failed' }));
    }
    return true;
  }

  if (pathname === '/api/push/tokens' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId') ?? undefined;
    const orgId = url.searchParams.get('orgId') ?? undefined;
    const tokens = listDeviceTokens({ userId, orgId });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, count: tokens.length, tokens: tokens.map(t => ({ ...t, token: `${t.token.slice(0, 8)}…` })) }));
    return true;
  }

  return false;
}
