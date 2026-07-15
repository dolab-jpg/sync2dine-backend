/**
 * Push token register + sender dry-run tests.
 * Run: npx tsx server/push/push-routes.test.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { handlePushRoutes } from '../push-routes';
import {
  clearDeviceTokensForTests,
  listDeviceTokens,
  upsertDeviceToken,
} from './deviceTokenStore';
import { sendPushToTokens } from './pushSender';

function request(
  method: string,
  pathname: string,
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await handlePushRoutes(req, res, pathname);
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });

    server.listen(0, async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}${pathname}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = (await res.json()) as Record<string, unknown>;
        resolve({ status: res.status, json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function run() {
  clearDeviceTokensForTests();
  let passed = 0;
  let failed = 0;

  const assert = (name: string, cond: boolean) => {
    if (cond) {
      console.log(`  ✓ ${name}`);
      passed += 1;
    } else {
      console.error(`  ✗ ${name}`);
      failed += 1;
    }
  };

  console.log('push-routes.test.ts');

  const bad = await request('POST', '/api/push/register', {});
  assert('rejects empty token', bad.status === 400);

  const ok = await request('POST', '/api/push/register', {
    token: 'test-fcm-token-123',
    platform: 'android',
    userId: 'user-1',
    orgId: 'org-1',
  });
  assert('registers token', ok.status === 200 && ok.json.ok === true);

  upsertDeviceToken({ token: 'test-fcm-token-123', platform: 'android', userId: 'user-1' });
  const tokens = listDeviceTokens({ userId: 'user-1' });
  assert('idempotent upsert', tokens.length === 1);

  const push = await sendPushToTokens(tokens, {
    title: 'Test',
    body: 'Lead alert',
    route: '/crm',
  });
  assert('dry-run push sends', push.dryRun === true && push.sent === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
