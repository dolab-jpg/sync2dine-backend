/**
 * Runtime debug for platform phone-lines: encrypt, save, DID resolve, mask, decrypt.
 * Usage:
 *   npx tsx scripts/debug-platform-phone-lines.mts
 *   DEBUG_SIP_USER=... DEBUG_SIP_PASS=... DEBUG_DID=0203... npx tsx scripts/debug-platform-phone-lines.mts
 */
import { appendFileSync, mkdirSync } from 'fs';
import {
  decryptPhoneLineSipPassword,
  deletePlatformPhoneLine,
  findDidConflict,
  listAllPlatformPhoneLines,
  resolveOrgIdForInboundDid,
  savePlatformPhoneLine,
} from '../server/phone-lines';
import { getOrganizationById, listOrganizations, createOrganization, deleteOrganization } from '../server/organizations';
import { getPhoneLineById, withOrgContext } from '../server/data-store';

const LOG = '/opt/cursor/artifacts/phone-lines-debug.log';
mkdirSync('/opt/cursor/artifacts', { recursive: true });

function log(hypothesisId: string, message: string, data: Record<string, unknown>) {
  const row = {
    sessionId: 'phone-lines',
    hypothesisId,
    message,
    data,
    timestamp: Date.now(),
  };
  console.log(JSON.stringify(row));
  appendFileSync(LOG, `${JSON.stringify(row)}\n`);
}

const tempOrgs: string[] = [];
const tempLines: Array<{ orgId: string; lineId: string }> = [];

async function main() {
  const orgs = listOrganizations();
  log('H1', 'orgs loaded', { count: orgs.length, ids: orgs.map((o) => ({ id: o.id, name: o.name, phoneDid: o.phoneDid })) });

  let orgId = orgs[0]?.id;
  if (!orgId) {
    const created = createOrganization({
      name: 'Debug Phone Line Org',
      contactName: 'Debug',
      contactEmail: `debug-pline-${Date.now()}@example.com`,
      contactPhone: '02000000999',
      plan: 'starter',
    });
    orgId = created.id;
    tempOrgs.push(orgId);
    log('H1', 'created temp org', { orgId });
  }

  const sipUser = (process.env.DEBUG_SIP_USER || 'debug_user').trim();
  const sipPass = (process.env.DEBUG_SIP_PASS || 'debug_pass_secret').trim();
  const did = (process.env.DEBUG_DID || `0203${String(Date.now()).slice(-7)}`).trim();
  const usingRealCreds = Boolean(process.env.DEBUG_SIP_USER && process.env.DEBUG_SIP_PASS);

  log('H2', 'save line attempt', { orgId, did, sipUser, usingRealCreds, passLen: sipPass.length });

  const line = savePlatformPhoneLine({
    orgId,
    label: usingRealCreds ? 'Live Judie line' : 'Debug Judie line',
    sipUsername: sipUser,
    sipPassword: sipPass,
    sipDomain: process.env.DEBUG_SIP_DOMAIN || 'sbc.soho66.co.uk',
    did,
    purpose: 'aria',
    connectionType: 'soho66',
    enabled: true,
  });
  if (!usingRealCreds) tempLines.push({ orgId, lineId: line.id });

  log('H2', 'save line result (masked)', {
    id: line.id,
    orgId: line.orgId,
    did: line.did,
    sipPassword: line.sipPassword,
    purpose: line.purpose,
    connectionType: line.connectionType,
  });

  const stored = withOrgContext(orgId, () => getPhoneLineById(line.id));
  const decrypted = stored ? decryptPhoneLineSipPassword(stored.sipPassword) : '';
  log('H3', 'at-rest encryption check', {
    storedPrefix: stored?.sipPassword?.slice(0, 3),
    encrypted: Boolean(stored?.sipPassword?.startsWith('v1:')),
    decryptMatches: decrypted === sipPass,
    decryptLen: decrypted.length,
  });

  const orgAfter = getOrganizationById(orgId);
  log('H4', 'org.phoneDid sync', {
    phoneDid: orgAfter?.phoneDid,
    matchesLine: orgAfter?.phoneDid === did || orgAfter?.phoneDid?.replace(/\D/g, '') === did.replace(/\D/g, ''),
  });

  const resolved = resolveOrgIdForInboundDid(did);
  const resolvedAlt = resolveOrgIdForInboundDid(`+44${did.replace(/\D/g, '').replace(/^0/, '')}`);
  log('H5', 'DID → org resolve', { did, resolved, resolvedAlt, expect: orgId, ok: resolved === orgId });

  const conflict = findDidConflict(did, { orgId, lineId: line.id });
  const conflictSelf = findDidConflict(did);
  log('H6', 'DID uniqueness', {
    conflictWhenExcluded: conflict ?? null,
    conflictWithoutExclude: conflictSelf ? { orgId: conflictSelf.orgId, lineId: conflictSelf.lineId } : null,
  });

  const listed = listAllPlatformPhoneLines().filter((l) => l.id === line.id);
  log('H7', 'platform list masks password', {
    found: listed.length,
    sipPassword: listed[0]?.sipPassword,
    orgName: listed[0]?.orgName,
  });

  // second org duplicate should fail
  let dupError: string | null = null;
  try {
    const org2 = createOrganization({
      name: 'Debug Phone Line Org 2',
      contactName: 'Debug',
      contactEmail: `debug-pline2-${Date.now()}@example.com`,
      contactPhone: '02000000998',
      plan: 'starter',
    });
    tempOrgs.push(org2.id);
    savePlatformPhoneLine({
      orgId: org2.id,
      label: 'Dup',
      sipUsername: 'x',
      sipPassword: 'y',
      did,
      purpose: 'aria',
    });
  } catch (err) {
    dupError = err instanceof Error ? err.message : String(err);
  }
  log('H8', 'duplicate DID rejected', { dupError, ok: Boolean(dupError?.includes('DID already')) });

  if (!usingRealCreds) {
    for (const t of tempLines) deletePlatformPhoneLine(t.orgId, t.lineId);
    for (const id of tempOrgs) deleteOrganization(id);
    log('cleanup', 'removed temp debug data', { tempOrgs, tempLines });
  } else {
    log('keep', 'kept live credentials line — not deleted', { orgId, lineId: line.id, did });
  }

  console.log('\nOK — see', LOG);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
