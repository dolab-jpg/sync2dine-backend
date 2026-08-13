import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataStore, saveCustomerRecord, withOrgContext } from '../data-store.js';
import { rememberPerson } from './remember-person.js';
import { buildSallyRelationshipMemory } from './relationship-memory.js';
import { captureReferralAndQueue } from './schedule-outbound.js';

const TEST_ORG = 'org_people_memory_test';
const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', `synced-data-${TEST_ORG}.json`);

function run<T>(fn: () => T): T {
  return withOrgContext(TEST_ORG, fn);
}

describe('rememberPerson / people memory', () => {
  after(() => {
    try {
      if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);
    } catch {
      /* ignore */
    }
  });

  it('rememberPerson on existing lead adds contacts row; relationship memory includes the name', () => {
    run(() => {
      const customer = saveCustomerRecord({
        name: 'Spice Garden',
        contactName: 'Raj',
        phone: '+447700900101',
        status: 'lead',
      });
      const remembered = rememberPerson({
        customerId: String(customer.id),
        name: 'Raj',
        role: 'owner',
        phone: '+447700900101',
        howKnown: 'spoke',
        setPrimary: true,
      });
      assert.equal(remembered.ok, true);
      const store = getDataStore();
      const row = store.contacts.find(
        (c) => String(c.customerId) === String(customer.id) && String(c.name).toLowerCase() === 'raj',
      );
      assert.ok(row, 'expected contacts row for Raj');
      const memory = buildSallyRelationshipMemory('+447700900101');
      assert.match(memory, /PEOPLE ON THIS ACCOUNT/);
      assert.match(memory, /Raj/);
    });
  });

  it('referral with new mobile on SAME venue does not create a second restaurant; Priya is on that account', () => {
    run(() => {
      const customer = saveCustomerRecord({
        name: 'Spice Garden',
        contactName: 'Raj',
        phone: '+447700900201',
        status: 'lead',
        openingHours: '12:00-22:00',
        venueType: 'restaurant',
      });
      rememberPerson({
        customerId: String(customer.id),
        name: 'Raj',
        role: 'owner',
        phone: '+447700900201',
        howKnown: 'spoke',
        setPrimary: true,
      });
      const before = getDataStore().customers.length;
      const result = captureReferralAndQueue({
        name: 'Priya',
        phone: '+447700900202',
        role: 'manager',
        referredByName: 'Raj',
        referredByPhone: '+447700900201',
        referredByVenue: 'Spice Garden',
        referredByCustomerId: String(customer.id),
        summary: 'Ask for Priya on her mobile',
        openingHours: '12:00-22:00',
        venueType: 'restaurant',
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.equal(result.isNewLead, false);
      const store = getDataStore();
      assert.equal(store.customers.length, before, 'must not spawn a second restaurant');
      const priya = store.contacts.find(
        (c) => String(c.customerId) === String(customer.id) && String(c.name).toLowerCase() === 'priya',
      );
      assert.ok(priya, 'Priya should appear in contacts for this venue');
      assert.equal(String(priya?.howKnown || ''), 'referred');
      const memory = buildSallyRelationshipMemory('+447700900201');
      assert.match(memory, /Priya/);
      // Queue may skip if eligibility/hours block; people memory is the contract.
      assert.ok(result.ok === true || result.error === 'needs_hours' || result.error === 'queue_failed');
    });
  });
});
