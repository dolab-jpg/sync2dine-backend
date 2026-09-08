import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePackageLine } from './saas-products';
import { SAAS_PACKAGES } from '../saas-packages';
import { formatObjectionPlaybook } from '../sally/offer';

describe('PAYG commercial package lines', () => {
  it('judie_payg_inbound weekly launch and standard amounts match catalog', () => {
    const pkg = SAAS_PACKAGES.judie_payg_inbound;
    assert.equal(pkg.launchWeeklyGbp, 46);
    assert.equal(pkg.standardWeeklyGbp, 77);
    assert.equal(pkg.weeklyAiMinutes, 60);
    assert.equal(pkg.aiOverageGbpPerMinute, 0.45);
    assert.equal(pkg.inboundOnly, true);

    const launch = resolvePackageLine('judie_payg_inbound', {
      interval: 'weekly',
      useLaunch: true,
    });
    assert.equal(launch[0]?.rate, 46);
    assert.equal(launch[0]?.unit, 'week');
    assert.equal(launch[0]?.category, 'product');

    const standard = resolvePackageLine('judie_payg_inbound', {
      interval: 'weekly',
      useLaunch: false,
    });
    assert.equal(standard[0]?.rate, 77);
  });

  it('appends setup fee once as a non-recurring extra line', () => {
    const lines = resolvePackageLine('judie_payg_inbound', {
      interval: 'weekly',
      useLaunch: true,
      setupFeeGbp: 99,
    });
    assert.equal(lines.length, 2);
    const setup = lines.find((l) => l.category === 'extra');
    assert.ok(setup);
    assert.equal(setup!.rate, 99);
    assert.equal(setup!.unit, 'fixed');
    assert.equal(setup!.description, 'Setup fee');
    assert.equal(lines.filter((l) => l.category === 'extra').length, 1);
  });

  it('objection playbook mentions PAYG cover without promising Sync2Dine carrier setup', () => {
    const playbook = formatObjectionPlaybook();
    assert.match(playbook, /Judie PAYG|payg_inbound/i);
    assert.match(playbook, /divert/i);
    assert.match(playbook, /not usage-only|do not auto-configure their carrier/i);
  });
});
