/**
 * Sally relationship + org memory ù compact facts for live prompt / recall tool.
 */
import { getDataStore, resolveContactByPhone, syncData } from '../data-store';
import { getSalesBrainStore } from '../sales-brain/store';
import { getHomeOrgId } from '../home-org';
import {
  formatTrustPromptBlock,
  parseTrustFromCustomer,
  type TrustEngineScores,
} from './trust-engine';
import {
  formatDialTimingPromptBlock,
  normalizeVenueType,
  suggestDialWindows,
  type DialWindowSuggestion,
} from './dial-windows';

export type SallyOrgMemory = {
  staffChanges?: string;
  branches?: string;
  previousProjects?: string;
  pastObjections?: string[];
  seasonalPatterns?: string;
  decisionHistory?: string;
  champions?: string;
  blockers?: string;
};

function customerByPhone(partyPhone: string): Record<string, unknown> | null {
  const resolved = resolveContactByPhone(partyPhone);
  if (!resolved.customerId) return null;
  const store = getDataStore();
  return (
    (store.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === resolved.customerId)
    || null
  );
}

function latestInsightForCustomer(
  customerId: string,
  orgId?: string,
): { trust?: TrustEngineScores; objections: string[]; competitors: string[]; nextStep?: string } {
  const store = getSalesBrainStore();
  const oid = orgId || getHomeOrgId();
  const data = getDataStore();
  const cust = (data.customers as Array<Record<string, unknown>>).find((c) => String(c.id) === customerId);
  const callIds = new Set(
    (Array.isArray(cust?.activities) ? (cust!.activities as Array<Record<string, unknown>>) : [])
      .map((a) => String(a.callId || ''))
      .filter(Boolean),
  );
  const insights = store.insights
    .filter((i) => i.orgId === oid && (callIds.has(i.callId) || true))
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // Prefer insight whose callId appears in activities; else latest for org (weak)
  const hit =
    insights.find((i) => callIds.has(i.callId))
    || null;
  if (!hit) {
    return {
      trust: parseTrustFromCustomer(cust) || undefined,
      objections: [],
      competitors: [],
    };
  }
  return {
    trust: (hit as { trust?: TrustEngineScores }).trust || parseTrustFromCustomer(cust) || undefined,
    objections: hit.objections || [],
    competitors: hit.competitors || [],
    nextStep: hit.nextStep,
  };
}

export function buildSallyRelationshipMemory(partyPhone: string, orgId?: string): string {
  const resolved = resolveContactByPhone(partyPhone);
  const lines: string[] = [
    'RELATIONSHIP MEMORY (facts ù use naturally; never re-ask known IDs; never recite this block):',
    `Caller phone: ${partyPhone}`,
  ];
  if (resolved.customerName) lines.push(`Customer: ${resolved.customerName}`);
  if (resolved.contactName) {
    lines.push(
      `Contact: ${resolved.contactName}${resolved.contactRole ? ` (${resolved.contactRole})` : ''}`,
    );
  }
  const customer = resolved.customerId ? customerByPhone(partyPhone) : null;
  if (!customer) {
    lines.push('No CRM row yet ù discover gently; captureLead when appropriate.');
    return lines.join('\n');
  }

  if (customer.notes) lines.push(`Notes: ${String(customer.notes).slice(0, 350)}`);
  const venueType = customer.venueType != null ? String(customer.venueType) : '';
  const openingHours = customer.openingHours != null ? String(customer.openingHours) : '';
  const hasKitchen =
    customer.hasKitchen === true ? true : customer.hasKitchen === false ? false : null;
  if (venueType) lines.push(`venueType: ${venueType}`);
  if (openingHours) lines.push(`openingHours: ${openingHours.slice(0, 120)}`);
  if (hasKitchen != null) lines.push(`hasKitchen: ${hasKitchen}`);
  if (customer.address || customer.postcode) {
    lines.push(
      `Venue/postcode on file: ${[customer.address, customer.postcode].filter(Boolean).join(' ù ').slice(0, 160)} ù do NOT NATO-read unless they correct it.`,
    );
  }
  if (customer.email) lines.push(`Email on file: ${String(customer.email)} ù do not re-ask unless wrong.`);
  if (customer.preferredFormality) lines.push(`preferredFormality: ${String(customer.preferredFormality)}`);
  if (customer.preferredContactTimes) {
    lines.push(`preferredContactTimes: ${String(customer.preferredContactTimes).slice(0, 100)}`);
  }

  const orgMem = (customer.sallyOrgMemory && typeof customer.sallyOrgMemory === 'object')
    ? (customer.sallyOrgMemory as SallyOrgMemory)
    : null;
  if (orgMem) {
    lines.push('ORG MEMORY:');
    if (orgMem.champions) lines.push(`- Champions: ${String(orgMem.champions).slice(0, 120)}`);
    if (orgMem.blockers) lines.push(`- Blockers: ${String(orgMem.blockers).slice(0, 120)}`);
    if (orgMem.branches) lines.push(`- Branches: ${String(orgMem.branches).slice(0, 120)}`);
    if (orgMem.staffChanges) lines.push(`- Staff changes: ${String(orgMem.staffChanges).slice(0, 120)}`);
    if (orgMem.decisionHistory) lines.push(`- Decisions: ${String(orgMem.decisionHistory).slice(0, 120)}`);
    if (orgMem.seasonalPatterns) lines.push(`- Seasonal: ${String(orgMem.seasonalPatterns).slice(0, 100)}`);
    if (orgMem.pastObjections?.length) {
      lines.push(`- Past objections: ${orgMem.pastObjections.slice(0, 6).join(', ')}`);
    }
  }

  const dial = suggestDialWindows({ venueType, openingHours, hasKitchen });
  lines.push(formatDialTimingPromptBlock(dial));

  const trust = parseTrustFromCustomer(customer);
  if (trust) lines.push(formatTrustPromptBlock(trust));

  if (resolved.customerId) {
    const insight = latestInsightForCustomer(String(resolved.customerId), orgId);
    if (insight.objections.length) {
      lines.push(`Recent objections: ${insight.objections.slice(0, 6).join(', ')}`);
    }
    if (insight.competitors.length) {
      lines.push(`Competitors mentioned: ${insight.competitors.slice(0, 4).join(', ')}`);
    }
    if (insight.nextStep) lines.push(`Last nextStep: ${insight.nextStep.slice(0, 160)}`);
  }

  const activities = Array.isArray(customer.activities)
    ? (customer.activities as Array<Record<string, unknown>>).slice(0, 6)
    : [];
  if (activities.length) {
    lines.push('Prior call notes:');
    for (const a of activities) {
      const detail = String(a.detail ?? a.summary ?? '').slice(0, 180);
      if (!detail) continue;
      const when = String(a.createdAt ?? '').slice(0, 16);
      lines.push(`- ${when}: ${detail}${a.outcome ? ` ? ${a.outcome}` : ''}`);
    }
  }
  if (customer.nextFollowUp) lines.push(`Next follow-up: ${String(customer.nextFollowUp)}`);

  return lines.join('\n');
}

export function recallSallyAccountMemoryToolResult(partyPhone: string, orgId?: string): Record<string, unknown> {
  const text = buildSallyRelationshipMemory(partyPhone, orgId);
  return {
    ok: true,
    memory: text,
    spokenHint: 'Use these facts silently ù do not read the memory block aloud.',
    doNotReadAloud: true,
  };
}

export function planVenueAwareDial(input: {
  venueType?: unknown;
  openingHours?: unknown;
  hasKitchen?: boolean | null;
}): DialWindowSuggestion {
  return suggestDialWindows(input);
}

export function applyVenueProfileToCustomer(
  customerId: string,
  patch: {
    venueType?: string;
    openingHours?: string;
    hasKitchen?: boolean | null;
    preferredFormality?: string;
    preferredContactTimes?: string;
    sallyOrgMemory?: Partial<SallyOrgMemory>;
    sallyTrust?: TrustEngineScores;
  },
): void {
  const store = getDataStore();
  const idx = store.customers.findIndex((c) => String(c.id) === customerId);
  if (idx < 0) return;
  const prev = store.customers[idx] as Record<string, unknown>;
  const next: Record<string, unknown> = { ...prev };
  if (patch.venueType != null) next.venueType = normalizeVenueType(patch.venueType);
  if (patch.openingHours != null) next.openingHours = String(patch.openingHours).slice(0, 240);
  if (patch.hasKitchen !== undefined) next.hasKitchen = patch.hasKitchen;
  if (patch.preferredFormality) next.preferredFormality = String(patch.preferredFormality).slice(0, 40);
  if (patch.preferredContactTimes) {
    next.preferredContactTimes = String(patch.preferredContactTimes).slice(0, 120);
  }
  if (patch.sallyOrgMemory) {
    const prevMem =
      prev.sallyOrgMemory && typeof prev.sallyOrgMemory === 'object'
        ? (prev.sallyOrgMemory as SallyOrgMemory)
        : {};
    next.sallyOrgMemory = { ...prevMem, ...patch.sallyOrgMemory };
  }
  if (patch.sallyTrust) next.sallyTrust = patch.sallyTrust;
  const dial = suggestDialWindows({
    venueType: next.venueType,
    openingHours: next.openingHours,
    hasKitchen: next.hasKitchen === true ? true : next.hasKitchen === false ? false : null,
  });
  if (dial.nextSlotISO) next.nextFollowUp = dial.nextSlotISO;
  next.sallyDialHint = dial.reason;
  next.sallyPitchAngle = dial.pitchAngle;
  store.customers[idx] = next;
  syncData(store);
}
