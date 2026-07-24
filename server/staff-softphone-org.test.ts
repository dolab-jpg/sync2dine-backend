import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  withOrgContext,
  savePhoneLine,
  deletePhoneLine,
  getStaffPhoneLineForUser,
  getPhoneLineByAssignedUserId,
} from './data-store';
import { getHomeOrgId } from './home-org';

describe('staff softphone home-org fallback', () => {
  const userId = `staff-softphone-test-${Date.now()}`;
  const clientOrg = 'c2887ddb-0cba-4df1-9086-e7399c92d159';
  let lineId = '';

  after(() => {
    if (!lineId) return;
    withOrgContext(getHomeOrgId(), () => {
      deletePhoneLine(lineId);
    });
  });

  it('finds staff softphone on home while request org is a client', () => {
    const home = getHomeOrgId();
    const line = withOrgContext(home, () =>
      savePhoneLine({
        label: 'Staff Softphone Test',
        sipUsername: `sip${Date.now()}`,
        sipPassword: 'test-password',
        did: `0203${String(Date.now()).slice(-7)}`,
        assignedUserId: userId,
        purpose: 'staff',
      }),
    );
    lineId = line.id;

    withOrgContext(clientOrg, () => {
      assert.equal(getPhoneLineByAssignedUserId(userId), undefined);
      const found = getStaffPhoneLineForUser(userId);
      assert.ok(found);
      assert.equal(found.id, line.id);
      assert.equal(found.assignedUserId, userId);
    });
  });
});
