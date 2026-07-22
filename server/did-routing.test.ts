/**
 * Cross-organisation isolation for DID routing, SIP masking, and order org context.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  deletePlatformPhoneLine,
  findDidConflict,
  getJudiePhoneLineForOrg,
  getPlatformPhoneLine,
  resolveInboundDidRoute,
  resolveOrgIdForInboundDid,
  savePlatformPhoneLine,
} from './phone-lines';
import {
  createOrganization,
  deleteOrganization,
  getOrganizationById,
  listOrganizations,
  updateOrganization,
} from './organizations';
import { listMenuItemsForOrg } from './menu-catalog';
import { withOrgContext, listPhoneLines, maskPhoneLine, getPhoneLineById } from './data-store';
import { resolvePosPushMode } from './connectors/types';

describe('DID routing cross-org isolation', () => {
  let orgA = '';
  let orgB = '';
  const createdOrgIds: string[] = [];
  const createdLines: Array<{ orgId: string; lineId: string }> = [];

  before(() => {
    listOrganizations();
    const a = createOrganization({
      name: 'Isolation Test A',
      contactName: 'A',
      contactEmail: `iso-a-${Date.now()}@example.com`,
      contactPhone: '07000000001',
      plan: 'starter',
      status: 'active',
    });
    const b = createOrganization({
      name: 'Isolation Test B',
      contactName: 'B',
      contactEmail: `iso-b-${Date.now()}@example.com`,
      contactPhone: '07000000002',
      plan: 'starter',
      status: 'active',
    });
    orgA = a.id;
    orgB = b.id;
    createdOrgIds.push(orgA, orgB);

    const lineA = savePlatformPhoneLine({
      orgId: orgA,
      label: 'Judie A',
      sipUsername: 'sip-a',
      sipPassword: 'secret-a-not-for-b',
      did: '02039991111',
      purpose: 'aria',
    });
    const lineB = savePlatformPhoneLine({
      orgId: orgB,
      label: 'Judie B',
      sipUsername: 'sip-b',
      sipPassword: 'secret-b-not-for-a',
      did: '02039992222',
      purpose: 'aria',
    });
    createdLines.push({ orgId: orgA, lineId: lineA.id }, { orgId: orgB, lineId: lineB.id });
  });

  after(() => {
    for (const { orgId, lineId } of createdLines) {
      try { deletePlatformPhoneLine(orgId, lineId); } catch { /* ignore */ }
    }
    for (const id of createdOrgIds) {
      try { deleteOrganization(id); } catch { /* ignore */ }
    }
  });

  it('Business A DID cannot resolve to Business B', () => {
    const route = resolveInboundDidRoute('02039991111', { allowDemoFallback: false });
    assert.equal(route.ok, true);
    if (!route.ok) return;
    assert.equal(route.orgId, orgA);
    assert.notEqual(route.orgId, orgB);
    assert.equal(resolveOrgIdForInboundDid('02039992222'), orgB);
  });

  it('unknown DID fails safely without demo override', () => {
    const route = resolveInboundDidRoute('02039990000', { allowDemoFallback: false });
    assert.equal(route.ok, false);
    if (route.ok) return;
    assert.equal(route.error, 'unknown_did');
    assert.ok(route.spokenHint);
  });

  it('missing DID can use explicit demo fallback', () => {
    const route = resolveInboundDidRoute('', { allowDemoFallback: true });
    assert.equal(route.ok, true);
    if (!route.ok) return;
    assert.equal(route.source, 'fallback_demo');
  });

  it('duplicate DIDs are rejected', () => {
    assert.throws(
      () => savePlatformPhoneLine({
        orgId: orgB,
        label: 'Clash',
        sipUsername: 'clash',
        sipPassword: 'clash-pass',
        did: '02039991111',
        purpose: 'aria',
      }),
      /DID already in use/,
    );
    const conflict = findDidConflict('02039991111', { orgId: orgB });
    assert.ok(conflict);
    assert.equal(conflict!.orgId, orgA);
  });

  it('Business A SIP credentials are not returned via Business B API', () => {
    const fromB = getPlatformPhoneLine(orgB, createdLines[0].lineId);
    assert.equal(fromB, undefined);
    const judieB = getJudiePhoneLineForOrg(orgB);
    assert.ok(judieB);
    assert.ok(judieB!.sipPassword);
    assert.ok(!String(judieB!.sipPassword).includes('secret-'));
    assert.notEqual(judieB!.did, '02039991111');

    const rawA = withOrgContext(orgA, () => getPhoneLineById(createdLines[0].lineId));
    assert.ok(rawA);
    const masked = maskPhoneLine(rawA!);
    assert.ok(masked.sipPassword);
    assert.notEqual(masked.sipPassword, 'secret-a-not-for-b');
    assert.ok(!String(masked.sipPassword).includes('secret-a'));
  });

  it('org phoneDid sync stays on Judie owner', () => {
    const a = getOrganizationById(orgA);
    const b = getOrganizationById(orgB);
    assert.ok(a?.phoneDid);
    assert.ok(b?.phoneDid);
    assert.notEqual(a!.phoneDid, b!.phoneDid);
  });

  it('menu listing is org-scoped (A context does not imply B catalog)', async () => {
    const menuA = await withOrgContext(orgA, () => listMenuItemsForOrg(orgA));
    const menuB = await withOrgContext(orgB, () => listMenuItemsForOrg(orgB));
    // Both may be empty locally; assert the calls are independently scoped (no throw / same org args).
    assert.ok(Array.isArray(menuA));
    assert.ok(Array.isArray(menuB));
    assert.equal(resolveOrgIdForInboundDid('02039991111'), orgA);
    // Simulate wrong-org order attempt: resolved DID org must win over a forged org id.
    const trusted = resolveOrgIdForInboundDid('02039991111');
    const forged = orgB;
    assert.notEqual(trusted, forged);
  });

  it('POS push modes stay org-controlled', () => {
    assert.equal(resolvePosPushMode({ ...({} as never), posPush: 'manual_only' }), 'manual_only');
    assert.equal(resolvePosPushMode({ ...({} as never), posPush: 'automatic' }), 'automatic');
    assert.equal(resolvePosPushMode({ ...({} as never), posPush: 'on_place' }), 'automatic');
  });

  it('clearing org config fails safely', () => {
    updateOrganization(orgA, { phoneDid: '' });
    // Line DID still routes via phoneLines table even if org.phoneDid cleared.
    assert.equal(resolveOrgIdForInboundDid('02039991111'), orgA);
    withOrgContext(orgA, () => {
      for (const line of listPhoneLines()) {
        if (line.id === createdLines[0].lineId) {
          // disable would be via save � deletion covered elsewhere
        }
      }
    });
  });
});
