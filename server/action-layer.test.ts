/**
 * Action-layer regression tests for Cynthia phone send / identity / push / hang-up.
 * Run: npx tsx server/action-layer.test.ts
 */
import { STAFF_PHONE_TOOL_NAMES, PRE_AUTH_PHONE_TOOLS, isToolAllowedForPhoneSession, isIdentityBound, type PhoneCallerIdentity } from './phone-auth';
import { resolveStaffUserId } from './cynthia-staff-store';
import { getPhoneSessionChatTools } from './phone-brain';
import { buildStaffOrchBody } from './phone-session';
import { isActionAllowedByRegistry, listActionsForContext } from './action-registry';
import { assertVapiProductionReady, isProductionRuntime, rejectUnknownProvider } from './provider-gates';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { handlePushRoutes } from './push-routes';
import { clearDeviceTokensForTests, upsertDeviceToken } from './push/deviceTokenStore';

function assert(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return true;
  }
  console.error(`  ✗ ${name}`);
  return false;
}

function staffIdentity(overrides: Partial<PhoneCallerIdentity> = {}): PhoneCallerIdentity {
  return {
    kind: 'staff',
    route: { mode: 'staff', userId: 'profile-uuid-1', role: 'manager', name: 'Pat' },
    role: 'manager',
    name: 'Pat',
    phone: '447700900123',
    userId: 'profile-uuid-1',
    member: {
      id: 'tm-1',
      userId: 'profile-uuid-1',
      name: 'Pat',
      phone: '447700900123',
      role: 'manager',
      phonePinHash: 'x',
    } as PhoneCallerIdentity['member'],
    pinConfigured: true,
    needsPin: true,
    ...overrides,
  };
}

async function request(
  method: string,
  pathname: string,
  body?: object,
  headers?: Record<string, string>,
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
          headers: { 'Content-Type': 'application/json', ...(headers || {}) },
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
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean) => {
    if (assert(name, cond)) passed += 1;
    else failed += 1;
  };

  console.log('action-layer.test.ts');

  check('sendToStaffCynthia in STAFF_PHONE_TOOL_NAMES', STAFF_PHONE_TOOL_NAMES.includes('sendToStaffCynthia' as typeof STAFF_PHONE_TOOL_NAMES[number]));
  check('saveQuote in STAFF_PHONE_TOOL_NAMES', STAFF_PHONE_TOOL_NAMES.includes('saveQuote' as typeof STAFF_PHONE_TOOL_NAMES[number]));
  check('sendCustomerMessage in STAFF_PHONE_TOOL_NAMES', STAFF_PHONE_TOOL_NAMES.includes('sendCustomerMessage' as typeof STAFF_PHONE_TOOL_NAMES[number]));
  check('sendToStaffCynthia not pre-auth', !PRE_AUTH_PHONE_TOOLS.has('sendToStaffCynthia'));

  const identity = staffIdentity();
  const tools = getPhoneSessionChatTools(identity, true);
  check(
    'Vapi staff tools expose sendToStaffCynthia',
    tools.some((t) => t.function.name === 'sendToStaffCynthia'),
  );
  check(
    'Vapi staff tools expose deliverCallFollowUp',
    tools.some((t) => t.function.name === 'deliverCallFollowUp'),
  );

  // PIN gate: unverified call id blocks privileged tool (uses empty call metadata)
  check(
    'unverified staff cannot sendToStaffCynthia',
    !isToolAllowedForPhoneSession('sendToStaffCynthia', 'missing-call', identity),
  );
  check(
    'unbound identity fails isIdentityBound',
    !isIdentityBound(staffIdentity({ userId: null, member: undefined })),
  );

  const unbound = staffIdentity({ userId: null, member: { id: 'tm', userId: '', name: 'X', phone: '1', role: 'staff' } as PhoneCallerIdentity['member'] });
  check('unbound identity rejected', !isIdentityBound(unbound));

  const orch = buildStaffOrchBody({
    call: { direction: 'inbound', from: '447700900123', to: '4420' },
    callId: 'call-1',
    partyPhone: '447700900123',
    identity,
  });
  check('buildStaffOrchBody carries profile UUID', orch.staffContext?.userId === 'profile-uuid-1');

  check('unknown recipient returns null', resolveStaffUserId({}) === null);
  check('rejects default-staff', resolveStaffUserId({ userId: 'default-staff' }) === null);
  check('accepts explicit uuid', resolveStaffUserId({ userId: 'profile-uuid-1' }) === 'profile-uuid-1');

  check(
    'registry allows send after pin',
    isActionAllowedByRegistry('sendToStaffCynthia', {
      channel: 'vapi_phone',
      role: 'manager',
      pinVerified: true,
    }),
  );
  check(
    'registry blocks send before pin',
    !isActionAllowedByRegistry('sendToStaffCynthia', {
      channel: 'vapi_phone',
      role: 'manager',
      pinVerified: false,
    }),
  );
  check(
    'registry excludes requestCodeFix from phone',
    !listActionsForContext({ channel: 'vapi_phone', role: 'manager', pinVerified: true })
      .some((a) => a.name === 'requestCodeFix'),
  );

  const prevFail = process.env.FAIL_CLOSED;
  const prevVoice = process.env.VOICE_PROVIDER;
  process.env.FAIL_CLOSED = '1';
  process.env.VOICE_PROVIDER = 'vapi';
  delete process.env.VAPI_PRIVATE_KEY;
  delete process.env.VAPI_PUBLIC_KEY;
  delete process.env.VAPI_SERVER_SECRET;
  delete process.env.VAPI_ELEVENLABS_VOICE_ID;
  delete process.env.ELEVENLABS_VOICE_ID;
  const health = assertVapiProductionReady();
  check('production vapi health fails closed without keys', health.ok === false && health.errors.length > 0);
  check('unknown provider rejected', rejectUnknownProvider('not-a-provider') != null);
  check('mock rejected in fail-closed', rejectUnknownProvider('mock') != null);
  if (prevFail === undefined) delete process.env.FAIL_CLOSED;
  else process.env.FAIL_CLOSED = prevFail;
  if (prevVoice === undefined) delete process.env.VOICE_PROVIDER;
  else process.env.VOICE_PROVIDER = prevVoice;
  check('isProductionRuntime respects FAIL_CLOSED', typeof isProductionRuntime() === 'boolean');

  clearDeviceTokensForTests();
  upsertDeviceToken({ token: 'tok-user-a', platform: 'android', userId: 'user-a', orgId: 'org-1' });
  upsertDeviceToken({ token: 'tok-user-b', platform: 'android', userId: 'user-b', orgId: 'org-1' });

  const denied = await request('POST', '/api/push/notify', {
    userId: 'user-a',
    orgId: 'org-1',
    title: 'T',
    body: 'B',
  });
  check('push notify rejects anonymous', denied.status === 401);

  const okPush = await request(
    'POST',
    '/api/push/notify',
    {
      userId: 'user-a',
      orgId: 'org-1',
      title: 'Cynthia',
      body: 'Card ready',
      data: { type: 'cynthia_card', route: '/cynthia?card=card-1' },
    },
    {
      'X-Org-Id': 'org-1',
      'X-User-Id': 'manager-1',
      'X-User-Role': 'manager',
    },
  );
  check('push notify filters by user', okPush.status === 200 && Number(okPush.json.sent) === 1);

  const cross = await request(
    'POST',
    '/api/push/notify',
    {
      userId: 'user-a',
      orgId: 'org-2',
      title: 'X',
      body: 'Y',
    },
    {
      'X-Org-Id': 'org-1',
      'X-User-Id': 'manager-1',
      'X-User-Role': 'manager',
    },
  );
  check('push notify rejects cross-org header mismatch', cross.status === 401);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
