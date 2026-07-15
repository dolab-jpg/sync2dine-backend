/**
 * One-off smoke: PIN gate + staff CRM tools against synced-data.
 * Run: npx tsx --env-file=.env scripts/smoke-phone-pin-crm.ts
 */
import {
  isToolAllowedForPhoneSession,
  markPhoneAuthVerified,
  isPhoneAuthVerified,
  resolvePhoneCallerIdentity,
} from '../server/phone-auth.ts';
import { executeServerReadTool, executeCustomerTool } from '../server/orchestrator-tool-exec.ts';
import { getDataStore } from '../server/data-store.ts';

const CALL_ID = `smoke-pin-${Date.now()}`;
const STAFF_PHONE = '447576442345';

async function main() {
  const store = getDataStore();
  const identity = resolvePhoneCallerIdentity(STAFF_PHONE);
  console.log('identity', {
    kind: identity.kind,
    role: identity.role,
    name: identity.name,
    phone: identity.phone,
    pinConfigured: identity.pinConfigured,
    memberId: identity.member?.id,
  });

  if (identity.kind !== 'staff' || identity.role !== 'super_admin') {
    throw new Error(`Expected staff/super_admin, got ${identity.kind}/${identity.role}`);
  }

  const blocked = isToolAllowedForPhoneSession('getBusinessSnapshot', CALL_ID, identity);
  console.log('unverified getBusinessSnapshot allowed?', blocked, '(expect false)');
  if (blocked !== false) throw new Error('PIN gate failed: unverified should block CRM tools');

  const pinOk = isToolAllowedForPhoneSession('verifyStaffPhonePin', CALL_ID, identity);
  console.log('unverified verifyStaffPhonePin allowed?', pinOk, '(expect true)');

  markPhoneAuthVerified(CALL_ID, identity);
  console.log('verified?', isPhoneAuthVerified(CALL_ID));

  const allowed = isToolAllowedForPhoneSession('getBusinessSnapshot', CALL_ID, identity);
  console.log('verified getBusinessSnapshot allowed?', allowed, '(expect true)');
  if (allowed !== true) throw new Error('PIN gate failed: verified should allow CRM tools');

  const body = {
    message: 'smoke',
    callContext: { callId: CALL_ID, from: STAFF_PHONE, to: STAFF_PHONE },
    staffContext: {
      customers: undefined as unknown as undefined,
      quotes: undefined as unknown as undefined,
    },
  } as Parameters<typeof executeServerReadTool>[2];

  // Minimal body — tools fall back to getDataStore()
  const orchBody = {
    message: 'smoke',
    callContext: { callId: CALL_ID, from: STAFF_PHONE },
  } as Parameters<typeof executeServerReadTool>[2];

  const snapshot = await executeServerReadTool('getBusinessSnapshot', {}, orchBody);
  console.log('getBusinessSnapshot', {
    customerCount: snapshot.customerCount,
    quoteCount: snapshot.quoteCount,
    projectCount: snapshot.projectCount,
    openProjectCount: snapshot.openProjectCount,
  });

  // Broad query so searchCustomers returns rows (empty query returns [])
  const sampleName = String((store.customers as Array<{ name?: string }>)[0]?.name || 'a').slice(0, 1) || 'a';
  const customers = await executeServerReadTool('searchCustomers', { query: sampleName, limit: 20 }, orchBody);
  console.log('searchCustomers', { query: sampleName, count: customers.count, sample: (customers.results as unknown[])?.slice?.(0, 2) });

  const projects = await executeServerReadTool('searchProjects', { query: 'open', limit: 10 }, orchBody);
  const projRows = (projects.results as Array<Record<string, unknown>>) || [];
  console.log('searchProjects', {
    query: projects.query,
    count: projects.count,
    sample: projRows.slice(0, 2).map((p) => ({
      id: p.id,
      title: p.title,
      address: p.address,
      customerPhone: p.customerPhone,
    })),
  });

  const briefing = executeCustomerTool('getAccountBriefing', {}, {
    ...orchBody,
    customerContext: { phone: STAFF_PHONE },
  } as Parameters<typeof executeCustomerTool>[2]);
  console.log('getAccountBriefing keys', Object.keys(briefing), {
    found: briefing.found,
    address: briefing.address ?? briefing.siteAddress,
  });

  const storeCounts = {
    customers: (store.customers || []).length,
    projects: (store.projects || []).length,
    quotes: (store.quotes || []).length,
  };

  if (!Number(snapshot.customerCount) || Number(snapshot.customerCount) < 1) {
    throw new Error('getBusinessSnapshot returned empty customerCount');
  }
  if (!Number(customers.count) || Number(customers.count) < 1) {
    throw new Error('searchCustomers returned empty');
  }
  if (!Number(projects.count) || Number(projects.count) < 1) {
    throw new Error('searchProjects(open) returned empty');
  }

  console.log('SMOKE_OK', { storeCounts, callId: CALL_ID });
}

main().catch((err) => {
  console.error('SMOKE_FAIL', err);
  process.exit(1);
});
