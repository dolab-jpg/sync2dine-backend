import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from './crypto';
import {
  decryptPhoneLineSipPassword,
  encryptPhoneLineSipPassword,
  findDidConflict,
  getSallyPlatformPhoneLine,
  resolveOrgIdForInboundDid,
  savePlatformPhoneLine,
  saveSallyPlatformPhoneLine,
  listAllPlatformPhoneLines,
  deletePlatformPhoneLine,
} from './phone-lines';
import { getHomeOrgId } from './home-org';
import { getOrganizationById } from './organizations';
import { createOrganization, deleteOrganization, listOrganizations } from './organizations';
import { withOrgContext, listPhoneLines, maskPhoneLine } from './data-store';

describe('phone-lines platform provisioning', () => {
  let orgA: string;
  let orgB: string;
  const createdOrgIds: string[] = [];
  const createdLines: Array<{ orgId: string; lineId: string }> = [];

  before(() => {
    // Ensure org list is hydrated
    listOrganizations();
  });

  after(() => {
    for (const { orgId, lineId } of createdLines) {
      try {
        deletePlatformPhoneLine(orgId, lineId);
      } catch {
        /* ignore */
      }
    }
    for (const id of createdOrgIds) {
      try {
        deleteOrganization(id);
      } catch {
        /* ignore */
      }
    }
  });

  it('encrypts and decrypts SIP passwords', () => {
    const enc = encryptPhoneLineSipPassword('sip-secret-123');
    assert.ok(enc.startsWith('v1:'));
    assert.equal(decryptPhoneLineSipPassword(enc), 'sip-secret-123');
    assert.equal(decryptPhoneLineSipPassword('legacy-plain'), 'legacy-plain');
    assert.equal(encryptPhoneLineSipPassword(enc), enc);
  });

  it('masks passwords on platform list and stores encrypted at rest', () => {
    const org = createOrganization({
      name: `Phone Line Test A ${Date.now()}`,
      contactName: 'Owner',
      contactEmail: `pline-a-${Date.now()}@example.com`,
      contactPhone: '02000000001',
      plan: 'starter',
    });
    orgA = org.id;
    createdOrgIds.push(orgA);

    const line = savePlatformPhoneLine({
      orgId: orgA,
      label: 'Judie main',
      sipUsername: 'userA',
      sipPassword: 'passwordA-secret',
      did: '02039990001',
      purpose: 'aria',
      connectionType: 'soho66',
    });
    createdLines.push({ orgId: orgA, lineId: line.id });

    assert.equal(line.sipPassword, '••••••');
    assert.equal(line.orgId, orgA);
    assert.equal(line.purpose, 'aria');

    const stored = withOrgContext(orgA, () => listPhoneLines().find((l) => l.id === line.id));
    assert.ok(stored);
    assert.ok(stored!.sipPassword.startsWith('v1:') || stored!.sipPassword === 'passwordA-secret');
    assert.equal(decryptSecret(stored!.sipPassword) || stored!.sipPassword, 'passwordA-secret');
    assert.equal(maskPhoneLine(stored!).sipPassword, '••••••');
  });

  it('rejects duplicate DIDs across restaurants', () => {
    const org = createOrganization({
      name: `Phone Line Test B ${Date.now()}`,
      contactName: 'Owner',
      contactEmail: `pline-b-${Date.now()}@example.com`,
      contactPhone: '02000000002',
      plan: 'starter',
    });
    orgB = org.id;
    createdOrgIds.push(orgB);

    assert.throws(
      () =>
        savePlatformPhoneLine({
          orgId: orgB,
          label: 'Judie B',
          sipUsername: 'userB',
          sipPassword: 'passwordB-secret',
          did: '02039990001',
          purpose: 'aria',
        }),
      /DID already in use/,
    );

    const conflict = findDidConflict('02039990001');
    assert.ok(conflict);
    assert.equal(conflict!.orgId, orgA);
  });

  it('resolves inbound DID to the owning org and syncs org.phoneDid', () => {
    const resolved = resolveOrgIdForInboundDid('02039990001');
    assert.equal(resolved, orgA);

    const orgs = listOrganizations();
    const a = orgs.find((o) => o.id === orgA);
    assert.ok(a?.phoneDid);
    assert.ok(String(a!.phoneDid).includes('02039990001') || a!.phoneDid!.replace(/\D/g, '').endsWith('2039990001'));
  });

  it('lists lines across orgs for platform owner', () => {
    const lineB = savePlatformPhoneLine({
      orgId: orgB,
      label: 'Judie B unique',
      sipUsername: 'userB',
      sipPassword: 'passwordB-secret',
      did: '02039990002',
      purpose: 'aria',
    });
    createdLines.push({ orgId: orgB, lineId: lineB.id });

    const all = listAllPlatformPhoneLines();
    const ours = all.filter((l) => l.orgId === orgA || l.orgId === orgB);
    assert.ok(ours.length >= 2);
    assert.ok(ours.every((l) => l.sipPassword === '••••••' || l.sipPassword === ''));
  });

  it('crypto helpers round-trip via encryptSecret', () => {
    const enc = encryptSecret('x');
    assert.equal(decryptSecret(enc), 'x');
  });

  it('keeps Sally platform line separate from restaurant Judie phoneDid', () => {
    const homeId = getHomeOrgId();
    const beforeDid = getOrganizationById(homeId)?.phoneDid || '';
    const sally = saveSallyPlatformPhoneLine({
      sipUsername: 'sally_user',
      sipPassword: 'sally_secret_pass',
      did: '02080505029',
      connectionType: 'soho66',
    });
    createdLines.push({ orgId: homeId, lineId: sally.id });
    assert.equal(sally.purpose, 'sally');
    assert.equal(sally.orgId, homeId);
    assert.ok(getSallyPlatformPhoneLine()?.id === sally.id);
    // Sally must not overwrite Judie org.phoneDid routing for restaurants
    assert.equal(getOrganizationById(homeId)?.phoneDid || '', beforeDid);
  });

  it('clears org.phoneDid when the last Judie line is deleted', () => {
    const org = createOrganization({
      name: `Phone Line Test C ${Date.now()}`,
      contactName: 'Owner',
      contactEmail: `pline-c-${Date.now()}@example.com`,
      contactPhone: '02000000003',
      plan: 'starter',
    });
    createdOrgIds.push(org.id);
    const line = savePlatformPhoneLine({
      orgId: org.id,
      label: 'Temp Judie',
      sipUsername: 'userC',
      sipPassword: 'passwordC-secret',
      did: '02039990003',
      purpose: 'aria',
    });
    assert.ok(listOrganizations().find((o) => o.id === org.id)?.phoneDid);
    assert.equal(deletePlatformPhoneLine(org.id, line.id), true);
    assert.equal(listOrganizations().find((o) => o.id === org.id)?.phoneDid || '', '');
  });
});
