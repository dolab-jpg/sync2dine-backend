import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isQuotePayable,
  paidQuotePatch,
  quoteToCheckoutLines,
  signQuoteCheckoutToken,
  verifyQuoteCheckoutToken,
} from './quote-checkout';

const TEST_SECRET = 'test-only-quote-checkout-secret';

test('quote checkout tokens validate quote id, signature, and expiry', () => {
  const token = signQuoteCheckoutToken({
    quoteId: 'Q-123',
    orgId: 'org-456',
    exp: 2_000,
  }, TEST_SECRET);

  assert.deepEqual(
    verifyQuoteCheckoutToken(token, 'Q-123', 1_999, TEST_SECRET),
    { v: 1, quoteId: 'Q-123', orgId: 'org-456', exp: 2_000 },
  );
  assert.equal(verifyQuoteCheckoutToken(token, 'Q-other', 1_999, TEST_SECRET), null);
  assert.equal(verifyQuoteCheckoutToken(token, 'Q-123', 2_001, TEST_SECRET), null);
  assert.equal(
    verifyQuoteCheckoutToken(`${token.slice(0, -1)}x`, 'Q-123', 1_999, TEST_SECRET),
    null,
  );
});

test('quote state rejects paid, terminal, expired, and invalid totals', () => {
  const future = new Date(10_000).toISOString();
  assert.deepEqual(isQuotePayable({ total: 10, expiresAt: future, status: 'sent' }, 5_000), { ok: true });
  assert.equal(isQuotePayable({
    total: 10,
    expiresAt: future,
    stripePaymentStatus: 'paid',
  }, 5_000).ok, false);
  assert.equal(isQuotePayable({ total: 10, expiresAt: future, status: 'rejected' }, 5_000).ok, false);
  assert.equal(isQuotePayable({ total: 10, expiresAt: new Date(1_000).toISOString() }, 5_000).ok, false);
  assert.equal(isQuotePayable({ total: 0, expiresAt: future }, 5_000).ok, false);
});

test('SaaS quote lines preserve exact total and recurring interval', () => {
  const lines = quoteToCheckoutLines({
    id: 'Q-SaaS',
    tradeName: 'Sync2Dine SaaS',
    total: 130,
    lines: [
      { description: 'Judie', quantity: 1, rate: 100, category: 'product' },
      { description: 'Setup', quantity: 1, rate: 30, category: 'extra' },
    ],
    wizardAnswers: {
      saas: true,
      packageId: 'judie_starter',
      billingInterval: 'annual',
    },
  });

  assert.equal(lines.reduce((sum, line) => sum + line.unitAmountPence * line.quantity, 0), 13_000);
  assert.deepEqual(lines.map((line) => [line.recurring, line.interval]), [
    [true, 'year'],
    [false, 'year'],
  ]);
});

test('paid quote patch is deterministic for webhook idempotency', () => {
  assert.deepEqual(
    paidQuotePatch('2026-07-19T12:00:00.000Z', 'evt_123', {
      customerId: 'cus_123',
      sessionId: 'cs_123',
    }),
    {
      stripePaymentStatus: 'paid',
      paidAt: '2026-07-19T12:00:00.000Z',
      status: 'paid',
      stripeEventId: 'evt_123',
      stripeCustomerId: 'cus_123',
      stripeCheckoutSessionId: 'cs_123',
    },
  );
});
