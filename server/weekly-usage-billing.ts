/**
 * Weekly SaaS usage rating: customer sell lines from the fare catalog,
 * plus internal cost/margin trees that must never reach the customer.
 */
import {
  FARE_SCHEDULE_VERSION,
  OUTBOUND_OVERAGE,
  SAAS_PACKAGES,
  getPackage,
  isSaasPackageId,
  judieTierToOrgPlan,
  type SaasPackageDef,
  type SaasPackageId,
} from './saas-packages';
import {
  getOrganizationById,
  type Organization,
  type OrgPlan,
} from './organizations';
import {
  listUsageEventsInRange,
  normalizeUsageOrgId,
  type UsageEvent,
} from './usage';

const USD_GBP = Number(process.env.USD_GBP_RATE?.trim() || '0.79') || 0.79;

/** Internal wholesale estimates for outbound trunk (not customer-facing). */
const WHOLESALE_OUTBOUND = {
  mobileGbpPerMin: 0.04,
  landlineGbpPerMin: 0.01,
} as const;

/** Internal AI-minute wholesale estimate when provider cost is missing. */
const WHOLESALE_AI_GBP_PER_MIN = 0.08;

export type CustomerSellLine = {
  code: 'ai_overage' | 'outbound_mobile' | 'outbound_landline' | 'other';
  description: string;
  quantity: number;
  unit: 'minutes';
  unitPriceGbp: number;
  amountGbp: number;
};

export type UsageSummaryRow = {
  label: string;
  included: number;
  used: number;
  unit: string;
};

export type InternalMarginLine = {
  code: string;
  label: string;
  sellGbp: number;
  costGbp: number;
  marginGbp: number;
  marginPct: number;
};

export type WeeklyBillingBreakdown = {
  orgId: string;
  packageId: SaasPackageId;
  packageName: string;
  fareVersion: string;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  isoWeek: string;
  usage: {
    aiMinutes: number;
    outboundMobileMinutes: number;
    outboundLandlineMinutes: number;
    outboundUnknownMinutes: number;
    tokens: number;
  };
  allowances: {
    weeklyAiMinutes: number;
    weeklyOutboundMinutes: number;
    weeklyTokenCap: number;
  };
  overage: {
    aiMinutes: number;
    outboundMobileMinutes: number;
    outboundLandlineMinutes: number;
  };
  customerLines: CustomerSellLine[];
  customerSubtotalGbp: number;
  usageSummary: UsageSummaryRow[];
  /** Platform-only — never serialize into Stripe descriptions, emails, or customer APIs. */
  internalMargins: {
    lines: InternalMarginLine[];
    totalSellGbp: number;
    totalCostGbp: number;
    totalMarginGbp: number;
    totalMarginPct: number;
    providerCostUsd: number;
  };
};

export type IsoWeekRange = {
  weekStart: Date;
  weekEnd: Date;
  weekStartIso: string;
  weekEndIso: string;
  weekLabel: string;
  isoWeek: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Previous completed ISO week (Mon 00:00 UTC → next Mon 00:00 UTC), or an explicit Monday. */
export function resolveBillingWeek(anchor: Date = new Date()): IsoWeekRange {
  const utc = new Date(Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate(),
  ));
  const day = utc.getUTCDay(); // 0=Sun … 6=Sat
  const daysSinceMonday = (day + 6) % 7;
  const thisMonday = new Date(utc);
  thisMonday.setUTCDate(utc.getUTCDate() - daysSinceMonday);
  thisMonday.setUTCHours(0, 0, 0, 0);

  // Default: bill the week that just ended (previous Monday → this Monday).
  const weekStart = new Date(thisMonday);
  weekStart.setUTCDate(thisMonday.getUTCDate() - 7);
  const weekEnd = new Date(thisMonday);

  return formatWeekRange(weekStart, weekEnd);
}

export function weekRangeFromStart(weekStartIso: string): IsoWeekRange {
  const weekStart = new Date(weekStartIso);
  if (Number.isNaN(weekStart.getTime())) {
    throw new Error(`Invalid weekStart: ${weekStartIso}`);
  }
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);
  return formatWeekRange(weekStart, weekEnd);
}

function formatWeekRange(weekStart: Date, weekEnd: Date): IsoWeekRange {
  const { year, week } = isoWeekParts(weekStart);
  const isoWeek = `${year}-W${String(week).padStart(2, '0')}`;
  const weekLabel = `${weekStart.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })} – ${new Date(weekEnd.getTime() - 1).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })}`;
  return {
    weekStart,
    weekEnd,
    weekStartIso: weekStart.toISOString(),
    weekEndIso: weekEnd.toISOString(),
    weekLabel,
    isoWeek,
  };
}

function isoWeekParts(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

const PLAN_TO_PACKAGE: Record<OrgPlan, SaasPackageId> = {
  starter: 'judie_starter',
  pro: 'judie_pro',
  enterprise: 'judie_enterprise',
  sync2dine_platform: 'combined',
  sync2dine_kiosk: 'atmosphere',
};

export function resolveOrgPackageId(org: Organization): SaasPackageId {
  const fromField = (org as Organization & { saasPackageId?: string }).saasPackageId;
  if (isSaasPackageId(fromField)) return fromField;

  const notes = String(org.notes || '');
  const match = notes.match(/(?:^|\b)(?:saas)?packageId\s*[=:]\s*([a-z0-9_]+)/i);
  if (match && isSaasPackageId(match[1])) return match[1];

  return PLAN_TO_PACKAGE[org.plan] ?? 'judie_starter';
}

function sumSeconds(events: UsageEvent[], predicate: (e: UsageEvent) => boolean): number {
  return events.reduce((sum, e) => (predicate(e) ? sum + Number(e.quantity || 0) : sum), 0);
}

function classifyPhoneEvents(events: UsageEvent[]): {
  aiSeconds: number;
  outboundMobileSec: number;
  outboundLandlineSec: number;
  outboundUnknownSec: number;
  tokens: number;
  providerCostUsd: number;
} {
  let aiSeconds = 0;
  let outboundMobileSec = 0;
  let outboundLandlineSec = 0;
  let outboundUnknownSec = 0;
  let tokens = 0;
  let providerCostUsd = 0;

  for (const e of events) {
    providerCostUsd += Number(e.costUsd || 0);
    const unit = e.unit || 'tokens';
    const qty = Number(e.quantity ?? e.totalTokens ?? 0);
    if ((!e.provider || e.provider === 'openai' || e.provider === 'deepseek') && (!unit || unit === 'tokens')) {
      tokens += e.totalTokens || qty;
    }
    if (unit !== 'seconds' && e.provider !== 'phone') continue;
    const endpoint = String(e.endpoint || '');
    const numberType = String(e.metadata?.numberType || e.model || 'unknown');
    if (endpoint === 'phone.ai' || endpoint === 'phone.inbound' || e.metadata?.billAs === 'ai') {
      aiSeconds += qty;
      continue;
    }
    if (endpoint === 'phone.outbound' || e.provider === 'phone') {
      // Outbound trunk minutes also count toward AI talk time for Judie packages.
      aiSeconds += qty;
      if (numberType === 'mobile') outboundMobileSec += qty;
      else if (numberType === 'landline') outboundLandlineSec += qty;
      else outboundUnknownSec += qty;
    }
  }

  return {
    aiSeconds,
    outboundMobileSec,
    outboundLandlineSec,
    outboundUnknownSec,
    tokens,
    providerCostUsd,
  };
}

function buildCustomerLines(
  pkg: SaasPackageDef,
  week: IsoWeekRange,
  overage: WeeklyBillingBreakdown['overage'],
): CustomerSellLine[] {
  const lines: CustomerSellLine[] = [];
  if (overage.aiMinutes > 0 && pkg.aiOverageGbpPerMinute > 0) {
    const amount = round2(overage.aiMinutes * pkg.aiOverageGbpPerMinute);
    lines.push({
      code: 'ai_overage',
      description: `AI overage ${overage.aiMinutes} min @ £${pkg.aiOverageGbpPerMinute.toFixed(2)} — ${week.isoWeek}`,
      quantity: overage.aiMinutes,
      unit: 'minutes',
      unitPriceGbp: pkg.aiOverageGbpPerMinute,
      amountGbp: amount,
    });
  }
  if (overage.outboundMobileMinutes > 0) {
    const amount = round2(overage.outboundMobileMinutes * OUTBOUND_OVERAGE.mobileGbpPerMin);
    lines.push({
      code: 'outbound_mobile',
      description: `Outbound mobile overage ${overage.outboundMobileMinutes} min @ £${OUTBOUND_OVERAGE.mobileGbpPerMin.toFixed(2)} — ${week.isoWeek}`,
      quantity: overage.outboundMobileMinutes,
      unit: 'minutes',
      unitPriceGbp: OUTBOUND_OVERAGE.mobileGbpPerMin,
      amountGbp: amount,
    });
  }
  if (overage.outboundLandlineMinutes > 0) {
    const amount = round2(overage.outboundLandlineMinutes * OUTBOUND_OVERAGE.landlineGbpPerMin);
    lines.push({
      code: 'outbound_landline',
      description: `Outbound landline overage ${overage.outboundLandlineMinutes} min @ £${OUTBOUND_OVERAGE.landlineGbpPerMin.toFixed(2)} — ${week.isoWeek}`,
      quantity: overage.outboundLandlineMinutes,
      unit: 'minutes',
      unitPriceGbp: OUTBOUND_OVERAGE.landlineGbpPerMin,
      amountGbp: amount,
    });
  }
  return lines;
}

function buildInternalMargins(
  customerLines: CustomerSellLine[],
  overage: WeeklyBillingBreakdown['overage'],
  providerCostUsd: number,
): WeeklyBillingBreakdown['internalMargins'] {
  const lines: InternalMarginLine[] = [];
  const providerCostGbp = round2(providerCostUsd * USD_GBP);

  for (const line of customerLines) {
    let costGbp = 0;
    if (line.code === 'ai_overage') {
      costGbp = round2(overage.aiMinutes * WHOLESALE_AI_GBP_PER_MIN);
    } else if (line.code === 'outbound_mobile') {
      costGbp = round2(overage.outboundMobileMinutes * WHOLESALE_OUTBOUND.mobileGbpPerMin);
    } else if (line.code === 'outbound_landline') {
      costGbp = round2(overage.outboundLandlineMinutes * WHOLESALE_OUTBOUND.landlineGbpPerMin);
    }
    const marginGbp = round2(line.amountGbp - costGbp);
    lines.push({
      code: line.code,
      label: line.description,
      sellGbp: line.amountGbp,
      costGbp,
      marginGbp,
      marginPct: line.amountGbp > 0 ? round2((marginGbp / line.amountGbp) * 100) : 0,
    });
  }

  if (providerCostGbp > 0) {
    lines.push({
      code: 'provider_tokens_tts',
      label: 'Provider AI / TTS cost (tokens & characters)',
      sellGbp: 0,
      costGbp: providerCostGbp,
      marginGbp: round2(-providerCostGbp),
      marginPct: 0,
    });
  }

  const totalSellGbp = round2(customerLines.reduce((s, l) => s + l.amountGbp, 0));
  const totalCostGbp = round2(lines.reduce((s, l) => s + l.costGbp, 0));
  const totalMarginGbp = round2(totalSellGbp - totalCostGbp);
  return {
    lines,
    totalSellGbp,
    totalCostGbp,
    totalMarginGbp,
    totalMarginPct: totalSellGbp > 0 ? round2((totalMarginGbp / totalSellGbp) * 100) : 0,
    providerCostUsd: round3(providerCostUsd),
  };
}

/** Customer-safe projection — strips internalMargins. */
export function toCustomerBreakdown(breakdown: WeeklyBillingBreakdown) {
  const { internalMargins: _internal, ...rest } = breakdown;
  return rest;
}

export function buildWeeklyBillingBreakdown(
  orgId: string,
  options: {
    weekStartIso?: string;
    packageId?: SaasPackageId;
    events?: UsageEvent[];
  } = {},
): WeeklyBillingBreakdown {
  const oid = normalizeUsageOrgId(orgId);
  const org = getOrganizationById(oid);
  if (!org) throw new Error(`Organization not found: ${oid}`);

  const week = options.weekStartIso
    ? weekRangeFromStart(options.weekStartIso)
    : resolveBillingWeek();

  const packageId = options.packageId && isSaasPackageId(options.packageId)
    ? options.packageId
    : resolveOrgPackageId(org);
  const pkg = getPackage(packageId);

  const events = options.events ?? listUsageEventsInRange(oid, week.weekStartIso, week.weekEndIso);
  const classified = classifyPhoneEvents(events);

  const aiMinutes = round2(classified.aiSeconds / 60);
  const outboundMobileMinutes = round2(classified.outboundMobileSec / 60);
  const outboundLandlineMinutes = round2(
    (classified.outboundLandlineSec + classified.outboundUnknownSec) / 60,
  );
  const outboundUnknownMinutes = round2(classified.outboundUnknownSec / 60);
  const outboundTotalMinutes = round2(
    outboundMobileMinutes + outboundLandlineMinutes,
  );

  const aiOverage = Math.max(0, round2(aiMinutes - pkg.weeklyAiMinutes));
  const outboundOverage = Math.max(0, round2(outboundTotalMinutes - pkg.weeklyOutboundMinutes));

  let overageMobile = 0;
  let overageLandline = 0;
  if (outboundOverage > 0) {
    const typed = outboundMobileMinutes + outboundLandlineMinutes;
    if (typed > 0) {
      overageMobile = round2(outboundOverage * (outboundMobileMinutes / typed));
      overageLandline = round2(outboundOverage - overageMobile);
    } else {
      overageLandline = outboundOverage;
    }
  }

  const overage = {
    aiMinutes: aiOverage,
    outboundMobileMinutes: overageMobile,
    outboundLandlineMinutes: overageLandline,
  };

  const customerLines = buildCustomerLines(pkg, week, overage);
  const customerSubtotalGbp = round2(customerLines.reduce((s, l) => s + l.amountGbp, 0));

  return {
    orgId: oid,
    packageId,
    packageName: pkg.name,
    fareVersion: FARE_SCHEDULE_VERSION,
    weekStart: week.weekStartIso,
    weekEnd: week.weekEndIso,
    weekLabel: week.weekLabel,
    isoWeek: week.isoWeek,
    usage: {
      aiMinutes,
      outboundMobileMinutes,
      outboundLandlineMinutes,
      outboundUnknownMinutes,
      tokens: classified.tokens,
    },
    allowances: {
      weeklyAiMinutes: pkg.weeklyAiMinutes,
      weeklyOutboundMinutes: pkg.weeklyOutboundMinutes,
      weeklyTokenCap: pkg.weeklyTokenCap,
    },
    overage,
    customerLines,
    customerSubtotalGbp,
    usageSummary: [
      {
        label: 'Judie AI minutes',
        included: pkg.weeklyAiMinutes,
        used: aiMinutes,
        unit: 'min',
      },
      {
        label: 'Outbound minutes',
        included: pkg.weeklyOutboundMinutes,
        used: outboundTotalMinutes,
        unit: 'min',
      },
      {
        label: 'AI tokens',
        included: pkg.weeklyTokenCap,
        used: classified.tokens,
        unit: 'tokens',
      },
    ],
    internalMargins: buildInternalMargins(customerLines, overage, classified.providerCostUsd),
  };
}

export function listBillablePackageIds(): SaasPackageId[] {
  return Object.keys(SAAS_PACKAGES) as SaasPackageId[];
}

export function packageMatchesOrgPlan(packageId: SaasPackageId, plan: OrgPlan): boolean {
  const pkg = getPackage(packageId);
  if (pkg.judieTier === 'none') {
    return plan === 'sync2dine_kiosk' || plan === 'sync2dine_platform';
  }
  return judieTierToOrgPlan(pkg.judieTier) === plan
    || PLAN_TO_PACKAGE[plan] === packageId;
}

// silence unused helper lint when tree-shaken in tests
void sumSeconds;
