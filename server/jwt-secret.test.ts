import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertJwtSecretForBoot,
  isKnownDevJwtSecret,
  KNOWN_DEV_JWT_SECRETS,
  resolveJwtSecret,
} from './jwt-secret';

describe('jwt-secret production fail-closed', () => {
  it('allows known development fallback when not in production', () => {
    const secret = resolveJwtSecret({ NODE_ENV: 'development' });
    assert.equal(secret, KNOWN_DEV_JWT_SECRETS[0]);
    assert.equal(isKnownDevJwtSecret(secret), true);
  });

  it('refuses missing JWT_SECRET in production', () => {
    assert.throws(
      () => resolveJwtSecret({ NODE_ENV: 'production' }),
      /JWT_SECRET is required in production/,
    );
    assert.throws(
      () => assertJwtSecretForBoot({ SYNC2DINE_ENV: 'production' }),
      /JWT_SECRET is required/,
    );
  });

  it('refuses known development fallback in production even when set', () => {
    assert.throws(
      () =>
        resolveJwtSecret({
          NODE_ENV: 'production',
          JWT_SECRET: KNOWN_DEV_JWT_SECRETS[0],
        }),
      /known development fallback/,
    );
  });

  it('accepts a strong production secret', () => {
    const secret = resolveJwtSecret({
      NODE_ENV: 'production',
      JWT_SECRET: 'prod-unit-test-secret-not-for-live-use-32chars',
    });
    assert.equal(secret, 'prod-unit-test-secret-not-for-live-use-32chars');
  });
});
