/**
 * Sync2Dine SaaS package catalog — canonical commercial source of truth.
 * Weekly billing with 40% launch offer and 50% annual prepay.
 */

export const FARE_SCHEDULE_VERSION = 's2d-fare-2026-07-19';

export const SAAS_PACKAGE_IDS = [
  'judie_payg_inbound',
  'atmosphere',
  'judie_starter',
  'judie_pro',
  'judie_enterprise',
  'combined',
  'combined_pro',
  'atmosphere_enterprise',
  'combined_enterprise',
] as const;

export type SaasPackageId = (typeof SAAS_PACKAGE_IDS)[number];

export type JudieTier = 'payg' | 'starter' | 'pro' | 'enterprise' | 'none';

export type OverageAction = 'continue_bill' | 'pause_transfer' | 'approval_required';

export type SaasPackageDef = {
  id: SaasPackageId;
  name: string;
  shortName: string;
  description: string;
  family: 'judie' | 'atmosphere' | 'complete';
  /** Standard (ongoing) weekly GBP — real product price. */
  standardWeeklyGbp: number;
  /** Launch weekly GBP — deadline-bound offer, keep after signing. */
  launchWeeklyGbp: number;
  /** Annual prepay GBP = round(launchWeekly × 52 × 0.50). */
  annualPrepayGbp: number;
  judieTier: JudieTier;
  includesAtmosphere: boolean;
  inboundOnly: boolean;
  weeklyAiMinutes: number;
  weeklyOutboundMinutes: number;
  aiOverageGbpPerMinute: number;
  weeklyTokenCap: number;
  badge?: string;
  primary: boolean;
};

/** Outbound overage fares (UK). */
export const OUTBOUND_OVERAGE = {
  mobileGbpPerMin: 0.12,
  landlineGbpPerMin: 0.03,
} as const;

/** Additional site floor (? £2.49/mo ? £1/week launch floor). */
export const ADDITIONAL_SITE_WEEKLY_GBP = 1;
export const ADDITIONAL_SITE_ANNUAL_GBP = 26;

export const SAAS_PACKAGES: Record<SaasPackageId, SaasPackageDef> = {
  judie_payg_inbound: {
    id: 'judie_payg_inbound',
    name: 'Judie Pay-as-you-go',
    shortName: 'Pay-as-you-go',
    description: 'Inbound-only Judie receptionist — orders and bookings into the app',
    family: 'judie',
    standardWeeklyGbp: 77,
    launchWeeklyGbp: 46,
    annualPrepayGbp: 1196,
    judieTier: 'payg',
    includesAtmosphere: false,
    inboundOnly: true,
    weeklyAiMinutes: 60,
    weeklyOutboundMinutes: 0,
    aiOverageGbpPerMinute: 0.45,
    weeklyTokenCap: 125_000,
    primary: false,
  },
  atmosphere: {
    id: 'atmosphere',
    name: 'Atmosphere',
    shortName: 'Atmosphere',
    description: 'Venue audio, promotional messaging, and staff training (Sync2Gear)',
    family: 'atmosphere',
    standardWeeklyGbp: 232,
    launchWeeklyGbp: 139,
    annualPrepayGbp: 3614,
    judieTier: 'none',
    includesAtmosphere: true,
    inboundOnly: false,
    weeklyAiMinutes: 0,
    weeklyOutboundMinutes: 0,
    aiOverageGbpPerMinute: 0,
    weeklyTokenCap: 125_000,
    primary: true,
  },
  judie_starter: {
    id: 'judie_starter',
    name: 'Judie Starter',
    shortName: 'Starter',
    description: 'Judie AI receptionist for orders, bookings, and transfers',
    family: 'judie',
    standardWeeklyGbp: 232,
    launchWeeklyGbp: 139,
    annualPrepayGbp: 3614,
    judieTier: 'starter',
    includesAtmosphere: false,
    inboundOnly: false,
    weeklyAiMinutes: 140,
    weeklyOutboundMinutes: 25,
    aiOverageGbpPerMinute: 0.35,
    weeklyTokenCap: 115_000,
    badge: 'Most Popular',
    primary: true,
  },
  judie_pro: {
    id: 'judie_pro',
    name: 'Judie Pro',
    shortName: 'Pro',
    description: 'Higher call capacity and outbound/winback capability',
    family: 'judie',
    standardWeeklyGbp: 385,
    launchWeeklyGbp: 231,
    annualPrepayGbp: 6006,
    judieTier: 'pro',
    includesAtmosphere: false,
    inboundOnly: false,
    weeklyAiMinutes: 420,
    weeklyOutboundMinutes: 60,
    aiOverageGbpPerMinute: 0.3,
    weeklyTokenCap: 460_000,
    primary: false,
  },
  judie_enterprise: {
    id: 'judie_enterprise',
    name: 'Judie Enterprise',
    shortName: 'Enterprise',
    description: 'Highest Judie capacity for multi-site restaurants',
    family: 'judie',
    standardWeeklyGbp: 577,
    launchWeeklyGbp: 346,
    annualPrepayGbp: 8996,
    judieTier: 'enterprise',
    includesAtmosphere: false,
    inboundOnly: false,
    weeklyAiMinutes: 840,
    weeklyOutboundMinutes: 120,
    aiOverageGbpPerMinute: 0.25,
    weeklyTokenCap: 2_300_000,
    primary: false,
  },
  combined: {
    id: 'combined',
    name: 'Complete',
    shortName: 'Complete',
    description: 'Atmosphere + Judie Starter — phone and venue growth system',
    family: 'complete',
    standardWeeklyGbp: 347,
    launchWeeklyGbp: 208,
    annualPrepayGbp: 5408,
    judieTier: 'starter',
    includesAtmosphere: true,
    inboundOnly: false,
    weeklyAiMinutes: 140,
    weeklyOutboundMinutes: 25,
    aiOverageGbpPerMinute: 0.35,
    weeklyTokenCap: 115_000,
    badge: 'Best value',
    primary: true,
  },
  combined_pro: {
    id: 'combined_pro',
    name: 'Complete Pro',
    shortName: 'Complete Pro',
    description: 'Atmosphere + Judie Pro',
    family: 'complete',
    standardWeeklyGbp: 539,
    launchWeeklyGbp: 323,
    annualPrepayGbp: 8398,
    judieTier: 'pro',
    includesAtmosphere: true,
    inboundOnly: false,
    weeklyAiMinutes: 420,
    weeklyOutboundMinutes: 60,
    aiOverageGbpPerMinute: 0.3,
    weeklyTokenCap: 460_000,
    primary: false,
  },
  atmosphere_enterprise: {
    id: 'atmosphere_enterprise',
    name: 'Atmosphere Enterprise',
    shortName: 'Atmos Enterprise',
    description: 'Advanced multi-zone Atmosphere and training',
    family: 'atmosphere',
    standardWeeklyGbp: 462,
    launchWeeklyGbp: 277,
    annualPrepayGbp: 7202,
    judieTier: 'none',
    includesAtmosphere: true,
    inboundOnly: false,
    weeklyAiMinutes: 0,
    weeklyOutboundMinutes: 0,
    aiOverageGbpPerMinute: 0,
    weeklyTokenCap: 460_000,
    primary: false,
  },
  combined_enterprise: {
    id: 'combined_enterprise',
    name: 'Complete Enterprise',
    shortName: 'Complete Ent',
    description: 'Atmosphere Enterprise + Judie Enterprise',
    family: 'complete',
    standardWeeklyGbp: 885,
    launchWeeklyGbp: 531,
    annualPrepayGbp: 13806,
    judieTier: 'enterprise',
    includesAtmosphere: true,
    inboundOnly: false,
    weeklyAiMinutes: 840,
    weeklyOutboundMinutes: 120,
    aiOverageGbpPerMinute: 0.25,
    weeklyTokenCap: 2_300_000,
    primary: false,
  },
};

export function isSaasPackageId(value: unknown): value is SaasPackageId {
  return typeof value === 'string' && (SAAS_PACKAGE_IDS as readonly string[]).includes(value);
}

export function getPackage(id: SaasPackageId): SaasPackageDef {
  return SAAS_PACKAGES[id];
}

export function primaryPackages(): SaasPackageDef[] {
  return SAAS_PACKAGE_IDS.map((id) => SAAS_PACKAGES[id]).filter((p) => p.primary);
}

export function scalePackages(): SaasPackageDef[] {
  return SAAS_PACKAGE_IDS.map((id) => SAAS_PACKAGES[id]).filter((p) => !p.primary);
}

export type BillingInterval = 'weekly' | 'annual';

export function priceForInterval(pkg: SaasPackageDef, interval: BillingInterval, useLaunch = true): number {
  if (interval === 'annual') return pkg.annualPrepayGbp;
  return useLaunch ? pkg.launchWeeklyGbp : pkg.standardWeeklyGbp;
}

export function monthlyEquivalentFromWeekly(weeklyGbp: number): number {
  return Math.round(((weeklyGbp * 52) / 12) * 100) / 100;
}

/** Map Judie tier to legacy OrgPlan for existing org records. */
export function judieTierToOrgPlan(tier: JudieTier): 'starter' | 'pro' | 'enterprise' {
  if (tier === 'pro') return 'pro';
  if (tier === 'enterprise') return 'enterprise';
  return 'starter';
}

export function formatFareSummary(pkg: SaasPackageDef): string {
  const lines = [
    `${pkg.name}: normally £${pkg.standardWeeklyGbp}/week — launch offer £${pkg.launchWeeklyGbp}/week (40% off).`,
    `Annual prepay £${pkg.annualPrepayGbp} (50% off annualized launch).`,
  ];
  if (pkg.weeklyAiMinutes > 0) {
    lines.push(
      `Included: ${pkg.weeklyAiMinutes} Judie AI min/week` +
        (pkg.inboundOnly ? ' (inbound only)' : '') +
        (pkg.weeklyOutboundMinutes > 0 ? `, ${pkg.weeklyOutboundMinutes} outbound min/week` : ', no outbound') +
        `. AI overage £${pkg.aiOverageGbpPerMinute.toFixed(2)}/min.` +
        (!pkg.inboundOnly
          ? ` Outbound overage £${OUTBOUND_OVERAGE.mobileGbpPerMin}/min mobile · £${OUTBOUND_OVERAGE.landlineGbpPerMin}/min landline.`
          : ''),
    );
  }
  if (pkg.includesAtmosphere) {
    lines.push('Includes Atmosphere (venue audio, messaging, and staff training).');
  }
  lines.push('Minutes reset weekly; unused minutes do not roll over. Fare schedule ' + FARE_SCHEDULE_VERSION + '.');
  return lines.join(' ');
}

/** Legacy product ID bridge for older quotes. */
export type LegacySaasProductId = 'phone_agent' | 'audio_management';

export function legacyProductToPackage(id: LegacySaasProductId, plan?: string): SaasPackageId {
  if (id === 'audio_management') return 'atmosphere';
  if (plan === 'pro') return 'judie_pro';
  if (plan === 'enterprise') return 'judie_enterprise';
  return 'judie_starter';
}

/** Packages Sally pitches first on phone (order matters). */
export const PRIMARY_PITCH_IDS: SaasPackageId[] = [
  'atmosphere',
  'judie_starter',
  'combined',
  'judie_pro',
];

export function weeklyPrice(pkg: SaasPackageDef, launchActive = true): number {
  return launchActive ? pkg.launchWeeklyGbp : pkg.standardWeeklyGbp;
}
