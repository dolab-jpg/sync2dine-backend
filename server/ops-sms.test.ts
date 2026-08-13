import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OPS_SMS_FORBIDDEN_TOKENS,
  formatOpsSms,
  formatUkDidForSms,
  resolveOpsSmsKind,
  type OpsSmsKind,
} from './ops-sms.js';

const KINDS: OpsSmsKind[] = [
  'api_down',
  'api_recovered',
  'api_restarted',
  'phone_line_down',
  'phone_line_up',
  'call_failed',
  'orders_backup',
  'ops_alert',
  'test',
];

function assertPlainSms(body: string) {
  assert.ok(body.length > 0, 'SMS body must not be empty');
  assert.ok(body.length <= 160, `SMS too long (${body.length}): ${body}`);
  for (const token of OPS_SMS_FORBIDDEN_TOKENS) {
    assert.ok(
      !body.toLowerCase().includes(token.toLowerCase()),
      `forbidden token "${token}" in: ${body}`,
    );
  }
}

describe('formatUkDidForSms', () => {
  it('formats London +44 geographic numbers', () => {
    assert.equal(formatUkDidForSms('+442031234567'), '0203 123 4567');
    assert.equal(formatUkDidForSms('02031234567'), '0203 123 4567');
  });

  it('formats UK mobiles', () => {
    assert.equal(formatUkDidForSms('07576442345'), '07576 442345');
    assert.equal(formatUkDidForSms('+447576442345'), '07576 442345');
  });
});

describe('formatOpsSms', () => {
  for (const kind of KINDS) {
    it(`returns plain English for ${kind}`, () => {
      const body = formatOpsSms(kind, {
        persona: 'Judie',
        did: '+442031234567',
        title: 'UNREGISTERED assistant-request webhook_fail 502 pjsip',
        message: 'S2D PHONE: sip:user@host REJECTED error',
      });
      assertPlainSms(body);
    });
  }

  it('matches api_down example', () => {
    assert.equal(
      formatOpsSms('api_down'),
      'Sync2Dine is down. The app and phone lines may not answer. We are restarting now.',
    );
  });

  it('matches api_recovered example', () => {
    assert.equal(
      formatOpsSms('api_recovered'),
      'Sync2Dine is back up. App and phones should work again.',
    );
  });

  it('matches api_restarted example', () => {
    assert.equal(
      formatOpsSms('api_restarted'),
      'Sync2Dine had a blip. We restarted it and it is working again.',
    );
  });

  it('formats phone_line_down with DID', () => {
    const body = formatOpsSms('phone_line_down', { persona: 'Judie', did: '02031234567' });
    assert.equal(body, 'Judie on 0203 123 4567 is offline. Callers to that number may not get through.');
    assertPlainSms(body);
  });

  it('formats phone_line_up with DID', () => {
    const body = formatOpsSms('phone_line_up', { persona: 'Judie', did: '02031234567' });
    assert.equal(body, 'Judie on 0203 123 4567 is back online.');
    assertPlainSms(body);
  });

  it('strips forbidden tokens from ops_alert fallback', () => {
    const body = formatOpsSms('ops_alert', {
      title: 'UNREGISTERED line',
      message: 'assistant-request failed webhook_fail 502 pjsip sip:foo@bar',
    });
    assertPlainSms(body);
    assert.match(body.toLowerCase(), /line|attention|sync2dine/);
  });
});

describe('resolveOpsSmsKind', () => {
  it('maps api events', () => {
    assert.equal(resolveOpsSmsKind({ event: 'api_down', title: 'x', message: 'y' }), 'api_down');
    assert.equal(resolveOpsSmsKind({ event: 'test', title: 'x', message: 'y' }), 'test');
    assert.equal(
      resolveOpsSmsKind({ event: 'api_recovered', title: 'Recovered', message: 'ok' }),
      'api_recovered',
    );
    assert.equal(
      resolveOpsSmsKind({
        event: 'api_recovered',
        title: 'Sync2Dine API auto-restarted',
        message: 'watchdog restarted the API',
      }),
      'api_restarted',
    );
  });

  it('maps ops_alert codes and call failures', () => {
    assert.equal(
      resolveOpsSmsKind({
        event: 'ops_alert',
        title: 'Orders',
        message: 'disk',
        code: 'orders_disk_fallback',
      }),
      'orders_backup',
    );
    assert.equal(
      resolveOpsSmsKind({
        event: 'ops_alert',
        title: 'Judie call failed',
        message: 'inbound error',
      }),
      'call_failed',
    );
    assert.equal(
      resolveOpsSmsKind({
        event: 'ops_alert',
        title: 'A phone call failed to start',
        message: 'A diner or sales call just failed.',
        code: 'phone_call_fail',
      }),
      'call_failed',
    );
    assert.equal(
      resolveOpsSmsKind({ event: 'ops_alert', title: 'Billing', message: 'check dashboard' }),
      'ops_alert',
    );
  });
});
