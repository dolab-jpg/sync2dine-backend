import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitAgentActivity,
  listRingBufferEvents,
  sanitizeActivityPayload,
  clampSummary,
  isAgentActivityPhase,
  MAX_SUMMARY_LENGTH,
  __resetAgentActivityForTests,
} from './agent-activity';

beforeEach(() => {
  __resetAgentActivityForTests();
});

test('sanitizeActivityPayload strips secret-like keys recursively', () => {
  const clean = sanitizeActivityPayload({
    customerId: 'c-1',
    token: 'abc',
    apiKey: 'k',
    api_key: 'k2',
    password: 'p',
    clientSecret: 'zzz',
    Authorization: 'Bearer x',
    nested: { refreshToken: 'r', keep: 1 },
  });
  assert.deepEqual(clean, { customerId: 'c-1', nested: { keep: 1 } });
});

test('sanitizeActivityPayload truncates oversized payloads', () => {
  const clean = sanitizeActivityPayload({ blob: 'x'.repeat(20_000) });
  assert.deepEqual(clean, { truncated: true });
});

test('clampSummary caps length', () => {
  assert.equal(clampSummary('hello '), 'hello');
  const long = clampSummary('a'.repeat(2_000));
  assert.equal(long.length, MAX_SUMMARY_LENGTH);
});

test('isAgentActivityPhase validates the enum', () => {
  assert.equal(isAgentActivityPhase('completed'), true);
  assert.equal(isAgentActivityPhase('navigate'), true);
  assert.equal(isAgentActivityPhase('exploded'), false);
  assert.equal(isAgentActivityPhase(42), false);
});

test('ring buffer stores events per org/user and supports sinceSeq replay', () => {
  const first = emitAgentActivity({
    orgId: 'org-a', targetUserId: 'user-1', phase: 'started', summary: 'Doing thing',
  });
  emitAgentActivity({ orgId: 'org-a', targetUserId: 'user-2', phase: 'started', summary: 'Other user' });
  const second = emitAgentActivity({
    orgId: 'org-a', targetUserId: 'user-1', phase: 'completed', summary: 'Done', route: '/quotes',
  });
  assert.ok(first && second);
  assert.ok(second.seq > first.seq);

  const all = listRingBufferEvents({ orgId: 'org-a', targetUserId: 'user-1' });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.phase), ['started', 'completed']);

  const replay = listRingBufferEvents({ orgId: 'org-a', targetUserId: 'user-1', sinceSeq: first.seq });
  assert.equal(replay.length, 1);
  assert.equal(replay[0].id, second.id);
  assert.equal(replay[0].route, '/quotes');

  assert.equal(listRingBufferEvents({ orgId: 'org-b', targetUserId: 'user-1' }).length, 0);
});

test('ring buffer caps at 200 events per org', () => {
  for (let i = 0; i < 230; i++) {
    emitAgentActivity({ orgId: 'org-cap', targetUserId: 'u', phase: 'working', summary: `e${i}` });
  }
  const events = listRingBufferEvents({ orgId: 'org-cap', targetUserId: 'u', limit: 200 });
  assert.equal(events.length, 200);
  assert.equal(events[events.length - 1].summary, 'e229');
});

test('emit rejects unresolved staff and bad phases, sanitizes payload', () => {
  assert.equal(emitAgentActivity({ targetUserId: '', phase: 'started', summary: 'x' }), null);
  assert.equal(emitAgentActivity({ targetUserId: 'default-staff', phase: 'started', summary: 'x' }), null);
  assert.equal(
    emitAgentActivity({ targetUserId: 'u', phase: 'nope' as never, summary: 'x' }),
    null,
  );
  const event = emitAgentActivity({
    targetUserId: 'u',
    phase: 'saved',
    summary: 'Saved quote',
    payload: { quoteId: 'q1', accessToken: 'leak' },
  });
  assert.ok(event);
  assert.deepEqual(event.payload, { quoteId: 'q1' });
});
