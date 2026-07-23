import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, KNOWN_DEV_ENCRYPTION_SECRET } from './crypto';

describe('org encryption key independence from JWT', () => {
  it('encrypt/decrypt works with ORG_ENCRYPTION_KEY and ignores JWT_SECRET', () => {
    const prevOrg = process.env.ORG_ENCRYPTION_KEY;
    const prevJwt = process.env.JWT_SECRET;
    const prevNode = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      process.env.ORG_ENCRYPTION_KEY = 'unit-test-org-encryption-key-aaaa';
      process.env.JWT_SECRET = 'unit-test-jwt-should-not-be-used-bbbb';
      const enc = encryptSecret('hello-sync2dine');
      assert.match(enc, /^v1:/);
      assert.equal(decryptSecret(enc), 'hello-sync2dine');

      // Changing JWT must not break decryption when ORG_ENCRYPTION_KEY is set
      process.env.JWT_SECRET = 'rotated-jwt-cccccccc';
      assert.equal(decryptSecret(enc), 'hello-sync2dine');
    } finally {
      if (prevOrg === undefined) delete process.env.ORG_ENCRYPTION_KEY;
      else process.env.ORG_ENCRYPTION_KEY = prevOrg;
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
    }
  });

  it('dev fallback secret is exported for ops recovery docs', () => {
    assert.ok(KNOWN_DEV_ENCRYPTION_SECRET.length > 16);
  });
});
