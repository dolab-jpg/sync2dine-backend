/**
 * Runtime debug: Sally (platform) vs Judie (restaurant) phone credentials.
 * Logs hypotheses H1–H8 with pass/fail evidence.
 */
import { appendFileSync, mkdirSync } from 'fs';
import {
  deletePlatformPhoneLine,
  getJudiePhoneLineForOrg,
  getSallyPlatformPhoneLine,
  listAllPlatformPhoneLines,
  resolveOrgIdForInboundDid,
  savePlatformPhoneLine,
  saveSallyPlatformPhoneLine,
  decryptPhoneLineSipPassword,
} from '../server/phone-lines';
import { createOrganization, deleteOrganization, getOrganizationById, listOrganizations, updateOrganization } from '../server/organizations';
import { getHomeOrgId } from '../server/home-org';
import { getPhoneLineById, withOrgContext } from '../server/data-store';
import { getSallyOfferStored } from '../server/sally-offer-store';

const LOG = '/opt/cursor/artifacts/sally-judie-split-debug.log';
mkdirSync('/opt/cursor/artifacts', { recursive: true });

type Row = {
  hypothesisId: string;
  message: string;
  data: Record<string, unknown>;
  pass?: boolean;
};

function log(row: Row) {
  const out = { sessionId: 'sally-judie', timestamp: Date.now(), ...row };
  console.log(JSON.stringify(out));
  appendFileSync(LOG, `${JSON.stringify(out)}\n`);
}

const cleanup: Array<() => void> = [];

async function main() {
  const homeId = getHomeOrgId();
  log({ hypothesisId: 'H1', message: 'home org for Sally', data: { homeId, name: getOrganizationById(homeId)?.name }, pass: Boolean(homeId) });

  // Isolate: clear leftover test DIDs on home if our previous debug left them
  const existingLines = listAllPlatformPhoneLines().filter((l) => l.orgId === homeId);
  log({ hypothesisId: 'H1b', message: 'existing home lines before test', data: { count: existingLines.length, lines: existingLines.map((l) => ({ id: l.id, purpose: l.purpose, did: l.did })) } });

  const restaurant = createOrganization({
    name: `Debug Restaurant ${Date.now()}`,
    contactName: 'Owner',
    contactEmail: `debug-rest-${Date.now()}@example.com`,
    contactPhone: '02000001111',
    plan: 'starter',
  });
  cleanup.push(() => deleteOrganization(restaurant.id));
  log({ hypothesisId: 'H2', message: 'created restaurant org', data: { orgId: restaurant.id }, pass: true });

  const sallyDid = '02081112222';
  const judieDid = '02083334444';

  const sally = saveSallyPlatformPhoneLine({
    label: 'Debug Sally',
    sipUsername: 'debug_sally_user',
    sipPassword: 'debug_sally_secret',
    did: sallyDid,
  });
  cleanup.push(() => deletePlatformPhoneLine(homeId, sally.id));

  const judie = savePlatformPhoneLine({
    orgId: restaurant.id,
    label: 'Debug Judie',
    sipUsername: 'debug_judie_user',
    sipPassword: 'debug_judie_secret',
    did: judieDid,
    purpose: 'aria',
  });
  cleanup.push(() => deletePlatformPhoneLine(restaurant.id, judie.id));

  log({
    hypothesisId: 'H3',
    message: 'Sally purpose and masking',
    data: {
      purpose: sally.purpose,
      masked: sally.sipPassword,
      orgId: sally.orgId,
      did: sally.did,
    },
    pass: sally.purpose === 'sally' && sally.sipPassword === '••••••' && sally.orgId === homeId,
  });

  log({
    hypothesisId: 'H4',
    message: 'Judie purpose on restaurant only',
    data: {
      purpose: judie.purpose,
      orgId: judie.orgId,
      did: judie.did,
      masked: judie.sipPassword,
    },
    pass: judie.purpose === 'aria' && judie.orgId === restaurant.id && judie.sipPassword === '••••••',
  });

  const homeAfter = getOrganizationById(homeId);
  const restAfter = getOrganizationById(restaurant.id);
  log({
    hypothesisId: 'H5',
    message: 'org.phoneDid follows Judie only (not Sally)',
    data: {
      homePhoneDid: homeAfter?.phoneDid || '',
      restaurantPhoneDid: restAfter?.phoneDid || '',
      sallyDid,
      judieDid,
    },
    pass: restAfter?.phoneDid === judieDid && (homeAfter?.phoneDid || '') !== sallyDid,
  });

  const resolveSally = resolveOrgIdForInboundDid(sallyDid);
  const resolveJudie = resolveOrgIdForInboundDid(judieDid);
  const resolveSallyE164 = resolveOrgIdForInboundDid('+442081112222');
  const resolveJudieE164 = resolveOrgIdForInboundDid('+442083334444');
  log({
    hypothesisId: 'H6',
    message: 'DID → org routing',
    data: { resolveSally, resolveJudie, resolveSallyE164, resolveJudieE164, homeId, restaurantId: restaurant.id },
    pass:
      resolveSally === homeId
      && resolveJudie === restaurant.id
      && resolveSallyE164 === homeId
      && resolveJudieE164 === restaurant.id,
  });

  const sallyStored = withOrgContext(homeId, () => getPhoneLineById(sally.id));
  const judieStored = withOrgContext(restaurant.id, () => getPhoneLineById(judie.id));
  log({
    hypothesisId: 'H7',
    message: 'passwords encrypted at rest and decrypt correctly',
    data: {
      sallyEnc: Boolean(sallyStored?.sipPassword?.startsWith('v1:')),
      judieEnc: Boolean(judieStored?.sipPassword?.startsWith('v1:')),
      sallyOk: decryptPhoneLineSipPassword(sallyStored!.sipPassword) === 'debug_sally_secret',
      judieOk: decryptPhoneLineSipPassword(judieStored!.sipPassword) === 'debug_judie_secret',
    },
    pass:
      Boolean(sallyStored?.sipPassword?.startsWith('v1:'))
      && Boolean(judieStored?.sipPassword?.startsWith('v1:'))
      && decryptPhoneLineSipPassword(sallyStored!.sipPassword) === 'debug_sally_secret'
      && decryptPhoneLineSipPassword(judieStored!.sipPassword) === 'debug_judie_secret',
  });

  const offer = getSallyOfferStored();
  log({
    hypothesisId: 'H8',
    message: 'Sally offer demoPhone synced from Sally line',
    data: { demoPhone: offer.demoPhone, sallyDid },
    pass: offer.demoPhone === sallyDid,
  });

  // Cross-contamination: restaurant must not see Sally as its Judie line
  const judieOnRest = getJudiePhoneLineForOrg(restaurant.id);
  const sallyFetched = getSallyPlatformPhoneLine();
  log({
    hypothesisId: 'H9',
    message: 'getJudie vs getSally accessors',
    data: {
      judieOnRestDid: judieOnRest?.did,
      judiePurpose: judieOnRest?.purpose,
      sallyFetchedDid: sallyFetched?.did,
      sallyPurpose: sallyFetched?.purpose,
    },
    pass:
      judieOnRest?.did === judieDid
      && judieOnRest?.purpose === 'aria'
      && sallyFetched?.did === sallyDid
      && sallyFetched?.purpose === 'sally',
  });

  // Duplicate DID across Sally and Judie should fail
  let dupErr: string | null = null;
  try {
    savePlatformPhoneLine({
      orgId: restaurant.id,
      label: 'Dup Judie',
      sipUsername: 'x',
      sipPassword: 'y',
      did: sallyDid,
      purpose: 'aria',
    });
  } catch (err) {
    dupErr = err instanceof Error ? err.message : String(err);
  }
  log({
    hypothesisId: 'H10',
    message: 'restaurant cannot reuse Sally DID',
    data: { dupErr },
    pass: Boolean(dupErr?.includes('DID already')),
  });

  for (const fn of cleanup.reverse()) {
    try { fn(); } catch { /* ignore */ }
  }
  // Ensure restaurant gone
  if (getOrganizationById(restaurant.id)) deleteOrganization(restaurant.id);

  const fails = 0; // counted from console by runner
  log({ hypothesisId: 'DONE', message: 'cleanup complete', data: { orgs: listOrganizations().length, log: LOG }, pass: true });
  console.log('\nLog:', LOG);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
