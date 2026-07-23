import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRequestOrgId,
  runWithRequestOrgContext,
  setRequestOrgId,
  withOrgContextAsync,
} from './data-store';

describe('request org AsyncLocalStorage isolation', () => {
  it('isolates setRequestOrgId across concurrent request scopes', async () => {
    const seen: string[] = [];

    await Promise.all([
      runWithRequestOrgContext(async () => {
        setRequestOrgId('org_concurrent_a');
        await new Promise((r) => setTimeout(r, 40));
        seen.push(`a:${getRequestOrgId()}`);
      }),
      runWithRequestOrgContext(async () => {
        setRequestOrgId('org_concurrent_b');
        await new Promise((r) => setTimeout(r, 10));
        seen.push(`b:${getRequestOrgId()}`);
        await new Promise((r) => setTimeout(r, 40));
        seen.push(`b2:${getRequestOrgId()}`);
      }),
    ]);

    assert.ok(seen.includes('a:org_concurrent_a'), `expected a isolation, got ${seen.join(',')}`);
    assert.ok(seen.includes('b:org_concurrent_b'), `expected b isolation, got ${seen.join(',')}`);
    assert.ok(seen.includes('b2:org_concurrent_b'), `expected b2 isolation, got ${seen.join(',')}`);
    assert.equal(seen.filter((s) => s.startsWith('a:') && s !== 'a:org_concurrent_a').length, 0);
  });

  it('withOrgContextAsync restores parent org after nested work', async () => {
    await runWithRequestOrgContext(async () => {
      setRequestOrgId('org_parent');
      await withOrgContextAsync('org_child', async () => {
        assert.equal(getRequestOrgId(), 'org_child');
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(getRequestOrgId(), 'org_child');
      });
      assert.equal(getRequestOrgId(), 'org_parent');
    });
  });
});
