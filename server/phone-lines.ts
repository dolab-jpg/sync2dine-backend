/**
 * Cross-org phone line helpers for platform_owner provisioning.
 * Lines themselves live in each org's synced-data store; this module
 * lists/creates them across tenants and resolves inbound DID → org.
 */
import { decryptSecret, encryptSecret } from './crypto';
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
} from './data-store';
import {
  getOrganizationById,
  getOrganizationByPhoneDid,
  listOrganizations,
  updateOrganization,
} from './organizations';

export type PhoneLineConnectionType = 'soho66' | 'sip' | 'twilio' | 'other';

export type PlatformPhoneLine = Omit<PhoneLine, 'sipPassword'> & {
  sipPassword: string;
  orgId: string;
  orgName?: string;
  connectionType?: PhoneLineConnectionType;
};

export function encryptPhoneLineSipPassword(password: string): string {
  const trimmed = String(password ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('v1:')) return trimmed;
  if (trimmed === '••••••') return '';
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
    if (exclude?.orgId && org.id === exclude.orgId && !exclude.lineId) {
      // still check lines in other orgs; for same org check below
    }
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

/** Resolve restaurant org from the inbound/outbound line DID. */
export function resolveOrgIdForInboundDid(did: string | undefined | null): string | undefined {
  const raw = String(did ?? '').trim();
  if (!raw) return undefined;

  const byOrg = getOrganizationByPhoneDid(raw);
  if (byOrg?.id) return byOrg.id;

  const normalized = normalizePhoneExport(raw);
  for (const org of listOrganizations()) {
    const hit = withOrgContext(org.id, () =>
      listPhoneLines().find((l) => l.enabled && normalizePhoneExport(l.did) === normalized),
    );
    if (hit) return org.id;
  }
  return undefined;
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

  const existing = input.id
    ? withOrgContext(orgId, () => getPhoneLineById(input.id!))
    : undefined;

  const passwordPlain = typeof input.sipPassword === 'string' && input.sipPassword.trim() && input.sipPassword !== '••••••'
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
      sipPassword: passwordPlain || decryptPhoneLineSipPassword(existing!.sipPassword),
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
  return withOrgContext(orgId, () => deletePhoneLine(lineId));
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
