import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  runWithRequestOrgContext,
  setRequestOrgId,
  getDataStore,
  saveCustomerRecord,
  syncData,
} from './data-store';
import { handleSync2GearIngestRoutes } from './sync2gear-ingest';

const SECRET = 'test-hmac-secret-32chars-long!!!';

function sign(timestamp: string, body: string): string {
  return createHmac('sha256', SECRET)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
}

function fakeReq(
  method: string,
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const chunks = [Buffer.from(body)];
  const req = {
    method,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'data') {
        for (const c of chunks) cb(c);
      }
      if (event === 'end') cb();
    },
  } as unknown as IncomingMessage;
  return req;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    statusCode: 0,
    setHeader() {},
    end(body?: string) {
      this._status = this.statusCode;
      this._body = body ?? '';
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

function parsed(res: ReturnType<typeof fakeRes>): Record<string, unknown> {
  return JSON.parse(res._body) as Record<string, unknown>;
}

function authedReq(body: Record<string, unknown>): {
  req: IncomingMessage;
  res: ReturnType<typeof fakeRes>;
} {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const sig = sign(ts, raw);
  return {
    req: fakeReq('POST', raw, {
      'x-s2g-timestamp': ts,
      'x-s2g-signature': sig,
    }),
    res: fakeRes(),
  };
}

describe('sync2gear ingest', () => {
  beforeEach(() => {
    process.env.SYNC2GEAR_INGEST_SECRET = SECRET;
  });

  it('rejects missing HMAC headers', async () => {
    await runWithRequestOrgContext(async () => {
      const req = fakeReq('POST', '{}');
      const res = fakeRes();
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 401);
      assert.equal(parsed(res).error, 'missing_auth_headers');
    });
  });

  it('rejects invalid HMAC signature', async () => {
    await runWithRequestOrgContext(async () => {
      const body = JSON.stringify({ sync2gearLeadId: 'abc', businessName: 'Test' });
      const ts = String(Date.now());
      const req = fakeReq('POST', body, {
        'x-s2g-timestamp': ts,
        'x-s2g-signature': 'wrong-signature',
      });
      const res = fakeRes();
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 401);
      assert.equal(parsed(res).error, 'invalid_signature');
    });
  });

  it('rejects expired timestamp', async () => {
    await runWithRequestOrgContext(async () => {
      const body = JSON.stringify({ sync2gearLeadId: 'abc', businessName: 'Test' });
      const ts = String(Date.now() - 6 * 60 * 1000); // 6 minutes ago
      const sig = sign(ts, body);
      const req = fakeReq('POST', body, {
        'x-s2g-timestamp': ts,
        'x-s2g-signature': sig,
      });
      const res = fakeRes();
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 401);
      assert.equal(parsed(res).error, 'timestamp_expired');
    });
  });

  it('returns 400 for invalid phone when callbackAt is set', async () => {
    await runWithRequestOrgContext(async () => {
      const { req, res } = authedReq({
        sync2gearLeadId: 'lead-1',
        businessName: 'Barao',
        phone: 'not-a-number',
        callbackAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 400);
      assert.equal(parsed(res).error, 'invalid_phone');
    });
  });

  it('returns 409 name_mismatch when phone matches different business', async () => {
    await runWithRequestOrgContext(async () => {
      setRequestOrgId('4fc49703-d1b0-4ac7-892d-9c32d31e9661');
      saveCustomerRecord({
        name: 'Existing Restaurant',
        phone: '+447700900111',
        status: 'lead',
        source: 'phone',
      });

      const { req, res } = authedReq({
        sync2gearLeadId: 'lead-nm',
        businessName: 'Totally Different Place',
        phone: '07700900111',
      });
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 409);
      assert.equal(parsed(res).error, 'name_mismatch');
    });
  });

  it('accepts valid ingest without callback', async () => {
    await runWithRequestOrgContext(async () => {
      setRequestOrgId('4fc49703-d1b0-4ac7-892d-9c32d31e9661');
      const { req, res } = authedReq({
        sync2gearLeadId: 'lead-ok-1',
        businessName: 'Good Restaurant',
        contactName: 'Adam',
        phone: '07700900222',
        notes: 'field visit follow-up',
      });
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 200);
      const body = parsed(res);
      assert.ok(body.customerId);
      assert.equal(body.skipped, false);
    });
  });

  it('skips placeholder emails', async () => {
    await runWithRequestOrgContext(async () => {
      setRequestOrgId('4fc49703-d1b0-4ac7-892d-9c32d31e9661');
      const { req, res } = authedReq({
        sync2gearLeadId: 'lead-placeholder',
        businessName: 'Placeholder Test',
        phone: '07700900333',
        email: 'test@floormix.lead',
      });
      const handled = await handleSync2GearIngestRoutes(req, res, '/api/integrations/sync2gear/ingest');
      assert.ok(handled);
      assert.equal(res._status, 200);
      const body = parsed(res);
      assert.ok(body.customerId);
      const store = getDataStore();
      const c = store.customers.find((x) => String(x.id) === String(body.customerId)) as Record<string, unknown> | undefined;
      assert.ok(!c?.email || !String(c.email).includes('floormix'));
    });
  });

  it('ignores unrelated paths', async () => {
    const req = fakeReq('GET', '');
    const res = fakeRes();
    const handled = await handleSync2GearIngestRoutes(req, res, '/api/other');
    assert.equal(handled, false);
  });
});
