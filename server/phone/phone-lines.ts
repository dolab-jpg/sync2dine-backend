/**
 * Cross-org phone line helpers for platform_owner provisioning.
 * Lines live in each org's synced-data store; this module lists/creates them
 * across tenants and resolves inbound DID → organisation.
 */
import { decryptSecret, encryptSecret } from '../crypto';
import {
  deletePhoneLine,
  getPhoneLineById,
  listPhoneLines,
  maskPhoneLine,
  normalizePhoneExport,
  savePhoneLine,
  withOrgContext,
  type PhoneLine,
  type PhoneLinePurpose,
  type PhoneLineStatus,
} from '../data-store';
import {
  getOrganizationById,
  getOrganizationByPhoneDid,
  listOrganizations,
  updateOrganization,
} from '../organizations';
import { getDemoKitchenOrgId, getHomeOrgId } from '../home-org';
import { getSallyOfferStored, updateSallyOfferStored } from '../sally-offer-store';

export type PhoneLineConnectionType = 'soho66' | 'sip' | 'twilio' | 'other';

export type PlatformPhoneLine = Omit<PhoneLine, 'sipPassword'> & {
  sipPassword: string;
  orgId: string;
  orgName?: string;
  connectionType?: PhoneLineConnectionType;
};

const MASK = '••••••';

export function encryptPhoneLineSipPassword(password: string): string {
  const trimmed = String(password ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('v1:')) return trimmed;
  if (trimmed === MASK) return '';
  return encryptSecret(trimmed);
}

/** Decrypt stored SIP password (legacy plaintext still works). */
export function decryptPhoneLineSipPassword(stored: string): string {
  return decryptSecret(String(stored ?? ''));
}

export function withDecryptedSipPassword(line: PhoneLine): PhoneLine {
  return {
    ...line,
    sipPassword: decryptPhoneLineSipPassword(line.sipPassword),
  };
}

function parseConnectionType(value: unknown, fallback: PhoneLineConnectionType = 'soho66'): PhoneLineConnectionType {
  if (value === 'soho66' || value === 'sip' || value === 'twilio' || value === 'other') return value;
  return fallback;
}

export function listAllPlatformPhoneLines(): PlatformPhoneLine[] {
  const orgs = listOrganizations();
  const out: PlatformPhoneLine[] = [];
  for (const org of orgs) {
    const lines = withOrgContext(org.id, () => listPhoneLines());
    for (const line of lines) {
      out.push({
        ...maskPhoneLine(line),
        orgId: org.id,
        orgName: org.name,
        connectionType: parseConnectionType(line.connectionType),
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function findDidConflict(
  did: string,
  exclude?: { orgId: string; lineId?: string },
): { orgId: string; lineId?: string; label: string } | undefined {
  const normalized = normalizePhoneExport(did);
  if (!normalized) return undefined;

  for (const org of listOrganizations()) {
    const orgDid = org.phoneDid ? normalizePhoneExport(org.phoneDid) : '';
    if (orgDid && orgDid === normalized && org.id !== exclude?.orgId) {
      return { orgId: org.id, label: `${org.name} (org DID)` };
    }
    const lines = withOrgContext(org.id, () => listPhoneLines());
    for (const line of lines) {
      if (exclude?.orgId === org.id && exclude.lineId === line.id) continue;
      if (normalizePhoneExport(line.did) === normalized) {
        return { orgId: org.id, lineId: line.id, label: line.label };
      }
    }
  }
  return undefined;
}

export type InboundDidRoute =
  | {
      ok: true;
      orgId: string;
      lineDid: string;
      purpose: PhoneLinePurpose;
      source: 'org_phoneDid' | 'phone_line' | 'fallback_demo';
      lineId?: string;
    }
  | {
      ok: false;
      error: 'missing_did' | 'unknown_did' | 'org_missing';
      lineDid?: string;
      spokenHint: string;
    };

/**
 * Resolve restaurant/platform org from the inbound line DID.
 * Valid match always wins over demo-kitchen fallback.
 */
export function resolveInboundDidRoute(
  did: string | undefined | null,
  opts?: { allowDemoFallback?: boolean },
): InboundDidRoute {
  const raw = String(did ?? '').trim();
  const allowDemoFallback = opts?.allowDemoFallback !== false;

  if (!raw) {
    if (allowDemoFallback) {
      return {
        ok: true,
        orgId: getDemoKitchenOrgId(),
        lineDid: '',
        purpose: 'aria',
        source: 'fallback_demo',
      };
    }
    return {
      ok: false,
      error: 'missing_did',
      spokenHint: 'This call has no business number — I cannot load a restaurant menu.',
    };
  }

  const byOrg = getOrganizationByPhoneDid(raw);
  if (byOrg?.id) {
    const line = withOrgContext(byOrg.id, () =>
      listPhoneLines().find((l) => l.enabled && normalizePhoneExport(l.did) === normalizePhoneExport(raw)),
    );
    return {
      ok: true,
      orgId: byOrg.id,
      lineDid: raw,
      purpose: (line?.purpose ?? 'aria') as PhoneLinePurpose,
      source: 'org_phoneDid',
      lineId: line?.id,
    };
  }

  const normalized = normalizePhoneExport(raw);
  for (const org of listOrganizations()) {
    const hit = withOrgContext(org.id, () =>
      listPhoneLines().find((l) => l.enabled && normalizePhoneExport(l.did) === normalized),
    );
    if (hit) {
      if (!getOrganizationById(org.id)) {
        return {
          ok: false,
          error: 'org_missing',
          lineDid: raw,
          spokenHint: 'This line is misconfigured — please try again later.',
        };
      }
      return {
        ok: true,
        orgId: org.id,
        lineDid: raw,
        purpose: (hit.purpose ?? 'aria') as PhoneLinePurpose,
        source: 'phone_line',
        lineId: hit.id,
      };
    }
  }

  return {
    ok: false,
    error: 'unknown_did',
    lineDid: raw,
    spokenHint:
      'This number is not set up for Sync2Dine yet — please check the restaurant listing or try again later.',
  };
}

/** Resolve restaurant org from the inbound/outbound line DID (undefined if unknown). */
export function resolveOrgIdForInboundDid(did: string | undefined | null): string | undefined {
  const route = resolveInboundDidRoute(did, { allowDemoFallback: false });
  return route.ok ? route.orgId : undefined;
}

/** Keep organizations.phoneDid in sync with the primary Judie (aria) line. */
export function syncOrgPhoneDidFromLine(orgId: string, line: PhoneLine): void {
  if ((line.purpose ?? 'staff') !== 'aria') return;
  if (!line.enabled || !line.did?.trim()) return;
  const org = getOrganizationById(orgId);
  if (!org) return;
  const next = line.did.trim();
  if (org.phoneDid && normalizePhoneExport(org.phoneDid) === normalizePhoneExport(next)) return;
  updateOrganization(orgId, { phoneDid: next });
}

export function savePlatformPhoneLine(input: {
  orgId: string;
  id?: string;
  label: string;
  sipUsername: string;
  sipPassword?: string;
  sipDomain?: string;
  did: string;
  enabled?: boolean;
  purpose?: PhoneLinePurpose;
  connectionType?: PhoneLineConnectionType;
  assignedUserId?: string | null;
  status?: PhoneLineStatus;
}): PlatformPhoneLine {
  const orgId = String(input.orgId || '').trim();
  if (!orgId) throw new Error('orgId is required');
  if (!getOrganizationById(orgId)) throw new Error('Organization not found');

  const conflict = findDidConflict(input.did, { orgId, lineId: input.id });
  if (conflict) {
    throw new Error(
      `DID already in use by ${conflict.label} (org ${conflict.orgId}${conflict.lineId ? `, line ${conflict.lineId}` : ''})`,
    );
  }

  // Sally lines must live on the home/platform org only.
  if (input.purpose === 'sally' && orgId !== getHomeOrgId()) {
    throw new Error('Sally phone lines can only be saved on the platform home organisation');
  }

  const existing = input.id
    ? withOrgContext(orgId, () => getPhoneLineById(input.id!))
    : undefined;

  const passwordPlain = typeof input.sipPassword === 'string'
    && input.sipPassword.trim()
    && input.sipPassword !== MASK
    ? input.sipPassword.trim()
    : existing
      ? decryptPhoneLineSipPassword(existing.sipPassword)
      : '';

  if (!existing && !passwordPlain) {
    throw new Error('sipPassword is required for new lines');
  }

  const line = withOrgContext(orgId, () =>
    savePhoneLine({
      id: input.id,
      label: input.label,
      sipUsername: input.sipUsername,
      sipPassword: encryptPhoneLineSipPassword(passwordPlain || decryptPhoneLineSipPassword(existing!.sipPassword)),
      sipDomain: input.sipDomain,
      did: input.did,
      enabled: input.enabled,
      purpose: input.purpose,
      connectionType: parseConnectionType(input.connectionType, existing?.connectionType ?? 'soho66'),
      assignedUserId: input.assignedUserId,
      status: input.status ?? existing?.status,
    }),
  );

  syncOrgPhoneDidFromLine(orgId, line);
  const org = getOrganizationById(orgId);
  return {
    ...maskPhoneLine(line),
    orgId,
    orgName: org?.name,
    connectionType: parseConnectionType(line.connectionType),
  };
}

export function deletePlatformPhoneLine(orgId: string, lineId: string): boolean {
  const existing = withOrgContext(orgId, () => getPhoneLineById(lineId));
  const ok = withOrgContext(orgId, () => deletePhoneLine(lineId));
  if (!ok) return false;

  const org = getOrganizationById(orgId);
  if (org?.phoneDid) {
    const remainingAria = withOrgContext(orgId, () =>
      listPhoneLines().filter((l) => l.enabled && (l.purpose ?? 'staff') === 'aria'),
    );
    if (remainingAria[0]) {
      syncOrgPhoneDidFromLine(orgId, remainingAria[0]);
    } else if (
      !existing
      || normalizePhoneExport(org.phoneDid) === normalizePhoneExport(existing.did)
    ) {
      updateOrganization(orgId, { phoneDid: '' });
    }
  }

  if (existing?.purpose === 'sally') {
    const offer = getSallyOfferStored();
    if (
      offer.demoPhone
      && existing.did
      && normalizePhoneExport(offer.demoPhone) === normalizePhoneExport(existing.did)
    ) {
      updateSallyOfferStored({ demoPhone: '' }, 'sally-phone-line-delete');
    }
  }
  return true;
}

export function getPlatformPhoneLine(orgId: string, lineId: string): PlatformPhoneLine | undefined {
  const line = withOrgContext(orgId, () => getPhoneLineById(lineId));
  if (!line) return undefined;
  const org = getOrganizationById(orgId);
  return {
    ...maskPhoneLine(line),
    orgId,
    orgName: org?.name,
    connectionType: parseConnectionType(line.connectionType),
  };
}

/** Primary Judie (aria) line for a restaurant org, if any. */
export function getJudiePhoneLineForOrg(orgId: string): PlatformPhoneLine | undefined {
  const lines = withOrgContext(orgId, () =>
    listPhoneLines().filter((l) => (l.purpose ?? 'staff') === 'aria'),
  );
  const primary = lines.find((l) => l.enabled) || lines[0];
  if (!primary) return undefined;
  return getPlatformPhoneLine(orgId, primary.id);
}

/** Platform-owner Sally sales line — always on the home Sync2Dine org. */
export function getSallyPlatformPhoneLine(): PlatformPhoneLine | undefined {
  const orgId = getHomeOrgId();
  const lines = withOrgContext(orgId, () =>
    listPhoneLines().filter((l) => l.purpose === 'sally'),
  );
  const primary = lines.find((l) => l.enabled) || lines[0];
  if (!primary) return undefined;
  return getPlatformPhoneLine(orgId, primary.id);
}

export function saveSallyPlatformPhoneLine(input: {
  label?: string;
  sipUsername: string;
  sipPassword?: string;
  sipDomain?: string;
  did: string;
  enabled?: boolean;
  connectionType?: PhoneLineConnectionType;
}): PlatformPhoneLine {
  const orgId = getHomeOrgId();
  const existing = getSallyPlatformPhoneLine();
  const line = savePlatformPhoneLine({
    orgId,
    id: existing?.id,
    label: input.label?.trim() || existing?.label || 'Sally sales',
    sipUsername: input.sipUsername,
    sipPassword: input.sipPassword,
    sipDomain: input.sipDomain,
    did: input.did,
    enabled: input.enabled,
    purpose: 'sally',
    connectionType: input.connectionType ?? 'soho66',
  });
  if (line.did?.trim()) {
    updateSallyOfferStored({ demoPhone: line.did.trim() }, 'sally-phone-line');
  }
  return line;
}
